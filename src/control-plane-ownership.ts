import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type Database from "better-sqlite3";

export const CONTROL_PLANE_SCHEMA = "devspace.control_plane.v1" as const;
const MAX_JSON_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface GrantEvidenceReference {
  repository: string;
  goal: string;
  coordinatorThread: string;
  evidenceHash: string;
}
export interface GrantEvidenceIndexRow extends GrantEvidenceReference { version: number; updatedAt: string; }

export interface TrustedOwnerContext {
  ownerThread: string;
}

export interface ResourceLeaseInput {
  repositoryKey: string;
  resourceKind: string;
  resourceId: string;
  resource: string;
  operation: string;
  scope: readonly string[];
  baseRevision: string;
  expiresAt: string;
  idempotencyKey: string;
  grant: GrantEvidenceReference;
}

export interface ResourceLease extends ResourceLeaseInput {
  schema: typeof CONTROL_PLANE_SCHEMA;
  leaseId: string;
  ownerThread: string;
  version: number;
  terminalState?: "released" | "handed_off" | "expired_reconciled";
  createdAt: string;
  updatedAt: string;
  operationHandle?: string;
  operationState?: "active" | "finished";
}

export function normalizeRepositoryKey(value: string): string {
  bounded(value, "repositoryKey");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) throw new ControlPlaneOwnershipError("INVALID_INPUT", "repositoryKey must be a canonical owner/repository key");
  return normalized;
}

export type OwnerContextResolver = (consumerContext: unknown) => TrustedOwnerContext | undefined;
export type GrantEvidenceVerifier = (reference: GrantEvidenceReference, owner: TrustedOwnerContext) => boolean;

export interface ControlPlaneOwnershipOptions {
  resolveOwnerContext?: OwnerContextResolver;
  verifyGrantEvidence?: GrantEvidenceVerifier;
  now?: () => number;
  newId?: () => string;
}

export class ControlPlaneOwnershipError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "AUTHORITY_REQUIRED" | "OWNERSHIP_CONFLICT" | "CAS_CONFLICT" | "EXPIRED" | "MALFORMED", message: string) {
    super(message);
    this.name = "ControlPlaneOwnershipError";
  }
}

export function initializeControlPlaneOwnershipDatabase(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists control_plane_resource_leases (
      lease_id text primary key,
      repository_key text not null,
      resource_kind text not null,
      resource_id text not null,
      resource text not null,
      operation text not null,
      scope_json text not null,
      base_revision text not null,
      idempotency_key text not null,
      owner_thread text not null,
      grant_json text not null,
      version integer not null,
      terminal_state text,
      expires_at text not null,
      created_at text not null,
      updated_at text not null,
      active_operation_handle text,
      operation_state text,
      unique(repository_key, resource_kind, resource_id, idempotency_key)
    );
    create index if not exists control_plane_resource_leases_resource_idx
      on control_plane_resource_leases(resource, terminal_state, updated_at);
    create table if not exists control_plane_handoff_receipts (
      receipt_id text primary key,
      lease_id text not null,
      resource text not null,
      from_owner_thread text not null,
      to_owner_thread text not null,
      previous_version integer not null,
      new_version integer not null,
      receipt_json text not null,
      created_at text not null,
      foreign key (lease_id) references control_plane_resource_leases(lease_id)
    );
    create table if not exists control_plane_completion_matrix (
      goal text not null,
      layer text not null,
      source text not null,
      revision text not null,
      status text not null,
      freshness text not null,
      gap text,
      version integer not null,
      updated_at text not null,
      primary key(goal, layer)
    );
    create table if not exists control_plane_grant_evidence (
      repository text not null, goal text not null, coordinator_thread text not null,
      evidence_hash text not null, version integer not null, updated_at text not null,
      primary key(repository, goal, coordinator_thread)
    );
  `);
}

function bounded(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new ControlPlaneOwnershipError("INVALID_INPUT", `${field} is invalid`);
  return value;
}
function normalizeScope(scope: readonly string[]): string[] {
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > 512) throw new ControlPlaneOwnershipError("INVALID_INPUT", "scope must be non-empty and bounded");
  const result = [...new Set(scope.map((raw) => {
    bounded(raw, "scope path");
    if (!raw.startsWith("/") || raw.includes("\0") || raw.split("/").some((part: string) => part === "." || part === "..")) throw new ControlPlaneOwnershipError("INVALID_INPUT", "scope must contain verified absolute realpaths");
    const normalized = posix.normalize(raw);
    if (normalized === "/.." || normalized.startsWith("/../")) throw new ControlPlaneOwnershipError("INVALID_INPUT", "scope path escapes its root");
    return normalized;
  }))].sort();
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw new ControlPlaneOwnershipError("INVALID_INPUT", "scope is too large");
  return result;
}
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const boundary = (value: string) => value === "/" ? value : value.replace(/\/+$/, "");
  return a.some((rawLeft) => b.some((rawRight) => { const left = boundary(rawLeft); const right = boundary(rawRight); return left === right || left === "/" || right === "/" || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }));
}
function parseJson<T>(raw: string, label: string): T {
  try { return JSON.parse(raw) as T; } catch { throw new ControlPlaneOwnershipError("MALFORMED", `${label} is malformed`); }
}
function validExpiry(value: string, now: number): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now || parsed > now + 24 * 60 * 60 * 1000) throw new ControlPlaneOwnershipError("INVALID_INPUT", "expiresAt must be bounded future UTC time");
}
function ownerFor(options: ControlPlaneOwnershipOptions, context: unknown): TrustedOwnerContext {
  const owner = options.resolveOwnerContext?.(context);
  if (!owner || !SAFE_ID.test(owner.ownerThread)) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "authenticated owner context is required");
  return owner;
}
function verifyGrant(options: ControlPlaneOwnershipOptions, grant: GrantEvidenceReference, owner: TrustedOwnerContext): void {
  bounded(grant.repository, "grant.repository"); bounded(grant.goal, "grant.goal"); bounded(grant.coordinatorThread, "grant.coordinatorThread"); bounded(grant.evidenceHash, "grant.evidenceHash");
  if (!options.verifyGrantEvidence?.(grant, owner)) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "authoritative grant evidence was not verified");
}

interface LeaseRow { lease_id: string; repository_key: string; resource_kind: string; resource_id: string; resource: string; operation: string; scope_json: string; base_revision: string; idempotency_key: string; owner_thread: string; grant_json: string; version: number; terminal_state: string | null; expires_at: string; created_at: string; updated_at: string; active_operation_handle: string | null; operation_state: string | null; }
function rowLease(row: LeaseRow): ResourceLease {
  const scope = parseJson<string[]>(row.scope_json, "lease scope");
  const grant = parseJson<GrantEvidenceReference>(row.grant_json, "lease grant");
  if (!Array.isArray(scope) || typeof grant.repository !== "string" || typeof grant.goal !== "string" || typeof grant.coordinatorThread !== "string" || typeof grant.evidenceHash !== "string" || !grant.repository || !grant.goal || !grant.coordinatorThread || !grant.evidenceHash) throw new ControlPlaneOwnershipError("MALFORMED", "lease evidence is malformed");
  if (!Number.isInteger(row.version) || row.version < 1 || (row.terminal_state !== null && !["released", "handed_off", "expired_reconciled"].includes(row.terminal_state)) || !Number.isFinite(Date.parse(row.expires_at)) || (row.operation_state !== null && row.operation_state !== "active" && row.operation_state !== "finished")) throw new ControlPlaneOwnershipError("MALFORMED", "lease state is malformed");
  return { schema: CONTROL_PLANE_SCHEMA, leaseId: row.lease_id, repositoryKey: row.repository_key, resourceKind: row.resource_kind, resourceId: row.resource_id, resource: row.resource, operation: row.operation, scope, baseRevision: row.base_revision, idempotencyKey: row.idempotency_key, ownerThread: row.owner_thread, grant, version: row.version, ...(row.terminal_state ? { terminalState: row.terminal_state as ResourceLease["terminalState"] } : {}), expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.active_operation_handle ? { operationHandle: row.active_operation_handle } : {}), ...(row.operation_state ? { operationState: row.operation_state as ResourceLease["operationState"] } : {}) };
}

export class ControlPlaneOwnershipStore {
  constructor(private readonly sqlite: Database.Database, private readonly options: ControlPlaneOwnershipOptions) {
    initializeControlPlaneOwnershipDatabase(sqlite);
  }
  putGrantEvidence(consumerContext: unknown, reference: GrantEvidenceReference, expectedVersion: number): GrantEvidenceIndexRow {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new ControlPlaneOwnershipError("INVALID_INPUT", "expectedVersion must be non-negative safe integer"); const owner = ownerFor(this.options, consumerContext); verifyGrant(this.options, reference, owner);
    const repository = normalizeRepositoryKey(reference.repository); bounded(reference.goal, "grant.goal"); bounded(reference.coordinatorThread, "grant.coordinatorThread"); bounded(reference.evidenceHash, "grant.evidenceHash");
    const now = new Date(this.now()).toISOString(); const tx = this.sqlite.transaction(() => { const current = this.sqlite.prepare("select * from control_plane_grant_evidence where repository=? and goal=? and coordinator_thread=?").get(repository, reference.goal, reference.coordinatorThread) as { version: number } | undefined; if (!current && expectedVersion !== 0) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "grant evidence row does not exist"); if (current && current.version !== expectedVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "grant evidence version changed"); const version = expectedVersion + 1; this.sqlite.prepare("insert into control_plane_grant_evidence(repository,goal,coordinator_thread,evidence_hash,version,updated_at) values(?,?,?,?,?,?) on conflict(repository,goal,coordinator_thread) do update set evidence_hash=excluded.evidence_hash, version=excluded.version, updated_at=excluded.updated_at").run(repository, reference.goal, reference.coordinatorThread, reference.evidenceHash, version, now); return this.getGrantEvidence(reference.repository, reference.goal, reference.coordinatorThread)!; }); return tx.immediate();
  }
  getGrantEvidence(repository: string, goal: string, coordinatorThread: string): GrantEvidenceIndexRow | undefined { const row = this.sqlite.prepare("select * from control_plane_grant_evidence where repository=? and goal=? and coordinator_thread=?").get(normalizeRepositoryKey(repository), goal, coordinatorThread) as { repository: string; goal: string; coordinator_thread: string; evidence_hash: string; version: number; updated_at: string } | undefined; if (row && (!Number.isSafeInteger(row.version) || row.version < 1 || !row.evidence_hash || !Number.isFinite(Date.parse(row.updated_at)))) throw new ControlPlaneOwnershipError("MALFORMED", "grant evidence row is malformed"); return row && { repository: row.repository, goal: row.goal, coordinatorThread: row.coordinator_thread, evidenceHash: row.evidence_hash, version: row.version, updatedAt: row.updated_at }; }
  acquire(consumerContext: unknown, input: ResourceLeaseInput): ResourceLease {
    const owner = ownerFor(this.options, consumerContext); verifyGrant(this.options, input.grant, owner);
    const repositoryKey = normalizeRepositoryKey(input.repositoryKey); if (normalizeRepositoryKey(input.grant.repository) !== repositoryKey) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "grant repository does not match the leased repository"); bounded(input.resourceKind, "resourceKind"); bounded(input.resourceId, "resourceId"); const scope = normalizeScope(input.scope); bounded(input.resource, "resource"); bounded(input.operation, "operation"); bounded(input.baseRevision, "baseRevision"); bounded(input.idempotencyKey, "idempotencyKey"); validExpiry(input.expiresAt, this.now());
    const now = new Date(this.now()).toISOString();
    const tx = this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare("select * from control_plane_resource_leases where repository_key=? and resource_kind=? and resource_id=? and idempotency_key=?").get(repositoryKey, input.resourceKind, input.resourceId, input.idempotencyKey) as LeaseRow | undefined;
      if (existing) {
        const current = rowLease(existing);
        if (current.ownerThread === owner.ownerThread && current.baseRevision === input.baseRevision && current.operation === input.operation && current.resource === input.resource && JSON.stringify(current.scope) === JSON.stringify(scope) && JSON.stringify(current.grant) === JSON.stringify(input.grant) && current.expiresAt === input.expiresAt && current.terminalState === undefined && Date.parse(current.expiresAt) > this.now()) return current;
        throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "idempotency key is bound to different lease evidence");
      }
      const active = this.sqlite.prepare("select * from control_plane_resource_leases where repository_key=? and resource_kind=? and resource_id=? and terminal_state is null").all(repositoryKey, input.resourceKind, input.resourceId) as LeaseRow[];
      for (const row of active) if (overlaps(scope, rowLease(row).scope)) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "overlapping resource scope is already leased");
      const leaseId = this.options.newId?.() ?? `lease_${randomUUID()}`; this.sqlite.prepare("insert into control_plane_resource_leases (lease_id,repository_key,resource_kind,resource_id,resource,operation,scope_json,base_revision,idempotency_key,owner_thread,grant_json,version,terminal_state,expires_at,created_at,updated_at,active_operation_handle,operation_state) values (?,?,?,?,?,?,?,?,?,?,?,1,null,?,?,?,null,null)").run(leaseId, repositoryKey, input.resourceKind, input.resourceId, input.resource, input.operation, JSON.stringify(scope), input.baseRevision, input.idempotencyKey, owner.ownerThread, JSON.stringify(input.grant), input.expiresAt, now, now);
      return rowLease(this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow);
    });
    return tx.immediate();
  }
  assertHeld(consumerContext: unknown, leaseId: string, expectedVersion: number, operation: string, baseRevision: string): ResourceLease {
    const owner = ownerFor(this.options, consumerContext); const row = this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow | undefined; if (!row) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "lease not found"); const lease = rowLease(row); verifyGrant(this.options, lease.grant, owner); if (lease.ownerThread !== owner.ownerThread || lease.version !== expectedVersion || lease.operation !== operation || lease.baseRevision !== baseRevision || lease.terminalState) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "lease evidence no longer matches"); if (Date.parse(lease.expiresAt) <= this.now()) throw new ControlPlaneOwnershipError("EXPIRED", "lease is expired and requires reconciliation"); return lease;
  }
  release(consumerContext: unknown, leaseId: string, expectedVersion: number): ResourceLease { return this.transition(consumerContext, leaseId, expectedVersion, "released"); }
  private transition(consumerContext: unknown, leaseId: string, expectedVersion: number, terminalState: "released" | "handed_off"): ResourceLease { const owner = ownerFor(this.options, consumerContext); const now = new Date(this.now()).toISOString(); const tx = this.sqlite.transaction(() => { const row = this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow | undefined; if (!row) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "lease not found"); const lease = rowLease(row); verifyGrant(this.options, lease.grant, owner); if (lease.operationHandle) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "active operation must finish or transfer before release"); const result = this.sqlite.prepare("update control_plane_resource_leases set terminal_state=?, version=version+1, updated_at=? where lease_id=? and owner_thread=? and version=? and terminal_state is null").run(terminalState, now, leaseId, owner.ownerThread, expectedVersion); if (result.changes !== 1) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "lease changed before transition"); return rowLease(this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow); }); return tx.immediate(); }
  beginOperation(consumerContext: unknown, leaseId: string, expectedVersion: number, handle: string): ResourceLease { bounded(handle, "operation handle"); const owner = ownerFor(this.options, consumerContext); const now = new Date(this.now()).toISOString(); const tx = this.sqlite.transaction(() => { const row = this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow | undefined; if (!row) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "lease not found"); const lease = rowLease(row); verifyGrant(this.options, lease.grant, owner); if (lease.ownerThread !== owner.ownerThread || lease.version !== expectedVersion || lease.terminalState || lease.operationHandle) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "operation pin no longer matches"); if (Date.parse(lease.expiresAt) <= this.now()) throw new ControlPlaneOwnershipError("EXPIRED", "lease is expired and requires reconciliation"); const result = this.sqlite.prepare("update control_plane_resource_leases set active_operation_handle=?, operation_state='active', version=version+1, updated_at=? where lease_id=? and owner_thread=? and version=? and terminal_state is null and active_operation_handle is null").run(handle, now, leaseId, owner.ownerThread, expectedVersion); if (result.changes !== 1) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "operation pin raced"); return rowLease(this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow); }); return tx.immediate(); }
  finishOperation(consumerContext: unknown, leaseId: string, expectedVersion: number, handle: string): ResourceLease { bounded(handle, "operation handle"); const owner = ownerFor(this.options, consumerContext); const now = new Date(this.now()).toISOString(); const tx = this.sqlite.transaction(() => { const row = this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow | undefined; if (!row) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "lease not found"); const lease = rowLease(row); verifyGrant(this.options, lease.grant, owner); const result = this.sqlite.prepare("update control_plane_resource_leases set active_operation_handle=null, operation_state='finished', version=version+1, updated_at=? where lease_id=? and owner_thread=? and version=? and active_operation_handle=? and terminal_state is null").run(now, leaseId, owner.ownerThread, expectedVersion, handle); if (result.changes !== 1) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "operation completion no longer matches"); return rowLease(this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow); }); return tx.immediate(); }
  handoff(consumerContext: unknown, leaseId: string, expectedVersion: number, recipientContext: unknown, receipt: HandoffInput): HandoffReceipt { const from = ownerFor(this.options, consumerContext); const to = ownerFor(this.options, recipientContext); if (from.ownerThread === to.ownerThread) throw new ControlPlaneOwnershipError("INVALID_INPUT", "handoff recipient must differ"); const now = new Date(this.now()).toISOString(); const tx = this.sqlite.transaction(() => { const row = this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow | undefined; if (!row) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "lease not found"); const lease = rowLease(row); verifyGrant(this.options, lease.grant, from); verifyGrant(this.options, lease.grant, to); if (lease.ownerThread !== from.ownerThread || lease.version !== expectedVersion || lease.terminalState || (lease.operationHandle && lease.operationHandle !== receipt.liveHandle)) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "lease changed or live operation handle is not explicitly transferred"); const newVersion = expectedVersion + 1; const result = this.sqlite.prepare("update control_plane_resource_leases set owner_thread=?, version=?, updated_at=? where lease_id=? and owner_thread=? and version=? and terminal_state is null").run(to.ownerThread, newVersion, now, leaseId, from.ownerThread, expectedVersion); if (result.changes !== 1) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "lease changed before handoff"); const value: HandoffReceipt = { schema: CONTROL_PLANE_SCHEMA, receiptId: this.options.newId?.() ?? `handoff_${randomUUID()}`, leaseId, resource: lease.resource, fromOwnerThread: from.ownerThread, toOwnerThread: to.ownerThread, previousVersion: expectedVersion, newVersion, baseRevision: lease.baseRevision, candidateRevision: receipt.candidateRevision, liveOperation: receipt.liveOperation, liveHandle: receipt.liveHandle, grantDependency: lease.grant, forbiddenOverlap: receipt.forbiddenOverlap, tests: receipt.tests, evidence: receipt.evidence, remainingGap: receipt.remainingGap, nextGate: receipt.nextGate, expiresAt: receipt.expiresAt, createdAt: now }; const json = JSON.stringify(value); if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw new ControlPlaneOwnershipError("INVALID_INPUT", "handoff receipt is too large"); this.sqlite.prepare("insert into control_plane_handoff_receipts (receipt_id,lease_id,resource,from_owner_thread,to_owner_thread,previous_version,new_version,receipt_json,created_at) values (?,?,?,?,?,?,?,?,?)").run(value.receiptId, leaseId, lease.resource, from.ownerThread, to.ownerThread, expectedVersion, newVersion, json, now); return value; }); return tx.immediate(); }
  get(leaseId: string): ResourceLease | undefined { const row = this.sqlite.prepare("select * from control_plane_resource_leases where lease_id=?").get(leaseId) as LeaseRow | undefined; return row ? rowLease(row) : undefined; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}

export interface HandoffReceipt { schema: typeof CONTROL_PLANE_SCHEMA; receiptId: string; leaseId: string; resource: string; fromOwnerThread: string; toOwnerThread: string; previousVersion: number; newVersion: number; baseRevision: string; candidateRevision: string; liveOperation: string; liveHandle: string; grantDependency: GrantEvidenceReference; forbiddenOverlap: readonly string[]; tests: readonly string[]; evidence: readonly string[]; remainingGap: string; nextGate: string; expiresAt: string; createdAt: string; }
export type HandoffInput = Pick<HandoffReceipt, "resource" | "candidateRevision" | "liveOperation" | "liveHandle" | "forbiddenOverlap" | "tests" | "evidence" | "remainingGap" | "nextGate" | "expiresAt">;
