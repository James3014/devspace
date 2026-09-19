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
  const generatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const artifacts = [
    ...(await inspectWorkspaces(input)),
    ...(await inspectReleases(input)),
    ...(await inspectBrowserRuntimes(input)),
  ].sort((a, b) => (a.kind + ":" + a.path).localeCompare(b.kind + ":" + b.path));
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

export async function applyHostStoragePlan(
  input: HostStorageRetentionInput,
  expectedPlanId: string,
  callbacks: { deleteWorkspaceSession: (workspaceId: string) => void },
): Promise<HostStorageApplyResult> {
  const replay = await readApplyReceipt(input.stateDir, expectedPlanId);
  if (replay) return replay;

  const fresh = await buildHostStoragePlan(input);
  if (fresh.planId !== expectedPlanId) {
    throw new Error(
      `STORAGE_PLAN_STALE: expected ${expectedPlanId}, current inventory is ${fresh.planId}; run storage_inventory again.`,
    );
  }

  const removed: HostStorageApplyResult["removed"] = [];
  const skipped: HostStorageApplyResult["skipped"] = [];

  for (const artifact of fresh.artifacts) {
    if (artifact.lifecycle !== "GC_ELIGIBLE") {
      skipped.push({ id: artifact.id, kind: artifact.kind, path: artifact.path, reason: artifact.reason });
      continue;
    }

    try {
      if (artifact.kind === "managed_worktree") {
        if (!artifact.workspaceId || !artifact.sourceRoot) {
          throw new Error("managed worktree inventory is missing workspace/source identity");
        }
        await removeManagedWorktreeArtifact(artifact);
        callbacks.deleteWorkspaceSession(artifact.workspaceId);
      } else if (artifact.kind === "release" || artifact.kind === "browser_runtime") {
        await removeOwnedDirectory(artifact.path);
      } else {
        throw new Error("checkout workspaces are never DevSpace-owned deletion targets");
      }
      removed.push({ id: artifact.id, kind: artifact.kind, path: artifact.path, bytes: artifact.sizeBytes });
    } catch (error) {
      skipped.push({
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        reason: `apply_failed:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const result: HostStorageApplyResult = {
    schema: HOST_STORAGE_RETENTION_SCHEMA,
    planId: fresh.planId,
    reclaimedBytes: removed.reduce((total, entry) => total + entry.bytes, 0),
    removed,
    skipped,
  };
  await writeApplyReceipt(input.stateDir, result);
  return result;
}

async function readApplyReceipt(
  stateDir: string,
  planId: string,
): Promise<HostStorageApplyResult | undefined> {
  const receipt = await readJson(applyReceiptPath(stateDir, planId));
  if (
    receipt?.schema !== HOST_STORAGE_RETENTION_SCHEMA ||
    receipt.planId !== planId ||
    !Array.isArray(receipt.removed) ||
    !Array.isArray(receipt.skipped) ||
    typeof receipt.reclaimedBytes !== "number"
  ) {
    return undefined;
  }
  return receipt as unknown as HostStorageApplyResult;
}

async function writeApplyReceipt(stateDir: string, result: HostStorageApplyResult): Promise<void> {
  const path = applyReceiptPath(stateDir, result.planId);
  const dir = join(resolve(stateDir), "host-storage-retention", "receipts");
  await mkdir(dir, { recursive: true });
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
  const bindingsByWorkspace = new Map<string, number>();
  for (const binding of input.conversationBindings) {
    bindingsByWorkspace.set(
      binding.workspaceSessionId,
      (bindingsByWorkspace.get(binding.workspaceSessionId) ?? 0) + 1,
    );
  }

  const agentsByWorkspace = new Map<string, LocalAgentRecord[]>();
  for (const record of input.agentRecords) {
    if (!record.workspaceId) continue;
    const records = agentsByWorkspace.get(record.workspaceId) ?? [];
    records.push(record);
    agentsByWorkspace.set(record.workspaceId, records);
  }

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
      ...(session.sourceRoot ? { sourceRoot: resolve(session.sourceRoot) } : {}),
    };

    if (kind === "workspace_checkout") {
      artifacts.push({
        ...base,
        lifecycle: "FOREIGN",
        reason: "checkout path is user-owned and is never a DevSpace deletion target",
      });
      continue;
    }

    if (!isPathInsideRoot(path, resolve(input.worktreeRoot))) {
      artifacts.push({
        ...base,
        lifecycle: "FOREIGN",
        reason: "managed-worktree record is outside configured worktreeRoot",
      });
      continue;
    }

    if (input.loadedWorkspaceIds.has(session.id)) {
      artifacts.push({ ...base, lifecycle: "ACTIVE", reason: "workspace is loaded in the running server" });
      continue;
    }

    const bindingCount = bindingsByWorkspace.get(session.id) ?? 0;
    if (bindingCount > 0) {
      artifacts.push({
        ...base,
        lifecycle: "PINNED",
        reason: `workspace has ${bindingCount} durable conversation binding(s)`,
      });
      continue;
    }

    const agentRecords = agentsByWorkspace.get(session.id) ?? [];
    const liveAgents = agentRecords.filter(
      (record) => record.status === "starting" || record.status === "running" || record.status === "idle",
    );
    if (liveAgents.length > 0) {
      artifacts.push({
        ...base,
        lifecycle: "PINNED",
        reason: `workspace has ${liveAgents.length} resumable/running agent record(s)`,
      });
      continue;
    }

    if (!session.sourceRoot) {
      artifacts.push({ ...base, lifecycle: "UNKNOWN", reason: "managed worktree lacks source repository identity" });
      continue;
    }

    const gitState = await inspectGitWorktree(path, resolve(session.sourceRoot));
    if (gitState.state === "unknown") {
      artifacts.push({ ...base, lifecycle: "UNKNOWN", reason: gitState.reason });
      continue;
    }
    if (gitState.dirty) {
      artifacts.push({
        ...base,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed worktree has uncommitted/untracked changes",
      });
      continue;
    }

    const lastUsedMs = Date.parse(session.lastUsedAt);
    if (!Number.isFinite(lastUsedMs) || nowMs - lastUsedMs < graceMs) {
      artifacts.push({
        ...base,
        lifecycle: "TERMINAL_BUT_RETAINED",
        reason: "managed worktree is clean/unreferenced but still inside the retention grace window",
      });
      continue;
    }

    artifacts.push({
      ...base,
      lifecycle: "GC_ELIGIBLE",
      reason: "DevSpace-owned managed worktree is unloaded, unbound, agent-terminal, clean, and past grace",
    });
  }
  return artifacts;
}

async function inspectReleases(input: HostStorageRetentionInput): Promise<HostStorageArtifact[]> {
  const releaseRoot = join(resolve(input.packageRoot), "releases");
  const dirs = await directoryChildren(releaseRoot);
  if (dirs.length === 0) return [];

  const activeRoot = await realpath(resolve(input.packageRoot)).catch(() => resolve(input.packageRoot));
  const pinnedReferences = await collectReleaseReferences(input.stateDir, releaseRoot);
  const owned: Array<{ path: string; name: string; sizeBytes: number; modifiedAt: string; mtimeMs: number }> = [];
  const foreign: HostStorageArtifact[] = [];

  for (const name of dirs) {
    const path = join(releaseRoot, name);
    if (!/^release-[A-Za-z0-9._-]+$/u.test(name)) {
      foreign.push({
        id: `release:${name}`,
        kind: "release",
        path,
        lifecycle: "FOREIGN",
        reason: "entry does not match DevSpace release naming",
        sizeBytes: await directorySize(path),
      });
      continue;
    }

    const packageJson = await readJson(join(path, "package.json"));
    if (packageJson?.name !== "@waishnav/devspace") {
      foreign.push({
        id: `release:${name}`,
        kind: "release",
        path,
        lifecycle: "UNKNOWN",
        reason: "release directory lacks a matching DevSpace package identity",
        sizeBytes: await directorySize(path),
      });
      continue;
    }
    const stats = await stat(path);
    owned.push({
      path,
      name,
      sizeBytes: await directorySize(path),
      modifiedAt: stats.mtime.toISOString(),
      mtimeMs: stats.mtimeMs,
    });
  }

  owned.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const keepCount = Math.max(1, input.releaseKeepCount ?? DEFAULT_RELEASE_KEEP_COUNT);
  const keep = new Set(owned.slice(0, keepCount).map((entry) => entry.path));

  const artifacts = owned.map<HostStorageArtifact>((entry) => {
    const canonical = resolve(entry.path);
    if (activeRoot === canonical || isPathInsideRoot(activeRoot, canonical)) {
      return {
        id: `release:${entry.name}`,
        kind: "release",
        path: canonical,
        lifecycle: "ACTIVE",
        reason: "currently executing package root resolves inside this release",
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      };
    }
    if (pinnedReferences.has(canonical)) {
      return {
        id: `release:${entry.name}`,
        kind: "release",
        path: canonical,
        lifecycle: "PINNED",
        reason: "release is referenced by a bounded DevSpace activation/rollback receipt",
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      };
    }
    if (keep.has(entry.path)) {
      return {
        id: `release:${entry.name}`,
        kind: "release",
        path: canonical,
        lifecycle: "PINNED",
        reason: `release is inside the newest ${keepCount} rollback candidates`,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      };
    }
    return {
      id: `release:${entry.name}`,
      kind: "release",
      path: canonical,
      lifecycle: "GC_ELIGIBLE",
      reason: "owned release is outside rollback retention and has no bounded receipt reference",
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
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
): Promise<{ state: "known"; dirty: boolean } | { state: "unknown"; reason: string }> {
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
    return { state: "known", dirty: String(statusResult.stdout).trim().length > 0 };
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
