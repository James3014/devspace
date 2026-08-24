import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Typed provider scratch separation and cleanup.
 *
 * Provider scratch state (temporary prompts, provider config files, transient
 * logs, IPC/session scratch) must live OUTSIDE product repositories. This
 * module creates DevSpace-owned scratch directories under the OS temp root,
 * marks them with an ownership manifest, and removes them only through a
 * typed cleanup that verifies ownership before deleting anything.
 *
 * This is not a general deletion facility: paths without a valid DevSpace
 * ownership marker are always refused with structured evidence.
 */

export const SCRATCH_DIR_PREFIX = "devspace-agent-scratch-";
const MARKER_FILE = ".devspace-owned.json";
const SCRATCH_MARKER_VERSION = 1;

export interface ScratchHandle {
  /** Absolute path of the owned scratch directory (outside any repository). */
  root: string;
  markerPath: string;
}

interface ScratchMarker {
  ownedBy: "devspace";
  version: number;
  kind: "provider_scratch";
  agentId: string;
  createdAt: string;
}

export class ScratchCleanupError extends Error {
  constructor(
    readonly code: "REFUSED_UNOWNED" | "REFUSED_ACTIVE_WORKER" | "REFUSED_OUTSIDE_TMP" | "INVALID_PATH",
    message: string,
  ) {
    super(message);
    this.name = "ScratchCleanupError";
  }
}

/**
 * Create an owned provider-scratch directory for one agent turn.
 * The directory is created outside every configured workspace: it always lives
 * directly under os.tmpdir(), which no product repo owns.
 */
export function createProviderScratch(agentId: string): ScratchHandle {
  const safeId = agentId.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  const root = join(tmpdir(), `${SCRATCH_DIR_PREFIX}${safeId}`);
  mkdirSync(root, { recursive: true });
  if (dirname(realpathSync(root)) !== resolve(realpathSync(tmpdir()))) {
    throw new Error(`Provider scratch root escaped the OS temp directory: ${root}`);
  }
  const markerPath = join(root, MARKER_FILE);
  const marker: ScratchMarker = {
    ownedBy: "devspace",
    version: SCRATCH_MARKER_VERSION,
    kind: "provider_scratch",
    agentId,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
  return { root, markerPath };
}

function readOwnedScratchMarker(path: string): ScratchMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      parsed.ownedBy === "devspace" &&
      parsed.version === SCRATCH_MARKER_VERSION &&
      parsed.kind === "provider_scratch" &&
      typeof parsed.agentId === "string"
    ) {
      return parsed as unknown as ScratchMarker;
    }
  } catch {
    // fallthrough: unowned or unreadable
  }
  return undefined;
}

/**
 * Verify that `path` is a DevSpace-owned provider-scratch directory:
 * inside the OS temp root, matching the scratch naming convention, and
 * carrying a valid ownership manifest. Returns refusal evidence otherwise.
 */
export function inspectScratchOwnership(path: string): { owned: true; marker: ScratchMarker } | {
  owned: false;
  reason: string;
} {
  let resolved: string;
  try {
    resolved = realpathSync(resolve(path));
  } catch {
    return { owned: false, reason: `path does not exist: ${path}` };
  }
  if (dirname(resolved) !== resolve(realpathSync(tmpdir())) || !basename(resolved).startsWith(SCRATCH_DIR_PREFIX)) {
    return { owned: false, reason: `path is not a DevSpace provider-scratch directory: ${resolved}` };
  }
  const marker = readOwnedScratchMarker(join(resolved, MARKER_FILE));
  if (!marker) {
    return { owned: false, reason: `scratch ownership manifest is missing or invalid: ${resolved}` };
  }
  return { owned: true, marker };
}

/** Structured result of a typed cleanup operation. */
export interface CleanupResult {
  path: string;
  removed: boolean;
  alreadyAbsent: boolean;
  refusals: Array<{ path: string; code: string; detail: string }>;
}

/**
 * Typed cleanup for one owned provider-scratch directory.
 *
 * - Refuses anything that is not a verified DevSpace-owned scratch directory.
 * - Idempotent: an already-absent path reports removed=false/alreadyAbsent=true.
 * - Never deletes an accepted-or-unaccepted Candidate: candidate cleanup is
 *   out of scope for this module by design.
 */
export function cleanupProviderScratch(path: string): CleanupResult {
  const refusal: CleanupResult = { path, removed: false, alreadyAbsent: false, refusals: [] };
  if (!existsSync(path)) {
    return { ...refusal, alreadyAbsent: true };
  }
  const ownership = inspectScratchOwnership(path);
  if (!ownership.owned) {
    return {
      ...refusal,
      refusals: [{ path, code: "REFUSED_UNOWNED", detail: ownership.reason }],
    };
  }
  rmSync(resolve(path), { recursive: true, force: true });
  return { path, removed: !existsSync(path), alreadyAbsent: false, refusals: [] };
}

/**
 * Sweep all DevSpace-owned provider-scratch directories currently present in
 * the OS temp root. Unowned entries are never touched; each is reported as a
 * refusal with evidence. Idempotent.
 */
export function sweepProviderScratch(): { swept: string[]; keptUnowned: string[] } {
  const swept: string[] = [];
  const keptUnowned: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(tmpdir())
      .filter((entry) => entry.startsWith(SCRATCH_DIR_PREFIX))
      .map((entry) => join(tmpdir(), entry));
  } catch {
    return { swept, keptUnowned };
  }
  for (const entry of entries) {
    const result = cleanupProviderScratch(entry);
    if (result.removed || result.alreadyAbsent) swept.push(entry);
    else keptUnowned.push(...result.refusals.map((r) => r.path));
  }
  return { swept, keptUnowned };
}

/**
 * Deterministic content hash over a scratch directory's own entries, used to
 * detect foreign mutation of owned scratch before cleanup evidence is reported.
 */
export function scratchContentFingerprint(handle: ScratchHandle): string {
  const hash = createHash("sha256");
  const entries = readdirSync(handle.root).sort();
  for (const entry of entries) {
    hash.update(entry);
    hash.update("\0");
  }
  return hash.digest("hex");
}
