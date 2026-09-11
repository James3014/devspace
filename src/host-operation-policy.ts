import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";

export interface HostOperationPolicy {
  enabled: boolean;
  ownerClientId: string;
  executablePath: string;
  executableSha256: string;
  argv: readonly string[];
  cwd: string;
  allowedPaths: { write: readonly string[]; read?: readonly string[] };
  maxWallMs: number;
  maxIdleMs: number;
  allowLongLivedProcess: boolean;
}

export interface HostOperationRequest {
  attemptKey: string;
  clientId?: string;
  executablePath: string;
  argv: readonly string[];
  cwd: string;
  allowedPaths: { write: readonly string[]; read?: readonly string[] };
  maxWallMs: number;
  maxIdleMs: number;
  allowLongLivedProcess: boolean;
  workspaceRoot?: string;
}

export interface BoundHostOperation {
  readonly request: Readonly<HostOperationRequest>;
  readonly attemptKey: string;
  readonly executable: string;
  readonly allowedPaths: readonly string[];
  readonly executableSha256: string;
  readonly scopeRoot: string;
  readonly requestHash: string;
  readonly operationId: string;
  readonly argvFingerprint: string;
  readonly limits: Readonly<{ maxWallMs: number; maxIdleMs: number; allowLongLivedProcess: boolean }>;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_EXECUTABLES = new Set([
  "bash", "csh", "dash", "fish", "git", "ksh", "launchctl", "pwsh", "powershell", "sh", "sudo", "tcsh", "zsh",
]);
const SAFE_ENV_KEYS = new Set(["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]);

export async function bindHostOperation(
  policy: HostOperationPolicy,
  request: HostOperationRequest,
  authenticatedClientId: string,
): Promise<BoundHostOperation> {
  if (!policy.enabled) deny("HOST_OPERATION_DISABLED", "Host operations are disabled by startup policy.");
  validateClientId(authenticatedClientId, "authenticated client id");
  validateClientId(policy.ownerClientId, "policy owner client id");
  if (authenticatedClientId !== policy.ownerClientId || (request.clientId !== undefined && request.clientId !== authenticatedClientId)) {
    deny("HOST_OPERATION_UNAUTHORIZED", "Host operation client identity does not match the startup-selected owner.");
  }
  validateRequestShape(request);
  const trusted = await normalizePolicy(policy);
  const executable = await canonicalFile(request.executablePath, "request executable");
  const executableSha256 = await sha256File(executable);
  if (executable !== trusted.executablePath || executableSha256 !== trusted.executableSha256) {
    deny("HOST_OPERATION_INVALID", "Executable path or content hash does not match startup policy.");
  }
  if (isForbiddenExecutable(executable)) deny("HOST_OPERATION_INVALID", "Executable class is forbidden for host operations.");
  if (!sameArray(request.argv, trusted.argv)) deny("HOST_OPERATION_INVALID", "Request argv does not exactly match startup policy.");
  const cwd = await canonicalDirectory(request.cwd, "request cwd");
  if (cwd !== trusted.cwd) deny("HOST_OPERATION_INVALID", "Request cwd does not exactly match startup policy.");

  const writePaths = await normalizeSubset(request.allowedPaths.write, trusted.writePaths, "write");
  const readPaths = await normalizeSubset(request.allowedPaths.read ?? [], trusted.readPaths, "read");
  await assertReadFiles(readPaths);
  for (const path of writePaths) assertSafeWritePath(path, request.workspaceRoot);
  for (const path of readPaths) assertSafeReadPath(path);
  if (pathsIntersect(executable, writePaths)) {
    deny("HOST_OPERATION_INVALID", "Executable path overlaps an approved write path.");
  }
  if (pathsIntersect(request.workspaceRoot ? await canonicalDirectory(request.workspaceRoot, "workspace root") : undefined, writePaths)) {
    deny("HOST_OPERATION_INVALID", "Workspace root intersects an approved write path.");
  }
  if (request.maxWallMs > trusted.maxWallMs || request.maxIdleMs > trusted.maxIdleMs) {
    deny("HOST_OPERATION_INVALID", "Requested time limits exceed startup policy.");
  }
  if (request.allowLongLivedProcess && !trusted.allowLongLivedProcess) {
    deny("HOST_OPERATION_INVALID", "Long-lived host processes are disabled by startup policy.");
  }

  const normalizedRequest = {
    attemptKey: request.attemptKey,
    clientId: request.clientId ?? authenticatedClientId,
    executablePath: executable,
    argv: [...request.argv],
    cwd,
    allowedPaths: { write: writePaths, read: readPaths },
    maxWallMs: request.maxWallMs,
    maxIdleMs: request.maxIdleMs,
    allowLongLivedProcess: request.allowLongLivedProcess,
    ...(request.workspaceRoot ? { workspaceRoot: await canonicalDirectory(request.workspaceRoot, "workspace root") } : {}),
  } satisfies HostOperationRequest;
  const policyHash = hashJson({ ...trusted, writePaths: trusted.writePaths, readPaths: trusted.readPaths });
  const requestHash = hashJson({ policyHash, request: normalizedRequest });
  const operationId = `host_${hashText(`${policyHash}\0${normalizedRequest.clientId}\0${request.attemptKey}\0${normalizedRequest.workspaceRoot ?? ""}`).slice(0, 32)}`;
  const bound = {
    request: deepFreeze(normalizedRequest),
    attemptKey: normalizedRequest.attemptKey,
    executable: normalizedRequest.executablePath,
    allowedPaths: Object.freeze([...normalizedRequest.allowedPaths.write]),
    executableSha256,
    scopeRoot: trusted.cwd,
    requestHash,
    operationId,
    argvFingerprint: hashJson([executable, ...normalizedRequest.argv]),
    limits: Object.freeze({ maxWallMs: request.maxWallMs, maxIdleMs: request.maxIdleMs, allowLongLivedProcess: request.allowLongLivedProcess }),
  } satisfies BoundHostOperation;
  return Object.freeze(bound);
}

export async function prepareHostOperationSandbox(
  bound: BoundHostOperation,
): Promise<{ argv: readonly string[]; env: Readonly<Record<string, string>> }> {
  const request = bound.request;
  const executable = await canonicalFile(request.executablePath, "bound executable");
  if (executable !== bound.executable || await sha256File(executable) !== bound.executableSha256) {
    deny("HOST_OPERATION_INVALID", "Bound executable changed after policy validation.");
  }
  const writePaths = await normalizePaths(request.allowedPaths.write, "bound write");
  if (!sameArray(writePaths, [...request.allowedPaths.write].sort())) {
    deny("HOST_OPERATION_INVALID", "Bound write scope changed after policy validation.");
  }
  if (!SandboxManager.isSupportedPlatform()) deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", "Host operation sandbox is unavailable on this platform.");
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length > 0) deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", `Host operation sandbox dependencies unavailable: ${dependencies.errors.join("; ")}`);
  const linkedLibraries = linkedLibraryPaths(request.executablePath);
  const command = `exec ${[request.executablePath, ...request.argv].map(shellQuote).join(" ")}`;
  if (process.platform !== "darwin") deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", "Host operation sandbox requires Darwin profile support.");
  const wrappedCommand = wrapCommandWithSandboxMacOS({
    command,
    commandId: bound.operationId,
    needsNetworkRestriction: true,
    httpProxyPort: undefined,
    socksProxyPort: undefined,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
    readConfig: { denyOnly: ["/"], allowWithinDeny: [...runtimeReadCarveouts(request.executablePath, linkedLibraries), ...(request.allowedPaths.read ?? []).flatMap(sandboxPathAliases)] },
    writeConfig: { allowOnly: request.allowedPaths.write.flatMap(sandboxPathAliases), denyWithinAllow: gitRootsToDeny(request.allowedPaths.write) },
    allowGitConfig: false,
    allowAppleEvents: false,
    binShell: "/bin/bash",
  });
  const wrapped = { argv: ["/bin/bash", "-c", wrappedCommand], env: process.env };
  if (process.platform === "darwin") {
    const profileMarker = "(allow process-fork)";
    const wrapperIndex = wrapped.argv.findIndex((value) => value.includes(profileMarker));
    if (wrapperIndex < 0) deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", "Sandbox wrapper did not expose a process-fork rule.");
    let wrapperCommand = wrapped.argv[wrapperIndex]!;
    wrapperCommand = wrapperCommand.replace(profileMarker, "(deny process-fork)");
    const broadReadMarker = "; File read\n(allow file-read*)\n";
    if (!wrapperCommand.includes(broadReadMarker)) deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", "Sandbox wrapper did not expose the default read rule.");
    // Keep only the root directory inode for traversal.  Removing the
    // runtime's default `(allow file-read*)` outright makes dyld abort before
    // exec; a literal root grant exposes no subtree contents and lets the
    // exact carve-outs below take effect.
    wrapperCommand = wrapperCommand.replace(broadReadMarker, '; File read\n(allow file-read* (literal "/"))\n');
    wrapperCommand = removeDefaultWriteCarveouts(wrapperCommand);
    // The generated profile's deny-root rule has deny precedence over the
    // exact allow subpaths. Remove only that root rule; the helper's git and
    // other deny rules remain in force below.
    wrapperCommand = wrapperCommand.replace(/\(deny file-write-unlink file-write-create\n  \(subpath "\/"\)\n  \(with message "[^"]+"\)\)\n/g, "");
    const writableMetadata = request.allowedPaths.write.flatMap(sandboxPathAliases).map((path) => `  (subpath ${JSON.stringify(path)})`).join("\n");
    if (writableMetadata) {
      const writableRules = request.allowedPaths.write.flatMap(sandboxPathAliases).map((path) => `  (subpath ${JSON.stringify(path)})`).join("\n");
      wrapperCommand = wrapperCommand.replace("; File write\n", `(allow file-read-metadata\n${writableMetadata}\n)\n(allow file-write*\n${writableRules}\n)\n\n; File write\n`);
    }
    for (const path of runtimeSymlinkCarveouts(request.executablePath, linkedLibraries)) {
      const quoted = shellProfilePath(path);
      wrapperCommand = wrapperCommand.replaceAll(`(subpath "${quoted}")`, `(literal "${quoted}")`);
    }
    const runtimeParents = runtimeSymlinkCarveouts(request.executablePath, linkedLibraries).flatMap((path) => {
      const parents: string[] = [];
      let current = dirname(path);
      for (let depth = 0; depth < 4 && current !== "/"; depth += 1) {
        parents.push(current);
        current = dirname(current);
      }
      return parents;
    });
    const requestParents = symlinkAncestorPaths([request.cwd, ...request.allowedPaths.write, ...(request.allowedPaths.read ?? [])]);
    if (runtimeParents.length > 0 || requestParents.length > 0) {
      const runtimeRules = [...new Set(runtimeParents)].map((path) => `  (literal ${JSON.stringify(path)})`).join("\n");
      const requestRules = [...new Set(requestParents)].map((path) => `  (literal ${JSON.stringify(path)})`).join("\n");
      const grants = `${runtimeRules ? `(allow file-read*\n${runtimeRules}\n)\n` : ""}${requestRules ? `(allow file-read-metadata\n${requestRules}\n)\n` : ""}`;
      wrapperCommand = wrapperCommand.replace("; File write\n", `${grants}\n; File write\n`);
    }
    const securityServerGrant = '(allow mach-lookup (global-name "com.apple.SecurityServer"))';
    if (wrapperCommand.includes(securityServerGrant)) wrapperCommand = wrapperCommand.replaceAll(`${securityServerGrant}\n`, "");
    if (wrapperCommand.includes(securityServerGrant)) deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", "Sandbox wrapper retained an unexpected SecurityServer grant.");
    wrapped.argv[wrapperIndex] = wrapperCommand;
  }
  const env = Object.fromEntries(Object.entries(wrapped.env).filter(([key, value]) => typeof value === "string" && (SAFE_ENV_KEYS.has(key) || key.startsWith("SANDBOX_") || key.startsWith("SRT_")))) as Record<string, string>;
  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  return Object.freeze({ argv: Object.freeze([...wrapped.argv]), env: Object.freeze(env) });
}

function symlinkAncestorPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of paths.flatMap(sandboxPathAliases)) {
    let current = resolve(path);
    const ancestors: string[] = [];
    while (current !== "/") {
      try { if (lstatSync(current).isSymbolicLink()) ancestors.push(current); } catch {}
      current = dirname(current);
    }
    result.push(...ancestors);
  }
  return result;
}

async function normalizePolicy(policy: HostOperationPolicy): Promise<{ executablePath: string; executableSha256: string; argv: string[]; cwd: string; writePaths: string[]; readPaths: string[]; maxWallMs: number; maxIdleMs: number; allowLongLivedProcess: boolean }> {
  validateRequestShape({ ...policy, attemptKey: "policy", clientId: policy.ownerClientId });
  if (!SHA256_PATTERN.test(policy.executableSha256)) deny("HOST_OPERATION_INVALID", "Policy executable hash is malformed.");
  const executablePath = await canonicalFile(policy.executablePath, "policy executable");
  const digest = await sha256File(executablePath);
  if (digest !== policy.executableSha256) deny("HOST_OPERATION_INVALID", "Policy executable content hash is stale or incorrect.");
  if (isForbiddenExecutable(executablePath)) deny("HOST_OPERATION_INVALID", "Policy executable class is forbidden for host operations.");
  const cwd = await canonicalDirectory(policy.cwd, "policy cwd");
  const writePaths = await normalizePaths(policy.allowedPaths.write, "policy write");
  const readPaths = await normalizePaths(policy.allowedPaths.read ?? [], "policy read");
  for (const path of writePaths) assertSafeWritePath(path);
  for (const path of readPaths) assertSafeReadPath(path);
  return { executablePath, executableSha256: digest, argv: [...policy.argv], cwd, writePaths, readPaths, maxWallMs: policy.maxWallMs, maxIdleMs: policy.maxIdleMs, allowLongLivedProcess: policy.allowLongLivedProcess };
}

function validateRequestShape(value: Pick<HostOperationPolicy, "argv" | "cwd" | "allowedPaths" | "maxWallMs" | "maxIdleMs" | "allowLongLivedProcess"> & Partial<Pick<HostOperationRequest, "attemptKey" | "clientId">>): void {
  if (!Array.isArray(value.argv) || value.argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) deny("HOST_OPERATION_INVALID", "Host operation argv is malformed.");
  if (!isAbsolute(value.cwd) || !value.cwd.trim()) deny("HOST_OPERATION_INVALID", "Host operation cwd is malformed.");
  if (!value.allowedPaths || !Array.isArray(value.allowedPaths.write)) deny("HOST_OPERATION_INVALID", "Host operation requires explicit write scope.");
  if (value.allowedPaths.write.some((path) => typeof path !== "string" || !path.trim()) || (value.allowedPaths.read ?? []).some((path) => typeof path !== "string" || !path.trim())) deny("HOST_OPERATION_INVALID", "Host operation path scope is malformed.");
  if (!Number.isSafeInteger(value.maxWallMs) || value.maxWallMs <= 0 || !Number.isSafeInteger(value.maxIdleMs) || value.maxIdleMs <= 0) deny("HOST_OPERATION_INVALID", "Host operation limits must be positive safe integers.");
  if (value.attemptKey !== undefined && !ATTEMPT_KEY_PATTERN.test(value.attemptKey)) deny("HOST_OPERATION_INVALID", "Host operation attempt key is malformed.");
  if (value.clientId !== undefined) validateClientId(value.clientId, "client id");
}

function validateClientId(value: string, label: string): void {
  if (!CLIENT_ID_PATTERN.test(value)) deny("HOST_OPERATION_INVALID", `${label} is malformed.`);
}

async function normalizePaths(paths: readonly string[], label: string): Promise<string[]> {
  const normalized = await Promise.all(paths.map((path) => canonicalExistingPath(path, `${label} path`)));
  return [...new Set(normalized)].sort();
}

async function assertReadFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) deny("HOST_OPERATION_INVALID", "Read scope must use exact files, not broad directories.");
  }
}

async function normalizeSubset(paths: readonly string[], approved: readonly string[], label: string): Promise<string[]> {
  const normalized = await normalizePaths(paths, `request ${label}`);
  if (normalized.some((path) => !approved.some((root) => isWithin(path, root)))) deny("HOST_OPERATION_INVALID", `Request ${label} path is outside startup policy.`);
  return normalized;
}

async function canonicalFile(path: string, label: string): Promise<string> {
  const canonical = await canonicalExistingPath(path, label);
  if (!(await stat(canonical)).isFile()) deny("HOST_OPERATION_INVALID", `${label} must be a regular file.`);
  return canonical;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await canonicalExistingPath(path, label);
  if (!(await stat(canonical)).isDirectory()) deny("HOST_OPERATION_INVALID", `${label} must be a directory.`);
  return canonical;
}

async function canonicalExistingPath(path: string, label: string): Promise<string> {
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) deny("HOST_OPERATION_INVALID", `${label} is malformed.`);
  try { return await realpath(path); } catch { deny("HOST_OPERATION_INVALID", `${label} is missing or contains an unsafe symlink.`); }
}

function assertSafeWritePath(path: string, workspaceRoot?: string): void {
  const home = resolve(homedir());
  const canonicalTmp = realpathSync.native(tmpdir());
  if (path === dirname(path) || path === home || path === "/" || path === canonicalTmp || isWithin(home, path) || isWithin(canonicalTmp, path)) deny("HOST_OPERATION_INVALID", "Broad root/home/temp writes are forbidden.");
  if (findGitRoot(path)) deny("HOST_OPERATION_INVALID", "Writes inside a configured repository are forbidden.");
  if (workspaceRoot && pathsIntersect(workspaceRoot, [path])) deny("HOST_OPERATION_INVALID", "Workspace root intersects an approved write path.");
}

function assertSafeReadPath(path: string): void {
  if (path === "/" || path === resolve(homedir())) deny("HOST_OPERATION_INVALID", "Broad root/home reads are forbidden.");
}

function findGitRoot(path: string): string | undefined {
  let current = path;
  while (current !== dirname(current)) {
    try { if (requireDirectoryOrFile(`${current}/.git`)) return current; } catch {}
    current = dirname(current);
  }
  return undefined;
}

function requireDirectoryOrFile(path: string): boolean {
  return existsSync(path);
}

function gitRootsToDeny(paths: readonly string[]): string[] {
  return [...new Set(paths.map(findGitRoot).filter((path): path is string => Boolean(path)))];
}

function runtimeReadCarveouts(executablePath: string, linkedLibraries = linkedLibraryPaths(executablePath)): string[] {
  const paths = [
    executablePath,
    "/dev",
    "/bin/bash",
    "/usr/bin/sandbox-exec",
    "/usr/lib",
    "/System/Library",
    ...linkedLibraries,
  ].filter((path) => existsSync(path));
  // dyld probes the install-name spelling first (often an /opt/homebrew/opt
  // symlink), while the sandbox profile also needs the resolved target.
  const withTargets = paths.flatMap((path) => {
    try {
      const target = realpathSync.native(path);
      const resolvedLeaf = join(realpathSync.native(dirname(path)), basename(path));
      return [path, target, ...(existsSync(resolvedLeaf) ? [resolvedLeaf, realpathSync.native(resolvedLeaf)] : [])];
    } catch { return [path]; }
  });
  // Parent directories must never be placed in allowWithinDeny: the SDK
  // renders those entries as subpath grants, turning traversal into subtree
  // read authority. The profile's fixed runtime rules provide traversal;
  // dynamic carveouts remain exact install-name/realpath objects only.
  return [...new Set([...withTargets, ...runtimeSymlinkCarveouts(executablePath)])];
}

function runtimeSymlinkCarveouts(executablePath: string, linkedLibraries = linkedLibraryPaths(executablePath)): string[] {
  const paths = [executablePath, ...linkedLibraries].filter((path) => existsSync(path));
  return paths.flatMap((path) => {
    try {
      const aliases = [path, join(realpathSync.native(dirname(path)), basename(path))];
      if (!lstatSync(path).isSymbolicLink()) return aliases.filter(existsSync);
      aliases.push(realpathSync.native(path));
      return aliases;
    } catch { return []; }
  });
}

function sandboxPathAliases(path: string): string[] {
  if (path.startsWith("/private/")) return [path, path.slice("/private".length)];
  if (path.startsWith("/var/") || path.startsWith("/tmp/")) return [path, `/private${path}`];
  return [path];
}

function removeDefaultWriteCarveouts(profile: string): string {
  // sandbox-runtime always adds its session logging paths to allowOnly.  They
  // are outside the bound request and must not become write authority merely
  // because the helper uses the runtime wrapper.
  const home = shellProfilePath(homedir());
  const result = profile
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      const isPathRule = trimmed.startsWith("(subpath ") || trimmed.startsWith("(regex ") || trimmed.startsWith("(literal ");
      return !isPathRule || (!line.includes("/tmp/claude") && !line.includes(`${home}/.npm/_logs`) && !line.includes(`${home}/.claude/debug`));
    })
    .join("\n");
  return result;
}

function shellProfilePath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function linkedLibraryPaths(executablePath: string): string[] {
  if (process.platform !== "darwin") return [];
  const seen = new Set<string>();
  const result: string[] = [];
  const startedAt = Date.now();
  const visit = (path: string, depth: number): void => {
    if (depth > 4 || seen.has(path)) return;
    if (seen.size >= 128 || Date.now() - startedAt > 5_000) deny("HOST_OPERATION_SANDBOX_UNAVAILABLE", "Executable dependency scan exceeded its bounded limit.");
    seen.add(path);
    const output = spawnSync("/usr/bin/otool", ["-L", path], { encoding: "utf8", timeout: 1_000, maxBuffer: 1_024 * 1_024 });
    if (output.status !== 0 || typeof output.stdout !== "string") return;
    for (const dependency of output.stdout.split("\n").slice(1).map((line) => line.trim().split(" ", 1)[0] ?? "").map((value) => value.startsWith("@loader_path/") ? join(dirname(path), value.slice("@loader_path/".length)) : value.startsWith("@rpath/") ? resolve(dirname(path), value.slice("@rpath/".length)) : value).filter((value) => value.startsWith("/"))) {
      if (!seen.has(dependency)) result.push(dependency);
      if (existsSync(dependency)) visit(dependency, depth + 1);
    }
  };
  visit(executablePath, 0);
  return result;
}

function pathsIntersect(root: string | undefined, paths: readonly string[]): boolean {
  return root !== undefined && paths.some((path) => isWithin(root, path) || isWithin(path, root));
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isForbiddenExecutable(path: string): boolean {
  const name = basename(path).toLowerCase().replace(/\.exe$/, "");
  return FORBIDDEN_EXECUTABLES.has(name);
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hashJson(value: unknown): string { return hashText(JSON.stringify(value)); }
async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function sameArray(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function deny(code: string, message: string): never { throw new HostOperationPolicyError(code, message); }

export class HostOperationPolicyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "HostOperationPolicyError"; }
}
