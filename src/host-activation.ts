import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const HOST_ACTIVATION_MANIFEST_SCHEMA = "devspace.host_activation_manifest.v1" as const;
export const HOST_ACTIVATION_RECEIPT_SCHEMA = "devspace.host_activation_receipt.v1" as const;
export const HOST_ACTIVATION_KINDS = ["OPENCLI_CHATGPT_ADAPTER_OVERLAY", "DEVSPACE_CONTROL_PLANE_CUTOVER"] as const;
export type HostActivationKind = typeof HOST_ACTIVATION_KINDS[number];

export type HostActivationClassification =
  | "CONFIRMED_NO_EFFECT"
  | "APPLIED"
  | "PARTIAL_EFFECT"
  | "ROLLED_BACK"
  | "EFFECT_UNKNOWN"
  | "BLOCKED_PREIMAGE_DRIFT";

export interface HostActivationReplaceExactUtf8 {
  kind: "replace_exact_utf8";
  oldText: string;
  newText: string;
}

export interface HostActivationTarget {
  targetId: string;
  path: string;
  expectedPreimageSha256: string;
  expectedPostimageSha256: string;
  transform: HostActivationReplaceExactUtf8;
}

export interface HostActivationManifest {
  schema: typeof HOST_ACTIVATION_MANIFEST_SCHEMA;
  kind: HostActivationKind;
  receiptDir: string;
  targets: HostActivationTarget[];
}

export interface BoundHostActivation {
  manifestPath: string;
  manifestSha256: string;
  kind: HostActivationKind;
  receiptDir: string;
  targets: readonly Readonly<Pick<HostActivationTarget, "targetId" | "path" | "expectedPreimageSha256" | "expectedPostimageSha256">>[];
}

export interface HostActivationTargetObservation {
  targetId: string;
  path: string;
  currentSha256?: string;
  state: "preimage" | "postimage" | "other" | "unreadable";
}

export interface HostActivationObservation {
  classification: HostActivationClassification;
  manifestSha256: string;
  kind: HostActivationKind;
  receiptPath: string;
  rollbackDir: string;
  receiptPresent: boolean;
  changedByOperation?: boolean;
  targets: HostActivationTargetObservation[];
}

export interface HostActivationReceipt extends HostActivationObservation {
  schema: typeof HOST_ACTIVATION_RECEIPT_SCHEMA;
  operationId: string;
  createdAt: string;
  error?: string;
}

export interface HostActivationTestHooks {
  beforeTargetWrite?: (target: HostActivationTarget, index: number) => Promise<void> | void;
}

export class HostActivationError extends Error {
  constructor(
    readonly code:
      | "HOST_ACTIVATION_INVALID"
      | "HOST_ACTIVATION_SCOPE_DENIED"
      | "BLOCKED_PREIMAGE_DRIFT"
      | "HOST_ACTIVATION_EFFECT_UNKNOWN",
    message: string,
  ) {
    super(message);
    this.name = "HostActivationError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTIVATION_MANIFEST_FLAG = "--activation-manifest";

export function hostActivationManifestPathFromArgv(argv: readonly string[]): string | undefined {
  const indices = argv.flatMap((value, index) => value === ACTIVATION_MANIFEST_FLAG ? [index] : []);
  if (indices.length === 0) return undefined;
  if (indices.length !== 1) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation argv must contain exactly one --activation-manifest flag.");
  const value = argv[indices[0]! + 1];
  if (!value || !isAbsolute(value)) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation manifest path must be absolute.");
  return resolve(value);
}

export async function bindHostActivation(
  manifestPath: string,
  allowedWritePaths: readonly string[],
  allowedReadPaths: readonly string[],
): Promise<BoundHostActivation> {
  const canonicalWritePaths = await Promise.all(allowedWritePaths.map((path) => canonicalScopePath(path, "activation write scope")));
  const canonicalReadPaths = await Promise.all(allowedReadPaths.map((path) => canonicalScopePath(path, "activation read scope")));
  const canonicalManifest = await canonicalExistingFile(manifestPath, "activation manifest");
  assertAllowed(canonicalManifest, canonicalReadPaths, "activation manifest");
  const raw = await readFile(canonicalManifest);
  const manifestSha256 = sha256(raw);
  const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
  const canonicalReceiptDir = await canonicalFutureDirectory(manifest.receiptDir, "activation receipt directory");
  assertAllowed(canonicalReceiptDir, canonicalWritePaths, "activation receipt directory");
  const seen = new Set<string>();
  const targets: Array<Pick<HostActivationTarget, "targetId" | "path" | "expectedPreimageSha256" | "expectedPostimageSha256">> = [];
  for (const target of manifest.targets) {
    if (seen.has(target.targetId)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `Duplicate activation target id: ${target.targetId}`);
    seen.add(target.targetId);
    const canonicalTarget = await canonicalExistingFile(target.path, `activation target ${target.targetId}`);
    assertAllowed(canonicalTarget, canonicalWritePaths, `activation target ${target.targetId}`);
    targets.push({
      targetId: target.targetId,
      path: canonicalTarget,
      expectedPreimageSha256: target.expectedPreimageSha256,
      expectedPostimageSha256: target.expectedPostimageSha256,
    });
  }
  return Object.freeze({
    manifestPath: canonicalManifest,
    manifestSha256,
    kind: manifest.kind,
    receiptDir: canonicalReceiptDir,
    targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
  });
}

export async function preflightHostActivation(binding: BoundHostActivation): Promise<HostActivationObservation> {
  return observeBoundActivation(binding, undefined);
}

export async function applyHostActivation(
  manifestPath: string,
  expectedManifestSha256: string,
  operationId: string,
  allowedWritePaths: readonly string[],
  allowedReadPaths: readonly string[],
  hooks: HostActivationTestHooks = {},
): Promise<HostActivationReceipt> {
  assertOperationId(operationId);
  if (!SHA256.test(expectedManifestSha256)) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Expected activation manifest hash is malformed.");
  const binding = await bindHostActivation(manifestPath, allowedWritePaths, allowedReadPaths);
  if (binding.manifestSha256 !== expectedManifestSha256) {
    throw new HostActivationError("BLOCKED_PREIMAGE_DRIFT", "Activation manifest changed after durable binding.");
  }
  const raw = await readFile(binding.manifestPath);
  const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
  await mkdir(binding.receiptDir, { recursive: true });
  const receiptPath = hostActivationReceiptPath(binding.receiptDir, operationId);
  const rollbackDir = hostActivationRollbackDir(binding.receiptDir, operationId);
  const initial = await observeBoundActivation(binding, operationId);
  if (initial.targets.every((target) => target.state === "postimage")) {
    return persistReceipt({
      ...initial,
      classification: "EFFECT_UNKNOWN",
      changedByOperation: false,
      schema: HOST_ACTIVATION_RECEIPT_SCHEMA,
      operationId,
      createdAt: new Date().toISOString(),
      error: "Targets match the declared postimages but no prior receipt proves this operation produced them.",
    });
  }
  if (!initial.targets.every((target) => target.state === "preimage")) {
    return persistReceipt({
      ...initial,
      classification: "BLOCKED_PREIMAGE_DRIFT",
      changedByOperation: false,
      schema: HOST_ACTIVATION_RECEIPT_SCHEMA,
      operationId,
      createdAt: new Date().toISOString(),
      error: "One or more activation targets no longer match the exact expected preimage.",
    });
  }

  const postimages = new Map<string, Buffer>();
  const originals = new Map<string, Buffer>();
  for (const target of manifest.targets) {
    const boundTarget = binding.targets.find((value) => value.targetId === target.targetId)!;
    const original = await readFile(boundTarget.path);
    if (sha256(original) !== target.expectedPreimageSha256) {
      return persistReceipt({
        ...(await observeBoundActivation(binding, operationId)),
        classification: "BLOCKED_PREIMAGE_DRIFT",
        changedByOperation: false,
        schema: HOST_ACTIVATION_RECEIPT_SCHEMA,
        operationId,
        createdAt: new Date().toISOString(),
        error: `Target ${target.targetId} changed before rollback preparation completed.`,
      });
    }
    const postimage = applyTransform(original, target);
    if (sha256(postimage) !== target.expectedPostimageSha256) {
      throw new HostActivationError("HOST_ACTIVATION_INVALID", `Deterministic postimage hash mismatch for target ${target.targetId}.`);
    }
    originals.set(target.targetId, original);
    postimages.set(target.targetId, postimage);
  }

  await mkdir(rollbackDir, { recursive: false });
  const rollbackManifest: Record<string, { path: string; sha256: string; backup: string }> = {};
  for (const target of manifest.targets) {
    const boundTarget = binding.targets.find((value) => value.targetId === target.targetId)!;
    const backup = join(rollbackDir, `${safeName(target.targetId)}.bin`);
    await writeFile(backup, originals.get(target.targetId)!);
    rollbackManifest[target.targetId] = { path: boundTarget.path, sha256: target.expectedPreimageSha256, backup };
  }
  await writeFile(join(rollbackDir, "manifest.json"), JSON.stringify({ schema: "devspace.host_activation_rollback.v1", operationId, manifestSha256: binding.manifestSha256, targets: rollbackManifest }, null, 2));

  let failure: unknown;
  try {
    for (let index = 0; index < manifest.targets.length; index += 1) {
      const target = manifest.targets[index]!;
      await hooks.beforeTargetWrite?.(target, index);
      const boundTarget = binding.targets.find((value) => value.targetId === target.targetId)!;
      await atomicReplace(boundTarget.path, postimages.get(target.targetId)!, operationId);
      const digest = sha256(await readFile(boundTarget.path));
      if (digest !== target.expectedPostimageSha256) throw new Error(`Postimage verification failed for ${target.targetId}`);
    }
  } catch (error) {
    failure = error;
  }

  if (failure === undefined) {
    const observed = await observeBoundActivation(binding, operationId);
    if (observed.targets.every((target) => target.state === "postimage")) {
      return persistReceipt({ ...observed, classification: "APPLIED", changedByOperation: true, schema: HOST_ACTIVATION_RECEIPT_SCHEMA, operationId, createdAt: new Date().toISOString() });
    }
    failure = new Error("Physical postimage readback did not match every activation target.");
  }

  const rollbackErrors: string[] = [];
  for (const target of [...manifest.targets].reverse()) {
    const boundTarget = binding.targets.find((value) => value.targetId === target.targetId)!;
    try {
      await atomicReplace(boundTarget.path, originals.get(target.targetId)!, `${operationId}-rollback`);
    } catch (error) {
      rollbackErrors.push(`${target.targetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const afterRollback = await observeBoundActivation(binding, operationId);
  const rollbackComplete = rollbackErrors.length === 0 && afterRollback.targets.every((target) => target.state === "preimage");
  const classification: HostActivationClassification = rollbackComplete
    ? "ROLLED_BACK"
    : afterRollback.targets.some((target) => target.state === "postimage")
      ? "PARTIAL_EFFECT"
      : "EFFECT_UNKNOWN";
  return persistReceipt({
    ...afterRollback,
    classification,
    changedByOperation: true,
    schema: HOST_ACTIVATION_RECEIPT_SCHEMA,
    operationId,
    createdAt: new Date().toISOString(),
    error: [failure instanceof Error ? failure.message : String(failure), ...rollbackErrors].filter(Boolean).join("; "),
  });

  async function persistReceipt(receipt: HostActivationReceipt): Promise<HostActivationReceipt> {
    const persisted = { ...receipt, receiptPresent: true };
    await writeFile(receiptPath, JSON.stringify(persisted, null, 2));
    return persisted;
  }
}

export async function reconcileHostActivation(binding: BoundHostActivation, operationId: string): Promise<HostActivationObservation> {
  assertOperationId(operationId);
  return observeBoundActivation(binding, operationId);
}

async function observeBoundActivation(binding: BoundHostActivation, operationId: string | undefined): Promise<HostActivationObservation> {
  const targets: HostActivationTargetObservation[] = [];
  for (const target of binding.targets) {
    try {
      const currentSha256 = sha256(await readFile(target.path));
      targets.push({
        targetId: target.targetId,
        path: target.path,
        currentSha256,
        state: currentSha256 === target.expectedPreimageSha256 ? "preimage" : currentSha256 === target.expectedPostimageSha256 ? "postimage" : "other",
      });
    } catch {
      targets.push({ targetId: target.targetId, path: target.path, state: "unreadable" });
    }
  }
  const receiptPath = hostActivationReceiptPath(binding.receiptDir, operationId ?? "preflight");
  const rollbackDir = hostActivationRollbackDir(binding.receiptDir, operationId ?? "preflight");
  const prior = operationId ? await readReceipt(receiptPath, operationId, binding.manifestSha256) : undefined;
  const allPre = targets.every((target) => target.state === "preimage");
  const allPost = targets.every((target) => target.state === "postimage");
  const anyUnreadable = targets.some((target) => target.state === "unreadable");
  const anyPost = targets.some((target) => target.state === "postimage");
  let classification: HostActivationClassification;
  if (prior?.classification === "BLOCKED_PREIMAGE_DRIFT") classification = "BLOCKED_PREIMAGE_DRIFT";
  else if (prior?.classification === "ROLLED_BACK" && allPre) classification = "ROLLED_BACK";
  else if (prior?.classification === "APPLIED" && allPost) classification = "APPLIED";
  else if (allPre) classification = "CONFIRMED_NO_EFFECT";
  else if (allPost) classification = "EFFECT_UNKNOWN";
  else if (anyUnreadable) classification = "EFFECT_UNKNOWN";
  else if (anyPost) classification = "PARTIAL_EFFECT";
  else classification = "EFFECT_UNKNOWN";
  return {
    classification,
    manifestSha256: binding.manifestSha256,
    kind: binding.kind,
    receiptPath,
    rollbackDir,
    receiptPresent: prior !== undefined,
    changedByOperation: prior?.changedByOperation,
    targets,
  };
}

async function readReceipt(path: string, operationId: string, manifestSha256: string): Promise<HostActivationReceipt | undefined> {
  try {
    const parsed = JSON.parse((await readFile(path)).toString("utf8")) as Partial<HostActivationReceipt>;
    if (parsed.schema !== HOST_ACTIVATION_RECEIPT_SCHEMA || parsed.operationId !== operationId || parsed.manifestSha256 !== manifestSha256) return undefined;
    if (!HOST_ACTIVATION_KINDS.includes(parsed.kind as HostActivationKind)) return undefined;
    if (!isClassification(parsed.classification)) return undefined;
    return parsed as HostActivationReceipt;
  } catch {
    return undefined;
  }
}

function parseManifest(value: unknown): HostActivationManifest {
  if (!value || typeof value !== "object") throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation manifest must be an object.");
  const raw = value as Partial<HostActivationManifest>;
  if (raw.schema !== HOST_ACTIVATION_MANIFEST_SCHEMA) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Unsupported activation manifest schema.");
  if (!HOST_ACTIVATION_KINDS.includes(raw.kind as HostActivationKind)) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Unsupported activation kind.");
  if (typeof raw.receiptDir !== "string" || !isAbsolute(raw.receiptDir)) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation receiptDir must be absolute.");
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation manifest requires at least one target.");
  const targets = raw.targets.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation target must be an object.");
    const target = candidate as Partial<HostActivationTarget>;
    if (typeof target.targetId !== "string" || !TARGET_ID.test(target.targetId)) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Activation targetId is malformed.");
    if (typeof target.path !== "string" || !isAbsolute(target.path)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `Activation target ${target.targetId} path must be absolute.`);
    if (typeof target.expectedPreimageSha256 !== "string" || !SHA256.test(target.expectedPreimageSha256)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `Activation target ${target.targetId} preimage hash is malformed.`);
    if (typeof target.expectedPostimageSha256 !== "string" || !SHA256.test(target.expectedPostimageSha256)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `Activation target ${target.targetId} postimage hash is malformed.`);
    if (!target.transform || target.transform.kind !== "replace_exact_utf8" || typeof target.transform.oldText !== "string" || typeof target.transform.newText !== "string" || target.transform.oldText.length === 0) throw new HostActivationError("HOST_ACTIVATION_INVALID", `Activation target ${target.targetId} transform is malformed.`);
    return {
      targetId: target.targetId,
      path: resolve(target.path),
      expectedPreimageSha256: target.expectedPreimageSha256,
      expectedPostimageSha256: target.expectedPostimageSha256,
      transform: { kind: "replace_exact_utf8" as const, oldText: target.transform.oldText, newText: target.transform.newText },
    };
  });
  return { schema: HOST_ACTIVATION_MANIFEST_SCHEMA, kind: raw.kind as HostActivationKind, receiptDir: resolve(raw.receiptDir), targets };
}

function applyTransform(original: Buffer, target: HostActivationTarget): Buffer {
  const source = original.toString("utf8");
  const first = source.indexOf(target.transform.oldText);
  if (first < 0 || source.indexOf(target.transform.oldText, first + target.transform.oldText.length) >= 0) {
    throw new HostActivationError("BLOCKED_PREIMAGE_DRIFT", `Activation target ${target.targetId} replacement anchor must match exactly once.`);
  }
  return Buffer.from(source.slice(0, first) + target.transform.newText + source.slice(first + target.transform.oldText.length), "utf8");
}

async function canonicalExistingFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} must be absolute.`);
  const requested = resolve(path);
  const info = await lstat(requested).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} must be a regular non-symlink file.`);
  return realpath(requested);
}

async function canonicalScopePath(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} must be absolute.`);
  const requested = resolve(path);
  const info = await lstat(requested).catch(() => undefined);
  if (!info || info.isSymbolicLink()) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} must be an existing non-symlink path.`);
  return realpath(requested);
}

async function canonicalFutureDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} must be absolute.`);
  const requested = resolve(path);
  try {
    const info = await lstat(requested);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} must be a regular non-symlink directory.`);
    return realpath(requested);
  } catch (error) {
    if (error instanceof HostActivationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} could not be inspected.`);
    const parent = dirname(requested);
    const parentInfo = await lstat(parent).catch(() => undefined);
    if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) throw new HostActivationError("HOST_ACTIVATION_INVALID", `${label} parent must be a regular non-symlink directory.`);
    const canonicalParent = await realpath(parent);
    return join(canonicalParent, basename(requested));
  }
}

function assertAllowed(path: string, allowed: readonly string[], label: string): void {
  const requested = resolve(path);
  if (!allowed.some((root) => pathWithin(requested, resolve(root)))) {
    throw new HostActivationError("HOST_ACTIVATION_SCOPE_DENIED", `${label} is outside the startup-approved host operation scope.`);
  }
}

function pathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function atomicReplace(path: string, content: Buffer, operationId: string): Promise<void> {
  const current = await stat(path);
  const temp = join(dirname(path), `.${basename(path)}.${safeName(operationId)}.tmp`);
  await writeFile(temp, content, { mode: current.mode });
  await rename(temp, path);
}

function hostActivationReceiptPath(receiptDir: string, operationId: string): string {
  return join(receiptDir, `${safeName(operationId)}.json`);
}

function hostActivationRollbackDir(receiptDir: string, operationId: string): string {
  return join(receiptDir, `${safeName(operationId)}.rollback`);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) throw new HostActivationError("HOST_ACTIVATION_INVALID", "Host activation operation id is malformed.");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isClassification(value: unknown): value is HostActivationClassification {
  return ["CONFIRMED_NO_EFFECT", "APPLIED", "PARTIAL_EFFECT", "ROLLED_BACK", "EFFECT_UNKNOWN", "BLOCKED_PREIMAGE_DRIFT"].includes(String(value));
}
