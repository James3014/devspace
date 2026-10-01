import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeBuildIdentity } from "./build-identity.js";
import type { CapabilityManifest } from "./capability-manifest.js";
import {
  createHostCapabilitySnapshot,
  createLocalHostCapabilitySnapshotReader,
  HOST_CAPABILITY_SNAPSHOT_SCHEMA,
  loadOrCreatePhysicalHostIdentity,
  parseHostCapabilitySnapshot,
  registerHostCapabilitySnapshotTool,
} from "./host-capability-snapshot.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-host-snapshot-"));
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, stateDir, workspace };
}

const runtime = (serverInstanceId: string): RuntimeBuildIdentity => ({
  product: "devspace",
  package: "@waishnav/devspace",
  version: "1.0.7",
  sourceCommit: "a".repeat(40),
  sourceDirty: false,
  buildId: "build-a",
  builtAt: "2026-09-26T00:00:00.000Z",
  serverInstanceId,
  pid: 123,
  startedAt: "2026-09-26T00:00:00.000Z",
  listenPort: 7676,
  configRoot: "/owner/config",
  stateRoot: "/owner/state",
  profileCatalogGeneration: "catalog-a",
});

const manifest: CapabilityManifest = {
  schema: "devspace.capability_manifest.v1",
  capabilities: ["agent_start.tool"],
  missing: [],
  manifestSha256: "b".repeat(64),
  inputSchemaFingerprint: "c".repeat(64),
};

const metrics = {
  platform: "darwin" as const,
  architecture: "arm64",
  totalMemoryBytes: 64 * 1024 ** 3,
  availableMemoryBytes: 40 * 1024 ** 3,
  logicalCpuCount: 12,
  loadAverage1m: 3,
};

test("persistent host identity survives restart while server identity may rotate", () => {
  const f = fixture();
  try {
    const first = loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-09-26T00:00:00Z"),
    });
    const second = loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "22222222-2222-4222-8222-222222222222",
      now: () => new Date("2026-09-26T01:00:00Z"),
    });
    assert.equal(first.hostId, "host-11111111-1111-4111-8111-111111111111");
    assert.deepEqual(second, first);

    const before = createHostCapabilitySnapshot({
      identity: first,
      runtimeIdentity: runtime("server-one"),
      capabilityManifest: manifest,
      metrics,
      now: () => new Date("2026-09-26T00:10:00Z"),
    });
    const after = createHostCapabilitySnapshot({
      identity: second,
      runtimeIdentity: runtime("server-two"),
      capabilityManifest: manifest,
      metrics,
      now: () => new Date("2026-09-26T01:10:00Z"),
    });
    assert.equal(before.static.hostId, after.static.hostId);
    assert.notEqual(before.verified.devspace.serverInstanceId, after.verified.devspace.serverInstanceId);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("persistent host identity survives separate Node process generations", () => {
  const f = fixture();
  try {
    const script = [
      'import { loadOrCreatePhysicalHostIdentity } from "./src/host-capability-snapshot.ts";',
      `const identity = loadOrCreatePhysicalHostIdentity({ stateDir: ${JSON.stringify(f.stateDir)}, workspaceRoots: [] });`,
      'process.stdout.write(identity.hostId);',
    ].join("\n");
    const first = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const second = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    assert.match(first, /^host-[0-9a-f-]+$/);
    assert.equal(second, first);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("snapshot separates static, dynamic and verified layers", () => {
  const f = fixture();
  try {
    const identity = loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "33333333-3333-4333-8333-333333333333",
      now: () => new Date("2026-09-26T00:00:00Z"),
    });
    const snapshot = createHostCapabilitySnapshot({
      identity,
      runtimeIdentity: runtime("server-a"),
      capabilityManifest: manifest,
      metrics,
      now: () => new Date("2026-09-26T00:20:00Z"),
    });
    assert.equal(snapshot.schema, HOST_CAPABILITY_SNAPSHOT_SCHEMA);
    assert.equal(snapshot.static.platform, "darwin");
    assert.equal(snapshot.static.architecture, "arm64");
    assert.equal(snapshot.static.memoryClass, "64_127_GIB");
    assert.equal(snapshot.dynamic.availableMemoryBytes, 40 * 1024 ** 3);
    assert.equal(snapshot.dynamic.normalizedLoad1m, 0.25);
    assert.equal(snapshot.dynamic.connectivityState, "LOCAL_OBSERVED");
    assert.equal(snapshot.verified.capabilityManifest.manifestSha256, manifest.manifestSha256);
    assert.equal(snapshot.freshness.observedAt, "2026-09-26T00:20:00.000Z");
    assert.match(snapshot.snapshotId, /^[0-9a-f]{64}$/);
    assert.deepEqual(parseHostCapabilitySnapshot(snapshot), snapshot);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dynamic telemetry changes snapshot identity without changing capability manifest identity", () => {
  const f = fixture();
  try {
    const identity = loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "44444444-4444-4444-8444-444444444444",
    });
    const first = createHostCapabilitySnapshot({
      identity,
      runtimeIdentity: runtime("server-a"),
      capabilityManifest: manifest,
      metrics,
      now: () => new Date("2026-09-26T00:20:00Z"),
    });
    const second = createHostCapabilitySnapshot({
      identity,
      runtimeIdentity: runtime("server-a"),
      capabilityManifest: manifest,
      metrics: { ...metrics, availableMemoryBytes: 20 * 1024 ** 3, loadAverage1m: 6 },
      now: () => new Date("2026-09-26T00:21:00Z"),
    });
    assert.notEqual(first.snapshotId, second.snapshotId);
    assert.notEqual(first.freshness.telemetrySha256, second.freshness.telemetrySha256);
    assert.equal(first.verified.capabilityManifest.manifestSha256, second.verified.capabilityManifest.manifestSha256);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("malformed persistent host identity fails closed instead of minting a replacement", () => {
  const f = fixture();
  try {
    loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "55555555-5555-4555-8555-555555555555",
    });
    const path = join(f.stateDir, "physical-host-identity", "identity.json");
    const tampered = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    tampered.hostId = "../bad";
    tampered.createdAt = "nope";
    writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    assert.throws(
      () => loadOrCreatePhysicalHostIdentity({
        stateDir: f.stateDir,
        workspaceRoots: [f.workspace],
      }),
      /Invalid physical hostId/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("syntactically valid persistent host identity replacement fails integrity verification", () => {
  const f = fixture();
  try {
    loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "66666666-6666-4666-8666-666666666666",
      now: () => new Date("2026-09-26T00:00:00Z"),
    });
    const path = join(f.stateDir, "physical-host-identity", "identity.json");
    const tampered = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    tampered.hostId = "host-77777777-7777-4777-8777-777777777777";
    tampered.createdAt = "2026-09-26T00:01:00.000Z";
    writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    assert.throws(
      () => loadOrCreatePhysicalHostIdentity({
        stateDir: f.stateDir,
        workspaceRoots: [f.workspace],
      }),
      /integrity mismatch/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("missing identity with surviving integrity key fails closed instead of minting a replacement", () => {
  const f = fixture();
  try {
    loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "77777777-7777-4777-8777-777777777777",
    });
    const identityPath = join(f.stateDir, "physical-host-identity", "identity.json");
    rmSync(identityPath);
    assert.throws(
      () => loadOrCreatePhysicalHostIdentity({
        stateDir: f.stateDir,
        workspaceRoots: [f.workspace],
        randomUuid: () => "99999999-9999-4999-8999-999999999999",
      }),
      /identity is missing.*refusing to mint a replacement identity/i,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("persistent host identity state must remain outside active workspace authority", () => {
  const f = fixture();
  try {
    const stateInsideWorkspace = join(f.workspace, ".devspace-state");
    assert.throws(
      () => loadOrCreatePhysicalHostIdentity({
        stateDir: stateInsideWorkspace,
        workspaceRoots: [f.workspace],
      }),
      /outside active workspace roots/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("stateDir symlink into a workspace cannot bypass owner-state containment", () => {
  if (process.platform === "win32") return;
  const f = fixture();
  try {
    const stateLink = join(f.root, "owner-state-link");
    symlinkSync(f.workspace, stateLink, "dir");
    assert.throws(
      () => loadOrCreatePhysicalHostIdentity({
        stateDir: stateLink,
        workspaceRoots: [f.workspace],
      }),
      /real directory, not a symlink|outside active workspace roots/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("physical host identity cannot equal the ephemeral server instance identity", () => {
  const f = fixture();
  try {
    const identity = loadOrCreatePhysicalHostIdentity({
      stateDir: f.stateDir,
      workspaceRoots: [f.workspace],
      randomUuid: () => "88888888-8888-4888-8888-888888888888",
    });
    assert.throws(
      () => createHostCapabilitySnapshot({
        identity,
        runtimeIdentity: runtime(identity.hostId),
        capabilityManifest: manifest,
        metrics,
      }),
      /distinct from ephemeral serverInstanceId/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("registers the zero-config local snapshot as a read-only MCP tool", async () => {
  const f = fixture();
  const server = new McpServer({ name: "host-snapshot-test", version: "1" });
  try {
    registerHostCapabilitySnapshotTool(server, {
      stateDir: f.stateDir,
      workspaceRoots: () => [],
      runtimeIdentity: runtime("server-tool"),
      capabilityManifest: manifest,
      observeMetrics: () => metrics,
      now: () => new Date("2026-09-26T00:25:00Z"),
    });
    const registered = (server as any)._registeredTools as Record<string, {
      handler: (input: unknown, extra: unknown) => Promise<any>;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    }>;
    assert.deepEqual(Object.keys(registered), ["host_capability_snapshot"]);
    assert.equal(registered.host_capability_snapshot.annotations?.readOnlyHint, true);
    assert.equal(registered.host_capability_snapshot.annotations?.destructiveHint, false);
    assert.equal(registered.host_capability_snapshot.annotations?.idempotentHint, true);
    const output = await registered.host_capability_snapshot.handler({}, {});
    assert.equal(output.structuredContent.static.hostId.startsWith("host-"), true);
    assert.equal(output.structuredContent.verified.devspace.serverInstanceId, "server-tool");
    assert.equal(output.structuredContent.verified.capabilityManifest.manifestSha256, manifest.manifestSha256);
  } finally {
    await server.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("snapshot reader fails closed if a later workspace overlaps the identity state", () => {
  const f = fixture();
  try {
    let roots: string[] = [];
    const readSnapshot = createLocalHostCapabilitySnapshotReader({
      stateDir: f.stateDir,
      workspaceRoots: () => roots,
      runtimeIdentity: runtime("server-a"),
      capabilityManifest: manifest,
      observeMetrics: () => metrics,
      now: () => new Date("2026-09-26T00:30:00Z"),
    });
    assert.equal(readSnapshot().verified.devspace.serverInstanceId, "server-a");
    roots = [f.root];
    assert.throws(() => readSnapshot(), /outside active workspace roots/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
