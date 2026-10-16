// Pure helpers for m5-cutover-sidecar.mjs (no dist imports, no I/O) so they can be unit-tested.
import { homedir } from "node:os";
import { join } from "node:path";

/** Refusal: state is not one of the resumable shapes. Exit 2, names the recovery command. */
export class Refuse extends Error {
  constructor(reason, recovery, extra = {}) {
    super(reason);
    this.recovery = recovery;
    this.extra = extra;
  }
}

/** Default stable service root; override with DEVSPACE_SERVICE_ROOT (legacy: SERVICE_ROOT). */
export function resolveServiceRoot(env = process.env, home = homedir()) {
  return env.DEVSPACE_SERVICE_ROOT || env.SERVICE_ROOT || join(home, ".local/share/devspace-service");
}

/** Read the sidecar's required inputs from env. Returns { ok, values?, error? }. */
export function readSidecarEnv(env = process.env, home = homedir()) {
  const values = {
    PENDING_ID: env.PENDING_ID,
    CONTRACT_PATH: env.CONTRACT_PATH,
    RECEIPT_PATH: env.RECEIPT_PATH,
    ACTIVE_RELEASE_ROOT: env.ACTIVE_RELEASE_ROOT,
    SERVICE_ROOT: resolveServiceRoot(env, home),
  };
  if (!values.PENDING_ID || !values.CONTRACT_PATH || !values.RECEIPT_PATH || !values.ACTIVE_RELEASE_ROOT) {
    return { ok: false, error: "PENDING_ID, CONTRACT_PATH, RECEIPT_PATH and ACTIVE_RELEASE_ROOT are all required" };
  }
  return { ok: true, values };
}

export function identityFromHealth(h) {
  return {
    serverInstanceId: h.mcp.serverInstanceId,
    sourceCommit: h.build.source_commit,
    buildId: h.build.build_id,
    capabilityManifestSha256: h.capabilityManifest.manifestSha256,
    ...(h.build.release_sha256 ? { releaseSha256: h.build.release_sha256 } : {}),
    ...(h.build.release_path ? { releasePath: h.build.release_path } : {}),
    ...(h.build.activation_cutover_id ? { activationCutoverId: h.build.activation_cutover_id } : {}),
  };
}

// Key-order-insensitive structural equality (used for stored record vs contract; live-vs-contract keeps
// the original JSON.stringify comparison because identityFromHealth emits the schema key order).
export const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const sameDeep = (a, b) => canon(a) === canon(b);
export const matchesTarget = (h, target) => h.build.source_commit === target.sourceCommit
  && h.build.build_id === target.buildId
  && h.capabilityManifest.manifestSha256 === target.capabilityManifestSha256;

export const RUNBOOK_CLI = "node $R/dist/cli.js";
export function recoveryFor(file, liveIsOld, liveIsTarget) {
  const id = file.cutoverId;
  const common = `--cutover-id ${id} --carrier <cid> --version 1 --validity-version 1`;
  if (file.phase === "prepared") {
    return `runbook s8 (prepared): if expired: ${RUNBOOK_CLI} cutover abort-expired-prepared ${common} --confirm ${id}; if not expired wait for expiry. Never reuse the attemptKey; use a new one.`;
  }
  if (file.phase === "drained" && !file.activationBinding) {
    return `runbook s8 (drained, no activation): if carrier+cutover expired and live is old: ${RUNBOOK_CLI} cutover recover-expired-drained ${common} --confirm ${id}; else do NOT rerun the sidecar: carrier rotate-credential then cutover restart-bound ${common} --credential-file <intent.json> --package-root <build-ready-root> --confirm ${id}.`;
  }
  if (file.phase === "drained" && file.activationBinding && !liveIsOld && !liveIsTarget) {
    return `runbook s8 (unexpected replacement): ${RUNBOOK_CLI} cutover recover-capability-mismatch | recover-failed-activation | recover-unexpected-replacement ${common} --package-root <target root> --confirm ${id}`;
  }
  return `runbook s8: inspect '${RUNBOOK_CLI} cutover status --json'; recovery per phase (abort-expired-prepared / recover-expired-drained / restart-bound / recover-*). Do not rerun cutover_start.`;
}

/**
 * Decide the sidecar mode from persisted state + live identity (read-only).
 * Returns "full" | "resume_drain" | "resume_restart" | "resume_finish"; throws Refuse otherwise.
 */
export function selectMode({ file, contract, liveIsOld, liveIsTarget }) {
  if (!file || file.phase === "closed") return "full"; // Branch a: brand-new attempt.
  const target = contract.cutover.expectedIdentity;
  const ours = sameDeep(file.oldServerIdentity, contract.cutover.currentIdentity)
    && sameDeep(file.expectedNewIdentity, target);
  if (!ours) {
    throw new Refuse("active cutover generation does not match this contract's currentIdentity/expectedIdentity",
      recoveryFor(file, liveIsOld, liveIsTarget), { activePhase: file.phase });
  }
  if (file.phase === "prepared" && !file.drainEvidence && !file.activationBinding && !file.restartRequest && liveIsOld) {
    return "resume_drain"; // Branch e: started, never drained; server already in drain gating.
  }
  if (file.phase === "drained" && file.activationBinding && !file.restartRequest && liveIsOld) {
    return "resume_restart"; // Branch b: drained + bound, restart never requested.
  }
  if (file.phase === "drained" && file.activationBinding && liveIsTarget) {
    return "resume_finish"; // Branch c: replacement already live.
  }
  // Branch d: prepared with progress, drained without activation, restart already requested but old live
  // (one-restart rule: never replay), or live matches neither identity -> refuse.
  throw new Refuse(`cutover ${file.cutoverId} in phase ${file.phase} (activationBinding=${Boolean(file.activationBinding)}, restartRequested=${Boolean(file.restartRequest)}, liveIsOld=${liveIsOld}, liveIsTarget=${liveIsTarget}) is not safely resumable`,
    recoveryFor(file, liveIsOld, liveIsTarget), { activePhase: file.phase });
}
