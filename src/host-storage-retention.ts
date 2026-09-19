import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DurableOperationRecord } from "./durable-operations.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import { safeWorkspaceRefSegment } from "./git.js";
import { isPathInsideRoot } from "./roots.js";
import type { WorkspaceConversationBinding, WorkspaceSession } from "./workspace-store.js";

const execFileAsync = promisify(execFile);

export const HOST_STORAGE_RETENTION_SCHEMA = "devspace.host_storage_retention.v1" as const;
export const HOST_STORAGE_BROWSER_MARKER_SCHEMA = "devspace.storage_artifact.v1" as const;
export const DEFAULT_RELEASE_KEEP_COUNT = 3;
export const DEFAULT_WORKTREE_GRACE_MS = 24 * 60 * 60 * 1000;

export type StorageArtifactKind =
  | "managed_worktree"
  | "workspace_record"
  | "workspace_checkout"
  | "managed_clone"
  | "release"
  | "browser_runtime";

export type StorageLifecycle =
  | "ACTIVE"
  | "PINNED"
  | "TERMINAL_BUT_RETAINED"
  | "GC_ELIGIBLE"
  | "UNKNOWN"
  | "FOREIGN";

export interface HostStorageArtifact {
  id: string;
  kind: StorageArtifactKind;
  path: string;
  lifecycle: StorageLifecycle;
  reason: string;
  sizeBytes: number;
  modifiedAt?: string;
  workspaceId?: string;
  sourceRoot?: string;
  ownershipRoot?: string;
  ownershipEvidence?: string;
  blockers?: string[];
  disposition?: "RETAIN" | "DELETE" | "RECONCILE" | "NOT_OWNED";
  lastUseAt?: string;
  ageMs?: number;
}

export interface HostStoragePlan {
  schema: typeof HOST_STORAGE_RETENTION_SCHEMA;
  planId: string;
  generatedAt: string;
  reclaimableBytes: number;
  artifacts: HostStorageArtifact[];
}

export interface HostStorageApplyResult {
  schema: typeof HOST_STORAGE_RETENTION_SCHEMA;
  planId: string;
  reclaimedBytes: number;
  removed: Array<{ id: string; kind: StorageArtifactKind; path: string; bytes: number }>;
  skipped: Array<{ id: string; kind: StorageArtifactKind; path: string; reason: string }>;
}

export interface HostStorageRetentionInput {
  stateDir: string;
  worktreeRoot: string;
  packageRoot: string;
  workspaceSessions: WorkspaceSession[];
  conversationBindings: WorkspaceConversationBinding[];
  loadedWorkspaceIds: Set<string>;
  agentRecords: LocalAgentRecord[];
  processWorkspaceStates: Map<string, "ACTIVE" | "UNKNOWN">;
  durableOperations: DurableOperationRecord[];
  allowedRoots: string[];
  activeSourceCommit?: string;
  nowMs?: number;
  releaseKeepCount?: number;
  worktreeGraceMs?: number;
}

interface BrowserMarker {
  schema: typeof HOST_STORAGE_BROWSER_MARKER_SCHEMA;
  owner: "devspace";
  kind: "browser_runtime";
  lifecycle: "active" | "terminal";
}

export async function buildHostStoragePlan(input: HostStorageRetentionInput): Promise<HostStoragePlan> {
  const nowMs = input.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const artifacts = [
    ...(await inspectWorkspaces(input)),
    ...(await inspectWorkspaceRecords(input)),
    ...(await inspectManagedClones(input)),
    ...(await inspectReleases(input)),
    ...(await inspectBrowserRuntimes(input)),
  ]
    .map((artifact) => decorateArtifact(artifact, nowMs))
    .sort((a, b) => (a.kind + ":" + a.path).localeCompare(b.kind + ":" + b.path));
  const reclaimableBytes = artifacts
    .filter((artifact) => artifact.lifecycle === "GC_ELIGIBLE")
    .reduce((total, artifact) => total + artifact.sizeBytes, 0);

  return {
    schema: HOST_STORAGE_RETENTION_SCHEMA,
    planId: hashPlan(artifacts),
    generatedAt,
    reclaimableBytes,
    artifacts,
  };
}

export interface HostStorageApplyCallbacks {
  deleteWorkspaceSession: (workspaceId: string) => void;
  assertWorkspaceSessionUnloaded?: (workspaceId: string) => void;
  assertPathUnreferenced?: (path: string) => void;
}

interface HostStorageApplyJournal extends HostStorageApplyResult {
  journalSchema: "devspace.host_storage_gc_journal.v1";
  status: "applying" | "reconciliation_required" | "completed";
  currentArtifactId?: string;
  updatedAt: string;
}

export async function applyHostStoragePlan(
  input: HostStorageRetentionInput,
  expectedPlanId: string,
  callbacks: HostStorageApplyCallbacks,
): Promise<HostStorageApplyResult> {
  const existing = await readApplyJournal(input.stateDir, expectedPlanId);
  if (existing.state === "corrupt") {
    throw new Error(
      `STORAGE_RECONCILIATION_REQUIRED: GC receipt for ${expectedPlanId} is unreadable; reconcile physical state before another apply.`,
    );
  }
  if (existing.state === "valid") {
    if (existing.journal.status === "completed") return journalResult(existing.journal);
    throw new Error(
      `STORAGE_RECONCILIATION_REQUIRED: GC plan ${expectedPlanId} was interrupted while ${existing.journal.currentArtifactId ?? "preparing cleanup"}; reconcile physical state before another apply.`,
    );
  }

  const fresh = await buildHostStoragePlan(input);
  if (fresh.planId !== expectedPlanId) {
    throw new Error(
      `STORAGE_PLAN_STALE: expected ${expectedPlanId}, current inventory is ${fresh.planId}; run storage_inventory again.`,
    );
  }

  const journal: HostStorageApplyJournal = {
    journalSchema: "devspace.host_storage_gc_journal.v1",
    schema: HOST_STORAGE_RETENTION_SCHEMA,
    planId: fresh.planId,
    status: "applying",
    reclaimedBytes: 0,
    removed: [],
    skipped: fresh.artifacts
      .filter((artifact) => artifact.lifecycle !== "GC_ELIGIBLE")
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        reason: artifact.reason,
      })),
    updatedAt: new Date().toISOString(),
  };
  await claimApplyJournal(input.stateDir, journal);

  for (const artifact of fresh.artifacts) {
    if (artifact.lifecycle !== "GC_ELIGIBLE") continue;

    journal.currentArtifactId = artifact.id;
    journal.updatedAt = new Date().toISOString();
    await writeApplyJournal(input.stateDir, journal);

    try {
      if (artifact.kind === "managed_worktree") {
        if (!artifact.workspaceId || !artifact.sourceRoot) {
          throw new Error("managed worktree inventory is missing workspace/source identity");
        }
        callbacks.assertWorkspaceSessionUnloaded?.(artifact.workspaceId);
        await removeManagedWorktreeArtifact(artifact);
        callbacks.deleteWorkspaceSession(artifact.workspaceId);
      } else if (artifact.kind === "workspace_record") {
        if (!artifact.workspaceId) {
          throw new Error("workspace record inventory is missing workspace identity");
        }
        callbacks.assertWorkspaceSessionUnloaded?.(artifact.workspaceId);
        await removeWorkspaceReviewRefs(artifact);
        callbacks.deleteWorkspaceSession(artifact.workspaceId);
      } else if (artifact.kind === "managed_clone") {
        callbacks.assertPathUnreferenced?.(artifact.path);
        await removeOwnedDirectory(artifact.path, artifact.ownershipRoot);
      } else if (artifact.kind === "release" || artifact.kind === "browser_runtime") {
        await removeOwnedDirectory(artifact.path, artifact.ownershipRoot);
      } else {
        throw new Error("user-owned checkout directories are never DevSpace deletion targets");
      }

      journal.removed.push({
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        bytes: artifact.sizeBytes,
      });
      journal.reclaimedBytes += artifact.sizeBytes;
      delete journal.currentArtifactId;
      journal.updatedAt = new Date().toISOString();
      await writeApplyJournal(input.stateDir, journal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      journal.status = "reconciliation_required";
      journal.skipped.push({
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        reason: `apply_failed:${message}`,
      });
      journal.updatedAt = new Date().toISOString();
      await writeApplyJournal(input.stateDir, journal);
      throw new Error(
        `STORAGE_RECONCILIATION_REQUIRED: cleanup for ${artifact.id} may have partially applied: ${message}`,
      );
    }
  }

  journal.status = "completed";
  delete journal.currentArtifactId;
  journal.updatedAt = new Date().toISOString();
  await writeApplyJournal(input.stateDir, journal);
  return journalResult(journal);
}

function journalResult(journal: HostStorageApplyJournal): HostStorageApplyResult {
  return {
    schema: journal.schema,
    planId: journal.planId,
    reclaimedBytes: journal.reclaimedBytes,
    removed: journal.removed,
    skipped: journal.skipped,
  };
}

async function readApplyJournal(
  stateDir: string,
  planId: string,
): Promise<
  | { state: "absent" }
  | { state: "corrupt" }
  | { state: "valid"; journal: HostStorageApplyJournal }
> {
  const path = applyReceiptPath(stateDir, planId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "corrupt" };
  }

  try {
    const value = JSON.parse(raw) as Partial<HostStorageApplyJournal>;
    if (
      value.journalSchema !== "devspace.host_storage_gc_journal.v1" ||
      value.schema !== HOST_STORAGE_RETENTION_SCHEMA ||
      value.planId !== planId ||
      !["applying", "reconciliation_required", "completed"].includes(String(value.status)) ||
      !Array.isArray(value.removed) ||
      !Array.isArray(value.skipped) ||
      typeof value.reclaimedBytes !== "number" ||
      typeof value.updatedAt !== "string"
    ) {
      return { state: "corrupt" };
    }
    return { state: "valid", journal: value as HostStorageApplyJournal };
  } catch {
    return { state: "corrupt" };
  }
}

async function claimApplyJournal(stateDir: string, journal: HostStorageApplyJournal): Promise<void> {
  const path = applyReceiptPath(stateDir, journal.planId);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(journal, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        `STORAGE_RECONCILIATION_REQUIRED: GC plan ${journal.planId} was claimed concurrently; read its receipt before another apply.`,
      );
    }
    throw error;
  }
}

async function writeApplyJournal(stateDir: string, journal: HostStorageApplyJournal): Promise<void> {
  const path = applyReceiptPath(stateDir, journal.planId);
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(journal, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, path);
}

function applyReceiptPath(stateDir: string, planId: string): string {
  const digest = planId.replace(/^sha256:/u, "");
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("Invalid storage plan id.");
  return join(resolve(stateDir), "host-storage-retention", "receipts", digest + ".json");
}

async function inspectWorkspaces(input: HostStorageRetentionInput): Promise<HostStorageArtifact[]> {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.worktreeGraceMs ?? DEFAULT_WORKTREE_GRACE_MS;
  const canonicalWorktreeRoot = await canonicalPath(input.worktreeRoot);
  const artifacts: HostStorageArtifact[] = [];

  for (const session of input.workspaceSessions) {
    const kind: StorageArtifactKind =
      session.mode === "worktree" && session.managed ? "managed_worktree" : "workspace_checkout";
    const path = resolve(session.root);
    const base = {
      id: `workspace:${session.id}`,
      kind,
      path,
      sizeBytes: await directorySize(path),
      workspaceId: session.id,
      lastUseAt: session.lastUsedAt,
      ...(session.sourceRoot ? { sourceRoot: resolve(session.sourceRoot) } : {}),
    };

    if (kind === "workspace_checkout") {
      artifacts.push({
        ...base,
        lifecycle: "FOREIGN",
        reason: "checkout path is user-owned and is never a DevSpace deletion target",
        ownershipEvidence: "physical checkout was supplied by the user; only its DevSpace session record is owned",
      });
      continue;
    }

    const canonicalWorktreePath = await canonicalPath(path);
    if (!isPathInsideRoot(canonicalWorktreePath, canonicalWorktreeRoot)) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        lifecycle: "FOREIGN",
        reason: "managed-worktree record resolves outside configured worktreeRoot",
        ownershipEvidence: "canonical containment check failed",
      });
      continue;
    }

    if (!session.sourceRoot) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        lifecycle: "UNKNOWN",
        reason: "managed worktree lacks source repository identity",
      });
      continue;
    }

    const canonicalSourceRoot = await canonicalPath(session.sourceRoot);
    if (!(await pathInsideAnyCanonicalRoot(canonicalSourceRoot, input.allowedRoots))) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: "FOREIGN",
        reason: "managed worktree source repository resolves outside configured allowed roots",
        ownershipEvidence: "source repository authority is outside DevSpace allowed roots",
      });
      continue;
    }

    const reference = workspaceReferenceState(session.id, input);
    if (reference) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: reference.lifecycle,
        reason: reference.reason,
      });
      continue;
    }

    const gitState = await inspectGitWorktree(canonicalWorktreePath, canonicalSourceRoot);
    if (gitState.state === "unknown") {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: "UNKNOWN",
        reason: gitState.reason,
      });
      continue;
    }
    if (gitState.dirty) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed worktree has uncommitted/untracked changes",
      });
      continue;
    }

    if (!session.baseSha) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: "UNKNOWN",
        reason: "managed worktree lacks its opening base commit identity",
      });
      continue;
    }
    if (gitState.head !== session.baseSha) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed worktree contains committed HEAD state that differs from its opening base commit",
      });
      continue;
    }

    const lastUsedMs = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(lastUsedMs) || nowMs - lastUsedMs < graceMs) {
      artifacts.push({
        ...base,
        path: canonicalWorktreePath,
        sourceRoot: canonicalSourceRoot,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed worktree is clean/unreferenced but still inside the retention grace window",
      });
      continue;
    }

    artifacts.push({
      ...base,
      path: canonicalWorktreePath,
      sourceRoot: canonicalSourceRoot,
      ownershipRoot: canonicalWorktreeRoot,
      lifecycle: "GC_ELIGIBLE",
      reason: "DevSpace-owned managed worktree is unloaded, unbound, process-free, agent-terminal, clean, unchanged from its base commit, and past grace",
      ownershipEvidence: "durable managed-worktree session plus canonical containment in configured worktreeRoot",
    });
  }
  return artifacts;
}

async function inspectWorkspaceRecords(input: HostStorageRetentionInput): Promise<HostStorageArtifact[]> {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.worktreeGraceMs ?? DEFAULT_WORKTREE_GRACE_MS;
  const artifacts: HostStorageArtifact[] = [];
  for (const session of input.workspaceSessions) {
    if (session.mode !== "checkout" || session.managed) continue;
    const reference = workspaceReferenceState(session.id, input);
    const base: HostStorageArtifact = {
      id: `workspace-record:${session.id}`,
      kind: "workspace_record",
      path: resolve(session.root),
      workspaceId: session.id,
      sourceRoot: resolve(session.root),
      sizeBytes: 0,
      lifecycle: "UNKNOWN",
      reason: "workspace record state has not been classified",
      lastUseAt: session.lastUsedAt,
      ownershipEvidence: "DevSpace durable workspace/session row; physical checkout remains user-owned",
    };
    if (reference) {
      artifacts.push({ ...base, lifecycle: reference.lifecycle, reason: reference.reason });
      continue;
    }
    const lastUsedMs = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(lastUsedMs) || nowMs - lastUsedMs < graceMs) {
      artifacts.push({
        ...base,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "unreferenced checkout session metadata is still inside the retention grace window",
      });
      continue;
    }
    artifacts.push({
      ...base,
      lifecycle: "GC_ELIGIBLE",
      reason: "DevSpace checkout session metadata is unloaded, unbound, process-free, agent-terminal, and past grace; the physical checkout is not deleted",
    });
  }
  return artifacts;
}

async function inspectManagedClones(input: HostStorageRetentionInput): Promise<HostStorageArtifact[]> {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.worktreeGraceMs ?? DEFAULT_WORKTREE_GRACE_MS;
  const cloneOperations = input.durableOperations.filter((operation) => operation.kind === "workspace_clone");
  const managedRoots = new Set<string>();
  const recordedPaths = new Set<string>();
  const artifacts: HostStorageArtifact[] = [];

  for (const operation of cloneOperations) {
    const destination = typeof operation.request.destination === "string"
      ? resolve(operation.request.destination)
      : undefined;
    if (!destination) continue;
    const ownershipRoot = devspaceCloneRoot(destination);
    if (!ownershipRoot) continue;
    const canonicalOwnershipRoot = await canonicalPath(ownershipRoot);
    const canonicalDestination = await canonicalPath(destination);
    managedRoots.add(canonicalOwnershipRoot);
    recordedPaths.add(canonicalDestination);

    const base: HostStorageArtifact = {
      id: `managed-clone:${operation.operationId}`,
      kind: "managed_clone",
      path: canonicalDestination,
      ownershipRoot: canonicalOwnershipRoot,
      sizeBytes: await directorySize(canonicalDestination),
      modifiedAt: operation.updatedAt,
      lastUseAt: operation.updatedAt,
      lifecycle: "UNKNOWN",
      reason: "managed clone state has not been classified",
      ownershipEvidence: "durable workspace_clone operation under a .devspace-chatgpt ownership root",
    };

    if (!isPathInsideRoot(canonicalDestination, canonicalOwnershipRoot) || canonicalDestination === canonicalOwnershipRoot) {
      artifacts.push({ ...base, lifecycle: "FOREIGN", reason: "clone destination does not resolve beneath its DevSpace ownership root" });
      continue;
    }
    if (operation.status === "started" || operation.status === "outcome_unknown") {
      artifacts.push({
        ...base,
        lifecycle: "UNKNOWN",
        reason: `workspace_clone operation is ${operation.status}; reconciliation is required before deletion`,
      });
      continue;
    }
    if (operation.status !== "succeeded") {
      artifacts.push({
        ...base,
        lifecycle: "UNKNOWN",
        reason: "failed workspace_clone may have partial physical effects and is retained for reconciliation",
      });
      continue;
    }

    if (await cloneHasWorkspaceReference(canonicalDestination, input)) {
      artifacts.push({ ...base, lifecycle: "PINNED", reason: "managed clone is referenced by a durable workspace/session or active agent" });
      continue;
    }

    const expectedHead = typeof operation.receipt?.head === "string" ? operation.receipt.head : undefined;
    if (!expectedHead) {
      artifacts.push({ ...base, lifecycle: "UNKNOWN", reason: "successful workspace_clone lacks a receipt-bound HEAD identity" });
      continue;
    }
    const gitState = await inspectManagedClone(canonicalDestination);
    if (gitState.state === "unknown") {
      artifacts.push({ ...base, lifecycle: "UNKNOWN", reason: gitState.reason });
      continue;
    }
    if (gitState.dirty) {
      artifacts.push({ ...base, lifecycle: "TERMINAL_BUT_RETAINED", reason: "managed clone has uncommitted/untracked state" });
      continue;
    }
    if (gitState.head !== expectedHead) {
      artifacts.push({
        ...base,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed clone HEAD differs from the durable workspace_clone receipt",
      });
      continue;
    }

    const lastUsedMs = Date.parse(operation.updatedAt);
    if (!Number.isFinite(lastUsedMs) || nowMs - lastUsedMs < graceMs) {
      artifacts.push({
        ...base,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed clone is clean/unreferenced but still inside the retention grace window",
      });
      continue;
    }

    artifacts.push({
      ...base,
      lifecycle: "GC_ELIGIBLE",
      reason: "receipt-owned .devspace-chatgpt clone is unreferenced, clean, unchanged from its recorded HEAD, and past grace",
    });
  }

  for (const root of managedRoots) {
    for (const repositoryRoot of await discoverGitRepositoryRoots(root, 3)) {
      const canonicalRepositoryRoot = await canonicalPath(repositoryRoot);
      if (recordedPaths.has(canonicalRepositoryRoot)) continue;
      artifacts.push({
        id: `managed-clone-untracked:${createHash("sha256").update(canonicalRepositoryRoot).digest("hex").slice(0, 16)}`,
        kind: "managed_clone",
        path: canonicalRepositoryRoot,
        ownershipRoot: root,
        sizeBytes: await directorySize(canonicalRepositoryRoot),
        lifecycle: "UNKNOWN",
        reason: "Git repository exists under a DevSpace clone root without a durable workspace_clone receipt; ownership/lifecycle requires reconciliation",
        ownershipEvidence: "location is inside .devspace-chatgpt, but no durable creation receipt was found",
      });
    }
  }

  return artifacts;
}

function workspaceReferenceState(
  workspaceId: string,
  input: HostStorageRetentionInput,
): { lifecycle: "ACTIVE" | "PINNED" | "UNKNOWN"; reason: string } | undefined {
  if (input.loadedWorkspaceIds.has(workspaceId)) {
    return { lifecycle: "ACTIVE", reason: "workspace is loaded in the running server" };
  }
  const processState = input.processWorkspaceStates.get(workspaceId);
  if (processState === "ACTIVE") {
    return { lifecycle: "PINNED", reason: "workspace has a live process-session reference" };
  }
  if (processState === "UNKNOWN") {
    return { lifecycle: "UNKNOWN", reason: "workspace process-tree termination state is unknown" };
  }
  const bindingCount = input.conversationBindings.filter(
    (binding) => binding.workspaceSessionId === workspaceId,
  ).length;
  if (bindingCount > 0) {
    return {
      lifecycle: "PINNED",
      reason: `workspace has ${bindingCount} durable conversation binding(s)`,
    };
  }

  const agentRecords = input.agentRecords.filter((record) => record.workspaceId === workspaceId);
  const liveAgents = agentRecords.filter(
    (record) => record.status === "starting" || record.status === "running" || record.status === "idle",
  );
  if (liveAgents.length > 0) {
    return {
      lifecycle: "PINNED",
      reason: `workspace has ${liveAgents.length} resumable/running agent record(s)`,
    };
  }
  const uncertainAgents = agentRecords.filter(agentLifecycleRequiresReconciliation);
  if (uncertainAgents.length > 0) {
    return {
      lifecycle: "UNKNOWN",
      reason: `workspace has ${uncertainAgents.length} agent record(s) with unresolved termination/scope lifecycle evidence`,
    };
  }
  return undefined;
}

function agentLifecycleRequiresReconciliation(record: LocalAgentRecord): boolean {
  const lifecycle = record.lifecycleState;
  return Boolean(
    lifecycle?.terminationPending ||
    lifecycle?.lifecycleCorrupt ||
    lifecycle?.terminationBlocked ||
    lifecycle?.activeTurn ||
    record.terminalReason === "unknown" ||
    record.scopeState === "UNKNOWN",
  );
}

async function cloneHasWorkspaceReference(
  clonePath: string,
  input: HostStorageRetentionInput,
): Promise<boolean> {
  for (const session of input.workspaceSessions) {
    if (await samePhysicalPath(session.root, clonePath)) return true;
  }
  for (const record of input.agentRecords) {
    if (
      (record.status === "starting" || record.status === "running" || record.status === "idle" || agentLifecycleRequiresReconciliation(record)) &&
      await samePhysicalPath(record.workspaceRoot, clonePath)
    ) return true;
  }
  return false;
}

async function inspectManagedClone(
  clonePath: string,
): Promise<{ state: "known"; dirty: boolean; head: string } | { state: "unknown"; reason: string }> {
  try {
    const stats = await lstat(clonePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { state: "unknown", reason: "managed clone target is not a real directory" };
    }
    const topLevel = String((await execFileAsync("git", ["-C", clonePath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
    })).stdout).trim();
    if (!(await samePhysicalPath(topLevel, clonePath))) {
      return { state: "unknown", reason: "managed clone path is not the Git repository top level" };
    }
    const [statusResult, headResult] = await Promise.all([
      execFileAsync("git", ["-C", clonePath, "status", "--porcelain=v1"], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", clonePath, "rev-parse", "HEAD"], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      }),
    ]);
    return {
      state: "known",
      dirty: String(statusResult.stdout).trim().length > 0,
      head: String(headResult.stdout).trim(),
    };
  } catch (error) {
    return {
      state: "unknown",
      reason: `unable to prove managed clone state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function discoverGitRepositoryRoots(root: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(path: string, remaining: number): Promise<void> {
    if (remaining < 0) return;
    let dir;
    try {
      dir = await opendir(path);
    } catch {
      return;
    }
    const entries = [];
    for await (const entry of dir) entries.push(entry);
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      found.push(path);
      return;
    }
    if (remaining === 0) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(join(path, entry.name), remaining - 1);
    }
  }
  await walk(root, depth);
  return found;
}

function devspaceCloneRoot(path: string): string | undefined {
  let current = resolve(path);
  while (true) {
    if (basename(current) === ".devspace-chatgpt") return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function pathInsideAnyCanonicalRoot(path: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    const canonicalRoot = await canonicalPath(root);
    if (isPathInsideRoot(path, canonicalRoot)) return true;
  }
  return false;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path)).catch(() => resolve(path));
}

async function samePhysicalPath(left: string, right: string): Promise<boolean> {
  return (await canonicalPath(left)) === (await canonicalPath(right));
}

async function inspectReleases(input: HostStorageRetentionInput): Promise<HostStorageArtifact[]> {
  const releaseRoot = join(resolve(input.packageRoot), "releases");
  const canonicalReleaseRoot = await canonicalPath(releaseRoot);
  const dirs = await directoryChildren(releaseRoot);
  if (dirs.length === 0) return [];

  const pinnedReferences = await collectReleaseReferences(input.stateDir, releaseRoot);
  const owned: Array<{ path: string; name: string; sizeBytes: number; modifiedAt: string; mtimeMs: number }> = [];
  const foreign: HostStorageArtifact[] = [];

  for (const name of dirs) {
    const rawPath = join(releaseRoot, name);
    const path = await canonicalPath(rawPath);
    if (!/^release-[A-Za-z0-9._-]+$/u.test(name)) {
      foreign.push({
        id: `release:${name}`,
        kind: "release",
        path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "FOREIGN",
        reason: "entry does not match DevSpace release naming",
        sizeBytes: await directorySize(path),
        ownershipEvidence: "release naming/identity contract did not match",
      });
      continue;
    }
    if (!isPathInsideRoot(path, canonicalReleaseRoot) || path === canonicalReleaseRoot) {
      foreign.push({
        id: `release:${name}`,
        kind: "release",
        path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "FOREIGN",
        reason: "release entry resolves outside the DevSpace release root",
        sizeBytes: await directorySize(path),
        ownershipEvidence: "canonical release-root containment failed",
      });
      continue;
    }

    const stats = await lstat(path).catch(() => undefined);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      foreign.push({
        id: `release:${name}`,
        kind: "release",
        path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "UNKNOWN",
        reason: "release entry is not a real directory",
        sizeBytes: await directorySize(path),
        ownershipEvidence: "release path shape is not safely owned",
      });
      continue;
    }

    const packageJson = await readJson(join(path, "package.json"));
    if (packageJson?.name !== "@waishnav/devspace") {
      foreign.push({
        id: `release:${name}`,
        kind: "release",
        path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "UNKNOWN",
        reason: "release directory lacks a matching DevSpace package identity",
        sizeBytes: await directorySize(path),
        ownershipEvidence: "package identity could not prove DevSpace ownership",
      });
      continue;
    }
    const dirStats = await stat(path);
    owned.push({
      path,
      name,
      sizeBytes: await directorySize(path),
      modifiedAt: dirStats.mtime.toISOString(),
      mtimeMs: dirStats.mtimeMs,
    });
  }

  owned.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const keepCount = Math.max(1, input.releaseKeepCount ?? DEFAULT_RELEASE_KEEP_COUNT);
  const keep = new Set(owned.slice(0, keepCount).map((entry) => entry.path));

  const artifacts = owned.map<HostStorageArtifact>((entry) => {
    const releaseRevision = entry.name.slice("release-".length);
    if (
      input.activeSourceCommit &&
      /^[0-9a-f]{7,40}$/u.test(releaseRevision) &&
      input.activeSourceCommit.startsWith(releaseRevision)
    ) {
      return {
        id: `release:${entry.name}`,
        kind: "release",
        path: entry.path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "ACTIVE",
        reason: "release revision matches the currently running DevSpace source commit",
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
        ownershipEvidence: "DevSpace package identity plus running source revision match",
      };
    }
    if (pinnedReferences.has(entry.path) || pinnedReferences.has(resolve(entry.path))) {
      return {
        id: `release:${entry.name}`,
        kind: "release",
        path: entry.path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "PINNED",
        reason: "release is referenced by a bounded DevSpace activation/rollback receipt",
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
        ownershipEvidence: "DevSpace package identity plus durable activation/rollback reference",
      };
    }
    if (keep.has(entry.path)) {
      return {
        id: `release:${entry.name}`,
        kind: "release",
        path: entry.path,
        ownershipRoot: canonicalReleaseRoot,
        lifecycle: "PINNED",
        reason: `release is inside the newest ${keepCount} rollback candidates`,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
        ownershipEvidence: "DevSpace package identity plus rollback-count retention policy",
      };
    }
    return {
      id: `release:${entry.name}`,
      kind: "release",
      path: entry.path,
      ownershipRoot: canonicalReleaseRoot,
      lifecycle: "GC_ELIGIBLE",
      reason: "owned release is outside rollback retention and has no active/reference evidence",
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      ownershipEvidence: "DevSpace release root, release naming, and package identity all matched",
    };
  });

  return [...artifacts, ...foreign];
}

async function inspectBrowserRuntimes(input: HostStorageRetentionInput): Promise<HostStorageArtifact[]> {
  const root = join(resolve(input.stateDir), "browser-runtimes");
  const dirs = await directoryChildren(root);
  const artifacts: HostStorageArtifact[] = [];
  for (const name of dirs) {
    const path = join(root, name);
    const sizeBytes = await directorySize(path);
    const marker = (await readJson(join(path, ".devspace-storage.json"))) as Partial<BrowserMarker> | undefined;
    if (
      marker?.schema !== HOST_STORAGE_BROWSER_MARKER_SCHEMA ||
      marker.owner !== "devspace" ||
      marker.kind !== "browser_runtime"
    ) {
      artifacts.push({
        id: `browser-runtime:${name}`,
        kind: "browser_runtime",
        path,
        lifecycle: "UNKNOWN",
        reason: "browser runtime has no trusted DevSpace ownership/lifecycle marker",
        sizeBytes,
      });
      continue;
    }
    if (marker.lifecycle === "active") {
      artifacts.push({
        id: `browser-runtime:${name}`,
        kind: "browser_runtime",
        path,
        lifecycle: "ACTIVE",
        reason: "DevSpace marker reports active browser runtime",
        sizeBytes,
      });
      continue;
    }
    if (marker.lifecycle === "terminal") {
      artifacts.push({
        id: `browser-runtime:${name}`,
        kind: "browser_runtime",
        path,
        lifecycle: "GC_ELIGIBLE",
        reason: "DevSpace-owned browser runtime has an explicit terminal marker",
        sizeBytes,
      });
      continue;
    }
    artifacts.push({
      id: `browser-runtime:${name}`,
      kind: "browser_runtime",
      path,
      lifecycle: "UNKNOWN",
      reason: "browser runtime marker lifecycle is not recognized",
      sizeBytes,
    });
  }
  return artifacts;
}

async function inspectGitWorktree(
  worktreePath: string,
  sourceRoot: string,
): Promise<{ state: "known"; dirty: boolean; head: string } | { state: "unknown"; reason: string }> {
  try {
    const statusResult = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain=v1"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const registration = await execFileAsync("git", ["-C", sourceRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const canonicalWorktreePath = await realpath(worktreePath).catch(() => resolve(worktreePath));
    let registered = false;
    for (const line of String(registration.stdout).split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const listedPath = line.slice("worktree ".length);
      const canonicalListedPath = await realpath(listedPath).catch(() => resolve(listedPath));
      if (canonicalListedPath === canonicalWorktreePath) {
        registered = true;
        break;
      }
    }
    if (!registered) {
      return { state: "unknown", reason: "physical worktree is not registered by its source repository" };
    }
    const headResult = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      state: "known",
      dirty: String(statusResult.stdout).trim().length > 0,
      head: String(headResult.stdout).trim(),
    };
  } catch (error) {
    return {
      state: "unknown",
      reason: `unable to prove managed worktree state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function removeManagedWorktreeArtifact(artifact: HostStorageArtifact): Promise<void> {
  const sourceRoot = artifact.sourceRoot!;
  await execFileAsync("git", ["-C", sourceRoot, "worktree", "remove", artifact.path], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const segment = safeWorkspaceRefSegment(artifact.workspaceId!);
  for (const suffix of ["open", "baseline"]) {
    await execFileAsync(
      "git",
      ["-C", sourceRoot, "update-ref", "-d", `refs/devspace/review/${segment}/${suffix}`],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    ).catch(() => undefined);
  }
}

async function removeOwnedDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("owned storage deletion target must be a real directory");
  }
  await rm(path, { recursive: true, force: false });
}

async function collectReleaseReferences(stateDir: string, releaseRoot: string): Promise<Set<string>> {
  const roots = [join(resolve(stateDir), "host-activation-receipts"), join(resolve(stateDir), "cutover")];
  const releasePaths = new Set<string>();
  for (const root of roots) {
    for await (const file of boundedFiles(root, 3, 512 * 1024)) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content.includes(releaseRoot)) continue;
      for (const match of content.matchAll(/release-[A-Za-z0-9._-]+/gu)) {
        releasePaths.add(resolve(releaseRoot, match[0]));
      }
    }
  }
  return releasePaths;
}

async function* boundedFiles(root: string, depth: number, maxBytes: number): AsyncGenerator<string> {
  if (depth < 0) return;
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return;
  }
  for await (const entry of dir) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth > 0) {
      yield* boundedFiles(path, depth - 1, maxBytes);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await stat(path).catch(() => undefined);
    if (stats && stats.size <= maxBytes) yield path;
  }
}

async function directoryChildren(root: string): Promise<string[]> {
  try {
    const dir = await opendir(root);
    const names: string[] = [];
    for await (const entry of dir) if (entry.isDirectory()) names.push(entry.name);
    return names.sort();
  } catch {
    return [];
  }
}

async function directorySize(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return 0;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return stats.size;
  let total = stats.size;
  let dir;
  try {
    dir = await opendir(path);
  } catch {
    return total;
  }
  for await (const entry of dir) total += await directorySize(join(path, entry.name));
  return total;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hashPlan(artifacts: HostStorageArtifact[]): string {
  const stable = artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    lifecycle: artifact.lifecycle,
    reason: artifact.reason,
    sizeBytes: artifact.sizeBytes,
    modifiedAt: artifact.modifiedAt ?? null,
    workspaceId: artifact.workspaceId ?? null,
    sourceRoot: artifact.sourceRoot ?? null,
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(stable)).digest("hex")}`;
}
