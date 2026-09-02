import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Immutable build identity, generated at build time by
 * scripts/generate-build-identity.mjs into generated/build-identity.json.
 *
 * The canonical runtime must be bound to an exact source commit / build
 * artifact, not to a branch name. Runtime identity is exposed through
 * /identity and the open_workspace receipt so reconnects that change PID,
 * build, or profile catalog generation force re-preflight.
 */
export interface BuildIdentityFile {
  package_name: string;
  package_version: string;
  source_commit: string;
  source_dirty: boolean;
  build_id: string;
  build_manifest_sha256?: string;
  built_at: string;
}

export interface RuntimeBuildIdentity {
  product: "devspace";
  package: string;
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
  buildId: string;
  buildManifestSha256?: string;
  builtAt: string;
  serverInstanceId: string;
  pid: number;
  startedAt: string;
  listenPort: number;
  configRoot: string;
  stateRoot: string;
  profileCatalogGeneration: string;
}

function packageRoot(): string {
  // dist/build-identity.js -> package root; src/build-identity.ts -> package root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadBuildIdentityFile(
  env: NodeJS.ProcessEnv = process.env,
  root: string = packageRoot(),
): BuildIdentityFile {
  const candidates = [
    env.DEVSPACE_BUILD_IDENTITY_PATH,
    join(root, "generated", "build-identity.json"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<BuildIdentityFile>;
      if (parsed.package_name && parsed.package_version && parsed.source_commit && parsed.build_id) {
        return {
          package_name: parsed.package_name,
          package_version: parsed.package_version,
          source_commit: parsed.source_commit,
          source_dirty: parsed.source_dirty === true,
          build_id: parsed.build_id,
          build_manifest_sha256: parsed.build_manifest_sha256,
          built_at: parsed.built_at ?? "unknown",
        };
      }
    } catch {
      // Fall through to package.json fallback.
    }
  }

  let name = "@waishnav/devspace";
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    if (pkg.name) name = pkg.name;
    if (pkg.version) version = pkg.version;
  } catch {
    // Keep defaults.
  }
  return {
    package_name: name,
    package_version: version,
    source_commit: "unverified",
    source_dirty: true,
    build_id: `${name}-${version}-unverified`,
    built_at: "unknown",
  };
}

export function describeRuntimeBuildIdentity(input: {
  identityFile?: BuildIdentityFile;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  listenPort: number;
  configRoot: string;
  stateRoot: string;
  profileCatalogGeneration: string;
  pid?: number;
  startedAt?: Date;
  serverInstanceId?: string;
}): RuntimeBuildIdentity {
  const file = input.identityFile
    ?? loadBuildIdentityFile(input.env, input.packageRoot);
  return {
    product: "devspace",
    package: file.package_name,
    version: file.package_version,
    sourceCommit: file.source_commit,
    sourceDirty: file.source_dirty,
    buildId: file.build_id,
    buildManifestSha256: file.build_manifest_sha256,
    builtAt: file.built_at,
    serverInstanceId: input.serverInstanceId ?? randomUUID(),
    pid: input.pid ?? process.pid,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    listenPort: input.listenPort,
    configRoot: input.configRoot,
    stateRoot: input.stateRoot,
    profileCatalogGeneration: input.profileCatalogGeneration,
  };
}
