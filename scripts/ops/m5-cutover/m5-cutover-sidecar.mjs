// Generic, RESUMABLE governed-cutover owner sidecar (derived from the M5 668f5df6 sidecar).
// Env: PENDING_ID (approved/recovered pairing), CONTRACT_PATH, RECEIPT_PATH, ACTIVE_RELEASE_ROOT
//      (optional DEVSPACE_SERVICE_ROOT, legacy SERVICE_ROOT; default $HOME/.local/share/devspace-service).
// Exit codes: 0 ok, 1 runtime failure, 2 refused (state combination not safely resumable; never guess).
import { readFileSync, writeFileSync } from "node:fs";
import { Refuse, identityFromHealth, matchesTarget, readSidecarEnv, selectMode } from "./m5-cutover-lib.mjs";

const sidecarEnv = readSidecarEnv();
const { PENDING_ID, CONTRACT_PATH, RECEIPT_PATH, ACTIVE_RELEASE_ROOT, SERVICE_ROOT } = sidecarEnv.values ?? {
  ...Object.fromEntries(["PENDING_ID", "CONTRACT_PATH", "RECEIPT_PATH", "ACTIVE_RELEASE_ROOT"].map((k) => [k, process.env[k]])),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (stage, extra = {}) => console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...extra }));

let cutoverId;
function fail(error) {
  const refused = error instanceof Refuse;
  const failure = {
    ok: false,
    cutoverId,
    error: error instanceof Error ? error.message : String(error),
    ...(refused ? { refused: true, recovery: error.recovery, ...error.extra } : {}),
    at: new Date().toISOString(),
  };
  if (RECEIPT_PATH) { try { writeFileSync(RECEIPT_PATH, JSON.stringify(failure, null, 2) + "\n", { mode: 0o600 }); } catch {} }
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = refused ? 2 : 1;
}

if (!sidecarEnv.ok) {
  fail(new Error(sidecarEnv.error));
  process.exit(process.exitCode);
}

// Dynamic dist imports from the ACTIVE release (protocol code == live server).
const dist = (name) => import(`file://${ACTIVE_RELEASE_ROOT}/dist/${name}.js`);
const { loadConfig } = await dist("config");
const { CarrierBindingStore } = await dist("carrier-binding");
const { DurableOperationManager, DurableOperationStore, planCutoverStart } = await dist("durable-operations");
const { CutoverStateStore } = await dist("cutover-state");
const { bindCutoverActivation, verifyActivationBinding } = await dist("cutover-activation");
const { createBoundLaunchdRestartActuator } = await dist("cutover-restart");
const { probeBuildReady } = await dist("cutover-build-ready");
const { createWorkspaceStore } = await dist("workspace-store");
const { WorkspaceRegistry } = await dist("workspaces");
const { LocalAgentSessionManager } = await dist("local-agent-sessions");

async function health(config) {
  const url = `http://${config.host}:${config.port}/healthz`;
  const probe = async () => {
    // connection: close makes undici open a fresh socket, never a pooled one the server already closed.
    const response = await fetch(url, { redirect: "error", headers: { connection: "close" } });
    if (!response.ok) throw new Error(`healthz HTTP ${response.status}`);
    return await response.json();
  };
  const connectionLevel = (e) => e instanceof TypeError || ["ECONNRESET", "ECONNREFUSED"].includes(e?.code ?? e?.cause?.code);
  try {
    return await probe();
  } catch (error) {
    if (!connectionLevel(error)) throw error;
    await new Promise((r) => setTimeout(r, 500));
    return await probe();
  }
}

// Post-activation probe: up to 3 attempts, 1 s apart (the stage that aborted last time).
async function healthRetry(config, attempts = 3, spacingMs = 1000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await health(config); } catch (error) { lastError = error; if (i < attempts - 1) await sleep(spacingMs); }
  }
  throw lastError;
}

function drainEvidence(mcp) {
  const keys = [
    "activeSessions","oldestAgeMs","highWaterActiveSessions","registrations","reusedRequests",
    "idleCloses","capacityEvictions","capacityRejections","closeErrors","disposalCallbackErrors",
    "inFlightRequestCount","sessionsWithInFlight","sessionsPendingClose",
    "configuredMaxSessions","configuredIdleTimeoutMs"
  ];
  return Object.fromEntries(keys.map((key) => [key, mcp[key]]));
}

const config = loadConfig();
let bindings, manager, workspaceStore, agentManager;
try {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  const target = contract.cutover.expectedIdentity;
  const pair = contract.cutover.finish;

  // ---- Phase detection (read-only; nothing mutated before this decision) ----
  const file = new CutoverStateStore(config.stateDir).get();
  const before = await health(config);
  const liveIdentity = identityFromHealth(before);
  const liveIsOld = JSON.stringify(liveIdentity) === JSON.stringify(contract.cutover.currentIdentity);
  const liveIsTarget = matchesTarget(before, target)
    && before.mcp.serverInstanceId !== contract.cutover.currentIdentity.serverInstanceId;
  if (file && file.phase !== "closed") cutoverId = file.cutoverId;
  const mode = selectMode({ file, contract, liveIsOld, liveIsTarget }); // "full" | "resume_drain" | "resume_restart" | "resume_finish"
  log("phase_detected", { mode, activePhase: file?.phase ?? null, cutoverId: file?.cutoverId ?? null, liveIsOld, liveIsTarget });

  if (mode !== "resume_finish" && Date.parse(contract.cutover.expiresAt) <= Date.now()) {
    throw new Refuse("contract cutover.expiresAt has passed; regenerate contract (new attemptKey) or recover per runbook",
      file ? recoveryFor(file, liveIsOld, liveIsTarget) : "regenerate contract and pairing (m5-cutover.sh)");
  }

  bindings = new CarrierBindingStore(config.stateDir);
  const pending = bindings.pending(PENDING_ID);
  if (!pending.binding_id) throw new Error("approved pairing lost its carrier binding");
  const context = { clientId: pending.client_id, sessionId: pending.session_id };
  const carrier = bindings.redeem(context, { pendingId: PENDING_ID });
  log("carrier_redeemed", { carrierId: carrier.id, authorityVersion: carrier.authorityVersion });

  const originalStartupRecovery = DurableOperationStore.prototype.markInterruptedUnknown;
  DurableOperationStore.prototype.markInterruptedUnknown = function () { return 0; };
  try {
    manager = new DurableOperationManager(config, undefined, bindings.readers);
  } finally {
    DurableOperationStore.prototype.markInterruptedUnknown = originalStartupRecovery;
  }

  let stored;   // record carrying activationBinding
  let drainedEvidence;
  let replacement;

  if (mode === "full") {
    // Branch a: full lifecycle exactly as the original sidecar.
    if (!liveIsOld) throw new Error("live predecessor identity no longer matches approved contract");
    log("predecessor_verified", { serverInstanceId: liveIdentity.serverInstanceId, sourceCommit: liveIdentity.sourceCommit });

    const plan = planCutoverStart(config.stateDir, {
      attemptKey: contract.cutover.attemptKey,
      currentIdentity: contract.cutover.currentIdentity,
      expectedIdentity: contract.cutover.expectedIdentity,
      expiresAt: contract.cutover.expiresAt,
    });
    const lease = bindings.prepareEffect(context, plan.subject);
    log("cutover_prepared", { operationId: plan.operationId, requestHash: plan.requestHash, leaseId: lease.leaseId, leaseVersion: lease.version });

    const started = manager.startCutover(contract.cutover, context);
    if (started.status !== "succeeded" || !started.receipt?.cutoverId) {
      throw new Error("cutover_start did not produce a successful exact durable intent");
    }
    cutoverId = started.receipt.cutoverId;
    log("cutover_started", { cutoverId, operationId: started.operationId });
  }

  if (mode === "resume_drain") {
    cutoverId = file.cutoverId;
    log("resumed", { mode, cutoverId, phase: file.phase });
  }

  if (mode === "full" || mode === "resume_drain") {
    // Wait for in-flight work to finish. The server is in drain gating from cutover_start onwards, so new
    // consequential starts are already blocked; we only wait for existing requests. DRAIN_WAIT_MS (default
    // 10 min) bounds the wait; progress is logged every 30 s.
    const drainWaitMs = Number(process.env.DRAIN_WAIT_MS ?? 600000);
    const drainDeadline = Date.now() + drainWaitMs;
    let drainHealth;
    let lastProgress = 0;
    for (;;) {
      drainHealth = await healthRetry(config);
      const inFlight = drainHealth.mcp.inFlightRequestCount ?? 0;
      const withInFlight = drainHealth.mcp.sessionsWithInFlight ?? 0;
      if (inFlight === 0 && withInFlight === 0) break;
      if (Date.now() - lastProgress >= 30000) {
        log("drain_waiting", { inFlightRequestCount: inFlight, sessionsWithInFlight: withInFlight, activeSessions: drainHealth.mcp.activeSessions, remainingMs: Math.max(0, drainDeadline - Date.now()) });
        lastProgress = Date.now();
      }
      if (Date.now() >= drainDeadline) {
        throw new Error(`live transport did not reach zero in-flight requests within DRAIN_WAIT_MS=${drainWaitMs}; re-run to resume at drain`);
      }
      await sleep(2000);
    }
    const drained = manager.drainCutover(cutoverId, contract.cutover.currentIdentity, () => drainEvidence(drainHealth.mcp), context);
    drainedEvidence = drained.drainEvidence;
    log("cutover_drained", { activeSessions: drained.drainEvidence?.activeSessions, inFlightRequestCount: drained.drainEvidence?.inFlightRequestCount });

    if (!config.mcpCutoverBuildReadyRoot) throw new Error("mcpCutoverBuildReadyRoot is not configured");
    const activation = bindCutoverActivation({
      cutoverId,
      packageRoot: config.mcpCutoverBuildReadyRoot,
      serviceRoot: SERVICE_ROOT,
      expected: target,
    });
    const cutoverStore = new CutoverStateStore(config.stateDir);
    stored = cutoverStore.recordActivationBinding(cutoverId, activation).record;
    if (!stored.activationBinding) throw new Error("activation binding was not durably recorded");
    verifyActivationBinding(stored.activationBinding, SERVICE_ROOT);
    log("activation_bound", { releasePath: activation.releasePath, releaseSha256: activation.releaseSha256 });
  } else {
    cutoverId = file.cutoverId;
    stored = file;
    drainedEvidence = file.drainEvidence;
    log("resumed", { mode, cutoverId, phase: file.phase, releasePath: file.activationBinding.releasePath });
  }

  if (mode === "full" || mode === "resume_drain" || mode === "resume_restart") {
    // Branches a and b converge here: re-verify the binding, then the single launchd-self restart.
    verifyActivationBinding(stored.activationBinding, SERVICE_ROOT);
    const liveBeforeRestart = await healthRetry(config, 3, 1000);
    const actuator = createBoundLaunchdRestartActuator({
      livePid: liveBeforeRestart.build.pid,
      serviceLabel: contract.cutover.restart.serviceLabel,
      launchdTarget: contract.cutover.restart.launchdTarget,
      expectedStableServiceRoot: SERVICE_ROOT,
      verifyActivation: () => {
        const record = new CutoverStateStore(config.stateDir).get();
        if (!record?.activationBinding) throw new Error("activation binding disappeared before restart");
        verifyActivationBinding(record.activationBinding, SERVICE_ROOT);
      },
    });
    if (!actuator) throw new Error("launchd restart actuator could not bind the live stable service");

    const restart = await manager.restartCutover(
      cutoverId,
      contract.cutover.currentIdentity,
      contract.cutover.restart.buildReady,
      (expected) => probeBuildReady({ packageRoot: config.mcpCutoverBuildReadyRoot, expected }),
      actuator,
      context,
      stored.activationBinding,
    );
    log("restart_scheduled", { scheduled: restart.scheduled });
  }

  // Branches a, b, c: wait for the approved replacement (c passes on the first probe).
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const h = await health(config);
      if (matchesTarget(h, target) && h.mcp.serverInstanceId !== contract.cutover.currentIdentity.serverInstanceId) {
        replacement = h;
        break;
      }
    } catch {}
    await sleep(1000);
  }
  if (!replacement) throw new Error("replacement runtime failed to converge to approved target");
  const replacementIdentity = identityFromHealth(replacement);
  log("replacement_verified", { serverInstanceId: replacementIdentity.serverInstanceId, sourceCommit: replacementIdentity.sourceCommit });

  workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  agentManager = new LocalAgentSessionManager(config);
  const session = workspaceStore.getSession(pair.workspaceId);
  if (!session) throw new Error("witness workspace is missing from durable store");
  const record = agentManager.getRecordByPrefixOrId(pair.agentId);
  if (!record || record.id !== pair.agentId || record.workspaceId !== pair.workspaceId) {
    throw new Error("witness agent is not durably bound to the requested workspace");
  }
  const inspected = workspaces.inspectWorkspace(pair.workspaceId);
  const workspace = workspaces.getWorkspace(pair.workspaceId);
  const status = await agentManager.getAgentStatus({
    workspaceId: pair.workspaceId,
    workspaceRoot: workspace.root,
    agentId: pair.agentId,
    waitMs: 0,
  });
  if (status.agentId !== pair.agentId || (status.workspaceId !== undefined && status.workspaceId !== pair.workspaceId)) {
    throw new Error("witness agent status identity drifted");
  }
  const reconciled = await agentManager.reconcileAgent({
    workspaceId: pair.workspaceId,
    workspaceRoot: workspace.root,
    isolated: workspace.mode === "worktree",
    agentId: pair.agentId,
  });
  if (reconciled.agentId !== pair.agentId) throw new Error("witness reconciliation returned a different agent");
  const witness = {
    workspaceQueryable: true,
    agentQueryable: true,
    agentReconciled: true,
    witnessWorkspaceId: pair.workspaceId,
    witnessAgentId: pair.agentId,
    workspaceSessions: 1,
    agentSessions: 1,
    witnessWorkspaceSessions: 1,
    witnessAgentSessions: 1,
    witnessKind: "exact-pair",
    detail: [
      { unit: `workspace:${pair.workspaceId}`, ok: true, ...(inspected.loaded ? {} : { detail: "durable session present; registry not currently loaded" }) },
      { unit: `agent:${pair.agentId}@${pair.workspaceId}`, ok: true },
    ],
  };
  log("witness_reconciled", { workspaceId: pair.workspaceId, agentId: pair.agentId });

  const finished = await manager.finishCutover(
    cutoverId,
    replacementIdentity,
    pair,
    async () => witness,
    context,
  );
  if (finished.phase !== "closed") throw new Error("cutover did not close after positive replacement witness");
  log("cutover_finished", { cutoverId, phase: finished.phase });

  const receipt = {
    schema: "devspace.issue413.wave1_sidecar_receipt.v1",
    cutoverId,
    carrierId: carrier.id,
    authorityVersion: carrier.authorityVersion,
    target,
    replacementIdentity,
    activation: stored.activationBinding,
    drainEvidence: drainedEvidence,
    reconciliationReceipt: finished.reconciliationReceipt,
    completedAt: new Date().toISOString(),
    mode,
  };
  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, receiptPath: RECEIPT_PATH, cutoverId, mode, replacementIdentity, phase: finished.phase }, null, 2));
} catch (error) {
  fail(error);
} finally {
  try { agentManager?.close(); } catch {}
  try { workspaceStore?.close?.(); } catch {}
  try { manager?.close(); } catch {}
  try { bindings?.close(); } catch {}
}
