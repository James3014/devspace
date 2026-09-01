import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, canonicalizePath, isPathInsideRoot } from "./roots.js";
import { EXECUTION_PROTOCOL_VERSION, type ExecutionAuthorityMode } from "./execution-protocol.js";

export type DurableOperationKind = "workspace_clone" | "dependency_sync";
export type DurableOperationStatus = "started" | "succeeded" | "failed" | "outcome_unknown";
export type DependencySyncRecipe = "npm_ci" | "pnpm_frozen" | "uv_frozen";

export interface DurableOperationRecord {
  operationId: string;
  attemptKey: string;
  requestHash: string;
  kind: DurableOperationKind;
  authorityMode: ExecutionAuthorityMode;
  scopeRoot: string;
  workspaceId?: string;
  status: DurableOperationStatus;
  retrySafe: boolean;
  request: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface DurableOperationRow {
  operation_id: string;
  attempt_key: string;
  request_hash: string;
  kind: string;
  authority_mode: string;
  scope_root: string;
  workspace_id: string | null;
  status: string;
  retry_safe: string;
  request_json: string;
  receipt_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class DurableOperationError extends Error {
  constructor(
    readonly code:
      | "INVALID_ATTEMPT_KEY"
      | "OPERATION_REPLAY_CONFLICT"
      | "OPERATION_IN_PROGRESS"
      | "OPERATION_OUTCOME_UNKNOWN"
      | "DESTINATION_OUTSIDE_ALLOWED_ROOT"
      | "DESTINATION_NOT_EMPTY"
      | "REMOTE_CREDENTIALS_NOT_ALLOWED"
      | "CLONE_FAILED"
      | "DEPENDENCY_RECIPE_UNSUPPORTED"
      | "DEPENDENCY_SYNC_FAILED"
      | "FROZEN_INPUT_CHANGED"
      | "RECONCILIATION_REQUIRED",
    message: string,
    readonly operation?: DurableOperationRecord,
  ) {
    super(message);
    this.name = "DurableOperationError";
  }
}

export class DurableOperationStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  markInterruptedUnknown(): number {
    const now = new Date().toISOString();
    const result = this.database.sqlite.prepare(`
      update durable_operations
      set status = 'outcome_unknown', retry_safe = 'false',
          error_code = 'RECONCILIATION_REQUIRED',
          error_message = 'DevSpace restarted while the mutating operation was nonterminal; reconcile physical state before any replay.',
          updated_at = ?
      where status = 'started'
    `).run(now);
    return result.changes;
  }

  getByOperationId(operationId: string): DurableOperationRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where operation_id = ? limit 1",
    ).get(operationId) as DurableOperationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByAttempt(scopeRoot: string, attemptKey: string): DurableOperationRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from durable_operations where scope_root = ? and attempt_key = ? limit 1",
    ).get(canonicalizePath(scopeRoot), attemptKey) as DurableOperationRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  createOrReplay(input: Omit<DurableOperationRecord, "createdAt" | "updatedAt" | "status" | "retrySafe">): {
    record: DurableOperationRecord;
    created: boolean;
  } {
    const transact = this.database.sqlite.transaction(() => {
      const existing = this.getByAttempt(input.scopeRoot, input.attemptKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash || existing.kind !== input.kind) {
          throw new DurableOperationError(
            "OPERATION_REPLAY_CONFLICT",
            `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
            existing,
          );
        }
        return { record: existing, created: false };
      }
      const now = new Date().toISOString();
      this.database.sqlite.prepare(`
        insert into durable_operations (
          operation_id, attempt_key, request_hash, kind, authority_mode,
          scope_root, workspace_id, status, retry_safe, request_json,
          receipt_json, error_code, error_message, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'started', 'false', ?, null, null, null, ?, ?)
      `).run(
        input.operationId,
        input.attemptKey,
        input.requestHash,
        input.kind,
        input.authorityMode,
        canonicalizePath(input.scopeRoot),
        input.workspaceId ?? null,
        JSON.stringify(input.request),
        now,
        now,
      );
      return { record: this.getByOperationId(input.operationId)!, created: true };
    });
    return transact.immediate();
  }

  finish(
    operationId: string,
    patch: {
      status: Exclude<DurableOperationStatus, "started">;
      retrySafe: boolean;
      receipt?: Record<string, unknown>;
      errorCode?: string;
      errorMessage?: string;
    },
  ): DurableOperationRecord {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(`
      update durable_operations
      set status = ?, retry_safe = ?, receipt_json = ?, error_code = ?, error_message = ?, updated_at = ?
      where operation_id = ?
    `).run(
      patch.status,
      String(patch.retrySafe),
      patch.receipt ? JSON.stringify(patch.receipt) : null,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      now,
      operationId,
    );
    const record = this.getByOperationId(operationId);
    if (!record) throw new Error(`Unknown durable operation: ${operationId}`);
    return record;
  }
}

export interface WorkspaceCloneInput {
  attemptKey: string;
  remote: string;
  destination: string;
  ref?: string;
  authorityMode?: ExecutionAuthorityMode;
}

export interface DependencySyncInput {
  attemptKey: string;
  workspaceId: string;
  workspaceRoot: string;
  recipe: DependencySyncRecipe;
  authorityMode?: ExecutionAuthorityMode;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export class DurableOperationManager {
  readonly store: DurableOperationStore;

  constructor(
    private readonly config: ServerConfig,
    private readonly runCommand: CommandRunner = spawnCommand,
  ) {
    this.store = new DurableOperationStore(config.stateDir);
    this.store.markInterruptedUnknown();
  }

  close(): void {
    this.store.close();
  }

  async workspaceClone(input: WorkspaceCloneInput): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    const authorityMode = input.authorityMode ?? "OWNER_DIRECT";
    if (authorityMode !== "OWNER_DIRECT") {
      throw new DurableOperationError(
        "RECONCILIATION_REQUIRED",
        "NEXUS_GOVERNED workspace bootstrap is not self-authorizing; G9 must provide validated Nexus authority evidence.",
      );
    }
    assertCredentialFreeRemote(input.remote);
    const destination = canonicalizePath(
      assertAllowedDestination(input.destination, this.config.allowedRoots),
    );
    const scopeRoot = matchingAllowedRoot(destination, this.config.allowedRoots);

    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      remote: sanitizeRemote(input.remote),
      destination,
      ref: input.ref,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("workspace_clone", scopeRoot, input.attemptKey);
    const existing = this.store.getByAttempt(scopeRoot, input.attemptKey);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.kind !== "workspace_clone") {
        throw new DurableOperationError(
          "OPERATION_REPLAY_CONFLICT",
          `attemptKey '${input.attemptKey}' is already bound to a materially different ${existing.kind} request.`,
          existing,
        );
      }
      return replayResult(existing);
    }

    await assertNewOrEmptyDestination(destination);
    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "workspace_clone",
      authorityMode,
      scopeRoot,
      request,
    });
    if (!created) return replayResult(record);

    const args = ["clone", "--", input.remote, destination];
    if (input.ref) args.splice(1, 0, "--branch", input.ref, "--single-branch");
    const result = await this.runCommand("git", args, scopeRoot);
    if (result.exitCode !== 0) {
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "CLONE_FAILED",
        errorMessage: redactSecrets(result.stderr || `git clone exited ${result.exitCode}`),
        receipt: { destination, remote: sanitizeRemote(input.remote), ref: input.ref },
      });
    }

    const head = await readGitHead(destination);
    return this.store.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: {
        destination,
        remote: sanitizeRemote(input.remote),
        ref: input.ref,
        head,
        openable: existsSync(resolve(destination, ".git")),
      },
    });
  }

  async dependencySync(input: DependencySyncInput): Promise<DurableOperationRecord> {
    assertAttemptKey(input.attemptKey);
    const authorityMode = input.authorityMode ?? "OWNER_DIRECT";
    if (authorityMode !== "OWNER_DIRECT") {
      throw new DurableOperationError(
        "RECONCILIATION_REQUIRED",
        "NEXUS_GOVERNED dependency sync is not self-authorizing; G9 must provide validated Nexus authority evidence.",
      );
    }
    const workspaceRoot = canonicalizePath(input.workspaceRoot);
    if (!this.config.allowedRoots.some((root) => isPathInsideRoot(workspaceRoot, canonicalizePath(root))) &&
        !isPathInsideRoot(workspaceRoot, canonicalizePath(this.config.worktreeRoot))) {
      throw new DurableOperationError("DESTINATION_OUTSIDE_ALLOWED_ROOT", `Workspace is outside configured roots: ${workspaceRoot}`);
    }

    const frozenInputs = recipeFrozenInputs(input.recipe);
    const before = await hashFiles(workspaceRoot, frozenInputs);
    const request = {
      version: EXECUTION_PROTOCOL_VERSION,
      workspaceId: input.workspaceId,
      workspaceRoot,
      recipe: input.recipe,
      frozenInputs: before,
    };
    const requestHash = hashJson(request);
    const operationId = stableOperationId("dependency_sync", workspaceRoot, input.attemptKey);
    const { record, created } = this.store.createOrReplay({
      operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "dependency_sync",
      authorityMode,
      scopeRoot: workspaceRoot,
      workspaceId: input.workspaceId,
      request,
    });
    if (!created) return replayResult(record);

    const command = dependencyCommand(input.recipe);
    const result = await this.runCommand(command.command, command.args, workspaceRoot);
    const after = await hashFiles(workspaceRoot, frozenInputs);
    if (hashJson(before) !== hashJson(after)) {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "FROZEN_INPUT_CHANGED",
        errorMessage: "Dependency specification or lock input changed during a FROZEN dependency sync.",
        receipt: { recipe: input.recipe, before, after, exitCode: result.exitCode },
      });
    }
    if (result.exitCode !== 0) {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "DEPENDENCY_SYNC_FAILED",
        errorMessage: redactSecrets(result.stderr || `${command.command} exited ${result.exitCode}`),
        receipt: { recipe: input.recipe, frozenInputs: after, exitCode: result.exitCode },
      });
    }
    return this.store.finish(operationId, {
      status: "succeeded",
      retrySafe: false,
      receipt: { recipe: input.recipe, frozenInputs: after, exitCode: result.exitCode },
    });
  }

  async reconcile(operationId: string): Promise<DurableOperationRecord> {
    const record = this.store.getByOperationId(operationId);
    if (!record) throw new DurableOperationError("RECONCILIATION_REQUIRED", `Unknown durable operation: ${operationId}`);
    if (record.status !== "outcome_unknown" && record.status !== "started") return record;

    if (record.kind === "workspace_clone") {
      const destination = String(record.request.destination ?? "");
      const expectedRemote = String(record.request.remote ?? "");
      const head = await readGitHead(destination);
      const remote = await readGitRemote(destination);
      if (head && remote && sanitizeRemote(remote) === expectedRemote) {
        return this.store.finish(operationId, {
          status: "succeeded",
          retrySafe: false,
          receipt: { destination, remote: expectedRemote, head, reconciled: true, openable: true },
        });
      }
      return this.store.finish(operationId, {
        status: "outcome_unknown",
        retrySafe: false,
        errorCode: "RECONCILIATION_REQUIRED",
        errorMessage: "Clone physical state does not prove a complete matching repository; manual cleanup or explicit recovery is required.",
        receipt: { destination, observedHead: head, observedRemote: remote ? sanitizeRemote(remote) : undefined, reconciled: true },
      });
    }

    const workspaceRoot = String(record.request.workspaceRoot ?? record.scopeRoot);
    const recipe = String(record.request.recipe) as DependencySyncRecipe;
    const frozenInputs = recipeFrozenInputs(recipe);
    const current = await hashFiles(workspaceRoot, frozenInputs);
    const original = record.request.frozenInputs as Record<string, string | null> | undefined;
    if (original && hashJson(original) !== hashJson(current)) {
      return this.store.finish(operationId, {
        status: "failed",
        retrySafe: false,
        errorCode: "FROZEN_INPUT_CHANGED",
        errorMessage: "Frozen dependency inputs differ from the operation's bound inputs; success cannot be claimed.",
        receipt: { recipe, original, current, reconciled: true },
      });
    }
    return this.store.finish(operationId, {
      status: "outcome_unknown",
      retrySafe: false,
      errorCode: "RECONCILIATION_REQUIRED",
      errorMessage: "Dependency inputs are intact, but installed-environment success cannot be proven after interruption without re-executing mutation.",
      receipt: { recipe, frozenInputs: current, reconciled: true },
    });
  }
}

function replayResult(record: DurableOperationRecord): DurableOperationRecord {
  if (record.status === "started") {
    throw new DurableOperationError("OPERATION_IN_PROGRESS", `Operation ${record.operationId} is already started.`, record);
  }
  if (record.status === "outcome_unknown") {
    throw new DurableOperationError(
      "OPERATION_OUTCOME_UNKNOWN",
      `Operation ${record.operationId} has uncertain physical effects; reconcile it instead of replaying mutation.`,
      record,
    );
  }
  return record;
}

function rowToRecord(row: DurableOperationRow): DurableOperationRecord {
  return {
    operationId: row.operation_id,
    attemptKey: row.attempt_key,
    requestHash: row.request_hash,
    kind: row.kind as DurableOperationKind,
    authorityMode: row.authority_mode as ExecutionAuthorityMode,
    scopeRoot: row.scope_root,
    workspaceId: row.workspace_id ?? undefined,
    status: row.status as DurableOperationStatus,
    retrySafe: row.retry_safe === "true",
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) as Record<string, unknown> : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertAttemptKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new DurableOperationError("INVALID_ATTEMPT_KEY", "attemptKey must be a bounded stable operation identity.");
  }
}

function assertAllowedDestination(destination: string, roots: readonly string[]): string {
  try {
    return assertAllowedPath(destination, [...roots]);
  } catch (error) {
    throw new DurableOperationError(
      "DESTINATION_OUTSIDE_ALLOWED_ROOT",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function matchingAllowedRoot(destination: string, roots: readonly string[]): string {
  const canonicalDestination = canonicalizePath(destination);
  const matches = roots
    .map((root) => canonicalizePath(root))
    .filter((root) => isPathInsideRoot(canonicalDestination, root))
    .sort((a, b) => b.length - a.length);
  if (!matches[0]) throw new DurableOperationError("DESTINATION_OUTSIDE_ALLOWED_ROOT", `No allowed root contains ${destination}`);
  return matches[0];
}

async function assertNewOrEmptyDestination(destination: string): Promise<void> {
  try {
    const info = await stat(destination);
    if (!info.isDirectory()) {
      throw new DurableOperationError("DESTINATION_NOT_EMPTY", `Clone destination already exists and is not a directory: ${destination}`);
    }
    const { readdir } = await import("node:fs/promises");
    if ((await readdir(destination)).length > 0) {
      throw new DurableOperationError("DESTINATION_NOT_EMPTY", `Clone destination must be new or empty: ${destination}`);
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ENOENT") return;
    throw error;
  }
}

function assertCredentialFreeRemote(remote: string): void {
  try {
    const url = new URL(remote);
    if (url.username || url.password) {
      throw new DurableOperationError(
        "REMOTE_CREDENTIALS_NOT_ALLOWED",
        "Credential-bearing Git URLs are not accepted. Use a credential helper and a credential-free remote URL.",
      );
    }
  } catch (error) {
    if (error instanceof DurableOperationError) throw error;
    // Local paths and SCP-like Git remotes are allowed; receipts still redact obvious credentials.
  }
}

function sanitizeRemote(remote: string): string {
  return redactSecrets(remote);
}

function redactSecrets(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|access_token|password|secret)=)[^&\s]+/gi, "$1[redacted]");
}

function stableOperationId(kind: DurableOperationKind, scopeRoot: string, attemptKey: string): string {
  return `op_${createHash("sha256").update(`${kind}\0${resolve(scopeRoot)}\0${attemptKey}`).digest("hex").slice(0, 16)}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function recipeFrozenInputs(recipe: DependencySyncRecipe): string[] {
  if (recipe === "npm_ci") return ["package.json", "package-lock.json"];
  if (recipe === "pnpm_frozen") return ["package.json", "pnpm-lock.yaml"];
  if (recipe === "uv_frozen") return ["pyproject.toml", "uv.lock"];
  throw new DurableOperationError("DEPENDENCY_RECIPE_UNSUPPORTED", `Unsupported dependency recipe: ${recipe}`);
}

function dependencyCommand(recipe: DependencySyncRecipe): { command: string; args: string[] } {
  if (recipe === "npm_ci") {
    return { command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
  }
  if (recipe === "pnpm_frozen") {
    return { command: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  }
  if (recipe === "uv_frozen") {
    return { command: "uv", args: ["sync", "--frozen"] };
  }
  throw new DurableOperationError("DEPENDENCY_RECIPE_UNSUPPORTED", `Unsupported dependency recipe: ${recipe}`);
}

async function hashFiles(root: string, paths: string[]): Promise<Record<string, string | null>> {
  const output: Record<string, string | null> = {};
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!isPathInsideRoot(absolute, root)) throw new Error(`Frozen input escaped workspace: ${path}`);
    try {
      output[path] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno?.code === "ENOENT") output[path] = null;
      else throw error;
    }
  }
  return output;
}

async function readGitHead(root: string): Promise<string | undefined> {
  if (!existsSync(root)) return undefined;
  try {
    const result = await spawnCommand("git", ["rev-parse", "HEAD"], root);
    return result.exitCode === 0 ? result.stdout.trim().toLowerCase() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function readGitRemote(root: string): Promise<string | undefined> {
  if (!existsSync(root)) return undefined;
  try {
    const result = await spawnCommand("git", ["remote", "get-url", "origin"], root);
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}
