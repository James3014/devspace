import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CUTOVER_STATE_SCHEMA = "devspace.cutover.v1" as const;

export interface CutoverServerIdentity {
  serverInstanceId: string;
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256?: string;
}

export interface ExpectedCutoverIdentity {
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256?: string;
}

export interface CutoverDrainEvidence {
  activeSessions: number;
  oldestAgeMs: number;
}

export interface CutoverReconciliationReceipt {
  closedByServerInstanceId: string;
  workspaceQueryable: boolean;
  agentQueryable: boolean;
  agentReconciled: boolean;
  reconciledAt: string;
}

export interface DurableCutoverRecord {
  schema: typeof CUTOVER_STATE_SCHEMA;
  cutoverId: string;
  phase: "prepared" | "drained" | "closed";
  oldServerIdentity: CutoverServerIdentity;
  expectedNewIdentity: ExpectedCutoverIdentity;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  expired?: boolean;
  drainEvidence?: CutoverDrainEvidence;
  reconciliationReceipt?: CutoverReconciliationReceipt;
}

export interface CutoverStateStoreOptions {
  now?: () => number;
  newId?: () => string;
}

export class CutoverStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverStateError";
  }
}

/**
 * A fixed-path, atomically created durable record is the exclusivity fence.
 * Expiry is projected as diagnostic evidence only and never authorizes unlink,
 * replacement, or ownership transfer of an unresolved record.
 */
export class CutoverStateStore {
  private readonly cutoverRoot: string;
  private readonly activeDir: string;
  private readonly createdPath: string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(stateDir: string, options: CutoverStateStoreOptions = {}) {
    this.cutoverRoot = join(stateDir, "cutover");
    this.activeDir = join(this.cutoverRoot, "active");
    this.createdPath = join(this.activeDir, "created.json");
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  get(): DurableCutoverRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.createdPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT") && !existsSync(this.activeDir)) return undefined;
      if (isErrno(error, "ENOENT")) {
        throw new CutoverStateError(
          "Durable cutover fence exists without a readable creation record; reconciliation is required.",
        );
      }
      throw error;
    }
    let record = parseRecord(raw);
    const events = readdirSync(this.activeDir).filter((name) => name.endsWith(".json"));
    const closed = events.filter((name) => name.startsWith("closed-")).sort().at(-1);
    const drained = events.filter((name) => name.startsWith("drained-")).sort().at(-1);
    if (closed) record = parseRecord(readFileSync(join(this.activeDir, closed), "utf8"));
    else if (drained) record = parseRecord(readFileSync(join(this.activeDir, drained), "utf8"));
    return {
      ...record,
      expired: record.expiresAt === undefined
        ? false
        : this.now() >= Date.parse(record.expiresAt),
    };
  }

  begin(input: {
    oldServerIdentity: CutoverServerIdentity;
    expectedNewIdentity: ExpectedCutoverIdentity;
    expiresAt?: string;
  }): DurableCutoverRecord {
    mkdirSync(this.cutoverRoot, { recursive: true, mode: 0o700 });
    const now = new Date(this.now()).toISOString();
    const record: DurableCutoverRecord = {
      schema: CUTOVER_STATE_SCHEMA,
      cutoverId: this.newId(),
      phase: "prepared",
      oldServerIdentity: input.oldServerIdentity,
      expectedNewIdentity: input.expectedNewIdentity,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };

    for (;;) {
      const existing = this.get();
      if (existing && existing.phase !== "closed") {
        throw new CutoverStateError(
          `Unresolved cutover ${existing.cutoverId} already owns the durable cutover fence.`,
        );
      }
      if (existing?.phase === "closed") {
        const archived = join(this.cutoverRoot, `closed-${existing.cutoverId}-${this.newId()}`);
        try {
          renameSync(this.activeDir, archived);
        } catch (error) {
          if (isErrno(error, "ENOENT")) continue;
          throw error;
        }
      }

      try {
        mkdirSync(this.activeDir, { mode: 0o700 });
        writeExclusiveDurable(this.createdPath, serializeRecord(record));
        syncDirectory(this.activeDir);
        syncDirectory(this.cutoverRoot);
        return record;
      } catch (error) {
        if (isErrno(error, "EEXIST")) continue;
        throw error;
      }
    }
  }

  recordDrain(cutoverId: string, evidence: CutoverDrainEvidence): DurableCutoverRecord {
    const record = this.requireExact(cutoverId);
    if (record.phase === "closed") return record;
    return this.replace({
      ...withoutDiagnostic(record),
      phase: "drained",
      drainEvidence: evidence,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  close(cutoverId: string, receipt: CutoverReconciliationReceipt): DurableCutoverRecord {
    const record = this.requireExact(cutoverId);
    if (record.phase === "closed") return record;
    return this.replace({
      ...withoutDiagnostic(record),
      phase: "closed",
      reconciliationReceipt: receipt,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  private requireExact(cutoverId: string): DurableCutoverRecord {
    const record = this.get();
    if (!record) throw new CutoverStateError("No durable cutover record exists.");
    if (record.cutoverId !== cutoverId) {
      throw new CutoverStateError(
        `Cutover id mismatch: active cutover is ${record.cutoverId}.`,
      );
    }
    return record;
  }

  private replace(record: DurableCutoverRecord): DurableCutoverRecord {
    const sequence = String(this.now()).padStart(16, "0");
    const eventPath = join(
      this.activeDir,
      `${record.phase}-${sequence}-${this.newId()}.json`,
    );
    writeExclusiveDurable(eventPath, serializeRecord(record));
    syncDirectory(this.activeDir);
    return record;
  }
}

function withoutDiagnostic(record: DurableCutoverRecord): DurableCutoverRecord {
  const { expired: _expired, ...durable } = record;
  return durable;
}

function serializeRecord(record: DurableCutoverRecord): string {
  return `${JSON.stringify(withoutDiagnostic(record), null, 2)}\n`;
}

function parseRecord(raw: string): DurableCutoverRecord {
  const value = JSON.parse(raw) as Partial<DurableCutoverRecord>;
  if (
    value.schema !== CUTOVER_STATE_SCHEMA ||
    typeof value.cutoverId !== "string" ||
    !["prepared", "drained", "closed"].includes(value.phase ?? "") ||
    !isIdentity(value.oldServerIdentity) ||
    !isExpectedIdentity(value.expectedNewIdentity) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new CutoverStateError("Durable cutover record is malformed; reconciliation is required.");
  }
  return value as DurableCutoverRecord;
}

function isIdentity(value: unknown): value is CutoverServerIdentity {
  const identity = value as Partial<CutoverServerIdentity> | undefined;
  return Boolean(
    identity &&
    typeof identity.serverInstanceId === "string" &&
    typeof identity.sourceCommit === "string" &&
    typeof identity.buildId === "string",
  );
}

function isExpectedIdentity(value: unknown): value is ExpectedCutoverIdentity {
  const identity = value as Partial<ExpectedCutoverIdentity> | undefined;
  return Boolean(
    identity &&
    typeof identity.sourceCommit === "string" &&
    typeof identity.buildId === "string",
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Preserve the original create error.
  }
}

function writeExclusiveDurable(path: string, content: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}
