import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ServerConfig } from "./config.js";
import { CarrierBindingStore } from "./carrier-binding.js";
import { DurableOperationManager } from "./durable-operations.js";
import {
  CutoverBuildNotReadyError,
  probeBuildReady,
} from "./cutover-build-ready.js";
import {
  createBoundLaunchdRestartActuator,
  inspectBoundStableLaunchdService,
  type BoundLaunchdRestartOptions,
  type InspectStableLaunchdServiceOptions,
  type SelfRestartActuator,
  type StableLaunchdServiceBinding,
} from "./cutover-restart.js";
import {
  bindCutoverActivation,
  verifyActivationBinding,
  type BindCutoverActivationInput,
} from "./cutover-activation.js";
import {
  CutoverStateError,
  CutoverStateStore,
  type CutoverServerIdentity,
  type DurableReconciliationWitness,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";

interface LiveCutoverHealth {
  identity: CutoverServerIdentity;
  pid: number;
  cutoverMode: string;
  reconciliationRequired: boolean;
}

export interface LocalBoundCutoverRestartDependencies {
  readHealth?: () => Promise<unknown>;
  probeTarget?: (
    packageRoot: string,
    expected: ExpectedCutoverIdentity,
  ) => Promise<{ buildReady: boolean; detail: string }> | { buildReady: boolean; detail: string };
  createActuator?: (options: BoundLaunchdRestartOptions) => SelfRestartActuator | undefined;
  inspectStableService?: (
    options: InspectStableLaunchdServiceOptions,
  ) => StableLaunchdServiceBinding | undefined;
  bindActivation?: (input: BindCutoverActivationInput) => ReturnType<typeof bindCutoverActivation>;
  verifyActivation?: (
    binding: ReturnType<typeof bindCutoverActivation>,
    serviceRoot: string,
  ) => unknown;
}

export interface LocalBoundCutoverRestartInput {
  config: ServerConfig;
  cutoverId: string;
  carrierId: string;
  expectedCarrierVersion: number;
  expectedValidityVersion: number;
  carrierCredential: string;
  confirmCutoverId: string;
  packageRoot: string;
}

function record(value: unknown): Record<string, unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value)) {
    throw new CutoverStateError("Live DevSpace health payload is malformed.");
  }
  return value as Record<string, unknown>;
}

export function parseLiveCutoverHealth(value: unknown): LiveCutoverHealth {
  const root=record(value), build=record(root.build), capability=record(root.capabilityManifest), mcp=record(root.mcp);
  const sourceCommit=build.source_commit, buildId=build.build_id, pid=build.pid;
  const releaseSha256=build.release_sha256, releasePath=build.release_path, activationCutoverId=build.activation_cutover_id;
  const capabilityManifestSha256=capability.manifestSha256;
  const serverInstanceId=mcp.serverInstanceId, cutoverMode=mcp.cutoverMode;
  const reconciliationRequired=mcp.reconciliationRequired;
  if(typeof sourceCommit!=="string" || !/^[a-f0-9]{40,64}$/.test(sourceCommit) ||
    typeof buildId!=="string" || !buildId ||
    !Number.isSafeInteger(pid) || (pid as number)<=0 ||
    typeof capabilityManifestSha256!=="string" || !/^[a-f0-9]{64}$/.test(capabilityManifestSha256) ||
    (releaseSha256!==undefined && (typeof releaseSha256!=="string" || !/^[a-f0-9]{64}$/.test(releaseSha256))) ||
    (releasePath!==undefined && (typeof releasePath!=="string" || !releasePath.startsWith("/"))) ||
    (activationCutoverId!==undefined && (typeof activationCutoverId!=="string" || !activationCutoverId)) ||
    typeof serverInstanceId!=="string" || !serverInstanceId ||
    typeof cutoverMode!=="string" || typeof reconciliationRequired!=="boolean") {
    throw new CutoverStateError("Live DevSpace health payload lacks exact runtime identity.");
  }
  return {
    identity:{
      serverInstanceId,
      sourceCommit,
      buildId,
      capabilityManifestSha256,
      ...(typeof releaseSha256==="string" ? {releaseSha256} : {}),
      ...(typeof releasePath==="string" ? {releasePath} : {}),
      ...(typeof activationCutoverId==="string" ? {activationCutoverId} : {}),
    },
    pid:pid as number,
    cutoverMode,
    reconciliationRequired,
  };
}

function loopbackHealthUrl(config: ServerConfig): URL {
  const host=config.host.trim().toLowerCase();
  if(!["127.0.0.1","localhost","::1"].includes(host)) {
    throw new CutoverStateError("Bound local cutover restart requires a loopback DevSpace host.");
  }
  const authority=host==="::1" ? "[::1]" : host;
  return new URL(`http://${authority}:${config.port}/healthz`);
}

async function readDefaultHealth(config: ServerConfig): Promise<unknown> {
  const response=await fetch(loopbackHealthUrl(config),{
    method:"GET",
    headers:{accept:"application/json"},
    signal:AbortSignal.timeout(5000),
  });
  if(!response.ok) throw new CutoverStateError(`Live DevSpace health returned HTTP ${response.status}.`);
  return response.json();
}

/**
 * Owner-local escape hatch for a cutover that is already durably DRAINED but
 * whose MCP carrier pairing cannot survive the host transport boundary.
 *
 * The function creates no new authority and never edits cutover state
 * directly. It projects the exact existing carrier into the same
 * ControlPlaneConsumer readers and delegates all restart markers, build-ready
 * checks, replay fencing, and the one launchd effect to restartCutover().
 */
export async function performLocalBoundCutoverRestart(
  input: LocalBoundCutoverRestartInput,
  dependencies: LocalBoundCutoverRestartDependencies = {},
) {
  const bindings=new CarrierBindingStore(input.config.stateDir);
  const manager=new DurableOperationManager(input.config,undefined,bindings.readers);
  try {
    const local=bindings.localDrainedCutoverContext({
      cutoverId:input.cutoverId,
      carrierId:input.carrierId,
      expectedVersion:input.expectedCarrierVersion,
      expectedValidityVersion:input.expectedValidityVersion,
      carrierCredential:input.carrierCredential,
      confirmCutoverId:input.confirmCutoverId,
    });
    const approved=local.cutover;
    const file=new CutoverStateStore(input.config.stateDir).get();
    if(!file || file.cutoverId!==input.cutoverId || file.phase!=="drained" ||
      !isDeepStrictEqual(file.oldServerIdentity,approved.currentIdentity) ||
      !isDeepStrictEqual(file.expectedNewIdentity,approved.expectedIdentity)) {
      throw new CutoverStateError("Bound local restart cutover generation changed before live verification.");
    }

    const health=parseLiveCutoverHealth(
      await (dependencies.readHealth ? dependencies.readHealth() : readDefaultHealth(input.config)),
    );
    if(health.cutoverMode!=="drain" || health.reconciliationRequired!==true ||
      !isDeepStrictEqual(health.identity,approved.currentIdentity)) {
      throw new CutoverStateError("Live DevSpace runtime does not match the approved drained predecessor.");
    }

    const packageRoot=realpathSync.native(input.packageRoot);
    const probe=dependencies.probeTarget ?? ((root: string, expected: ExpectedCutoverIdentity) =>
      probeBuildReady({packageRoot:root,expected}));
    const preflight=await probe(packageRoot,approved.expectedIdentity);
    if(preflight.buildReady!==true) throw new CutoverBuildNotReadyError(preflight.detail);

    const inspectStableService =
      dependencies.inspectStableService ?? inspectBoundStableLaunchdService;
    const stableService = inspectStableService({
      livePid:health.pid,
      serviceLabel:approved.restart.serviceLabel,
      launchdTarget:approved.restart.launchdTarget,
    });
    if(!stableService) {
      throw new CutoverStateError(
        "Approved launchd target is not bound to the canonical stable DevSpace service launcher.",
      );
    }

    const bindActivation = dependencies.bindActivation ?? bindCutoverActivation;
    const verifyActivation = dependencies.verifyActivation ?? verifyActivationBinding;
    const activationBinding = bindActivation({
      cutoverId:input.cutoverId,
      packageRoot,
      serviceRoot:stableService.serviceRoot,
      expected:approved.expectedIdentity,
    });
    const stateStore = new CutoverStateStore(input.config.stateDir);
    stateStore.recordActivationBinding(input.cutoverId, activationBinding);
    verifyActivation(activationBinding, stableService.serviceRoot);

    const createActuator=dependencies.createActuator ?? createBoundLaunchdRestartActuator;
    const actuator=createActuator({
      livePid:health.pid,
      serviceLabel:approved.restart.serviceLabel,
      launchdTarget:approved.restart.launchdTarget,
      expectedStableServiceRoot:stableService.serviceRoot,
      verifyActivation:()=>verifyActivation(activationBinding,stableService.serviceRoot),
    });
    if(!actuator) {
      throw new CutoverStateError(
        "Approved launchd target does not own the live drained PID through the canonical stable launcher.",
      );
    }

    const outcome=await manager.restartCutover(
      input.cutoverId,
      health.identity,
      approved.restart.buildReady,
      expected=>probe(packageRoot,expected),
      actuator,
      local.context,
      activationBinding,
    );
    return {
      ...outcome,
      liveIdentity:health.identity,
      packageRoot,
      stableServiceRoot:stableService.serviceRoot,
      activationBinding,
    };
  } finally {
    manager.close();
    bindings.close();
  }
}

export interface LocalBoundCutoverFinishDependencies {
  readHealth?: () => Promise<unknown>;
  /** Defaults to the server's exact-pair inventory witness over the real workspace store and agent manager. */
  reconcile?: (pair: { workspaceId: string; agentId: string }) => Promise<DurableReconciliationWitness>;
}

export interface LocalBoundCutoverFinishInput {
  config: ServerConfig;
  cutoverId: string;
  carrierId: string;
  expectedCarrierVersion: number;
  expectedValidityVersion: number;
  carrierCredential: string;
  confirmCutoverId: string;
  workspaceId: string;
  agentId: string;
}

async function reconcileExactPair(
  config: ServerConfig,
  pair: { workspaceId: string; agentId: string },
): Promise<DurableReconciliationWitness> {
  // Lazy imports keep the heavy server module off the other CLI paths.
  const { resolveDurableReconciliationWitnessFromInventory } = await import("./server.js");
  const { createWorkspaceStore } = await import("./workspace-store.js");
  const { WorkspaceRegistry } = await import("./workspaces.js");
  const { LocalAgentSessionManager } = await import("./local-agent-sessions.js");
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const agentSessionManager = new LocalAgentSessionManager(config);
  try {
    return await resolveDurableReconciliationWitnessFromInventory(
      { workspaceStore, workspaces: new WorkspaceRegistry(config, workspaceStore), agentSessionManager },
      pair,
    );
  } finally {
    agentSessionManager.close();
    workspaceStore.close?.();
  }
}

/**
 * Owner-local closure of a coordination-bound DRAINED generation whose
 * replacement runtime is already live (for example after restart-bound when the
 * owner sidecar died before finish). Mints no authority: it projects the same
 * root carrier context as restart-bound, requires the live healthz identity to
 * be the exact expected replacement (and not the old instance), runs the
 * exact-pair witness, and delegates every state/lease check to finishCutover().
 */
export async function performLocalBoundCutoverFinish(
  input: LocalBoundCutoverFinishInput,
  dependencies: LocalBoundCutoverFinishDependencies = {},
) {
  const bindings=new CarrierBindingStore(input.config.stateDir);
  const manager=new DurableOperationManager(input.config,undefined,bindings.readers);
  try {
    const local=bindings.localDrainedCutoverContext({
      cutoverId:input.cutoverId,
      carrierId:input.carrierId,
      expectedVersion:input.expectedCarrierVersion,
      expectedValidityVersion:input.expectedValidityVersion,
      carrierCredential:input.carrierCredential,
      confirmCutoverId:input.confirmCutoverId,
    });
    const file=new CutoverStateStore(input.config.stateDir).get();
    if(!file || file.cutoverId!==input.cutoverId || file.phase!=="drained") {
      throw new CutoverStateError("Bound local finish requires the exact drained cutover generation.");
    }
    const health=parseLiveCutoverHealth(
      await (dependencies.readHealth ? dependencies.readHealth() : readDefaultHealth(input.config)),
    );
    const expected=file.expectedNewIdentity;
    if(health.identity.serverInstanceId===file.oldServerIdentity.serverInstanceId ||
      health.identity.sourceCommit!==expected.sourceCommit ||
      health.identity.buildId!==expected.buildId ||
      (expected.capabilityManifestSha256!==undefined &&
        health.identity.capabilityManifestSha256!==expected.capabilityManifestSha256)) {
      throw new CutoverStateError("Live DevSpace runtime is not the exact expected replacement; refusing bound finish.");
    }
    const pair={workspaceId:input.workspaceId,agentId:input.agentId};
    const closed=await manager.finishCutover(
      input.cutoverId,
      health.identity,
      pair,
      ()=>dependencies.reconcile ? dependencies.reconcile(pair) : reconcileExactPair(input.config,pair),
      local.context,
    );
    return {record:closed,liveIdentity:health.identity};
  } finally {
    manager.close();
    bindings.close();
  }
}
