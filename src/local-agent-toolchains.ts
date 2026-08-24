import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Allowlisted toolchain registry for bounded repository verification.
 *
 * Dev MCP never installs packages, creates a .venv, or mutates repository
 * configuration to locate verifier executables. If a toolchain is not already
 * configured, the verification call fails explicitly.
 */

export interface ToolchainSpec {
  id: string;
  root: string;
  /** verifier name -> executable path (absolute or relative to root). */
  verifiers: Record<string, string>;
  /**
   * Optional read-only dependency bridge for managed worktrees. The Candidate
   * lock and declarations define selected package requirements; actual package
   * identities in the configured dependency root must satisfy them before use.
   */
  dependencyBridge?: {
    /** Optional exact binding for the Candidate workspace lockfile only. */
    lockfileSha256?: string;
    /** Preferred selected package names, or legacy exact package-version requirements. */
    packages: string[] | Record<string, string>;
  };
}

export interface ResolvedToolchainExecutable {
  executable: string;
  root: string;
}

export interface ToolchainVerificationResult {
  toolchainId: string;
  verifier: string;
  executable: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export function parseToolchains(value: string | undefined): ToolchainSpec[] {
  if (!value || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`DEVSPACE_TOOLCHAINS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DEVSPACE_TOOLCHAINS must be a JSON array of toolchain objects.");
  }

  const toolchains: ToolchainSpec[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("DEVSPACE_TOOLCHAINS entries must be objects.");
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
    const root = typeof record.root === "string" && record.root.trim() ? record.root.trim() : undefined;
    const verifiers = record.verifiers;
    if (!id || !root) {
      throw new Error(`DEVSPACE_TOOLCHAINS entry must have string id and root.`);
    }
    if (!verifiers || typeof verifiers !== "object" || Array.isArray(verifiers)) {
      throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' must have a verifiers mapping.`);
    }
    const resolvedVerifiers: Record<string, string> = {};
    for (const [name, executable] of Object.entries(verifiers)) {
      if (typeof executable !== "string" || !executable.trim()) {
        throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' verifier '${name}' must be a string.`);
      }
      resolvedVerifiers[name] = executable.trim();
    }
    let dependencyBridge: ToolchainSpec["dependencyBridge"];
    if (record.dependencyBridge !== undefined) {
      if (!record.dependencyBridge || typeof record.dependencyBridge !== "object" || Array.isArray(record.dependencyBridge)) {
        throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' dependencyBridge must be an object.`);
      }
      const bridge = record.dependencyBridge as Record<string, unknown>;
      const lockfileSha256 = typeof bridge.lockfileSha256 === "string"
        ? bridge.lockfileSha256.trim().toLowerCase()
        : undefined;
      if (lockfileSha256 !== undefined && !/^[0-9a-f]{64}$/.test(lockfileSha256)) {
        throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' dependencyBridge.lockfileSha256 must be a SHA-256 hex digest.`);
      }
      let packages: string[] | Record<string, string>;
      if (Array.isArray(bridge.packages)) {
        packages = [];
        for (const name of bridge.packages) {
          if (typeof name !== "string" || !validPackageName(name) || packages.includes(name)) {
            throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' dependencyBridge package '${String(name)}' is invalid.`);
          }
          packages.push(name);
        }
      } else {
        if (!bridge.packages || typeof bridge.packages !== "object") {
          throw new Error(
            `DEVSPACE_TOOLCHAINS entry '${id}' dependencyBridge.packages must be selected package names or a package-version mapping.`,
          );
        }
        packages = {};
        for (const [name, version] of Object.entries(bridge.packages)) {
          if (!validPackageName(name) || typeof version !== "string" || !version.trim()) {
            throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' dependencyBridge package '${name}' is invalid.`);
          }
          packages[name] = version.trim();
        }
      }
      dependencyBridge = { lockfileSha256, packages };
    }
    toolchains.push({ id, root, verifiers: resolvedVerifiers, dependencyBridge });
  }
  return toolchains;
}

function validPackageName(name: string): boolean {
  return Boolean(name) && !isAbsolute(name) && !name.split("/").some((part) => !part || part === "." || part === "..");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
};

type PackageLock = {
  packages?: Record<string, { version?: unknown } & PackageManifest>;
};

function readJsonFile<T>(path: string, description: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new Error(`${description} is missing or unreadable: ${path}`);
  }
}

function dependencyRequirement(manifest: PackageManifest, name: string): string | undefined {
  for (const field of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    const value = (field as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numericVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareNumericVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesCandidateRequirement(version: string, requirement: string): boolean {
  const actual = numericVersion(version);
  const trimmed = requirement.trim();
  if (!actual) return version === trimmed;
  if (trimmed === "*" || trimmed === "x" || trimmed === "X") return true;
  const exact = numericVersion(trimmed);
  if (exact) return version === trimmed;

  const operator = /^(\^|~)(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (operator) {
    const minimum = numericVersion(operator[2]);
    if (!minimum || compareNumericVersions(actual, minimum) < 0) return false;
    const [major, minor, patch] = minimum;
    const maximum: [number, number, number] = operator[1] === "~"
      ? [major, minor + 1, 0]
      : major > 0
        ? [major + 1, 0, 0]
        : minor > 0
          ? [0, minor + 1, 0]
          : [0, 0, patch + 1];
    return compareNumericVersions(actual, maximum) < 0;
  }

  const comparisons = trimmed.split(/\s+/).filter(Boolean);
  if (comparisons.length > 0 && comparisons.every((part) => /^(?:>=|>|<=|<)\d+\.\d+\.\d+$/.test(part))) {
    return comparisons.every((part) => {
      const match = /^(>=|>|<=|<)(\d+\.\d+\.\d+)$/.exec(part)!;
      const expected = numericVersion(match[2])!;
      const comparison = compareNumericVersions(actual, expected);
      return match[1] === ">=" ? comparison >= 0
        : match[1] === ">" ? comparison > 0
          : match[1] === "<=" ? comparison <= 0
            : comparison < 0;
    });
  }
  return false;
}

/**
 * Build an environment that lets tools execute against one configured,
 * read-only dependency root without adding node_modules to the worktree.
 */
export function buildToolchainEnvironment(
  toolchains: ToolchainSpec[],
  toolchainId: string,
  workspaceRoot: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const toolchain = toolchains.find((candidate) => candidate.id === toolchainId);
  if (!toolchain) throw new Error(`Toolchain '${toolchainId}' is not configured.`);
  if (!toolchain.dependencyBridge) return { ...baseEnv };

  const root = realpathSync(toolchain.root);
  const workspace = realpathSync(workspaceRoot);
  const workspaceLockfile = join(workspace, "package-lock.json");
  const expectedHash = toolchain.dependencyBridge.lockfileSha256;
  if (!existsSync(workspaceLockfile) || (expectedHash && fileSha256(workspaceLockfile) !== expectedHash)) {
    throw new Error(`Toolchain '${toolchainId}' workspace lockfile is stale or missing.`);
  }

  const workspaceManifest = readJsonFile<PackageManifest>(
    join(workspace, "package.json"),
    `Toolchain '${toolchainId}' Candidate package manifest`,
  );
  const workspaceLock = readJsonFile<PackageLock>(
    workspaceLockfile,
    `Toolchain '${toolchainId}' Candidate lockfile`,
  );
  const selectedPackages = Array.isArray(toolchain.dependencyBridge.packages)
    ? toolchain.dependencyBridge.packages.map((name) => ({ name, exactVersion: undefined }))
    : Object.entries(toolchain.dependencyBridge.packages).map(([name, exactVersion]) => ({ name, exactVersion }));
  const nodeModules = realpathSync(join(root, "node_modules"));
  for (const { name, exactVersion } of selectedPackages) {
    const candidateVersion = workspaceLock.packages?.[`node_modules/${name}`]?.version;
    if (typeof candidateVersion !== "string") {
      throw new Error(`Toolchain '${toolchainId}' Candidate lock does not resolve selected dependency '${name}'.`);
    }
    const declaredRequirement = dependencyRequirement(workspaceManifest, name)
      ?? dependencyRequirement(workspaceLock.packages?.[""] ?? {}, name);
    if (!declaredRequirement) {
      throw new Error(`Toolchain '${toolchainId}' Candidate does not declare selected dependency '${name}'.`);
    }
    const required = exactVersion ?? declaredRequirement;
    if (exactVersion && candidateVersion !== exactVersion) {
      throw new Error(
        `Toolchain '${toolchainId}' Candidate lock resolves '${name}' to ${candidateVersion}, not configured ${exactVersion}.`,
      );
    }
    if (!satisfiesCandidateRequirement(candidateVersion, declaredRequirement)) {
      throw new Error(
        `Toolchain '${toolchainId}' Candidate lock for '${name}' contradicts requirement ${declaredRequirement}: ${candidateVersion}.`,
      );
    }
    const packagePath = resolve(nodeModules, name, "package.json");
    if (!packagePath.startsWith(`${nodeModules}${sep}`) || !existsSync(packagePath)) {
      throw new Error(`Toolchain '${toolchainId}' dependency '${name}' is missing.`);
    }
    let actualName: unknown;
    let actualVersion: unknown;
    try {
      const identity = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown; version?: unknown };
      actualName = identity.name;
      actualVersion = identity.version;
    } catch {
      throw new Error(`Toolchain '${toolchainId}' dependency '${name}' has an unreadable package identity.`);
    }
    if (actualName !== name || typeof actualVersion !== "string" || !satisfiesCandidateRequirement(actualVersion, required)) {
      throw new Error(
        `Toolchain '${toolchainId}' dependency '${name}' requires ${required}; found ${String(actualVersion ?? "unknown")}.`,
      );
    }
  }

  const bin = realpathSync(join(nodeModules, ".bin"));
  const requireBase = pathToFileURL(join(root, "package.json")).href;
  const hookSource = [
    `import{builtinModules,createRequire,syncBuiltinESMExports}from"node:module"`,
    `import{readFileSync}from"node:fs"`,
    `import{join,resolve,sep}from"node:path"`,
    `import{pathToFileURL,fileURLToPath}from"node:url"`,
    `const bridgeRequire=createRequire(${JSON.stringify(requireBase)})`,
    `const bridgeNodeModules=${JSON.stringify(nodeModules)}`,
    `const bridgeNodeModulesUrl=pathToFileURL(bridgeNodeModules+sep).href`,
    `const workspaceRoot=${JSON.stringify(workspace)}`,
    `const moduleApi=bridgeRequire("node:module")`,
    `const originalRegisterHooks=moduleApi.registerHooks.bind(moduleApi)`,
    `const bridgeBuiltins=new Set(builtinModules.flatMap(name=>[name,name.replace(/^node:/,"")]))`,
    `const exportTarget=(value,wildcard)=>{if(typeof value==="string")return wildcard?value.replace("*",wildcard):value;if(Array.isArray(value)){for(const item of value){const target=exportTarget(item,wildcard);if(target)return target}return}if(value&&typeof value==="object"){for(const condition of ["import","node","default"]){const target=exportTarget(value[condition],wildcard);if(target)return target}}}`,
    `const bridgeUrl=specifier=>{let required;try{required=bridgeRequire.resolve(specifier)}catch{}if(required&&required.startsWith(bridgeNodeModules+sep))return pathToFileURL(required).href;const parts=specifier.split("/");const packageParts=specifier.startsWith("@")?parts.slice(0,2):parts.slice(0,1);const packageName=packageParts.join("/");const subpath="."+(parts.length>packageParts.length?"/"+parts.slice(packageParts.length).join("/"):"");const packageRoot=join(bridgeNodeModules,...packageParts);let manifest;try{manifest=JSON.parse(readFileSync(join(packageRoot,"package.json"),"utf8"))}catch{throw new Error("DevSpace dependency bridge cannot resolve '"+specifier+"' from its verified source checkout")}let target;if(manifest.exports!==undefined){if(manifest.exports&&typeof manifest.exports==="object"&&!Array.isArray(manifest.exports)&&Object.keys(manifest.exports).some(key=>key.startsWith("."))){target=exportTarget(manifest.exports[subpath]);if(!target){for(const [key,value] of Object.entries(manifest.exports)){const star=key.indexOf("*");if(star<0)continue;const prefix=key.slice(0,star);const suffix=key.slice(star+1);if(subpath.startsWith(prefix)&&subpath.endsWith(suffix)){target=exportTarget(value,subpath.slice(prefix.length,subpath.length-suffix.length));if(target)break}}}}else if(subpath===".")target=exportTarget(manifest.exports)}else target=subpath==="."?(manifest.module??manifest.main??"./index.js"):subpath;if(typeof target!=="string"||!target.startsWith("./"))throw new Error("DevSpace dependency bridge cannot resolve '"+specifier+"' from its verified source checkout");const entry=resolve(packageRoot,target);if(entry!==packageRoot&&!entry.startsWith(packageRoot+sep))throw new Error("DevSpace dependency bridge rejected out-of-root dependency '"+packageName+"'");return pathToFileURL(entry).href}`,
    `const bridgeHooks={resolve(specifier,context,nextResolve){`,
    `if(bridgeBuiltins.has(specifier)||/^[a-z][a-z0-9+.-]*:/i.test(specifier)||specifier.startsWith("#")||specifier.startsWith(".")||specifier.startsWith("/"))return nextResolve(specifier,context)`,
    `if(context.parentURL?.startsWith(bridgeNodeModulesUrl)){const result=nextResolve(specifier,context);if(result.url?.startsWith(bridgeNodeModulesUrl))return result;throw new Error("DevSpace dependency bridge rejected dependency resolution outside its verified source checkout: "+specifier)}`,
    `const parentInsideWorkspace=url=>{if(!url)return true;try{return fileURLToPath(url).startsWith(workspaceRoot+sep)}catch{return false}}`,
    `if(parentInsideWorkspace(context.parentURL))return nextResolve(bridgeUrl(specifier),context)`,
    `return nextResolve(specifier,context)`,
    `}}`,
    `originalRegisterHooks(bridgeHooks)`,
    `moduleApi.registerHooks=(hooks)=>{const result=originalRegisterHooks(hooks);originalRegisterHooks(bridgeHooks);return result}`,
    `syncBuiltinESMExports()`,
  ].join(";");
  const bridgeImport = `--import=data:text/javascript,${encodeURIComponent(hookSource)}`;
  return {
    ...baseEnv,
    PATH: baseEnv.PATH ? `${bin}${delimiter}${baseEnv.PATH}` : bin,
    NODE_PATH: nodeModules,
    NODE_OPTIONS: baseEnv.NODE_OPTIONS ? `${bridgeImport} ${baseEnv.NODE_OPTIONS}` : bridgeImport,
    DEVSPACE_DEPENDENCY_ROOT: root,
  };
}

export function resolveToolchainExecutable(
  toolchains: ToolchainSpec[],
  toolchainId: string,
  verifier: string,
): ResolvedToolchainExecutable | undefined {
  const toolchain = toolchains.find((candidate) => candidate.id === toolchainId);
  if (!toolchain) return undefined;

  const configured = toolchain.verifiers[verifier];
  if (!configured) return undefined;

  const executable = isAbsolute(configured)
    ? resolve(configured)
    : resolve(toolchain.root, configured);

  if (!existsSync(executable)) return undefined;
  try {
    return { executable: realpathSync(executable), root: toolchain.root };
  } catch {
    return undefined;
  }
}

export function describeToolchainExecutables(
  toolchains: ToolchainSpec[],
  toolchainId: string,
): Record<string, string> | undefined {
  const toolchain = toolchains.find((candidate) => candidate.id === toolchainId);
  if (!toolchain) return undefined;
  const executables: Record<string, string> = {};
  for (const [verifier, configured] of Object.entries(toolchain.verifiers)) {
    const resolved = resolveToolchainExecutable(toolchains, toolchainId, verifier);
    executables[verifier] = resolved?.executable ?? configured;
  }
  return executables;
}

/**
 * Run one allowlisted verifier executable with a bounded cwd, bounded timeout,
 * and structured output. No shell, no redirection, no environment mutation,
 * no package installation.
 */
export function runToolchainVerifier(input: {
  toolchains: ToolchainSpec[];
  toolchainId: string;
  verifier: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<ToolchainVerificationResult> {
  const resolved = resolveToolchainExecutable(input.toolchains, input.toolchainId, input.verifier);
  if (!resolved) {
    return Promise.reject(
      new Error(
        `Toolchain '${input.toolchainId}' verifier '${input.verifier}' is not configured or not resolvable.`,
      ),
    );
  }

  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS;
  let environment: NodeJS.ProcessEnv;
  try {
    environment = buildToolchainEnvironment(
      input.toolchains,
      input.toolchainId,
      input.cwd,
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    );
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let completed = false;
    let timer: NodeJS.Timeout | undefined;

    const child = execFile(
      resolved.executable,
      input.args,
      {
        cwd: input.cwd,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        env: environment,
      },
      (error, stdout, stderr) => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeout(timer);
        const timedOut = Boolean(
          error &&
            typeof error === "object" &&
            "killed" in error &&
            (error as { killed?: unknown }).killed === true &&
            typeof error === "object" &&
            "signal" in error &&
            (error as { signal?: unknown }).signal === "SIGTERM",
        );
        resolvePromise({
          toolchainId: input.toolchainId,
          verifier: input.verifier,
          executable: resolved.executable,
          exitCode: error ? (error as { code?: number | null }).code ?? null : 0,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: (stdout ?? "").toString(),
          stderr: (stderr ?? "").toString(),
        });
      },
    );

    timer = setTimeout(() => {
      if (completed) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }, timeoutMs);
  });
}
