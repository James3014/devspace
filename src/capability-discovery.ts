import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const CAPABILITY_DISCOVERY_RECEIPT_SCHEMA = "nexus.capability_discovery_receipt.v1" as const;
export const CAPABILITY_DISCOVERY_INDEX_SCHEMA = "nexus.capability_discovery_index.v1" as const;
export const CAPABILITY_DISCOVERY_INDEX_PATH = "docs/agents/CAPABILITY_DISCOVERY_INDEX.v1.json" as const;
export const NEXUS_CAPABILITY_REPOSITORY = "James3014/Nexus-new" as const;

export type CapabilityDiscoveryDisposition =
  | "REUSE_EXISTING"
  | "EXTEND_EXISTING"
  | "WRAP_EXISTING"
  | "NEW_CAPABILITY_JUSTIFIED"
  | "BLOCKED_UNKNOWN";

export interface CapabilityDiscoveryReceipt {
  schema: typeof CAPABILITY_DISCOVERY_RECEIPT_SCHEMA;
  repository: typeof NEXUS_CAPABILITY_REPOSITORY;
  indexRevision: string;
  indexPath: typeof CAPABILITY_DISCOVERY_INDEX_PATH;
  indexSha256: string;
  intent: string;
  disposition: CapabilityDiscoveryDisposition;
  matchedCapabilityIds: string[];
  evidence: {
    architecture: string[];
    source: string[];
    history: string[];
    runtime: string[];
  };
  newCapabilityJustification?: string;
}

export interface CapabilityDiscoveryIndexEntry {
  id: string;
  canonicalOwnerRepository: string;
  components: string[];
  evidenceRefs: string[];
  doNotDuplicateBeforeEvaluation: string[];
}

export interface CapabilityDiscoveryVerification {
  receipt: CapabilityDiscoveryReceipt;
  matchedCapabilities: CapabilityDiscoveryIndexEntry[];
}

export class CapabilityDiscoveryError extends Error {
  constructor(readonly code: "CAPABILITY_DISCOVERY_REQUIRED" | "INVALID_CAPABILITY_DISCOVERY" | "CAPABILITY_DISCOVERY_STALE", message: string) {
    super(message);
    this.name = "CapabilityDiscoveryError";
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, label: string, min = 0): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", `${label} must be an array of non-empty strings.`);
  }
  const result = value.map((item) => item.trim());
  if (result.length < min) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", `${label} must contain at least ${min} item(s).`);
  }
  return result;
}

export function parseCapabilityDiscoveryReceipt(value: unknown): CapabilityDiscoveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_REQUIRED", "Mutating delegated execution requires a capability discovery receipt.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== CAPABILITY_DISCOVERY_RECEIPT_SCHEMA) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Capability discovery receipt schema mismatch.");
  }
  if (record.repository !== NEXUS_CAPABILITY_REPOSITORY) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Capability discovery receipt repository must be canonical Nexus-new.");
  }
  if (record.indexPath !== CAPABILITY_DISCOVERY_INDEX_PATH) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Capability discovery receipt indexPath is not canonical.");
  }
  const revision = requireText(record.indexRevision, "indexRevision");
  const sha = requireText(record.indexSha256, "indexSha256");
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "indexRevision must be a 40-character lowercase Git SHA.");
  if (!/^[0-9a-f]{64}$/u.test(sha)) throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "indexSha256 must be a SHA-256 digest.");
  const disposition = record.disposition as CapabilityDiscoveryDisposition;
  if (!["REUSE_EXISTING", "EXTEND_EXISTING", "WRAP_EXISTING", "NEW_CAPABILITY_JUSTIFIED", "BLOCKED_UNKNOWN"].includes(disposition)) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Capability discovery disposition is unsupported.");
  }
  if (!record.evidence || typeof record.evidence !== "object" || Array.isArray(record.evidence)) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Capability discovery evidence must be an object.");
  }
  const evidence = record.evidence as Record<string, unknown>;
  const receipt: CapabilityDiscoveryReceipt = {
    schema: CAPABILITY_DISCOVERY_RECEIPT_SCHEMA,
    repository: NEXUS_CAPABILITY_REPOSITORY,
    indexRevision: revision,
    indexPath: CAPABILITY_DISCOVERY_INDEX_PATH,
    indexSha256: sha,
    intent: requireText(record.intent, "intent"),
    disposition,
    matchedCapabilityIds: requireStringArray(record.matchedCapabilityIds, "matchedCapabilityIds"),
    evidence: {
      architecture: requireStringArray(evidence.architecture, "evidence.architecture", 1),
      source: requireStringArray(evidence.source, "evidence.source", 1),
      history: requireStringArray(evidence.history, "evidence.history", 1),
      runtime: requireStringArray(evidence.runtime, "evidence.runtime", 1),
    },
    ...(record.newCapabilityJustification === undefined ? {} : { newCapabilityJustification: requireText(record.newCapabilityJustification, "newCapabilityJustification") }),
  };
  if (["REUSE_EXISTING", "EXTEND_EXISTING", "WRAP_EXISTING"].includes(receipt.disposition) && receipt.matchedCapabilityIds.length === 0) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", `${receipt.disposition} requires at least one matched capability.`);
  }
  if (receipt.disposition === "NEW_CAPABILITY_JUSTIFIED") {
    if (receipt.matchedCapabilityIds.length !== 0) {
      throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "NEW_CAPABILITY_JUSTIFIED must not claim a matched donor capability.");
    }
    if (!receipt.newCapabilityJustification) {
      throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "NEW_CAPABILITY_JUSTIFIED requires an explicit justification.");
    }
  }
  return receipt;
}

interface VerificationOptions {
  observeCanonicalMain?: () => string;
  fetchIndex?: (revision: string, path: string) => Promise<string>;
}

const RAW_HOST = "raw.githubusercontent.com";
const NEXUS_REMOTE = "https://github.com/James3014/Nexus-new.git";
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

function observeCanonicalMainDefault(): string {
  const probe = spawnSync("git", ["ls-remote", NEXUS_REMOTE, "refs/heads/main"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024,
  });
  if (probe.error || probe.status !== 0) {
    throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_STALE", `Unable to resolve canonical Nexus main: ${probe.error?.message ?? String(probe.stderr || probe.status)}`);
  }
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main\s*$/mu.exec(String(probe.stdout || ""));
  if (!match) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_STALE", "Canonical Nexus main probe returned malformed identity.");
  return match[1]!;
}

async function fetchIndexDefault(revision: string, path: string): Promise<string> {
  const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const response = await fetch(`https://${RAW_HOST}/James3014/Nexus-new/${revision}/${encodedPath}`, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json,text/plain" },
  });
  if (!response.ok || new URL(response.url).hostname !== RAW_HOST) {
    throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_STALE", `Capability discovery index fetch failed closed (HTTP ${response.status}).`);
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Capability discovery index exceeds bounded size limit.");
  }
  return raw;
}

export async function verifyCapabilityDiscoveryReceipt(receipt: CapabilityDiscoveryReceipt, options: VerificationOptions = {}): Promise<CapabilityDiscoveryVerification> {
  if (receipt.disposition === "BLOCKED_UNKNOWN") {
    throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_REQUIRED", "BLOCKED_UNKNOWN cannot authorize a mutating worker; complete discovery first.");
  }
  const observedMain = (options.observeCanonicalMain ?? observeCanonicalMainDefault)();
  if (observedMain !== receipt.indexRevision) {
    throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_STALE", `Discovery receipt is bound to ${receipt.indexRevision}, current Nexus main is ${observedMain}.`);
  }
  const raw = await (options.fetchIndex ?? fetchIndexDefault)(receipt.indexRevision, receipt.indexPath);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== receipt.indexSha256) {
    throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_STALE", "Discovery index bytes do not match indexSha256.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Discovery index is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Discovery index root is malformed.");
  const root = parsed as Record<string, unknown>;
  if (root.schema !== CAPABILITY_DISCOVERY_INDEX_SCHEMA || !Array.isArray(root.capabilities)) {
    throw new CapabilityDiscoveryError("INVALID_CAPABILITY_DISCOVERY", "Discovery index schema/capabilities mismatch.");
  }
  const entries = new Map<string, CapabilityDiscoveryIndexEntry>();
  for (const item of root.capabilities) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) continue;
    entries.set(id, {
      id,
      canonicalOwnerRepository: typeof record.canonicalOwnerRepository === "string" ? record.canonicalOwnerRepository : "unknown",
      components: Array.isArray(record.components) ? record.components.filter((value): value is string => typeof value === "string") : [],
      evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter((value): value is string => typeof value === "string") : [],
      doNotDuplicateBeforeEvaluation: Array.isArray(record.doNotDuplicateBeforeEvaluation) ? record.doNotDuplicateBeforeEvaluation.filter((value): value is string => typeof value === "string") : [],
    });
  }
  const matchedCapabilities = receipt.matchedCapabilityIds.map((id) => {
    const entry = entries.get(id);
    if (!entry) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_STALE", `Matched capability '${id}' is absent from the current index.`);
    return entry;
  });
  return { receipt, matchedCapabilities };
}

export function renderCapabilityDiscoveryForWorker(verification: CapabilityDiscoveryVerification): string {
  return [
    "DEVSPACE CAPABILITY DISCOVERY — verified reuse-before-invention context.",
    "This is navigation evidence, not routing, approval, integration, release, or production authority.",
    JSON.stringify({
      intent: verification.receipt.intent,
      disposition: verification.receipt.disposition,
      evidence: verification.receipt.evidence,
      matchedCapabilities: verification.matchedCapabilities,
      ...(verification.receipt.newCapabilityJustification ? { newCapabilityJustification: verification.receipt.newCapabilityJustification } : {}),
    }),
  ].join("\n");
}
