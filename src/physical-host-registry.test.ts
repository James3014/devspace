import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHostIdentityBinding } from "./host-identity.js";
import {
  loadPhysicalHostRegistry,
  type PhysicalHostDefinition,
  type RemoteDevspaceIdentity,
} from "./physical-host-registry.js";

const SOURCE_COMMIT = "a".repeat(40);
const MANIFEST_SHA = "b".repeat(64);
const BUILD_ID = "build-1";
const HOST_ID = "mac-studio";

function hostIdentity(input: { hostId?: string; buildId?: string; sourceCommit?: string; home?: string; path?: string; stateRoot?: string } = {}) {
  return buildHostIdentityBinding({
    environment: {
      HOME: input.home ?? "/Users/james",
      PATH: input.path ?? "/opt/homebrew/bin:/usr/bin",
      DEVSPACE_HOST_ID: input.hostId ?? HOST_ID,
    },
    stateRoot: input.stateRoot ?? "/Users/james/.local/share/devspace",
    devspaceBuildId: input.buildId ?? BUILD_ID,
    devspaceSourceCommit: input.sourceCommit ?? SOURCE_COMMIT,
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.8.0",
    hostname: "m5.local",
  });
}
const HOST_IDENTITY = hostIdentity();

function withFixture(run: (fixture: { root: string; workspace: string; registryPath: string }) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "devspace-host-registry-"));
  const workspace = join(root, "workspace");
  const registryPath = join(root, "hosts.json");
  mkdirSync(workspace);
  return Promise.resolve(run({ root, workspace, registryPath })).finally(() => rmSync(root, { recursive: true, force: true }));
}

function writeRegistry(path: string, hosts: PhysicalHostDefinition[]): void {
  writeFileSync(path, `${JSON.stringify({ hosts }, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
}

function host(identityUrl = "https://mac-studio.example.test/identity"): PhysicalHostDefinition {
  return {
    hostId: HOST_ID,
    identityUrl,
    expected: {
      sourceCommit: SOURCE_COMMIT,
      buildId: BUILD_ID,
      capabilityManifestSha256: MANIFEST_SHA,
      hostIdentityHash: HOST_IDENTITY.hostIdentityHash,
    },
  };
}

function identity(overrides: Partial<RemoteDevspaceIdentity> = {}): RemoteDevspaceIdentity {
  const sourceCommit = overrides.sourceCommit ?? SOURCE_COMMIT;
  const buildId = overrides.buildId ?? BUILD_ID;
  return {
    product: "devspace",
    version: "1.0.7",
    sourceCommit,
    sourceDirty: false,
    buildId,
    serverInstanceId: "server-1",
    hostIdentity: overrides.hostIdentity ?? hostIdentity({ buildId, sourceCommit }),
    capabilityManifest: {
      schema: "devspace.capability_manifest.v1",
      capabilities: ["agent_start"],
      missing: [],
      manifestSha256: MANIFEST_SHA,
    },
    ...overrides,
  };
}

function jsonFetch(value: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
}

test("physical host registry is opt-in", () => {
  const registry = loadPhysicalHostRegistry({ registryPath: undefined, allowedRoots: [] });
  assert.equal(registry, undefined);
});

test("physical host registry must live outside allowed roots", async () => {
  await withFixture(({ workspace }) => {
    const path = join(workspace, "hosts.json");
    writeRegistry(path, [host()]);
    assert.throws(
      () => loadPhysicalHostRegistry({ registryPath: path, allowedRoots: [workspace] }),
      /outside DEVSPACE_ALLOWED_ROOTS/,
    );
  });
});

test("non-loopback identity URL must use HTTPS", async () => {
  await withFixture(({ workspace, registryPath }) => {
    writeRegistry(registryPath, [host("http://mac-studio.example.test/identity")]);
    assert.throws(
      () => loadPhysicalHostRegistry({ registryPath, allowedRoots: [workspace] }),
      /must use HTTPS/,
    );
  });
});

test("exact clean identity admits capability readback", async () => {
  await withFixture(async ({ workspace, registryPath }) => {
    writeRegistry(registryPath, [host()]);
    const registry = loadPhysicalHostRegistry({
      registryPath,
      allowedRoots: [workspace],
      fetchImpl: jsonFetch(identity()),
    });
    assert.ok(registry);

    const status = await registry.status("mac-studio");
    assert.equal(status.state, "MATCH");
    assert.equal(status.observed?.sourceCommit, SOURCE_COMMIT);

    const capabilities = await registry.capabilities("mac-studio");
    assert.equal(capabilities.admitted, true);
    assert.deepEqual(capabilities.capabilityManifest, identity().capabilityManifest);
  });
});

test("dirty or mismatched identity is reachable but not admitted", async () => {
  await withFixture(async ({ workspace, registryPath }) => {
    writeRegistry(registryPath, [host()]);
    const registry = loadPhysicalHostRegistry({
      registryPath,
      allowedRoots: [workspace],
      fetchImpl: jsonFetch(identity({ sourceDirty: true, buildId: "different-build" })),
    });
    assert.ok(registry);

    const status = await registry.status("mac-studio");
    assert.equal(status.state, "IDENTITY_MISMATCH");
    assert.deepEqual(status.mismatches, ["sourceDirty", "buildId", "hostIdentityHash"]);

    const capabilities = await registry.capabilities("mac-studio");
    assert.equal(capabilities.admitted, false);
    assert.equal("capabilityManifest" in capabilities, false);
  });
});

test("cross-host endpoint with the same build/source/manifest is not admitted", async () => {
  await withFixture(async ({ workspace, registryPath }) => {
    writeRegistry(registryPath, [host()]);
    const otherHost = identity({
      hostIdentity: hostIdentity({
        hostId: "m4-laptop",
        home: "/Users/jameschen",
        path: "/usr/local/bin:/usr/bin",
        stateRoot: "/Users/jameschen/.local/share/devspace",
      }),
    });
    const registry = loadPhysicalHostRegistry({
      registryPath,
      allowedRoots: [workspace],
      fetchImpl: jsonFetch(otherHost),
    });
    assert.ok(registry);
    const status = await registry.status(HOST_ID);
    assert.equal(status.state, "IDENTITY_MISMATCH");
    assert.deepEqual(status.mismatches, ["hostId", "hostIdentityHash"]);
    const capabilities = await registry.capabilities(HOST_ID);
    assert.equal(capabilities.admitted, false);
  });
});

test("unexpected capability-manifest schema fails closed", async () => {
  await withFixture(async ({ workspace, registryPath }) => {
    writeRegistry(registryPath, [host()]);
    const badIdentity = identity();
    badIdentity.capabilityManifest.schema = "devspace.capability_manifest.v2";
    const registry = loadPhysicalHostRegistry({
      registryPath,
      allowedRoots: [workspace],
      fetchImpl: jsonFetch(badIdentity),
    });
    assert.ok(registry);

    const status = await registry.status("mac-studio");
    assert.equal(status.state, "INVALID_RESPONSE");
    assert.equal(status.errorCode, "INVALID_IDENTITY_RESPONSE");
  });
});
