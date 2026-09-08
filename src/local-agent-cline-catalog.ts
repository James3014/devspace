import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

export const CLINE_CATALOG_SOURCE = "https://github.com/cline/cline/blob/main/docs/api/models.mdx";
export const CLINE_CLI_SOURCE = "https://github.com/cline/cline/blob/main/apps/cli/README.md";
export const CLINE_RECOMMENDED_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
export const CLINE_THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh"] as const;
export type ClineThinkingLevel = (typeof CLINE_THINKING_LEVELS)[number];

export type ClineCatalogState = "READY" | "UNKNOWN" | "BLOCKED";
export type ClineFreeStatus = "known-free" | "known-paid" | "unknown";

export interface ClineCatalogEntry {
  cliProviderId: "cline" | "cline-pass";
  catalogTier: "free" | "pass";
  modelProviderId: string;
  modelId: string;
  fullName: string;
  routeKey: string;
  thinking: readonly ClineThinkingLevel[];
  thinkingKnown: boolean;
  supportsReasoning: boolean | "unknown";
  free: ClineFreeStatus;
  accountEntitlement: "unknown";
  source: "cline-api" | "fixture";
}

export interface ClineRuntimeIdentity {
  command: string;
  cliProviderId: "cline";
  version: string;
  supportsProviderFlag: boolean;
  supportsModelFlag: boolean;
  supportedThinking: readonly ClineThinkingLevel[];
}

export interface ClineCatalogSnapshot {
  state: ClineCatalogState;
  entries: readonly ClineCatalogEntry[];
  fetchedAt?: string;
  expiresAt?: string;
  generation: string;
  runtime: ClineRuntimeIdentity;
  endpoint?: string;
  source: "cline-api" | "cli-capability" | "fixture" | "none";
  diagnostic?: string;
  lastSuccessfulAt?: string;
  retryAfter?: string;
}

export function isClineCatalogFresh(snapshot: Pick<ClineCatalogSnapshot, "state" | "fetchedAt" | "expiresAt">, now = Date.now()): boolean {
  const fetched = snapshot.fetchedAt ? Date.parse(snapshot.fetchedAt) : NaN;
  const expires = snapshot.expiresAt ? Date.parse(snapshot.expiresAt) : NaN;
  return snapshot.state === "READY"
    && Number.isFinite(fetched)
    && fetched <= now
    && Number.isFinite(expires)
    && now < expires;
}

export interface ClineCatalogResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface ClineCatalogOptions {
  command?: string;
  endpoint?: string;
  fetchCatalog?: (endpoint: string) => Promise<ClineCatalogResponse>;
  probeRuntime?: () => Promise<ClineRuntimeIdentity>;
  now?: () => Date;
  maxAgeMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  failureBackoffMs?: number;
}

const UNKNOWN_RUNTIME: ClineRuntimeIdentity = {
  command: "cline",
  cliProviderId: "cline",
  version: "unknown",
  supportsProviderFlag: false,
  supportsModelFlag: false,
  supportedThinking: [],
};

function generation(entries: readonly ClineCatalogEntry[], runtime?: ClineRuntimeIdentity): string {
  const hash = createHash("sha256");
  if (runtime) hash.update(`${runtime.cliProviderId}|${runtime.command}|${runtime.version}|${runtime.supportedThinking.join(",")}\n`);
  for (const entry of [...entries].sort((a, b) => a.routeKey.localeCompare(b.routeKey))) {
    hash.update(`${entry.routeKey}|${entry.thinking.join(",")}|${entry.thinkingKnown}|${entry.supportsReasoning}|${entry.free}|${entry.source}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

function unknownSnapshot(runtime: ClineRuntimeIdentity = UNKNOWN_RUNTIME, diagnostic = "No authoritative Cline model catalog was supplied."): ClineCatalogSnapshot {
  return { state: "UNKNOWN", entries: [], generation: generation([]), runtime, source: "none", diagnostic };
}

function splitModelId(value: string): { providerId: string; modelId: string; fullName: string } | undefined {
  const fullName = value.trim();
  const separator = fullName.indexOf("/");
  if (separator <= 0 || separator === fullName.length - 1 || fullName.includes("//") || /\s|[\u0000-\u001f\u007f]/.test(fullName)) return undefined;
  return { providerId: fullName.slice(0, separator), modelId: fullName.slice(separator + 1), fullName };
}

async function fetchBoundedCatalog(endpoint: string, timeoutMs: number, maxBodyBytes: number): Promise<ClineCatalogResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBodyBytes) throw new Error("Cline catalog response exceeds the maximum body size.");
      return { status: response.status, json: async () => JSON.parse(text) };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) { await reader.cancel(); throw new Error("Cline catalog response exceeds the maximum body size."); }
      chunks.push(next.value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return { status: response.status, json: async () => JSON.parse(text) };
  } finally {
    clearTimeout(timeout);
  }
}

function parseThinking(value: unknown): ClineThinkingLevel[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Cline catalog thinking levels must be an array when present.");
  const result = value.filter((candidate): candidate is ClineThinkingLevel =>
    typeof candidate === "string" && (CLINE_THINKING_LEVELS as readonly string[]).includes(candidate),
  );
  if (result.length !== value.length) throw new Error("Cline catalog contains an unsupported thinking level.");
  return [...new Set(result)];
}

/** Parse Cline's installed @cline/llms shape: { clinePass: [], free: [] }.
 * The separate `recommended` group exposed by some public responses is not a
 * runnable family in the installed parser and therefore cannot be promoted. */
export function parseClineCatalogFeed(payload: unknown, source: "cline-api" | "fixture" = "fixture"): ClineCatalogEntry[] {
  if (!payload || typeof payload !== "object") throw new Error("Cline model feed must be an object.");
  const object = payload as { clinePass?: unknown; free?: unknown };
  if (!Array.isArray(object.clinePass) || !Array.isArray(object.free)) throw new Error("Cline model feed must contain clinePass/free arrays.");
  const pass = object.clinePass;
  const entries: ClineCatalogEntry[] = [];
  const passIds = new Set<string>();
  for (const item of object.clinePass) {
    if (!item || typeof item !== "object") throw new Error("Cline model feed contains a malformed entry.");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") throw new Error("Cline model feed entry is missing string id.");
    const identity = splitModelId(record.id);
    if (!identity || passIds.has(identity.fullName)) throw new Error(`Cline model feed contains invalid or duplicate pass id '${record.id}'.`);
    passIds.add(identity.fullName);
    const capabilities = record.capabilities && typeof record.capabilities === "object" ? record.capabilities as Record<string, unknown> : record;
    const thinking = parseThinking(record.thinkingLevels ?? capabilities.thinkingLevels);
    const supportsReasoning = typeof capabilities.supportsReasoning === "boolean" ? capabilities.supportsReasoning : "unknown";
    entries.push({ cliProviderId: "cline-pass", catalogTier: "pass", modelProviderId: identity.providerId, modelId: identity.modelId, fullName: identity.fullName, routeKey: `cline-pass:${identity.fullName}`, thinking: thinking ?? [], thinkingKnown: thinking !== undefined, supportsReasoning, free: "unknown", accountEntitlement: "unknown", source });
  }
  const freeIds = new Set<string>();
  for (const item of object.free) {
    if (!item || typeof item !== "object") throw new Error("Cline model feed contains a malformed free entry.");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") throw new Error("Cline model feed free entry is missing string id.");
    const identity = splitModelId(record.id);
    if (!identity || freeIds.has(identity.fullName)) throw new Error(`Cline model feed contains invalid or duplicate free id '${record.id}'.`);
    freeIds.add(identity.fullName);
    const capabilities = record.capabilities && typeof record.capabilities === "object" ? record.capabilities as Record<string, unknown> : record;
    const thinking = parseThinking(record.thinkingLevels ?? capabilities.thinkingLevels);
    const supportsReasoning = typeof capabilities.supportsReasoning === "boolean" ? capabilities.supportsReasoning : "unknown";
    entries.push({ cliProviderId: "cline", catalogTier: "free", modelProviderId: identity.providerId, modelId: identity.modelId, fullName: identity.fullName, routeKey: `cline:${identity.fullName}`, thinking: thinking ?? [], thinkingKnown: thinking !== undefined, supportsReasoning, free: "known-free", accountEntitlement: "unknown", source });
    if (pass.length > 0 && !passIds.has(identity.fullName)) entries.push({ cliProviderId: "cline-pass", catalogTier: "free", modelProviderId: identity.providerId, modelId: identity.modelId, fullName: identity.fullName, routeKey: `cline-pass:${identity.fullName}`, thinking: thinking ?? [], thinkingKnown: thinking !== undefined, supportsReasoning, free: "known-free", accountEntitlement: "unknown", source });
  }
  return entries;
}

export async function probeClineRuntime(command = "cline"): Promise<ClineRuntimeIdentity> {
  try {
    const [{ stdout: versionOut }, { stdout: helpOut }] = await Promise.all([
      execFileAsync(command, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 }),
      execFileAsync(command, ["--help"], { timeout: 5000, maxBuffer: 128 * 1024 }),
    ]);
    const help = String(helpOut);
    const supportedThinking = CLINE_THINKING_LEVELS.filter((level) => new RegExp(`(?:none\\|)?${level}(?:\\||[>,])`).test(help));
    return {
      command,
      cliProviderId: "cline",
      version: String(versionOut).trim().split(/\s+/)[0] || "unknown",
      supportsProviderFlag: /(?:^|\s)-P,?\s+--provider\b/m.test(help),
      supportsModelFlag: /(?:^|\s)-m,?\s+--model\b/m.test(help),
      supportedThinking,
    };
  } catch {
    return { ...UNKNOWN_RUNTIME, command };
  }
}

export class ClineCatalogService {
  private snapshot: ClineCatalogSnapshot;
  private refreshInFlight?: Promise<ClineCatalogSnapshot>;
  private readonly options: Required<Pick<ClineCatalogOptions, "maxAgeMs" | "now">> & ClineCatalogOptions;

  constructor(options: ClineCatalogOptions = {}) {
    this.options = { maxAgeMs: 5 * 60_000, timeoutMs: 5_000, maxBodyBytes: 1_048_576, now: () => new Date(), ...options };
    this.snapshot = unknownSnapshot();
  }

  getSnapshot(): ClineCatalogSnapshot {
    const fetched = this.snapshot.fetchedAt ? Date.parse(this.snapshot.fetchedAt) : NaN;
    if (this.snapshot.state === "READY" && (!Number.isFinite(fetched) || fetched > this.options.now().getTime() || this.options.now().getTime() - fetched > this.options.maxAgeMs)) {
      return { ...this.snapshot, state: "UNKNOWN", diagnostic: "Cline model catalog is stale; refresh required." };
    }
    return this.snapshot;
  }

  refresh(force = false): Promise<ClineCatalogSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const current = this.getSnapshot();
    if (!force && current.state === "READY") return Promise.resolve(current);
    if (!force && current.retryAfter && Date.parse(current.retryAfter) > this.options.now().getTime()) return Promise.resolve(current);
    this.snapshot = current;
    this.refreshInFlight = this.doRefresh().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<ClineCatalogSnapshot> {
    let runtime: ClineRuntimeIdentity;
    try {
      runtime = this.options.probeRuntime ? await this.options.probeRuntime() : await probeClineRuntime(this.options.command);
    } catch (error) {
      this.snapshot = this.failedSnapshot(UNKNOWN_RUNTIME, error instanceof Error ? error.message : "Cline runtime probe failed.");
      return this.snapshot;
    }
    if (!runtime.supportsProviderFlag || !runtime.supportsModelFlag || runtime.supportedThinking.length === 0) {
      this.snapshot = { ...this.failedSnapshot(runtime, "Installed Cline runtime does not expose the required provider/model/thinking contract."), state: "BLOCKED", source: "cli-capability" };
      return this.snapshot;
    }
    const endpoint = this.options.endpoint ?? CLINE_RECOMMENDED_MODELS_ENDPOINT;
    const fetchCatalog = this.options.fetchCatalog ?? ((url: string) => fetchBoundedCatalog(url, this.options.timeoutMs!, this.options.maxBodyBytes!));
    if (!endpoint || !fetchCatalog) {
      this.snapshot = this.failedSnapshot(runtime, "Cline CLI has no model-list command and no catalog adapter is available.");
      this.snapshot.source = "cli-capability";
      return this.snapshot;
    }
    try {
      const response = await fetchCatalog(endpoint);
      if (response.status < 200 || response.status >= 300) throw new Error(`Cline catalog endpoint returned HTTP ${response.status}.`);
      const entries = parseClineCatalogFeed(await response.json(), "cline-api");
      const fetchedAt = this.options.now().toISOString();
      this.snapshot = { state: "READY", entries, fetchedAt, expiresAt: new Date(this.options.now!().getTime() + this.options.maxAgeMs!).toISOString(), lastSuccessfulAt: fetchedAt, generation: generation(entries, runtime), runtime, endpoint, source: "cline-api" };
    } catch (error) {
      this.snapshot = { ...this.failedSnapshot(runtime, error instanceof Error ? error.message : "Cline catalog feed failed."), state: "BLOCKED", source: "cline-api", endpoint };
    }
    return this.snapshot;
  }

  private failedSnapshot(runtime: ClineRuntimeIdentity, diagnostic: string): ClineCatalogSnapshot {
    const now = this.options.now();
    const retryAfter = new Date(now.getTime() + (this.options.failureBackoffMs ?? 30_000)).toISOString();
    return { ...this.snapshot, state: "UNKNOWN", runtime, diagnostic, retryAfter };
  }
}
