import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpencodeClientLike } from "./local-agent-opencode.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TTL_MS = 30_000;
const FAILURE_RETRY_MS = 5_000;
const SDK_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 10_000;

export interface OpencodeCatalogEntry { providerId: string; modelId: string; fullName: string; variants: string[]; status: string; enabled?: boolean; variantsKnown?: boolean; }
export type OpencodeCatalogFreshness = "fresh" | "stale" | "unknown";
export type OpencodeCatalogSource = "sdk" | "cli" | "fallback";
export interface OpencodeCatalogFailure { code: "SDK_UNAVAILABLE" | "SDK_ERROR" | "CLI_UNAVAILABLE" | "CLI_MALFORMED" | "FALLBACK_ONLY"; message: string; }
export interface OpencodeCatalogRuntime { executable?: string; version: string; source: "cli" | "sdk" | "unknown"; }
export interface OpencodeCatalogSnapshot {
  entries: OpencodeCatalogEntry[];
  fetchedAt: string;
  source: OpencodeCatalogSource;
  generation: string;
  version: string;
  freshness?: OpencodeCatalogFreshness;
  failure?: OpencodeCatalogFailure;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  runtime?: OpencodeCatalogRuntime;
  expiresAt?: string;
}
export interface ModelValidationResult {
  valid: boolean;
  blockerCode?: "EXACT_MODEL_UNAVAILABLE" | "VARIANT_UNAVAILABLE";
  reason?: string;
  variantStatus?: "supported" | "unsupported" | "unknown";
  catalogStatus?: "known" | "unknown";
}
export interface OpencodeCatalogProbeResult { stdout: string; executable?: string; }
export interface OpencodeCatalogAcquireOptions {
  client?: OpencodeClientLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  runCommand?: (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<OpencodeCatalogProbeResult>;
}

let activeCatalogSnapshot: OpencodeCatalogSnapshot | undefined;
let catalogGenerationCounter = 1;
const scopedSnapshots = new Map<string, OpencodeCatalogSnapshot>();
const scopedInflight = new Map<string, Promise<OpencodeCatalogSnapshot>>();
const scopedAttempts = new Map<string, number>();
const scopedFailures = new Map<string, boolean>();
const clientScopeIds = new WeakMap<object, number>();
let nextClientScopeId = 1;

function scopeKey(client: OpencodeClientLike | undefined, env: NodeJS.ProcessEnv): string {
  let clientKey = "none";
  if (client) {
    const object = client as object;
    let id = clientScopeIds.get(object);
    if (!id) { id = nextClientScopeId++; clientScopeIds.set(object, id); }
    clientKey = `client-${id}`;
  }
  // Only execution identity affects a probe scope; never hash auth/secrets.
  return `${clientKey}|path=${env.PATH ?? ""}|home=${env.HOME ?? ""}|opencode-home=${env.OPENCODE_HOME ?? ""}|config=${env.OPENCODE_CONFIG ?? ""}|xdg-config=${env.XDG_CONFIG_HOME ?? ""}|xdg-data=${env.XDG_DATA_HOME ?? ""}`;
}

function fallbackEntries(): OpencodeCatalogEntry[] {
  return [
    ["opencode", "big-pickle"], ["opencode", "ling-3.0-flash-fin-free"], ["opencode", "mimo-v2.5-free"],
    ["opencode", "muse-spark-1.2-contributor-free"], ["opencode", "nemotron-3-ultra-free"], ["opencode", "nemotron-3.5-lightning-free"],
    ["opencode-go", "deepseek-v4-flash"], ["opencode-go", "glm-5.3-flash"], ["opencode-go", "grok-4.6"], ["opencode-go", "hy3"], ["opencode-go", "mimo-v2.5"],
  ].map(([providerId, modelId]) => ({ providerId, modelId, fullName: `${providerId}/${modelId}`, variants: [], variantsKnown: false, status: "active" }));
}

export function computeOpencodeCatalogGeneration(entries: readonly OpencodeCatalogEntry[], counter = catalogGenerationCounter): string {
  const hash = createHash("sha256");
  hash.update(`gen-${counter}:`);
  for (const entry of [...entries].sort((a, b) => a.fullName.localeCompare(b.fullName))) hash.update(`${entry.providerId}:${entry.modelId}:${entry.fullName}:${[...entry.variants].sort().join(",")}:${entry.variantsKnown === true ? "known" : entry.variantsKnown === false ? "unknown" : "unspecified"}:${entry.enabled === false ? "disabled" : entry.enabled === true ? "enabled" : "unspecified"}:${entry.status}\n`);
  return hash.digest("hex").slice(0, 16);
}

export function parseOpencodeCliModels(stdout: string): OpencodeCatalogEntry[] {
  const entries: OpencodeCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /\u001b|[\u2500-\u257f]/.test(line) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(line) || seen.has(line)) continue;
    seen.add(line);
    const separator = line.indexOf("/");
    entries.push({ providerId: line.slice(0, separator), modelId: line.slice(separator + 1), fullName: line, variants: [], variantsKnown: false, status: "active" });
  }
  return entries;
}

async function defaultRunCommand(file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<OpencodeCatalogProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const result = await execFileAsync(file, [...args], { encoding: "utf8", env: options.env, timeout: options.timeoutMs, maxBuffer: 1024 * 1024, signal: controller.signal });
    let executable = file;
    try {
      const resolved = await execFileAsync(process.platform === "win32" ? "where" : "which", [file], { encoding: "utf8", env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 });
      executable = resolved.stdout.trim().split(/\r?\n/)[0] || file;
    } catch { /* retain the command identity when resolution is unavailable */ }
    return { stdout: result.stdout, executable };
  } finally { clearTimeout(timer); }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function makeSnapshot(entries: OpencodeCatalogEntry[], source: OpencodeCatalogSource, version: string, fetchedAt: string, freshness: OpencodeCatalogFreshness, runtime: OpencodeCatalogRuntime, failure?: OpencodeCatalogFailure, lastSuccessAt?: string): OpencodeCatalogSnapshot {
  return { entries, source, version, fetchedAt, freshness, runtime, generation: computeOpencodeCatalogGeneration(entries), ...(freshness === "fresh" ? { expiresAt: new Date(Date.parse(fetchedAt) + DEFAULT_TTL_MS).toISOString() } : {}), ...(failure ? { failure } : {}), ...(lastSuccessAt ? { lastSuccessAt } : {}) };
}

export async function fetchOpencodeCatalog(client?: OpencodeClientLike, env: NodeJS.ProcessEnv = process.env, probe?: OpencodeCatalogAcquireOptions["runCommand"], now = () => Date.now()): Promise<OpencodeCatalogSnapshot> {
  const runCommand = probe ?? ((file, args, options) => defaultRunCommand(file, args, options));
  const fetchedAt = new Date(now()).toISOString();
  let version = "unknown";
  let executable: string | undefined;
  if (!client) try {
    const result = await runCommand("opencode", ["--version"], { env, timeoutMs: SDK_TIMEOUT_MS });
    version = result.stdout.trim().slice(0, 60) || "unknown";
    executable = result.executable;
  } catch { /* version is provenance only */ }

  let sdkFailure: OpencodeCatalogFailure;
  if (client) {
    try {
      const controller = new AbortController();
      const response = await withTimeout(client.v2.model.list({}, { throwOnError: true, signal: controller.signal }), SDK_TIMEOUT_MS, "SDK model catalog").catch((error) => { controller.abort(); throw error; });
      const list = response?.data?.data;
      if (!Array.isArray(list)) throw new Error("SDK model catalog response had no data array");
      const entries = list.map((item) => {
        if (typeof item?.id !== "string" || typeof item?.providerID !== "string") throw new Error("SDK model catalog contained malformed model entries");
        if (item.variants !== undefined && !Array.isArray(item.variants)) throw new Error("SDK model catalog contained malformed variants");
        if (item.variants?.some((variant) => !variant || typeof variant.id !== "string" || !variant.id)) throw new Error("SDK model catalog contained malformed variant entries");
        if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error("SDK model catalog contained malformed enabled metadata");
        return { providerId: item.providerID, modelId: item.id, fullName: `${item.providerID}/${item.id}`, variants: item.variants?.map((variant) => variant.id) ?? [], variantsKnown: item.variants !== undefined, enabled: item.enabled, status: item.status ?? "unknown" };
      });
      return makeSnapshot(entries, "sdk", version, fetchedAt, "fresh", { version, executable, source: "sdk" }, undefined, fetchedAt);
    } catch (error) { sdkFailure = { code: "SDK_ERROR", message: error instanceof Error ? error.message : String(error) }; }
  } else sdkFailure = { code: "SDK_UNAVAILABLE", message: "OpenCode SDK client was not provided" };

  try {
    const result = await runCommand("opencode", ["models"], { env, timeoutMs: CLI_TIMEOUT_MS });
    const entries = parseOpencodeCliModels(result.stdout);
    if (!entries.length) throw new Error("OpenCode CLI returned no strict model identities");
    executable ??= result.executable;
    return makeSnapshot(entries, "cli", version, fetchedAt, "fresh", { version, executable, source: "cli" }, undefined, fetchedAt);
  } catch (error) {
    const cliFailure: OpencodeCatalogFailure = { code: error instanceof Error && error.message.includes("no strict") ? "CLI_MALFORMED" : "CLI_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) };
    return makeSnapshot(fallbackEntries(), "fallback", version, fetchedAt, "unknown", { version, executable, source: executable ? "cli" : "unknown" }, { code: "FALLBACK_ONLY", message: `${sdkFailure.code}: ${sdkFailure.message}; ${cliFailure.code}: ${cliFailure.message}` });
  }
}

export function getActiveOpencodeCatalogSnapshot(): OpencodeCatalogSnapshot {
  if (!activeCatalogSnapshot) activeCatalogSnapshot = makeSnapshot(fallbackEntries(), "fallback", "unknown", new Date(0).toISOString(), "unknown", { version: "unknown", source: "unknown" }, { code: "FALLBACK_ONLY", message: "No live OpenCode catalog has been fetched yet" });
  return activeCatalogSnapshot;
}
export function setActiveOpencodeCatalogSnapshot(value: OpencodeCatalogSnapshot, client?: OpencodeClientLike, env: NodeJS.ProcessEnv = process.env): void {
  if (!client && env === process.env) activeCatalogSnapshot = value;
  scopedSnapshots.set(scopeKey(client, env), value);
}

function startRefresh(options: OpencodeCatalogAcquireOptions): Promise<OpencodeCatalogSnapshot> {
  const env = options.env ?? process.env;
  const key = scopeKey(options.client, env);
  const existing = scopedInflight.get(key);
  if (existing) return existing;
  const now = options.now ?? (() => Date.now());
  const attemptAt = now();
  scopedAttempts.set(key, attemptAt);
  let resolveShared!: (value: OpencodeCatalogSnapshot) => void;
  let rejectShared!: (error: unknown) => void;
  const shared = new Promise<OpencodeCatalogSnapshot>((resolve, reject) => { resolveShared = resolve; rejectShared = reject; });
  scopedInflight.set(key, shared);
  void fetchOpencodeCatalog(options.client, env, options.runCommand, now).then((fetched) => {
    const previous = scopedSnapshots.get(key) ?? (key === scopeKey(undefined, process.env) ? activeCatalogSnapshot : undefined);
    const next = fetched.source === "fallback" && previous && previous.source !== "fallback" ? { ...previous, freshness: "stale" as const, failure: fetched.failure, lastAttemptAt: fetched.fetchedAt } : { ...fetched, ...(fetched.freshness === "fresh" && options.ttlMs !== undefined ? { expiresAt: new Date(attemptAt + options.ttlMs).toISOString() } : {}), lastAttemptAt: fetched.fetchedAt };
    scopedSnapshots.set(key, next);
    scopedFailures.set(key, next.source === "fallback" || next.freshness === "stale");
    if (key === scopeKey(undefined, process.env)) activeCatalogSnapshot = next;
    resolveShared(next);
  }, rejectShared).finally(() => {
    scopedInflight.delete(key);
  });
  return shared;
}

/** Acquire a current snapshot with TTL and failure backoff; concurrent calls share one probe. */
export function acquireOpencodeCatalog(options: OpencodeCatalogAcquireOptions = {}): Promise<OpencodeCatalogSnapshot> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryMs = options.retryMs ?? FAILURE_RETRY_MS;
  const env = options.env ?? process.env;
  const key = scopeKey(options.client, env);
  const active = scopedSnapshots.get(key) ?? (key === scopeKey(undefined, process.env) ? activeCatalogSnapshot : undefined);
  const currentTime = now();
  const observedAt = Date.parse(active?.lastSuccessAt ?? active?.fetchedAt ?? "");
  const expiry = Date.parse(active?.expiresAt ?? "");
  if (active?.freshness === "fresh" && Number.isFinite(observedAt) && currentTime >= observedAt && currentTime < expiry && currentTime - observedAt < ttlMs) return Promise.resolve(active);
  const inFlight = scopedInflight.get(key);
  if (inFlight) return inFlight;
  const attempt = scopedAttempts.get(key);
  if (scopedFailures.get(key) && attempt !== undefined && now() - attempt < retryMs && active) return Promise.resolve({ ...active, freshness: active.source === "fallback" ? "unknown" : "stale" });
  return startRefresh(options);
}

/** Force a bounded refresh while retaining single-flight and failure backoff. */
export function refreshOpencodeCatalog(client?: OpencodeClientLike, env: NodeJS.ProcessEnv = process.env): Promise<OpencodeCatalogSnapshot> {
  return startRefresh({ client, env });
}
export function getOpencodeCatalogGeneration(): string { return getActiveOpencodeCatalogSnapshot().generation; }

export function validateOpencodeModelAndVariant(model?: string, variant?: string, catalog: OpencodeCatalogSnapshot = getActiveOpencodeCatalogSnapshot()): ModelValidationResult {
  if (!model) return { valid: true };
  const freshness = catalog.freshness ?? (catalog.source === "fallback" ? "unknown" : "fresh");
  const age = Date.now() - Date.parse(catalog.lastSuccessAt ?? catalog.fetchedAt);
  const expiry = catalog.expiresAt ? Date.parse(catalog.expiresAt) : Date.parse(catalog.fetchedAt) + DEFAULT_TTL_MS;
  if (catalog.source === "fallback" || freshness !== "fresh" || !Number.isFinite(age) || age < 0 || !Number.isFinite(expiry) || Date.now() >= expiry) return { valid: false, blockerCode: "EXACT_MODEL_UNAVAILABLE", catalogStatus: "unknown", reason: `OpenCode catalog is ${catalog.source === "fallback" ? "fallback-only" : freshness} and does not establish current model membership.` };
  const trimmedModel = model.trim();
  const matches = catalog.entries.filter((entry) => entry.fullName === trimmedModel || (!trimmedModel.includes("/") && entry.modelId === trimmedModel));
  const entry = matches.length === 1 ? matches[0] : undefined;
  if (!entry) return { valid: false, blockerCode: "EXACT_MODEL_UNAVAILABLE", reason: matches.length > 1 ? `OpenCode model '${model}' is ambiguous; use its exact provider/model identity.` : `OpenCode model '${model}' is not available in the current catalog.` };
  if (!trimmedModel.includes("/") && entry.providerId !== "opencode") return { valid: false, blockerCode: "EXACT_MODEL_UNAVAILABLE", reason: `OpenCode model '${model}' requires exact identity '${entry.fullName}'.` };
  if (!["active", "alpha", "beta", "deprecated"].includes(entry.status)) return { valid: false, blockerCode: "EXACT_MODEL_UNAVAILABLE", reason: `OpenCode model '${model}' has unavailable status '${entry.status}'.` };
  if (entry.enabled === false) return { valid: false, blockerCode: "EXACT_MODEL_UNAVAILABLE", reason: `OpenCode model '${model}' is disabled by the installed provider catalog.` };
  if (variant && variant.trim() !== "") {
    if (entry.variantsKnown === false) return { valid: false, blockerCode: "VARIANT_UNAVAILABLE", variantStatus: "unknown", reason: `OpenCode model '${model}' has no variant evidence; '${variant}' is UNKNOWN.` };
    if (!entry.variants.includes(variant)) return { valid: false, blockerCode: "VARIANT_UNAVAILABLE", variantStatus: "unsupported", reason: `OpenCode model '${model}' does not support exact variant '${variant}'.` };
  }
  return { valid: true };
}
