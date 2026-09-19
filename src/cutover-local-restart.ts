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
  type BoundLaunchdRestartOptions,
  type SelfRestartActuator,
} from "./cutover-restart.js";
import {
  CutoverStateError,
  CutoverStateStore,
  type CutoverServerIdentity,
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
}

export interface LocalBoundCutoverRestartInput {
  config: ServerConfig;
  cutoverId: string;
  carrierId: string;
  expectedCarrierVersion: number;
  expectedValidityVersion: number;
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
  const capabilityManifestSha256=capability.manifestSha256;
  const serverInstanceId=mcp.serverInstanceId, cutoverMode=mcp.cutoverMode;
  const reconciliationRequired=mcp.reconciliationRequired;
  if(typeof sourceCommit!=="string" || !/^[a-f0-9]{40,64}$/.test(sourceCommit) ||
    typeof buildId!=="string" || !buildId ||
    !Number.isSafeInteger(pid) || (pid as number)<=0 ||
    typeof capabilityManifestSha256!=="string" || !/^[a-f0-9]{64}$/.test(capabilityManifestSha256) ||
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
  const manager=new DurableOperationManager(input.config,undefined,undefined,undefined,bindings.readers);
  try {
    const local=bindings.localDrainedCutoverContext({
      cutoverId:input.cutoverId,
      carrierId:input.carrierId,
      expectedVersion:input.expectedCarrierVersion,
      expectedValidityVersion:input.expectedValidityVersion,
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

    const createActuator=dependencies.createActuator ?? createBoundLaunchdRestartActuator;
    const actuator=createActuator({
      livePid:health.pid,
      serviceLabel:approved.restart.serviceLabel,
      launchdTarget:approved.restart.launchdTarget,
    });
    if(!actuator) {
      throw new CutoverStateError("Approved launchd target does not own the live drained DevSpace PID.");
    }

    const outcome=await manager.restartCutover(
      input.cutoverId,
      health.identity,
      approved.restart.buildReady,
      expected=>probe(packageRoot,expected),
      actuator,
      local.context,
    );
    return { ...outcome, liveIdentity:health.identity, packageRoot };
  } finally {
    manager.close();
    bindings.close();
  }
}
