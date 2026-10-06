import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { probeBuildReady } from "./cutover-build-ready.js";
import {
  CUTOVER_ACTIVATION_BINDING_SCHEMA,
  CutoverStateError,
  type CutoverActivationBinding,
  type ExpectedCutoverIdentity,
} from "./cutover-state.js";

export const CUTOVER_RELEASE_POINTER_SCHEMA = "devspace.cutover_release_pointer.v1" as const;
export const CUTOVER_RELEASE_POINTER_FILENAME = "current-release.json" as const;
export const CUTOVER_STABLE_LAUNCHER_RELATIVE_PATH = join("dist", "service-launcher.js");

export interface CutoverReleasePointer {
  schema: typeof CUTOVER_RELEASE_POINTER_SCHEMA;
  cutoverId: string;
  sourceCommit: string;
  buildId: string;
  releaseSha256: string;
  releasePath: string;
  previousReleasePath?: string;
  boundAt: string;
}

export interface BindCutoverActivationInput {
  cutoverId: string;
  packageRoot: string;
  serviceRoot: string;
  expected: ExpectedCutoverIdentity;
  now?: () => number;
}

const REQUIRED_RELEASE_ENTRIES = ["package.json", "dist", "generated", "node_modules"] as const;
const OPTIONAL_RELEASE_ENTRIES = [
  "package-lock.json",
  "README.md",
  "docs",
  "examples",
  "scripts",
  "skills",
] as const;

export function bindCutoverActivation(input: BindCutoverActivationInput): CutoverActivationBinding {
  const serviceRoot = canonicalDirectory(input.serviceRoot, "stable service root");
  const packageRoot = canonicalDirectory(input.packageRoot, "target package root");
  const releaseRootPath = join(serviceRoot, "releases");
  mkdirSync(releaseRootPath, { recursive: true, mode: 0o700 });
  const releaseRoot = canonicalDirectory(releaseRootPath, "release root");

  if (isPathInside(packageRoot, serviceRoot) || isPathInside(serviceRoot, packageRoot)) {
    throw new CutoverStateError(
      "Target package root must be separate from the stable service root before release materialization.",
    );
  }

  const release = materializeRelease(packageRoot, releaseRoot, input.expected);
  const pointerPath = join(serviceRoot, CUTOVER_RELEASE_POINTER_FILENAME);
  const prior = readPointerIfPresent(pointerPath);
  if (prior) validatePointer(prior, serviceRoot);

  if (
    prior?.cutoverId === input.cutoverId &&
    prior.sourceCommit === input.expected.sourceCommit &&
    prior.buildId === input.expected.buildId &&
    prior.releasePath === release.releasePath &&
    prior.releaseSha256 === release.releaseSha256
  ) {
    const readback = verifyReleasePointer(pointerPath, serviceRoot);
    return {
      schema: CUTOVER_ACTIVATION_BINDING_SCHEMA,
      cutoverId: input.cutoverId,
      sourceCommit: input.expected.sourceCommit,
      buildId: input.expected.buildId,
      releaseSha256: release.releaseSha256,
      releasePath: release.releasePath,
      pointerPath,
      ...(readback.previousReleasePath ? { previousReleasePath: readback.previousReleasePath } : {}),
      boundAt: readback.boundAt,
    };
  }

  const boundAt = new Date((input.now ?? Date.now)()).toISOString();
  const pointer: CutoverReleasePointer = {
    schema: CUTOVER_RELEASE_POINTER_SCHEMA,
    cutoverId: input.cutoverId,
    sourceCommit: input.expected.sourceCommit,
    buildId: input.expected.buildId,
    releaseSha256: release.releaseSha256,
    releasePath: release.releasePath,
    ...(prior?.releasePath ? { previousReleasePath: prior.releasePath } : {}),
    boundAt,
  };
  atomicWriteJson(pointerPath, pointer);
  const readback = verifyReleasePointer(pointerPath, serviceRoot);
  if (!samePointer(readback, pointer)) {
    throw new CutoverStateError(
      "Activation pointer readback changed after commit; reconciliation is required.",
    );
  }

  return {
    schema: CUTOVER_ACTIVATION_BINDING_SCHEMA,
    cutoverId: input.cutoverId,
    sourceCommit: input.expected.sourceCommit,
    buildId: input.expected.buildId,
    releaseSha256: release.releaseSha256,
    releasePath: release.releasePath,
    pointerPath,
    ...(pointer.previousReleasePath ? { previousReleasePath: pointer.previousReleasePath } : {}),
    boundAt,
  };
}

export function verifyActivationBinding(
  binding: CutoverActivationBinding,
  serviceRootInput: string,
): CutoverReleasePointer {
  const serviceRoot = canonicalDirectory(serviceRootInput, "stable service root");
  const pointerPath = join(serviceRoot, CUTOVER_RELEASE_POINTER_FILENAME);
  if (resolve(binding.pointerPath) !== resolve(pointerPath)) {
    throw new CutoverStateError(
      "Activation binding pointer path is not the canonical stable-service pointer.",
    );
  }
  const pointer = verifyReleasePointer(pointerPath, serviceRoot);
  if (
    pointer.cutoverId !== binding.cutoverId ||
    pointer.sourceCommit !== binding.sourceCommit ||
    pointer.buildId !== binding.buildId ||
    pointer.releaseSha256 !== binding.releaseSha256 ||
    pointer.releasePath !== binding.releasePath ||
    pointer.previousReleasePath !== binding.previousReleasePath
  ) {
    throw new CutoverStateError(
      "Physical activation pointer no longer matches the durable cutover binding.",
    );
  }
  return pointer;
}

export function verifyReleasePointer(
  pointerPathInput: string,
  serviceRootInput: string,
): CutoverReleasePointer {
  const serviceRoot = canonicalDirectory(serviceRootInput, "stable service root");
  const pointerPath = resolve(pointerPathInput);
  const expectedPointerPath = resolve(join(serviceRoot, CUTOVER_RELEASE_POINTER_FILENAME));
  if (pointerPath !== expectedPointerPath) {
    throw new CutoverStateError(
      "Activation pointer path is outside the canonical stable-service location.",
    );
  }
  const pointer = readPointer(pointerPath);
  validatePointer(pointer, serviceRoot);
  const ready = probeBuildReady({
    packageRoot: pointer.releasePath,
    expected: { sourceCommit: pointer.sourceCommit, buildId: pointer.buildId },
  });
  if (!ready.buildReady) {
    throw new CutoverStateError(
      `Activation release identity readback failed: ${ready.detail}`,
    );
  }
  const digest = hashReleaseTree(pointer.releasePath);
  if (digest !== pointer.releaseSha256) {
    throw new CutoverStateError(
      "Activation release digest changed after binding; refusing restart.",
    );
  }
  return pointer;
}

export function readCutoverReleasePointer(pointerPath: string): CutoverReleasePointer {
  return readPointer(pointerPath);
}

export function hashReleaseTree(rootInput: string): string {
  const root = canonicalDirectory(rootInput, "release root");
  const hash = createHash("sha256");
  hash.update("devspace.release-tree.v1\0");

  const visit = (directory: string, prefix: string): void => {
    const names = readdirSync(directory).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const absolute = join(directory, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(absolute);
      const mode = info.mode & 0o777;
      if (info.isDirectory()) {
        hash.update(`d\0${rel}\0${mode.toString(8)}\0`);
        visit(absolute, rel);
      } else if (info.isFile()) {
        hash.update(`f\0${rel}\0${mode.toString(8)}\0${info.size}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      } else if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        let physicalTarget:string;
        try {
          physicalTarget=realpathSync.native(resolve(dirname(absolute), target));
        } catch {
          throw new CutoverStateError(
            `Release contains a broken symlink: ${rel}`,
          );
        }
        if (!isPathInside(physicalTarget, root) || physicalTarget===root) {
          throw new CutoverStateError(
            `Release symlink escapes the immutable release root: ${rel}`,
          );
        }
        hash.update(`l\0${rel}\0${target}\0`);
      } else {
        throw new CutoverStateError(
          `Release contains unsupported filesystem entry: ${rel}`,
        );
      }
    }
  };

  visit(root, "");
  return hash.digest("hex");
}

function materializeRelease(
  packageRoot: string,
  releaseRoot: string,
  expected: ExpectedCutoverIdentity,
): { releasePath: string; releaseSha256: string } {
  for (const entry of REQUIRED_RELEASE_ENTRIES) {
    if (!existsSync(join(packageRoot, entry))) {
      throw new CutoverStateError(
        `Target package is missing required runtime entry: ${entry}`,
      );
    }
  }

  const temp = join(
    releaseRoot,
    `.stage-${expected.sourceCommit.slice(0, 12)}-${randomUUID()}`,
  );
  mkdirSync(temp, { mode: 0o700 });
  try {
    for (const entry of [...REQUIRED_RELEASE_ENTRIES, ...OPTIONAL_RELEASE_ENTRIES]) {
      const source = join(packageRoot, entry);
      if (!existsSync(source)) continue;
      cpSync(source, join(temp, entry), {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      });
    }

    const ready = probeBuildReady({ packageRoot: temp, expected });
    if (!ready.buildReady) {
      throw new CutoverStateError(
        `Materialized release failed target identity verification: ${ready.detail}`,
      );
    }

    const releaseSha256 = hashReleaseTree(temp);
    const finalPath = join(
      releaseRoot,
      `release-${expected.sourceCommit}-${releaseSha256.slice(0, 16)}`,
    );
    if (existsSync(finalPath)) {
      const canonical = canonicalDirectory(finalPath, "existing immutable release");
      if (hashReleaseTree(canonical) !== releaseSha256) {
        throw new CutoverStateError(
          "Existing release path does not match the staged release digest.",
        );
      }
      const existingReady = probeBuildReady({ packageRoot: canonical, expected });
      if (!existingReady.buildReady) {
        throw new CutoverStateError(
          `Existing release path does not match the approved target: ${existingReady.detail}`,
        );
      }
      rmSync(temp, { recursive: true, force: true });
      return { releasePath: canonical, releaseSha256 };
    }

    renameSync(temp, finalPath);
    syncDirectory(releaseRoot);
    return { releasePath: canonicalDirectory(finalPath, "materialized release"), releaseSha256 };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function readPointerIfPresent(path: string): CutoverReleasePointer | undefined {
  if (!existsSync(path)) return undefined;
  return readPointer(path);
}

function readPointer(path: string): CutoverReleasePointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CutoverStateError(
      `Activation pointer is unreadable or malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPointer(parsed)) {
    throw new CutoverStateError("Activation pointer schema or identity fields are malformed.");
  }
  return parsed;
}

function validatePointer(pointer: CutoverReleasePointer, serviceRoot: string): void {
  const releaseRoot = canonicalDirectory(join(serviceRoot, "releases"), "release root");
  const releasePath = canonicalDirectory(pointer.releasePath, "activation release");
  if (!isPathInside(releasePath, releaseRoot) || releasePath === releaseRoot) {
    throw new CutoverStateError(
      "Activation pointer release path escapes the canonical release root.",
    );
  }
  if (pointer.previousReleasePath !== undefined) {
    const previous = resolve(pointer.previousReleasePath);
    if (!isPathInside(previous, releaseRoot) || previous === releaseRoot) {
      throw new CutoverStateError(
        "Activation pointer previous release path escapes the canonical release root.",
      );
    }
  }
}

function isPointer(value: unknown): value is CutoverReleasePointer {
  const pointer = value as Partial<CutoverReleasePointer> | undefined;
  return Boolean(
    pointer &&
    pointer.schema === CUTOVER_RELEASE_POINTER_SCHEMA &&
    typeof pointer.cutoverId === "string" &&
    pointer.cutoverId.length > 0 &&
    typeof pointer.sourceCommit === "string" &&
    /^[0-9a-f]{40}$/.test(pointer.sourceCommit) &&
    typeof pointer.buildId === "string" &&
    pointer.buildId.length > 0 &&
    typeof pointer.releaseSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(pointer.releaseSha256) &&
    typeof pointer.releasePath === "string" &&
    isAbsolute(pointer.releasePath) &&
    (pointer.previousReleasePath === undefined ||
      (typeof pointer.previousReleasePath === "string" &&
        isAbsolute(pointer.previousReleasePath))) &&
    typeof pointer.boundAt === "string" &&
    Number.isFinite(Date.parse(pointer.boundAt))
  );
}

function samePointer(a: CutoverReleasePointer, b: CutoverReleasePointer): boolean {
  return a.schema === b.schema &&
    a.cutoverId === b.cutoverId &&
    a.sourceCommit === b.sourceCommit &&
    a.buildId === b.buildId &&
    a.releaseSha256 === b.releaseSha256 &&
    a.releasePath === b.releasePath &&
    a.previousReleasePath === b.previousReleasePath &&
    a.boundAt === b.boundAt;
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new CutoverStateError(`${label} must be absolute.`);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new CutoverStateError(`${label} does not exist.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CutoverStateError(`${label} must be a real non-symlink directory.`);
  }
  return realpathSync.native(path);
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
