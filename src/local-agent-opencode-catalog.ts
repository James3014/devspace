import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { OpencodeClientLike } from "./local-agent-opencode.js";

export interface OpencodeCatalogEntry {
  providerId: string;
  modelId: string;
  fullName: string;
  variants: string[];
  status: string;
}

export interface OpencodeCatalogSnapshot {
  entries: OpencodeCatalogEntry[];
  fetchedAt: string;
  source: "sdk" | "cli" | "fallback";
  generation: string;
  version: string;
}

export interface ModelValidationResult {
  valid: boolean;
  blockerCode?: "EXACT_MODEL_UNAVAILABLE" | "VARIANT_UNAVAILABLE";
  reason?: string;
}

let activeCatalogSnapshot: OpencodeCatalogSnapshot | undefined;
let catalogGenerationCounter = 1;

/**
 * Baseline fallback catalog. Single source of truth used both by the async
 * fetch path (when SDK/CLI probing is unavailable) and the synchronous
 * initial snapshot, so they can never diverge. Kept in sync with the
 * live OpenCode CLI baseline; models missing from this list fail closed
 * (EXACT_MODEL_UNAVAILABLE) instead of being accepted.
 */
const fallbackOpencodeCatalogEntries: readonly OpencodeCatalogEntry[] = [
  { providerId: "opencode", modelId: "big-pickle", fullName: "opencode/big-pickle", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode", modelId: "ling-3.0-flash-fin-free", fullName: "opencode/ling-3.0-flash-fin-free", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode", modelId: "mimo-v2.5-free", fullName: "opencode/mimo-v2.5-free", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", fullName: "opencode/muse-spark-1.2-contributor-free", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode", modelId: "muse-spark-1.3-contributor-free", fullName: "opencode/muse-spark-1.3-contributor-free", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode", modelId: "nemotron-3-ultra-free", fullName: "opencode/nemotron-3-ultra-free", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode", modelId: "nemotron-3.5-lightning-free", fullName: "opencode/nemotron-3.5-lightning-free", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode-go", modelId: "deepseek-v4-flash", fullName: "opencode-go/deepseek-v4-flash", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode-go", modelId: "glm-5.3-flash", fullName: "opencode-go/glm-5.3-flash", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode-go", modelId: "grok-4.6", fullName: "opencode-go/grok-4.6", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode-go", modelId: "hy3", fullName: "opencode-go/hy3", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
  { providerId: "opencode-go", modelId: "mimo-v2.5", fullName: "opencode-go/mimo-v2.5", variants: ["none", "minimal", "low", "medium", "high"], status: "active" },
];

export function computeOpencodeCatalogGeneration(entries: readonly OpencodeCatalogEntry[], counter = catalogGenerationCounter): string {
  const hash = createHash("sha256");
  hash.update(`gen-${counter}:`);
  for (const entry of [...entries].sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    hash.update(`${entry.fullName}:${entry.variants.join(",")}:${entry.status}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Shared fallback snapshot builder. Both async fetch fallback and the
 * synchronous initial snapshot derive from the same baseline const, so they
 * can never diverge.
 */
export function fallbackOpencodeCatalogSnapshot(
  fetchedAt = new Date().toISOString(),
): OpencodeCatalogSnapshot {
  const fallbackEntries = [...fallbackOpencodeCatalogEntries];
  return {
    entries: fallbackEntries,
    fetchedAt,
    source: "fallback",
    generation: computeOpencodeCatalogGeneration(fallbackEntries),
    version: "unknown",
  };
}

export function parseOpencodeCliModels(stdout: string): OpencodeCatalogEntry[] {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => Boolean(line) && !line.startsWith("▄") && !line.startsWith("█") && !line.startsWith("▀") && !line.startsWith("Commands:"));
  const entries: OpencodeCatalogEntry[] = [];
  for (const line of lines) {
    if (line.includes("/")) {
      const [providerId, ...rest] = line.split("/");
      const modelId = rest.join("/");
      entries.push({
        providerId,
        modelId,
        fullName: line,
        // Standard OpenCode reasoning variants commonly supported across models
        variants: ["none", "minimal", "low", "medium", "high"],
        status: "active",
      });
    }
  }
  return entries;
}

export async function fetchOpencodeCatalog(
  client?: OpencodeClientLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeCatalogSnapshot> {
  const fetchedAt = new Date().toISOString();
  let version = "unknown";
  try {
    const rawVersion = execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000, env }).trim();
    if (rawVersion) version = rawVersion.slice(0, 60);
  } catch {
    // Keep unknown.
  }

  // 1. Try fetching via live SDK client if available
  if (client) {
    try {
      const modelApi = (client.v2 as unknown as { model?: { list: (params?: unknown, opts?: { throwOnError: boolean }) => Promise<{ data?: { data?: Array<{ id: string; providerID: string; variants?: Array<{ id: string }>; status?: string }> } }> } }).model;
      if (modelApi && typeof modelApi.list === "function") {
        const response = await modelApi.list({}, { throwOnError: true });
        const list = response?.data?.data ?? [];
        if (list.length > 0) {
          const entries: OpencodeCatalogEntry[] = list.map((item) => {
            const providerId = item.providerID;
            const modelId = item.id;
            const fullName = `${providerId}/${modelId}`;
            const variants = (item.variants ?? []).map((v) => v.id);
            return {
              providerId,
              modelId,
              fullName,
              variants: variants.length > 0 ? variants : ["none", "minimal", "low", "medium", "high"],
              status: item.status ?? "active",
            };
          });
          const generation = computeOpencodeCatalogGeneration(entries);
          return {
            entries,
            fetchedAt,
            source: "sdk",
            generation,
            version,
          };
        }
      }
    } catch {
      // Fall through to CLI probe.
    }
  }

  // 2. Try fetching via OpenCode CLI
  try {
    const stdout = execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 10000, env });
    const entries = parseOpencodeCliModels(stdout);
    if (entries.length > 0) {
      const generation = computeOpencodeCatalogGeneration(entries);
      return {
        entries,
        fetchedAt,
        source: "cli",
        generation,
        version,
      };
    }
  } catch {
    // Fall through to fallback catalog.
  }

  // 3. Fallback catalog matching current baseline snapshot
  const fallbackEntries = [...fallbackOpencodeCatalogEntries];

  const generation = computeOpencodeCatalogGeneration(fallbackEntries);
  return {
    entries: fallbackEntries,
    fetchedAt,
    source: "fallback",
    generation,
    version,
  };
}

export function getActiveOpencodeCatalogSnapshot(): OpencodeCatalogSnapshot {
  if (!activeCatalogSnapshot) {
    // Sync initial fallback snapshot until async fetch completes. Always built
    // from the shared baseline const used by the fetch fallback path.
    activeCatalogSnapshot = fallbackOpencodeCatalogSnapshot();
  }
  return activeCatalogSnapshot;
}

export function setActiveOpencodeCatalogSnapshot(snapshot: OpencodeCatalogSnapshot): void {
  activeCatalogSnapshot = snapshot;
}

export async function refreshOpencodeCatalog(
  client?: OpencodeClientLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeCatalogSnapshot> {
  catalogGenerationCounter += 1;
  const snapshot = await fetchOpencodeCatalog(client, env);
  activeCatalogSnapshot = snapshot;
  return snapshot;
}

export function getOpencodeCatalogGeneration(): string {
  return getActiveOpencodeCatalogSnapshot().generation;
}

export function validateOpencodeModelAndVariant(
  model?: string,
  variant?: string,
  catalog: OpencodeCatalogSnapshot = getActiveOpencodeCatalogSnapshot(),
): ModelValidationResult {
  if (!model) return { valid: true };

  const trimmedModel = model.trim();
  const entry = catalog.entries.find((e) =>
    e.fullName === trimmedModel ||
    e.modelId === trimmedModel ||
    (trimmedModel.includes("/") && e.modelId === trimmedModel.split("/")[1] && e.providerId === trimmedModel.split("/")[0]),
  );

  if (!entry) {
    return {
      valid: false,
      blockerCode: "EXACT_MODEL_UNAVAILABLE",
      reason: `OpenCode model '${model}' is not available in the current catalog.`,
    };
  }

  if (variant && variant.trim() !== "") {
    const normalizedVariant = variant.trim().toLowerCase();
    // Check if variant exists in available variants
    if (!entry.variants.includes(normalizedVariant)) {
      return {
        valid: false,
        blockerCode: "VARIANT_UNAVAILABLE",
        reason: `OpenCode model '${model}' does not support variant '${variant}'. Available: ${entry.variants.join(", ")}`,
      };
    }
  }

  return { valid: true };
}
