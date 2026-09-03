import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CUTOVER_LEASE_SCHEMA = "devspace.cutover_lease.v1" as const;
export const DEFAULT_CUTOVER_LEASE_TTL_MS = 10 * 60 * 1_000;

export interface CutoverLease {
  schema: typeof CUTOVER_LEASE_SCHEMA;
  leaseId: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  reason: "deployment_cutover" | "maintenance";
}

export interface AcquireCutoverLeaseInput {
  stateRoot: string;
  serverInstanceId: string;
  leaseId?: string;
  ttlMs?: number;
  now?: () => number;
  reason?: CutoverLease["reason"];
}

export interface AcquireCutoverLeaseResult {
  acquired: boolean;
  lease?: CutoverLease;
  existing?: CutoverLease;
  reason: "acquired" | "held" | "replaced_expired";
}

function leasePath(stateRoot: string): string {
  return join(stateRoot, "cutover-lease.json");
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}
export async function readCutoverLease(stateRoot: string): Promise<CutoverLease | undefined> {
  try {
    const leaseFile = leasePath(stateRoot);
    const raw = await readFile(leaseFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<CutoverLease>;
    if (parsed.schema !== CUTOVER_LEASE_SCHEMA) {
      return undefined;
    }
    if (parsed.leaseId) {
      if (parsed.holder) {
        if (parsed.acquiredAt) {
          if (parsed.expiresAt) {
            return parsed as CutoverLease;
          }
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
export async function acquireCutoverLease(
  input: AcquireCutoverLeaseInput,
): Promise<AcquireCutoverLeaseResult> {
  const nowMs = input.now?.() ?? Date.now();
  const lease: CutoverLease = {
    schema: CUTOVER_LEASE_SCHEMA,
    leaseId: input.leaseId ?? randomUUID(),
    holder: input.serverInstanceId,
    acquiredAt: nowIso(nowMs),
    expiresAt: nowIso(nowMs + (input.ttlMs ?? DEFAULT_CUTOVER_LEASE_TTL_MS)),
    reason: input.reason ?? "deployment_cutover",
  };
  const path = leasePath(input.stateRoot);
  const leaseJson = JSON.stringify(lease, null, 2);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, leaseJson, { flag: "wx" });
    return { acquired: true, lease, reason: "acquired" };
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "EEXIST") throw error;
    const existing = await readCutoverLease(input.stateRoot);



  if (existing) {
    const expiresMs = new Date(existing.expiresAt).getTime();
    if (expiresMs > nowMs) {

      return { acquired: false, existing, lease, reason: "held" };
    }
  }

  try {
    await unlink(path);
  } catch (error: unknown) {
    const errno2 = error as NodeJS.ErrnoException;
    if (errno2.code !== "ENOENT") throw error;
  }

  try {
    await writeFile(path, leaseJson, { flag: "wx" });
    return { acquired: true, lease, reason: "replaced_expired" };
  } catch (error: unknown) {
    const errno3 = error as NodeJS.ErrnoException;
    if (errno3.code === "EEXIST") {
      const recheck = await readCutoverLease(input.stateRoot);
      return { acquired: false, existing: recheck, lease, reason: "held" };
    }
    throw error;
  }
}
}

export async function releaseCutoverLease(
  stateRoot: string,
  expectedHolder: string,
): Promise<{ released: boolean; existing?: CutoverLease }> {
  const existing = await readCutoverLease(stateRoot);



  if (!existing) {

    return { released: false };
  }
  if (existing.holder !== expectedHolder) {

    return { released: false, existing };
  }
  try {
    await unlink(leasePath(stateRoot));

    return { released: true };
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {

      return { released: false };
    }
    throw error;
  }
}
