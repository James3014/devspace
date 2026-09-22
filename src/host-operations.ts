import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { terminateProcessTree } from "./process-platform.js";
import { redactSensitiveText } from "./sensitive-redaction.js";
import type { DurableOperationRecord, DurableOperationStore } from "./durable-operations.js";
import { bindHostOperation, prepareHostOperationSandbox, type HostOperationPolicy, type HostOperationRequest, type BoundHostOperation } from "./host-operation-policy.js";
import {
  bindHostActivation,
  hostActivationManifestPathFromArgv,
  preflightHostActivation,
  reconcileHostActivation,
  type BoundHostActivation,
  type HostActivationClassification,
  type HostActivationObservation,
} from "./host-activation.js";

export type HostOperationObservedPaths =
  | { status: "not_collected" }
  | { status: "collected"; activation: HostActivationObservation };

export interface HostOperationReceipt {
  operationId: string;
  attemptKey: string;
  executable: string;
  executableSha256: string;
  argvFingerprint: string;
  allowedPaths: string[];
  network: "none";
  process?: { pid: number; startTime: string; processGroup: number; command: string; argvFingerprint: string; groupOwned: boolean };
  outcome: "succeeded" | "running" | "failed" | "unknown";
  reconciliation: "not_required" | "required" | "complete";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  repository?: { preHead?: string; preDirty?: boolean; postHead?: string; postDirty?: boolean };
  effectTarget: "HOST_OPERATION";
  executor: { kind: "devspace_host_executor"; pid: number; provider: null; model: null; profile: null; session: null };
  observedPaths: HostOperationObservedPaths;
}

export class HostOperationError extends Error {
  constructor(readonly code: "HOST_OPERATION_DISABLED" | "HOST_OPERATION_INVALID" | "HOST_OPERATION_RECONCILIATION_REQUIRED", message: string) {
    super(message);
    this.name = "HostOperationError";
  }
}

export class HostOperationRegistrar {
  private disposed = false;
  private readonly pending = new Set<ChildProcess>();
  private readonly inFlight = new Map<string, Promise<DurableOperationRecord>>();
  private readonly policy: HostOperationPolicy;
  constructor(
    private readonly store: DurableOperationStore,
    policy: HostOperationPolicy,
    private readonly prepareSandbox: typeof prepareHostOperationSandbox = prepareHostOperationSandbox,
  ) { this.policy = Object.freeze({ ...policy, argv: Object.freeze([...policy.argv]), allowedPaths: Object.freeze({ write: Object.freeze([...policy.allowedPaths.write]), read: Object.freeze([...(policy.allowedPaths.read ?? [])]) }) }); }
  private readonly processes = new Map<string, { child: ChildProcess; pid: number; startTime: string; processGroup: number; command: string; argvFingerprint: string; executable: string; wallTimer: NodeJS.Timeout; idleTimer: NodeJS.Timeout; forceTimer?: NodeJS.Timeout; cancelRequested?: boolean; timedOut?: boolean }>();

  async preflight(input: Omit<HostOperationRequest, "clientId">, ownerClientId: string): Promise<Record<string, unknown>> {
    const bound = await this.bind(input, ownerClientId);
    const activation = await this.bindActivation(bound);
    const requestHash = activationRequestHash(bound.requestHash, activation);
    const activationObservation = activation ? await preflightHostActivation(activation) : undefined;
    return {
      status: activationObservation && activationObservation.classification !== "CONFIRMED_NO_EFFECT" ? "blocked" : "ready",
      operationId: bound.operationId,
      requestHash,
      executable: bound.request.executablePath,
      argvFingerprint: bound.argvFingerprint,
      allowedPaths: bound.request.allowedPaths.write,
      network: "none",
      limits: bound.limits,
      ...(activation ? { activation: { binding: activation, observation: activationObservation } } : {}),
    };
  }

  async start(input: Omit<HostOperationRequest, "clientId">, ownerClientId: string): Promise<DurableOperationRecord> {
    if (this.disposed) throw new HostOperationError("HOST_OPERATION_DISABLED", "Host operation registrar is shut down.");
    const bound = await this.bind(input, ownerClientId);
    const activation = await this.bindActivation(bound);
    if (this.disposed) throw new HostOperationError("HOST_OPERATION_DISABLED", "Host operation registrar is shut down.");
    const requestHash = activationRequestHash(bound.requestHash, activation);
    const durableRequest = activation
      ? { ...bound.request, activation, hostBinding: { executableSha256: bound.executableSha256, argvFingerprint: bound.argvFingerprint } }
      : bound.request;
    const operation = this.store.createOrReplay({ operationId: bound.operationId, attemptKey: input.attemptKey, requestHash, kind: "host_operation", authorityMode: "OWNER_DIRECT", scopeRoot: bound.scopeRoot, workspaceId: bound.request.workspaceId, request: durableRequest as unknown as Record<string, unknown> });
    if (!operation.created) {
      if (operation.record.status === "succeeded" || operation.record.status === "failed") return operation.record;
      const inFlight = this.inFlight.get(operation.record.operationId);
      if (inFlight) return inFlight;
      throw new HostOperationError("HOST_OPERATION_RECONCILIATION_REQUIRED", `Host operation ${operation.record.operationId} requires reconciliation before retry.`);
    }

    if (activation) {
      const before = await preflightHostActivation(activation);
      const allPre = before.targets.every((target) => target.state === "preimage");
      if (!allPre) {
        const classification: HostActivationClassification = before.classification === "PARTIAL_EFFECT"
          ? "PARTIAL_EFFECT"
          : before.classification === "BLOCKED_PREIMAGE_DRIFT"
            ? "BLOCKED_PREIMAGE_DRIFT"
            : "EFFECT_UNKNOWN";
        return this.finishActivation(bound.operationId, operation.record, activationReceipt(bound, { ...before, classification, changedByOperation: false }));
      }
    }

    const work = (async () => {
      let receipt: HostOperationReceipt;
      try {
        receipt = await this.execute(bound, activation);
      } catch (error) {
        if (activation) {
          try {
            const observed = await reconcileHostActivation(activation, bound.operationId);
            return this.finishActivation(bound.operationId, this.require(bound.operationId), activationReceipt(bound, observed), error instanceof Error ? error.message : String(error));
          } catch (reconcileError) {
            return this.store.finishHostOperation(bound.operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: reconcileError instanceof Error ? reconcileError.message : String(reconcileError) });
          }
        }
        return this.store.finishHostOperation(bound.operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: error instanceof Error ? error.message : String(error) });
      }
      if (receipt.outcome === "running") {
        this.store.recordHostOperationReceipt(bound.operationId, receipt as unknown as Record<string, unknown>);
        return this.require(bound.operationId);
      }
      if (activation) {
        try {
          const observed = await reconcileHostActivation(activation, bound.operationId);
          return this.finishActivation(bound.operationId, this.require(bound.operationId), { ...receipt, observedPaths: { status: "collected", activation: observed }, outcome: activationOutcome(observed.classification), reconciliation: "complete" });
        } catch (error) {
          return this.store.finishHostOperation(bound.operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: error instanceof Error ? error.message : String(error), receipt: receipt as unknown as Record<string, unknown> });
        }
      }
      return this.store.finishHostOperation(bound.operationId, { status: receipt.outcome === "succeeded" ? "succeeded" : "failed", retrySafe: false, receipt: receipt as unknown as Record<string, unknown> });
    })();
    this.inFlight.set(bound.operationId, work);
    try { return await work; } finally { this.inFlight.delete(bound.operationId); }
  }

  status(operationId: string, ownerClientId: string): DurableOperationRecord {
    return this.requireOwned(operationId, ownerClientId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const owned = [...this.processes.entries()];
    for (const [operationId, proc] of owned) {
      proc.cancelRequested = true;
      clearTimeout(proc.wallTimer);
      clearTimeout(proc.idleTimer);
      if (proc.forceTimer) clearTimeout(proc.forceTimer);
      terminateProcessTree(proc.child, "SIGTERM", globalThis.process.platform !== "win32");
      if (!await waitForExit(proc.child, 500)) {
        terminateProcessTree(proc.child, "SIGKILL", globalThis.process.platform !== "win32");
        await waitForExit(proc.child, 500);
      }
      this.processes.delete(operationId);
    }
    for (const child of this.pending) {
      terminateProcessTree(child, "SIGTERM", globalThis.process.platform !== "win32");
      if (!await waitForExit(child, 500)) {
        terminateProcessTree(child, "SIGKILL", globalThis.process.platform !== "win32");
        await waitForExit(child, 500);
      }
    }
    this.pending.clear();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  async reconcile(operationId: string, ownerClientId: string): Promise<DurableOperationRecord> {
    const record = this.requireOwned(operationId, ownerClientId);
    if (record.kind !== "host_operation") throw new HostOperationError("HOST_OPERATION_INVALID", "Operation is not a host operation.");
    if (record.status === "succeeded" || record.status === "failed") return record;
    const activation = activationBindingFromRecord(record);
    if (record.status === "started") {
      const owned = this.processes.get(operationId);
      if (owned && await this.isSameProcess(owned)) return record;
    }
    if (activation) {
      try {
        const observed = await reconcileHostActivation(activation, operationId);
        const receipt = activationReceiptFromRecord(record, observed);
        return this.finishActivation(operationId, record, receipt);
      } catch (error) {
        return this.finishUnknown(record, error instanceof Error ? error.message : String(error));
      }
    }
    if (record.status === "started") {
      // A replacement registrar has no live ChildProcess ownership. Persisted
      // PID/start/group data is diagnostic only and cannot authorize adoption
      // or cancellation after restart.
      return this.store.finishHostOperation(operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: "Physical host process state is unknown; reconcile before retry." });
    }
    return record;
  }

  async cancel(operationId: string, ownerClientId: string): Promise<DurableOperationRecord> {
    const record = this.requireOwned(operationId, ownerClientId);
    if (record.kind !== "host_operation") throw new HostOperationError("HOST_OPERATION_INVALID", "Operation is not a host operation.");
    const owned = this.processes.get(operationId);
    if (!owned || !await this.isSameProcess(owned)) throw new HostOperationError("HOST_OPERATION_RECONCILIATION_REQUIRED", "Cancellation requires a live exact process identity.");
    owned.cancelRequested = true;
    terminateProcessTree(owned.child, "SIGTERM", process.platform !== "win32");
    const exited = await waitForExit(owned.child, 1_000);
    if (!exited) {
      terminateProcessTree(owned.child, "SIGKILL", process.platform !== "win32");
      if (!await waitForExit(owned.child, 1_000)) throw new HostOperationError("HOST_OPERATION_RECONCILIATION_REQUIRED", "Owned process did not terminate after bounded cancellation.");
    }
    clearTimeout(owned.wallTimer);
    clearTimeout(owned.idleTimer);
    if (owned.forceTimer) clearTimeout(owned.forceTimer);
    this.processes.delete(operationId);
    return this.store.finishHostOperation(operationId, { status: "failed", retrySafe: false, errorCode: "CANCELLED", errorMessage: "Owned host process cancelled.", receipt: { ...record.receipt, outcome: "failed", reconciliation: "complete", signal: "SIGTERM" } });
  }

  private require(operationId: string): DurableOperationRecord {
    const record = this.store.getByOperationId(operationId);
    if (!record) throw new HostOperationError("HOST_OPERATION_INVALID", `Unknown host operation: ${operationId}`);
    return record;
  }

  private requireOwned(operationId: string, ownerClientId: string): DurableOperationRecord {
    const record = this.require(operationId);
    if (!this.policy.enabled || ownerClientId !== this.policy.ownerClientId || record.kind !== "host_operation" || record.request.clientId !== ownerClientId) throw new HostOperationError("HOST_OPERATION_INVALID", "Host operation is owned by a different authenticated client.");
    return record;
  }

  private async bind(input: Omit<HostOperationRequest, "clientId">, ownerClientId: string) {
    return bindHostOperation(this.policy, { ...input, clientId: ownerClientId }, ownerClientId);
  }

  private async bindActivation(bound: BoundHostOperation): Promise<BoundHostActivation | undefined> {
    const manifestPath = hostActivationManifestPathFromArgv(bound.request.argv);
    if (!manifestPath) return undefined;
    if (bound.request.allowLongLivedProcess) throw new HostOperationError("HOST_OPERATION_INVALID", "Host activation operations cannot be long-lived.");
    try {
      return await bindHostActivation(manifestPath, bound.request.allowedPaths.write, bound.request.allowedPaths.read ?? []);
    } catch (error) {
      throw new HostOperationError("HOST_OPERATION_INVALID", error instanceof Error ? error.message : String(error));
    }
  }

  private finishActivation(operationId: string, record: DurableOperationRecord, receipt: HostOperationReceipt, detail?: string): DurableOperationRecord {
    const classification = receipt.observedPaths.status === "collected" ? receipt.observedPaths.activation.classification : "EFFECT_UNKNOWN";
    const patch = activationFinishPatch(classification, receipt, detail);
    if (record.status === "started") return this.store.finishHostOperation(operationId, patch);
    if (record.status === "outcome_unknown") return this.store.finish(operationId, patch);
    return record;
  }

  private finishUnknown(record: DurableOperationRecord, message: string): DurableOperationRecord {
    const patch = { status: "outcome_unknown" as const, retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: message };
    return record.status === "started" ? this.store.finishHostOperation(record.operationId, patch) : this.store.finish(record.operationId, patch);
  }

  private async execute(bound: BoundHostOperation, activation?: BoundHostActivation): Promise<HostOperationReceipt> {
    const wrapped = await this.prepareSandbox(bound);
    if (this.disposed) throw new HostOperationError("HOST_OPERATION_DISABLED", "Host operation registrar is shut down.");
    const repositoryPre = captureRepositoryWitness(bound.request.workspaceRoot);
    const receiptMeta = { effectTarget: "HOST_OPERATION" as const, executor: { kind: "devspace_host_executor" as const, pid: process.pid, provider: null, model: null, profile: null, session: null }, observedPaths: { status: "not_collected" as const } };
    const env = activation
      ? {
        ...wrapped.env,
        DEVSPACE_HOST_OPERATION_ID: bound.operationId,
        DEVSPACE_HOST_ACTIVATION_MANIFEST_SHA256: activation.manifestSha256,
        DEVSPACE_HOST_ACTIVATION_WRITE_PATHS: JSON.stringify(bound.request.allowedPaths.write),
        DEVSPACE_HOST_ACTIVATION_READ_PATHS: JSON.stringify(bound.request.allowedPaths.read ?? []),
      }
      : wrapped.env;
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), { cwd: bound.request.cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.pending.add(child);
    child.on("error", () => { /* execute/reconcile reports the durable unknown outcome */ });
    let childExited = false;
    child.once("exit", () => { childExited = true; });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8").slice(0, 8_192 - stderr.length); });
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutTriggered = false;
    const timeout = () => {
      if (timeoutTriggered) return;
      timeoutTriggered = true;
      timedOut = true;
      terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
      forceTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL", process.platform !== "win32"), 1_000);
      const current = this.processes.get(bound.operationId);
      if (current) current.forceTimer = forceTimer;
    };
    const wallTimer = setTimeout(timeout, bound.limits.maxWallMs);
    let idleTimer = setTimeout(timeout, bound.limits.maxIdleMs);
    const resetIdle = () => {
      if (timeoutTriggered) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(timeout, bound.limits.maxIdleMs);
      const current = this.processes.get(bound.operationId);
      if (current) current.idleTimer = idleTimer;
    };
    child.stdout?.on("data", resetIdle);
    child.stderr?.on("data", resetIdle);
    let physical: { pid: number; startTime: string; processGroup: number; command: string } | undefined;
    if (bound.limits.allowLongLivedProcess) {
      const identityTimer = setTimeout(() => terminateProcessTree(child, "SIGTERM", process.platform !== "win32"), Math.min(bound.limits.maxWallMs, bound.limits.maxIdleMs));
      try {
        physical = await readProcessIdentity(child.pid!, bound.request.executablePath);
        if (childExited) throw new HostOperationError("HOST_OPERATION_RECONCILIATION_REQUIRED", "Host process exited before ownership could be established.");
      } catch (error) {
        clearTimeout(identityTimer); clearTimeout(wallTimer); clearTimeout(idleTimer); if (forceTimer) clearTimeout(forceTimer); this.pending.delete(child);
        terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
        if (!await waitForExit(child, 500)) terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
        const detail = redactSensitiveText(stderr.trim()).slice(0, 8_192);
        throw new HostOperationError("HOST_OPERATION_RECONCILIATION_REQUIRED", `${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ""}`);
      }
      clearTimeout(identityTimer);
    }
    const processIdentity = physical ? { ...physical, argvFingerprint: bound.argvFingerprint, groupOwned: process.platform !== "win32" } : undefined;
    const receiptProcess = processIdentity ? { ...processIdentity, command: redactSensitiveText(processIdentity.command).slice(0, 8_192) } : undefined;
    if (bound.limits.allowLongLivedProcess) {
      this.processes.set(bound.operationId, { child, ...physical!, argvFingerprint: bound.argvFingerprint, executable: bound.request.executablePath, wallTimer, idleTimer, forceTimer });
      this.pending.delete(child);
      child.once("exit", (code, signal) => {
        clearTimeout(wallTimer); clearTimeout(idleTimer); if (forceTimer) clearTimeout(forceTimer);
        const current = this.processes.get(bound.operationId);
        this.processes.delete(bound.operationId);
        this.pending.delete(child);
        const cancelled = current?.cancelRequested === true;
        this.store.finishHostOperation(bound.operationId, { status: code === 0 && !cancelled && !timedOut ? "succeeded" : "failed", retrySafe: false, errorCode: cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : undefined, errorMessage: cancelled ? "Owned host process cancelled." : timedOut ? "Host operation exceeded its configured time limit." : undefined, receipt: { ...receiptMeta, operationId: bound.operationId, attemptKey: bound.attemptKey, executable: bound.executable, executableSha256: bound.executableSha256, argvFingerprint: bound.argvFingerprint, allowedPaths: bound.allowedPaths, network: "none", process: receiptProcess, outcome: code === 0 && !cancelled && !timedOut ? "succeeded" : "failed", reconciliation: "complete", exitCode: code, signal: signal ?? (cancelled || timedOut ? "SIGTERM" : null), repository: { ...repositoryPre, ...captureRepositoryWitness(bound.request.workspaceRoot, "post") } } });
      });
      return { ...receiptMeta, operationId: bound.operationId, attemptKey: bound.request.attemptKey, executable: bound.request.executablePath, executableSha256: bound.executableSha256, argvFingerprint: bound.argvFingerprint, allowedPaths: [...bound.request.allowedPaths.write], network: "none", process: receiptProcess!, outcome: "running", reconciliation: "required", repository: repositoryPre };
    }
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => { child.once("error", error => { clearTimeout(wallTimer); clearTimeout(idleTimer); if (forceTimer) clearTimeout(forceTimer); this.pending.delete(child); reject(error); }); child.once("exit", (code, signal) => { clearTimeout(wallTimer); clearTimeout(idleTimer); if (forceTimer) clearTimeout(forceTimer); resolveExit({ code, signal }); }); });
    this.pending.delete(child);
    return { ...receiptMeta, operationId: bound.operationId, attemptKey: bound.request.attemptKey, executable: bound.request.executablePath, executableSha256: bound.executableSha256, argvFingerprint: bound.argvFingerprint, allowedPaths: [...bound.request.allowedPaths.write], network: "none", outcome: exit.code === 0 && !timedOut ? "succeeded" : "failed", reconciliation: "complete", exitCode: exit.code, signal: exit.signal ?? (timedOut ? "SIGTERM" : null), repository: { ...repositoryPre, ...captureRepositoryWitness(bound.request.workspaceRoot, "post") } };
  }

  private async isSameProcess(processInfo: { pid: number; startTime: string; processGroup: number; command: string; argvFingerprint: string; executable: string }): Promise<boolean> {
    try {
      process.kill(processInfo.pid, 0);
      const current = await readProcessIdentity(processInfo.pid, processInfo.executable);
      return current.startTime === processInfo.startTime && current.processGroup === processInfo.processGroup && current.command === processInfo.command;
    } catch { return false; }
  }
}

function activationRequestHash(hostRequestHash: string, activation: BoundHostActivation | undefined): string {
  if (!activation) return hostRequestHash;
  return createHash("sha256").update(JSON.stringify({ hostRequestHash, activationManifestSha256: activation.manifestSha256, activationKind: activation.kind })).digest("hex");
}

function activationBindingFromRecord(record: DurableOperationRecord): BoundHostActivation | undefined {
  const value = record.request.activation;
  if (!value || typeof value !== "object") return undefined;
  const activation = value as Partial<BoundHostActivation>;
  if (typeof activation.manifestPath !== "string" || typeof activation.manifestSha256 !== "string" || typeof activation.kind !== "string" || typeof activation.receiptDir !== "string" || !Array.isArray(activation.targets)) return undefined;
  return activation as BoundHostActivation;
}

function activationReceipt(bound: BoundHostOperation, observed: HostActivationObservation): HostOperationReceipt {
  return {
    operationId: bound.operationId,
    attemptKey: bound.attemptKey,
    executable: bound.executable,
    executableSha256: bound.executableSha256,
    argvFingerprint: bound.argvFingerprint,
    allowedPaths: [...bound.allowedPaths],
    network: "none",
    outcome: activationOutcome(observed.classification),
    reconciliation: "complete",
    effectTarget: "HOST_OPERATION",
    executor: { kind: "devspace_host_executor", pid: process.pid, provider: null, model: null, profile: null, session: null },
    observedPaths: { status: "collected", activation: observed },
  };
}

function activationReceiptFromRecord(record: DurableOperationRecord, observed: HostActivationObservation): HostOperationReceipt {
  const existing = (record.receipt ?? {}) as Partial<HostOperationReceipt>;
  const request = record.request as unknown as HostOperationRequest & { hostBinding?: { executableSha256?: string; argvFingerprint?: string } };
  return {
    operationId: record.operationId,
    attemptKey: record.attemptKey,
    executable: existing.executable ?? request.executablePath,
    executableSha256: existing.executableSha256 ?? request.hostBinding?.executableSha256 ?? "unknown",
    argvFingerprint: existing.argvFingerprint ?? request.hostBinding?.argvFingerprint ?? "unknown",
    allowedPaths: existing.allowedPaths ?? [...(request.allowedPaths?.write ?? [])],
    network: "none",
    process: existing.process,
    outcome: activationOutcome(observed.classification),
    reconciliation: "complete",
    exitCode: existing.exitCode,
    signal: existing.signal,
    repository: existing.repository,
    effectTarget: "HOST_OPERATION",
    executor: existing.executor ?? { kind: "devspace_host_executor", pid: process.pid, provider: null, model: null, profile: null, session: null },
    observedPaths: { status: "collected", activation: observed },
  };
}

function activationOutcome(classification: HostActivationClassification): HostOperationReceipt["outcome"] {
  if (classification === "APPLIED") return "succeeded";
  if (classification === "PARTIAL_EFFECT" || classification === "EFFECT_UNKNOWN") return "unknown";
  return "failed";
}

function activationFinishPatch(classification: HostActivationClassification, receipt: HostOperationReceipt, detail?: string): Parameters<DurableOperationStore["finish"]>[1] {
  if (classification === "APPLIED") return { status: "succeeded", retrySafe: false, receipt: receipt as unknown as Record<string, unknown> };
  if (classification === "PARTIAL_EFFECT" || classification === "EFFECT_UNKNOWN") {
    return { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: detail ?? `Host activation physical state is ${classification}.`, receipt: receipt as unknown as Record<string, unknown> };
  }
  const errorCode = classification === "BLOCKED_PREIMAGE_DRIFT" ? "BLOCKED_PREIMAGE_DRIFT" : classification === "ROLLED_BACK" ? "HOST_ACTIVATION_ROLLED_BACK" : "HOST_ACTIVATION_CONFIRMED_NO_EFFECT";
  return { status: "failed", retrySafe: false, errorCode, errorMessage: detail ?? `Host activation ended as ${classification}.`, receipt: receipt as unknown as Record<string, unknown> };
}

function captureRepositoryWitness(workspaceRoot: string | undefined, phase?: "post"): { preHead?: string; preDirty?: boolean; postHead?: string; postDirty?: boolean } {
  if (!workspaceRoot) return {};
  try {
    const head = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).length > 0;
    return phase === "post" ? { postHead: head, postDirty: dirty } : { preHead: head, preDirty: dirty };
  } catch { return {}; }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once("exit", onExit);
  });
}

async function readProcessIdentity(pid: number, executable: string): Promise<{ pid: number; startTime: string; processGroup: number; command: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const startTime = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
      const processGroup = Number(execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).trim());
      const commandName = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
      // `comm` identifies the executable currently running after a shell
      // wrapper has performed exec; command is retained only as an observed
      // diagnostic, never as the authority identity.
      if (startTime && Number.isSafeInteger(processGroup) && commandName === executable) return { pid, startTime, processGroup, command };
    } catch { /* process may not be observable yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new HostOperationError("HOST_OPERATION_RECONCILIATION_REQUIRED", `Process ${pid} identity could not be observed.`);
}
