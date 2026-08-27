import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_PROXY_LOCAL_PROTECTED_TOOLS,
} from "./config.js";
import { readPackageBuildIdentity, type PackageBuildIdentity } from "./nexus-tools.js";

export const HOST_ACTIVATION_SCHEMA = "nexus.devspace.host_generation_activation.v1";
export const BOUND_SERVICE_LABEL = "com.nexus.mcp.devspace.direct";
export const BOUND_PACKAGE_NAME = "@nexus-local/devspace";
export const BOUND_INSTALL_ROOT = join(homedir(), ".npm-global/lib/node_modules/@nexus-local/devspace");
export const BOUND_NODE = "/opt/homebrew/bin/node";
export const BOUND_NPM = "/opt/homebrew/bin/npm";
export const BOUND_LAUNCHCTL = "/bin/launchctl";
export const BOUND_HEALTHZ = "http://127.0.0.1:7676/healthz";
export const REQUIRED_PUBLIC_ACTIONS = [
  "git_merge_pull_request",
  "github_complete_pull_request",
] as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const PACKAGE_VERSION = /^1\.0\.1-nexus\.\d+$/;
const BUILD_ID = /^nexus-1\.0\.1-nexus\.\d+-[0-9a-f]{8}$/;
const ARTIFACT_SHA = /^[0-9a-f]{64}$/;
const ALLOWED_TOP_LEVEL = new Set(["schema", "operation", "expected_old", "desired"]);
const ALLOWED_EXPECTED_OLD = new Set(["package_version", "source_commit", "build_id"]);
const ALLOWED_DESIRED = new Set([
  "package_version",
  "source_commit",
  "source_tree",
  "build_id",
  "artifact_sha256",
]);
const FORBIDDEN_KEYS = new Set([
  "service_label",
  "label",
  "plist",
  "command",
  "shell",
  "env",
  "environment",
  "path",
  "executable",
  "install_root",
  "node_path",
  "npm_path",
  "refspec",
  "remote",
  "force",
  "cwd",
  "argv",
  "program",
  "source_root",
]);

export type ActivationOperation = "status" | "activate";
export type ActivationOutcome = "PASS" | "RECONCILED" | "BLOCK" | "NOT_READY";

export interface GenerationIdentity {
  package_version: string;
  source_commit: string;
  build_id: string;
}

export interface DesiredGeneration extends GenerationIdentity {
  source_tree: string;
  artifact_sha256?: string;
}

export interface ActivationRequest {
  schema: typeof HOST_ACTIVATION_SCHEMA;
  operation: ActivationOperation;
  expected_old?: GenerationIdentity;
  desired?: DesiredGeneration;
}

export interface InstalledIdentity extends GenerationIdentity {
  package_name: string;
  source_dirty?: boolean;
}

export interface ServiceStatus {
  label: string;
  pid: number | null;
  running: boolean;
}

export interface RuntimeReadiness {
  reachable: boolean;
  ok: boolean | null;
  source_commit: string | null;
  build_id: string | null;
  package_version: string | null;
  local_protected_tools: string[] | null;
}

export interface PackedArtifact {
  tarballPath: string;
  sha256: string;
}

export interface ActivationResult {
  outcome: ActivationOutcome;
  mutated: boolean;
  code: string;
  installed: InstalledIdentity | null;
  service: ServiceStatus;
  runtime: RuntimeReadiness | null;
  artifact_sha256?: string;
  message: string;
}

export interface ActivationAdapters {
  readInstalledIdentity(): InstalledIdentity | null;
  readServiceStatus(): ServiceStatus;
  readSourceHead(): { commit: string; tree: string; dirtyNonGenerated: boolean };
  readSourceBuiltIdentity(): PackageBuildIdentity | null;
  pack(): PackedArtifact;
  install(artifact: PackedArtifact): void;
  restartBoundService(oldPid: number | null): { newPid: number };
  readRuntime(): RuntimeReadiness;
  readInstalledActions(): string[];
  sleep(ms: number): Promise<void>;
}

export class HostActivationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostActivationError";
  }
}

function rejectForbidden(record: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new HostActivationError("REQUEST_FIELD_REJECTED", `${label} forbids ${key}`);
    }
  }
}

function rejectUnknown(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  rejectForbidden(record, label);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new HostActivationError("REQUEST_FIELD_REJECTED", `${label} forbids unknown field ${key}`);
    }
  }
}

function requireSha(value: unknown, name: string): string {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", `${name} must be a 40-char lowercase SHA`);
  }
  return value;
}

function requireVersion(value: unknown, name: string): string {
  if (typeof value !== "string" || !PACKAGE_VERSION.test(value)) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", `${name} must be a 1.0.1-nexus.N version`);
  }
  return value;
}

function requireBuildId(value: unknown, name: string): string {
  if (typeof value !== "string" || !BUILD_ID.test(value)) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", `${name} must be a nexus-1.0.1-nexus.N-xxxxxxxx build id`);
  }
  return value;
}

function parseGeneration(raw: unknown, label: string): GenerationIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", `${label} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  rejectUnknown(record, ALLOWED_EXPECTED_OLD, label);
  return {
    package_version: requireVersion(record.package_version, `${label}.package_version`),
    source_commit: requireSha(record.source_commit, `${label}.source_commit`),
    build_id: requireBuildId(record.build_id, `${label}.build_id`),
  };
}

function parseDesired(raw: unknown): DesiredGeneration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", "desired must be an object");
  }
  const record = raw as Record<string, unknown>;
  rejectUnknown(record, ALLOWED_DESIRED, "desired");
  const artifact = record.artifact_sha256;
  if (artifact !== undefined && (typeof artifact !== "string" || !ARTIFACT_SHA.test(artifact))) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", "desired.artifact_sha256 must be a 64-char lowercase SHA-256");
  }
  return {
    package_version: requireVersion(record.package_version, "desired.package_version"),
    source_commit: requireSha(record.source_commit, "desired.source_commit"),
    source_tree: requireSha(record.source_tree, "desired.source_tree"),
    build_id: requireBuildId(record.build_id, "desired.build_id"),
    ...(artifact ? { artifact_sha256: artifact } : {}),
  };
}

export function parseActivationRequest(raw: unknown): ActivationRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HostActivationError("REQUEST_SCHEMA_INVALID", "request must be an object");
  }
  const record = raw as Record<string, unknown>;
  rejectUnknown(record, ALLOWED_TOP_LEVEL, "request");
  if (record.schema !== HOST_ACTIVATION_SCHEMA) {
    throw new HostActivationError("REQUEST_SCHEMA_INVALID", "schema must be nexus.devspace.host_generation_activation.v1");
  }
  if (record.operation !== "status" && record.operation !== "activate") {
    throw new HostActivationError("REQUEST_SCHEMA_INVALID", "operation must be status or activate");
  }
  if (record.operation === "status") {
    return {
      schema: HOST_ACTIVATION_SCHEMA,
      operation: "status",
      ...(record.expected_old ? { expected_old: parseGeneration(record.expected_old, "expected_old") } : {}),
      ...(record.desired ? { desired: parseDesired(record.desired) } : {}),
    };
  }
  if (!record.expected_old || !record.desired) {
    throw new HostActivationError("REQUEST_IDENTITY_INVALID", "activate requires expected_old and desired");
  }
  return {
    schema: HOST_ACTIVATION_SCHEMA,
    operation: "activate",
    expected_old: parseGeneration(record.expected_old, "expected_old"),
    desired: parseDesired(record.desired),
  };
}

function sameGeneration(left: GenerationIdentity, right: GenerationIdentity): boolean {
  return (
    left.package_version === right.package_version
    && left.source_commit === right.source_commit
    && left.build_id === right.build_id
  );
}

function runtimeMatchesDesired(runtime: RuntimeReadiness, desired: DesiredGeneration): boolean {
  return (
    runtime.reachable
    && runtime.ok === true
    && runtime.source_commit === desired.source_commit
    && runtime.build_id === desired.build_id
    && runtime.package_version === desired.package_version
    && REQUIRED_PUBLIC_ACTIONS.every((name) => runtime.local_protected_tools?.includes(name))
  );
}

function missingRequiredActions(actions: string[]): string[] {
  return REQUIRED_PUBLIC_ACTIONS.filter((name) => !actions.includes(name));
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function runHostGeneration(
  request: ActivationRequest,
  adapters: ActivationAdapters,
): Promise<ActivationResult> {
  const service = adapters.readServiceStatus();
  if (service.label !== BOUND_SERVICE_LABEL) {
    return {
      outcome: "BLOCK",
      mutated: false,
      code: "SERVICE_IDENTITY_MISMATCH",
      installed: adapters.readInstalledIdentity(),
      service,
      runtime: null,
      message: "adapter attempted to target a service other than the bound DevSpace host",
    };
  }

  const installed = adapters.readInstalledIdentity();
  if (request.operation === "status") {
    return {
      outcome: "RECONCILED",
      mutated: false,
      code: "STATUS",
      installed,
      service,
      runtime: adapters.readRuntime(),
      message: "read-only host generation status",
    };
  }

  const expectedOld = request.expected_old!;
  const desired = request.desired!;
  const runtime = adapters.readRuntime();

  if (installed && sameGeneration(installed, desired) && runtimeMatchesDesired(runtime, desired)) {
    return {
      outcome: "RECONCILED",
      mutated: false,
      code: "ALREADY_ACTIVE",
      installed,
      service,
      runtime,
      message: "desired generation already installed and live; no mutation",
    };
  }

  if (installed && sameGeneration(installed, desired)) {
    return await restartAndVerify(adapters, desired, service.pid, false);
  }

  if (!installed || !sameGeneration(installed, expectedOld)) {
    return {
      outcome: "BLOCK",
      mutated: false,
      code: "EXPECTED_OLD_MISMATCH",
      installed,
      service,
      runtime,
      message: "installed generation does not match expected_old",
    };
  }

  const source = adapters.readSourceHead();
  if (source.dirtyNonGenerated) {
    return {
      outcome: "BLOCK",
      mutated: false,
      code: "SOURCE_DIRTY",
      installed,
      service,
      runtime,
      message: "refusing to pack a dirty source tree",
    };
  }
  if (source.commit !== desired.source_commit || source.tree !== desired.source_tree) {
    return {
      outcome: "BLOCK",
      mutated: false,
      code: "SOURCE_IDENTITY_MISMATCH",
      installed,
      service,
      runtime,
      message: "source HEAD/tree is not the desired Candidate",
    };
  }

  const built = adapters.readSourceBuiltIdentity();
  if (
    !built
    || built.package_name !== BOUND_PACKAGE_NAME
    || built.package_version !== desired.package_version
    || built.source_commit !== desired.source_commit
    || built.build_id !== desired.build_id
  ) {
    return {
      outcome: "BLOCK",
      mutated: false,
      code: "BUILD_IDENTITY_MISMATCH",
      installed,
      service,
      runtime,
      message: "built generated/build-identity.json does not match desired Candidate",
    };
  }

  const artifact = adapters.pack();
  if (desired.artifact_sha256 && desired.artifact_sha256 !== artifact.sha256) {
    return {
      outcome: "BLOCK",
      mutated: false,
      code: "ARTIFACT_DIGEST_MISMATCH",
      installed,
      service,
      runtime,
      artifact_sha256: artifact.sha256,
      message: "packed artifact digest does not match desired.artifact_sha256",
    };
  }

  adapters.install(artifact);
  const installedAfter = adapters.readInstalledIdentity();
  if (!installedAfter || !sameGeneration(installedAfter, desired) || installedAfter.package_name !== BOUND_PACKAGE_NAME) {
    return {
      outcome: "BLOCK",
      mutated: true,
      code: "INSTALL_IDENTITY_MISMATCH",
      installed: installedAfter,
      service,
      runtime,
      artifact_sha256: artifact.sha256,
      message: "installed package identity does not match desired Candidate",
    };
  }

  const missing = missingRequiredActions(adapters.readInstalledActions());
  if (missing.length > 0) {
    return {
      outcome: "BLOCK",
      mutated: true,
      code: "ACTION_SURFACE_MISSING",
      installed: installedAfter,
      service,
      runtime,
      artifact_sha256: artifact.sha256,
      message: `installed artifact is missing required actions: ${missing.join(",")}`,
    };
  }

  return await restartAndVerify(adapters, desired, service.pid, true, artifact.sha256);
}

async function restartAndVerify(
  adapters: ActivationAdapters,
  desired: DesiredGeneration,
  oldPid: number | null,
  mutatedBeforeRestart: boolean,
  artifactSha?: string,
): Promise<ActivationResult> {
  let newPid: number;
  try {
    newPid = adapters.restartBoundService(oldPid).newPid;
  } catch (error) {
    return {
      outcome: "BLOCK",
      mutated: mutatedBeforeRestart,
      code: "RESTART_FAILED",
      installed: adapters.readInstalledIdentity(),
      service: adapters.readServiceStatus(),
      runtime: adapters.readRuntime(),
      artifact_sha256: artifactSha,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await adapters.sleep(250);
    const service = adapters.readServiceStatus();
    const runtime = adapters.readRuntime();
    if (!service.running || service.pid === null) continue;
    if (!runtime.reachable || runtime.ok !== true) continue;
    if (
      runtime.source_commit !== desired.source_commit
      || runtime.build_id !== desired.build_id
      || runtime.package_version !== desired.package_version
    ) {
      return {
        outcome: "BLOCK",
        mutated: true,
        code: "RUNTIME_IDENTITY_MISMATCH",
        installed: adapters.readInstalledIdentity(),
        service,
        runtime,
        artifact_sha256: artifactSha,
        message: "process started with a build identity other than the desired Candidate",
      };
    }
    const missing = missingRequiredActions(runtime.local_protected_tools ?? []);
    if (missing.length > 0) {
      return {
        outcome: "BLOCK",
        mutated: true,
        code: "ACTION_SURFACE_MISSING",
        installed: adapters.readInstalledIdentity(),
        service,
        runtime,
        artifact_sha256: artifactSha,
        message: `live action surface missing ${missing.join(",")}`,
      };
    }
    return {
      outcome: "PASS",
      mutated: true,
      code: "ACTIVATED",
      installed: adapters.readInstalledIdentity(),
      service: { ...service, pid: newPid },
      runtime,
      artifact_sha256: artifactSha,
      message: "bound DevSpace host generation activated",
    };
  }

  return {
    outcome: "NOT_READY",
    mutated: true,
    code: "READINESS_UNPROVEN",
    installed: adapters.readInstalledIdentity(),
    service: adapters.readServiceStatus(),
    runtime: adapters.readRuntime(),
    artifact_sha256: artifactSha,
    message: "service restart did not prove live readiness within the bounded wait",
  };
}

function gitText(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).replace(/\n$/, "");
}

export function sourceHasNonGeneratedDirt(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const path = line.slice(3);
      return !path.startsWith("generated/") && !path.startsWith("dist/");
    });
}

function readIdentityFile(path: string): InstalledIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      parsed.package_name !== BOUND_PACKAGE_NAME
      || typeof parsed.package_version !== "string"
      || typeof parsed.source_commit !== "string"
      || typeof parsed.build_id !== "string"
    ) {
      return null;
    }
    return {
      package_name: parsed.package_name,
      package_version: parsed.package_version,
      source_commit: parsed.source_commit,
      build_id: parsed.build_id,
      ...(typeof parsed.source_dirty === "boolean" ? { source_dirty: parsed.source_dirty } : {}),
    };
  } catch {
    return null;
  }
}

function parseLaunchctlPid(output: string): number | null {
  const match = output.match(/^\s*pid = (\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

async function fetchHealthz(): Promise<RuntimeReadiness> {
  try {
    const response = await fetch(BOUND_HEALTHZ, { signal: AbortSignal.timeout(2000) });
    const body = await response.json() as Record<string, unknown>;
    const build = body.build && typeof body.build === "object" && !Array.isArray(body.build)
      ? body.build as Record<string, unknown>
      : {};
    return {
      reachable: true,
      ok: body.ok === true,
      source_commit: typeof build.source_commit === "string" ? build.source_commit : null,
      build_id: typeof build.build_id === "string" ? build.build_id : null,
      package_version: typeof build.package_version === "string" ? build.package_version : null,
      local_protected_tools: Array.isArray(body.local_protected_tools)
        ? body.local_protected_tools.filter((name): name is string => typeof name === "string")
        : null,
    };
  } catch {
    return {
      reachable: false,
      ok: null,
      source_commit: null,
      build_id: null,
      package_version: null,
      local_protected_tools: null,
    };
  }
}

export function createProductionAdapters(): ActivationAdapters {
  const root = packageRoot();
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new HostActivationError("PLATFORM_UNSUPPORTED", "host activation requires a POSIX uid");
  }
  const serviceTarget = `gui/${uid}/${BOUND_SERVICE_LABEL}`;

  return {
    readInstalledIdentity() {
      return readIdentityFile(join(BOUND_INSTALL_ROOT, "generated", "build-identity.json"));
    },
    readServiceStatus() {
      try {
        const output = execFileSync(BOUND_LAUNCHCTL, ["print", serviceTarget], {
          encoding: "utf8",
        });
        const pid = parseLaunchctlPid(output);
        return { label: BOUND_SERVICE_LABEL, pid, running: pid !== null };
      } catch {
        return { label: BOUND_SERVICE_LABEL, pid: null, running: false };
      }
    },
    readSourceHead() {
      const commit = gitText(root, ["rev-parse", "HEAD"]);
      const tree = gitText(root, ["rev-parse", "HEAD^{tree}"]);
      const porcelain = gitText(root, ["status", "--porcelain=v1"]);
      const dirtyNonGenerated = sourceHasNonGeneratedDirt(porcelain);
      return { commit, tree, dirtyNonGenerated };
    },
    readSourceBuiltIdentity() {
      return readPackageBuildIdentity();
    },
    pack() {
      const dest = join(tmpdir(), "nexus-devspace-host-activation");
      mkdirSync(dest, { recursive: true });
      // --ignore-scripts skips postpack, which looks for *.tgz in cwd; the activator hashes the packed file itself.
      const raw = execFileSync(BOUND_NPM, ["pack", "--json", "--ignore-scripts", "--pack-destination", dest], {
        cwd: root,
        encoding: "utf8",
        timeout: 120000,
      });
      const parsed = JSON.parse(raw) as Array<{ filename?: string; id?: string }>;
      const filename = parsed[0]?.filename;
      if (!filename) throw new HostActivationError("PACK_FAILED", "npm pack did not return a filename");
      const tarballPath = resolve(dest, filename);
      if (!tarballPath.startsWith(resolve(dest) + "/") && tarballPath !== resolve(dest, filename)) {
        throw new HostActivationError("PACK_FAILED", "packed artifact escaped the bound destination");
      }
      const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
      return { tarballPath, sha256 };
    },
    install(artifact) {
      if (!artifact.tarballPath.startsWith(join(tmpdir(), "nexus-devspace-host-activation"))) {
        throw new HostActivationError("INSTALL_PATH_REJECTED", "refusing to install an artifact outside the bound pack directory");
      }
      execFileSync(BOUND_NPM, ["install", "-g", artifact.tarballPath], {
        encoding: "utf8",
        timeout: 180000,
      });
    },
    restartBoundService(_oldPid) {
      execFileSync(BOUND_LAUNCHCTL, ["kickstart", "-k", serviceTarget], { encoding: "utf8" });
      for (let i = 0; i < 40; i += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        try {
          const output = execFileSync(BOUND_LAUNCHCTL, ["print", serviceTarget], { encoding: "utf8" });
          const pid = parseLaunchctlPid(output);
          if (pid !== null) return { newPid: pid };
        } catch {
          // keep polling
        }
      }
      throw new HostActivationError("RESTART_FAILED", "bound service did not publish a pid after kickstart");
    },
    readRuntime() {
      throw new HostActivationError("RUNTIME_SYNC_UNSUPPORTED", "use runLiveHostGeneration");
    },
    readInstalledActions() {
      const configJs = readFileSync(join(BOUND_INSTALL_ROOT, "dist", "config.js"), "utf8");
      return [...CANONICAL_PROXY_LOCAL_PROTECTED_TOOLS].filter((name) => configJs.includes(`"${name}"`));
    },
    async sleep(ms) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
    },
  };
}

export async function runLiveHostGeneration(request: ActivationRequest): Promise<ActivationResult> {
  const base = createProductionAdapters();
  let runtime = await fetchHealthz();
  const adapters: ActivationAdapters = {
    ...base,
    readRuntime() {
      return runtime;
    },
    async sleep(ms) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
      runtime = await fetchHealthz();
    },
  };
  return await runHostGeneration(request, adapters);
}
