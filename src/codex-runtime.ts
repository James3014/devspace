import { execFileSync } from "node:child_process";
import { constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";

export const MINIMUM_CODEX_RUNTIME_VERSION = "0.149.0";

export interface CodexRuntimeIdentity {
  ready: boolean;
  sdkName?: string;
  sdkVersion?: string;
  sdkPackagePath?: string;
  executable?: string;
  binaryVersion?: string;
  minimumVersion: string;
  reason?: string;
}

export interface InspectCodexRuntimeOptions {
  sdkPackagePath?: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

type PackageIdentity = {
  name?: unknown;
  version?: unknown;
};

const require = createRequire(import.meta.url);

function compareVersions(left: string, right: string): number | undefined {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
    return match ? match.slice(1).map(Number) : undefined;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function defaultSdkPackagePath(env: NodeJS.ProcessEnv): string | undefined {
  const dependencyRoot = env.DEVSPACE_DEPENDENCY_ROOT?.trim();
  if (dependencyRoot) {
    return join(dependencyRoot, "node_modules", "@openai", "codex-sdk", "package.json");
  }
  try {
    return realpathSync(require.resolve("@openai/codex-sdk/package.json"));
  } catch {
    try {
      let directory = dirname(require.resolve("@openai/codex-sdk"));
      const root = parse(directory).root;
      while (directory !== root) {
        const packagePath = join(directory, "package.json");
        if (existsSync(packagePath)) {
          const identity = JSON.parse(readFileSync(packagePath, "utf8")) as PackageIdentity;
          if (identity.name === "@openai/codex-sdk") return realpathSync(packagePath);
        }
        directory = dirname(directory);
      }
    } catch {
      // The caller receives one fail-closed resolution result below.
    }
    return undefined;
  }
}

function defaultExecutable(sdkPackagePath: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const override = env.DEVSPACE_CODEX_EXECUTABLE?.trim();
  if (override) return override;
  if (!sdkPackagePath) return undefined;
  return join(dirname(sdkPackagePath), "..", "codex", "bin", "codex.js");
}

function failure(
  reason: string,
  identity: Omit<CodexRuntimeIdentity, "ready" | "minimumVersion" | "reason"> = {},
): CodexRuntimeIdentity {
  return {
    ready: false,
    minimumVersion: MINIMUM_CODEX_RUNTIME_VERSION,
    ...identity,
    reason,
  };
}

export function inspectCodexRuntime(
  options: InspectCodexRuntimeOptions = {},
): CodexRuntimeIdentity {
  const env = options.env ?? process.env;
  const configuredSdkPath = options.sdkPackagePath ?? defaultSdkPackagePath(env);
  if (!configuredSdkPath || !existsSync(configuredSdkPath)) {
    return failure(
      configuredSdkPath
        ? `Codex SDK package manifest does not exist: ${configuredSdkPath}`
        : "Codex SDK package manifest could not be resolved.",
      { sdkPackagePath: configuredSdkPath },
    );
  }

  let sdkPackagePath: string;
  let sdk: PackageIdentity;
  try {
    sdkPackagePath = realpathSync(configuredSdkPath);
    sdk = JSON.parse(readFileSync(sdkPackagePath, "utf8")) as PackageIdentity;
  } catch (error) {
    return failure(`Codex SDK package manifest is unreadable: ${String(error)}`, {
      sdkPackagePath: configuredSdkPath,
    });
  }

  const sdkName = typeof sdk.name === "string" ? sdk.name : undefined;
  const sdkVersion = typeof sdk.version === "string" ? sdk.version : undefined;
  const sdkIdentity = { sdkName, sdkVersion, sdkPackagePath };
  if (sdkName !== "@openai/codex-sdk" || !sdkVersion) {
    return failure("Codex SDK package identity is invalid.", sdkIdentity);
  }
  const sdkCompatibility = compareVersions(sdkVersion, MINIMUM_CODEX_RUNTIME_VERSION);
  if (sdkCompatibility === undefined || sdkCompatibility < 0) {
    return failure(
      `DevSpace requires @openai/codex-sdk >= ${MINIMUM_CODEX_RUNTIME_VERSION}; found ${sdkVersion}.`,
      sdkIdentity,
    );
  }

  const configuredExecutable = options.executable ?? defaultExecutable(sdkPackagePath, env);
  if (!configuredExecutable || !existsSync(configuredExecutable)) {
    return failure(
      configuredExecutable
        ? `Codex executable does not exist: ${configuredExecutable}`
        : "Codex executable could not be resolved.",
      { ...sdkIdentity, executable: configuredExecutable },
    );
  }

  let executable: string;
  try {
    executable = realpathSync(configuredExecutable);
    if (!statSync(executable).isFile()) {
      return failure(`Codex executable is not a file: ${executable}`, {
        ...sdkIdentity,
        executable,
      });
    }
    if (process.platform !== "win32") accessSync(executable, constants.X_OK);
  } catch (error) {
    return failure(`Codex executable is not runnable: ${String(error)}`, {
      ...sdkIdentity,
      executable: configuredExecutable,
    });
  }

  let output: string;
  try {
    output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      env,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    return failure(`Codex executable version probe failed: ${String(error)}`, {
      ...sdkIdentity,
      executable,
    });
  }

  const versionMatch = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output);
  const binaryVersion = versionMatch?.[1];
  const runtimeIdentity = { ...sdkIdentity, executable, binaryVersion };
  if (!binaryVersion) {
    return failure(`Codex executable returned an unrecognized version: ${output}`, runtimeIdentity);
  }
  const binaryCompatibility = compareVersions(binaryVersion, MINIMUM_CODEX_RUNTIME_VERSION);
  if (binaryCompatibility === undefined || binaryCompatibility < 0) {
    return failure(
      `DevSpace requires Codex CLI >= ${MINIMUM_CODEX_RUNTIME_VERSION}; found ${binaryVersion}.`,
      runtimeIdentity,
    );
  }

  return {
    ready: true,
    minimumVersion: MINIMUM_CODEX_RUNTIME_VERSION,
    ...runtimeIdentity,
  };
}
