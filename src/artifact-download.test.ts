import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as z from "zod/v4";
import {
  artifactToolLogFields,
  downloadIncomingArtifact,
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { ArtifactError } from "./artifact-error.js";
import {
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-download-test-"));
type ArtifactDownloadInput = Parameters<typeof downloadIncomingArtifact>[0];
type ArtifactDownloadTestHooks = NonNullable<ArtifactDownloadInput["testHooks"]>;
const executableDownloadHooks: Pick<ArtifactDownloadInput, "testHooks"> =
  isArtifactDownloadSupportedPlatform()
    ? {}
    : {
        testHooks: {
          platform: "linux",
          directoryAnchorPath: (_handle: unknown, openedPath: string) => openedPath,
        },
      };

try {
  testOneToolContract();
  testPlatformSupportContract();
  await testCoreAdmissionPrecedesAdapterOpen(join(root, "core-admission"));
  if (!isArtifactDownloadSupportedPlatform()) {
    await testUnsupportedPlatform(join(root, "unsupported-platform"));
  }
  await testSafeDownloadAndConflict(join(root, "downloads"));
  await testDestinationValidation(join(root, "destinations"));
  await testStagingWorkspaceSeparation(join(root, "staging-separation"));
  await testSizeLimitAndCleanup(join(root, "size-limit"));
  await testCrashLeftoverCleanup(join(root, "stale-partials"));
  await testAtomicPublishUnavailable(join(root, "atomic-publish"));
  await testSymlinkRejection(join(root, "symlinks"));
  await testPublicationFailurePreservesReplacement(join(root, "publication-race"));
  await testDirectorySyncEffectUnknown(join(root, "directory-sync"));
  await testPublishedPermissions(join(root, "permissions"));
  testLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

function testOneToolContract(): void {
  const registered = new Map<string, { descriptor: Record<string, unknown>; callback: (input: never) => unknown }>();
  const server = {
    registerTool(
      name: string,
      descriptor: Record<string, unknown>,
      callback: (input: never) => unknown,
    ) {
      registered.set(name, { descriptor, callback });
      return {};
    },
  };

  registerArtifactTools(server as never, {
    config: {
      stateDir: "/unused/devspace-state",
      artifactMaxFileBytes: 1024,
      logging: { toolCalls: false },
    } as never,
    workspaces: {} as never,
  });

  assert.deepEqual([...registered.keys()], ["download_artifact"]);
  const descriptor = registered.get("download_artifact")?.descriptor;
  assert.ok(descriptor);
  assert.deepEqual(descriptor._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual(Object.keys(descriptor.inputSchema as object).sort(), ["file", "path", "workspaceId"]);
  assert.deepEqual(Object.keys(descriptor.outputSchema as object).sort(), ["coreMutation", "path"]);
  assert.equal((descriptor.annotations as { destructiveHint?: boolean }).destructiveHint, false);

  const fileSchema = (descriptor.inputSchema as z.ZodRawShape).file as z.ZodType;
  const valid = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  assert.deepEqual(fileSchema.parse(valid), valid);
  assert.throws(() => fileSchema.parse({ file_id: "file_123" }));

  const sensitiveExtraValue = "Bearer should-not-leak";
  const rejected = fileSchema.safeParse({
    ...valid,
    authorization: sensitiveExtraValue,
  });
  assert.equal(rejected.success, false);
  assert.equal(JSON.stringify(rejected).includes(sensitiveExtraValue), false);
}

async function testCoreAdmissionPrecedesAdapterOpen(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(workspaceRoot, { recursive: true });
  let adapterOpenCount = 0;
  let admittedPaths: readonly string[] | undefined;
  let callback: ((input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>) | undefined;
  const server = {
    registerTool(
      _name: string,
      _descriptor: Record<string, unknown>,
      handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>,
    ) {
      callback = handler;
      return {};
    },
  };
  const adapter: IncomingArtifactAdapter = {
    id: "counting-adapter",
    canHandle: () => true,
    async open() {
      adapterOpenCount += 1;
      return { name: "blocked.txt", stream: Readable.from(["must not open"]) };
    },
  };
  registerArtifactTools(server as never, {
    config: { stateDir, artifactMaxFileBytes: 1024, logging: { toolCalls: false } } as never,
    workspaces: {
      getWorkspace: () => ({ id: "ws_unbound_artifact", root: workspaceRoot }),
    } as never,
    incomingArtifactAdapters: [adapter],
    coreMutation: {
      admit: async (request: { paths: readonly string[] }) => {
        admittedPaths = request.paths;
        throw new Error("[CORE_BOUND_SESSION_REQUIRED] binding required before download");
      },
    } as never,
  });
  assert.ok(callback);
  await assert.rejects(
    callback!({ workspaceId: "ws_unbound_artifact", file: { native: true }, path: "nested/./blocked.txt" }, {}),
    /CORE_BOUND_SESSION_REQUIRED/,
  );
  assert.deepEqual(admittedPaths, ["nested/blocked.txt"]);
  assert.equal(adapterOpenCount, 0, "unbound download must not open the source adapter");
  assert.deepEqual(await readdir(workspaceRoot), [], "unbound download must not create destination bytes");
  await assert.rejects(stat(stateDir), { code: "ENOENT" });
}

function downloadForTest(
  input: Omit<ArtifactDownloadInput, "testHooks">,
  overrides?: ArtifactDownloadTestHooks,
): ReturnType<typeof downloadIncomingArtifact> {
  const base = executableDownloadHooks.testHooks;
  const testHooks = base || overrides ? { ...base, ...overrides } : undefined;
  return downloadIncomingArtifact({ ...input, ...(testHooks ? { testHooks } : {}) });
}

function testPlatformSupportContract(): void {
  assert.equal(isArtifactDownloadSupportedPlatform("linux"), true);
  assert.equal(isArtifactDownloadSupportedPlatform("darwin"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("freebsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("openbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("netbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("win32"), false);
}

async function testUnsupportedPlatform(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(workspaceRoot, { recursive: true });
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_platform_unsupported",
  );
}

async function testSafeDownloadAndConflict(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(join(workspaceRoot, "public", "images"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const bytes = Buffer.from("native artifact bytes\u0000\xff", "latin1");
  const registry = registryFor({
    name: "../../generated.png",
    size: bytes.length,
    stream: Readable.from([bytes]),
  });

  let stagedPath: string | undefined;
  const first = await downloadForTest({
    registry,
    workspaceId: "ws_test",
    workspaceRoot,
    stateDir,
    maxFileBytes: 1024,
    file: { native: true },
    path: "public/images/generated.png",
    publishLink: async (sourcePath, destinationPath) => {
      stagedPath = await realpath(sourcePath);
      await link(sourcePath, destinationPath);
    },
  });
  assert.equal(first.path, "public/images/generated.png");
  assert.equal(
    first.sha256,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);
  assert.ok(stagedPath?.startsWith(`${await realpath(stateDir)}/`));
  assert.equal(stagedPath?.startsWith(`${await realpath(workspaceRoot)}/`), false);
  assert.deepEqual(await readdir(join(workspaceRoot, "public", "images")), ["generated.png"]);

  await expectArtifactError(
    downloadForTest({
      registry: registryFor({
        name: "replacement.png",
        stream: Readable.from(["replacement"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "public/images/generated.png",
    }),
    "artifact_destination_exists",
  );
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);
  assert.deepEqual(await readdir(workspaceRoot), ["public"]);
  assert.deepEqual(await stagingEntries(stateDir), []);
}

async function testDestinationValidation(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(workspaceRoot, { recursive: true });

  for (const path of ["../outside.txt", "nested/../outside.txt", "/absolute.txt", "folder/"]) {
    await expectArtifactError(
      downloadForTest({
        registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
        workspaceId: "ws_test",
        workspaceRoot,
        stateDir,
        maxFileBytes: 1024,
        file: { native: true },
        path,
      }),
      "artifact_destination_invalid",
    );
  }

  await mkdir(stateDir, { recursive: true });
  await expectArtifactError(
    downloadForTest({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "missing/blocked.txt",
    }),
    "artifact_destination_parent_unsafe",
  );
  assert.deepEqual(await readdir(workspaceRoot), []);
  assert.deepEqual(await stagingEntries(stateDir), []);
}

async function testStagingWorkspaceSeparation(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(workspaceRoot, ".devspace-state");
  await mkdir(stateDir, { recursive: true });
  let adapterOpenCount = 0;

  await expectArtifactError(
    downloadForTest({
      registry: new IncomingArtifactAdapterRegistry([{
        id: "must-not-open",
        canHandle: () => true,
        async open() {
          adapterOpenCount += 1;
          return { name: "blocked.txt", stream: Readable.from(["blocked"]) };
        },
      }]),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_staging_workspace_overlap",
  );

  assert.equal(adapterOpenCount, 0);
  assert.deepEqual(await readdir(workspaceRoot), [".devspace-state"]);
  assert.deepEqual(await readdir(stateDir), []);
}

async function testSizeLimitAndCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await expectArtifactError(
    downloadForTest({
      registry: registryFor({
        name: "too-large.bin",
        size: 5,
        stream: Readable.from([Buffer.from("12345")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 4,
      file: { native: true },
      path: "too-large.bin",
    }),
    "artifact_file_too_large",
  );

  let workspaceEntriesDuringFailure: string[] | undefined;
  let stagingEntriesDuringFailure: string[] | undefined;
  const oversizedStream = Readable.from((async function* () {
    yield Buffer.from("123");
    workspaceEntriesDuringFailure = await readdir(workspaceRoot);
    stagingEntriesDuringFailure = await stagingEntries(stateDir);
    yield Buffer.from("45");
  })());
  await expectArtifactError(
    downloadForTest({
      registry: registryFor({
        name: "stream-too-large.bin",
        stream: oversizedStream,
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 4,
      file: { native: true },
      path: "stream-too-large.bin",
    }),
    "artifact_file_too_large",
  );

  assert.deepEqual(workspaceEntriesDuringFailure, []);
  assert.equal(stagingEntriesDuringFailure?.length, 1);
  assert.match(stagingEntriesDuringFailure?.[0] ?? "", /^\.devspace-download-.+\.partial$/);
  assert.deepEqual(await readdir(workspaceRoot), []);
  assert.deepEqual(await stagingEntries(stateDir), []);
}

async function testCrashLeftoverCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(join(workspaceRoot, "downloads"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await downloadForTest({
    registry: registryFor({ name: "first.txt", stream: Readable.from(["first"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    stateDir,
    maxFileBytes: 1024,
    file: { native: true },
    path: "downloads/first.txt",
  });

  const destinationDirectory = join(workspaceRoot, "downloads");
  const stalePartial = join(destinationDirectory, ".devspace-download-stale.partial");
  const recentPartial = join(destinationDirectory, ".devspace-download-recent.partial");
  const unrelated = join(destinationDirectory, "keep-me.partial");
  await writeFile(stalePartial, "stale");
  await writeFile(recentPartial, "recent");
  await writeFile(unrelated, "unrelated");
  const old = new Date(Date.now() - (48 * 60 * 60 * 1_000));
  await utimes(stalePartial, old, old);

  const stagingDirectory = join(stateDir, "incoming-artifact-staging");
  const staleStaged = join(stagingDirectory, ".devspace-download-orphan.partial");
  const recentStaged = join(stagingDirectory, ".devspace-download-active.partial");
  const unrelatedStaged = join(stagingDirectory, "keep-me.txt");
  await writeFile(staleStaged, "stale", { mode: 0o600 });
  await writeFile(recentStaged, "recent", { mode: 0o600 });
  await writeFile(unrelatedStaged, "unrelated", { mode: 0o600 });
  await utimes(staleStaged, old, old);

  await downloadForTest({
    registry: registryFor({ name: "second.txt", stream: Readable.from(["second"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    stateDir,
    maxFileBytes: 1024,
    file: { native: true },
    path: "downloads/second.txt",
  });

  const entries = await readdir(destinationDirectory);
  assert.equal(entries.includes(".devspace-download-stale.partial"), true);
  assert.equal(entries.includes(".devspace-download-recent.partial"), true);
  assert.equal(entries.includes("keep-me.partial"), true);
  assert.equal(entries.includes("first.txt"), true);
  assert.equal(entries.includes("second.txt"), true);
  const stagedEntries = await readdir(stagingDirectory);
  assert.equal(stagedEntries.includes(".devspace-download-orphan.partial"), false);
  assert.equal(stagedEntries.includes(".devspace-download-active.partial"), true);
  assert.equal(stagedEntries.includes("keep-me.txt"), true);
}

async function testAtomicPublishUnavailable(testRoot: string): Promise<void> {
  for (const code of ["EXDEV", "ENOSYS", "EOPNOTSUPP"]) {
    const workspaceRoot = join(testRoot, code, "workspace");
    const stateDir = join(testRoot, code, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    await expectArtifactError(
      downloadForTest({
        registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
        workspaceId: "ws_test",
        workspaceRoot,
        stateDir,
        maxFileBytes: 1024,
        file: { native: true },
        path: "blocked.txt",
        publishLink: async () => {
          throw Object.assign(new Error(`${code} publish failure`), { code });
        },
      }),
      "artifact_atomic_publish_unavailable",
    );

    assert.deepEqual(await readdir(workspaceRoot), []);
    assert.deepEqual(await stagingEntries(stateDir), []);
  }
}

async function testSymlinkRejection(testRoot: string): Promise<void> {
  if (process.platform === "win32") return;

  const outside = join(testRoot, "outside");
  const stateDir = join(testRoot, "state");
  await mkdir(outside, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const linkedWorkspaceRoot = join(testRoot, "linked-workspace");
  await symlink(outside, linkedWorkspaceRoot, "dir");
  await expectArtifactError(
    downloadForTest({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedWorkspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_workspace_unsafe",
  );

  const linkedDestinationRoot = join(testRoot, "linked-destination-workspace");
  await mkdir(linkedDestinationRoot, { recursive: true });
  await symlink(outside, join(linkedDestinationRoot, "assets"), "dir");
  await expectArtifactError(
    downloadForTest({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedDestinationRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "assets/blocked.txt",
    }),
    "artifact_destination_parent_unsafe",
  );
}

async function testPublicationFailurePreservesReplacement(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const destinationPath = join(workspaceRoot, "generated.txt");
  const userSibling = join(workspaceRoot, ".devspace-download-user.partial");
  const downloadedBytes = Buffer.from("downloaded");
  await writeFile(userSibling, "user-owned");

  await expectArtifactEffectUnknown(
    downloadForTest({
      registry: registryFor({
        name: "generated.txt",
        stream: Readable.from([downloadedBytes]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "./generated.txt",
      publishLink: async (partialPath, candidatePath) => {
        await link(partialPath, candidatePath);
        await unlink(candidatePath);
        await writeFile(candidatePath, "replacement");
      },
    }),
    {
      destinationPath: "generated.txt",
      expectedSize: downloadedBytes.length,
      expectedSha256: `sha256:${createHash("sha256").update(downloadedBytes).digest("hex")}`,
    },
  );

  assert.equal(await readFile(destinationPath, "utf8"), "replacement");
  assert.equal(await readFile(userSibling, "utf8"), "user-owned");
  assert.deepEqual((await readdir(workspaceRoot)).sort(), [
    ".devspace-download-user.partial",
    "generated.txt",
  ]);
  assert.deepEqual(await stagingEntries(stateDir), []);
}

async function testDirectorySyncEffectUnknown(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  const destinationPath = join(workspaceRoot, "durable.txt");
  const userSibling = join(workspaceRoot, ".devspace-download-user.partial");
  const downloadedBytes = Buffer.from("linked-before-directory-sync");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(userSibling, "user-owned");

  await expectArtifactEffectUnknown(
    downloadForTest(
      {
        registry: registryFor({
          name: "durable.txt",
          stream: Readable.from([downloadedBytes]),
        }),
        workspaceId: "ws_test",
        workspaceRoot,
        stateDir,
        maxFileBytes: 1024,
        file: { native: true },
        path: "./durable.txt",
      },
      {
        syncDestinationDirectory: async () => {
          throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
        },
      },
    ),
    {
      destinationPath: "durable.txt",
      expectedSize: downloadedBytes.length,
      expectedSha256: `sha256:${createHash("sha256").update(downloadedBytes).digest("hex")}`,
    },
  );

  assert.deepEqual(await readFile(destinationPath), downloadedBytes);
  assert.equal(await readFile(userSibling, "utf8"), "user-owned");
  assert.deepEqual((await readdir(workspaceRoot)).sort(), [
    ".devspace-download-user.partial",
    "durable.txt",
  ]);
  assert.deepEqual(await stagingEntries(stateDir), []);
}

async function testPublishedPermissions(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const stateDir = join(testRoot, "state");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const previousUmask = process.umask(0o077);
  try {
    await downloadForTest({
      registry: registryFor({
        name: "private.txt",
        stream: Readable.from(["private"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      stateDir,
      maxFileBytes: 1024,
      file: { native: true },
      path: "private.txt",
    });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal((await stat(join(workspaceRoot, "private.txt"))).mode & 0o777, 0o600);
}

function testLogRedaction(): void {
  const fields = artifactToolLogFields({
    file: {
      download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
      file_id: "file_secret",
      file_name: "generated.png",
      authorization: "Bearer log-secret",
    },
    workspaceId: "ws_secret",
    path: "private/generated.png",
  });
  const serialized = JSON.stringify(fields);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("log-secret"), false);
  assert.equal(serialized.includes("ws_secret"), true);
  assert.equal(serialized.includes("files.oaiusercontent.com"), true);
}

function registryFor(source: {
  name: string;
  mimeType?: string;
  size?: number;
  stream: Readable;
}): IncomingArtifactAdapterRegistry {
  const adapter: IncomingArtifactAdapter = {
    id: "test-native",
    canHandle: () => true,
    async open() {
      return source;
    },
  };
  return new IncomingArtifactAdapterRegistry([adapter]);
}

async function stagingEntries(stateDir: string): Promise<string[]> {
  return readdir(join(stateDir, "incoming-artifact-staging"));
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}

async function expectArtifactEffectUnknown(
  promise: Promise<unknown>,
  expected: {
    destinationPath: string;
    expectedSize: number;
    expectedSha256: string;
  },
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const classified = error as ArtifactError & {
      effectState?: string;
      destinationPath?: string;
      expectedSize?: number;
      expectedSha256?: string;
      reconciliationRequired?: boolean;
      retrySafe?: boolean;
    };
    assert.equal(classified.code, "artifact_destination_effect_unknown");
    assert.equal(classified.effectState, "EFFECT_UNKNOWN");
    assert.equal(classified.destinationPath, expected.destinationPath);
    assert.equal(classified.expectedSize, expected.expectedSize);
    assert.equal(classified.expectedSha256, expected.expectedSha256);
    assert.equal(classified.reconciliationRequired, true);
    assert.equal(classified.retrySafe, false);
    assert.match(classified.message, /reconciliation is required/i);
    assert.match(classified.message, /must not be retried/i);
    return true;
  });
}
