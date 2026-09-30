import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  loadavg,
  platform,
  totalmem,
} from "node:os";
import { isAbsolute, relative, resolve, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { RuntimeBuildIdentity } from "./build-identity.js";
import type { CapabilityManifest } from "./capability-manifest.js";

export const PHYSICAL_HOST_IDENTITY_SCHEMA = "devspace.physical_host_identity.v1" as const;
export const HOST_CAPABILITY_SNAPSHOT_SCHEMA = "devspace.host_capability_snapshot.v1" as const;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PhysicalHostIdentity {
  schema: typeof PHYSICAL_HOST_IDENTITY_SCHEMA;
  hostId: string;
  createdAt: string;
}

export interface HostCapabilityStaticFacts {
  hostId: string;
  platform: NodeJS.Platform;
  architecture: string;
  totalMemoryBytes: number;
  memoryClass: string;
  logicalCpuCount: number;
}

export interface HostCapabilityDynamicState {
  availableMemoryBytes: number;
  loadAverage1m: number;
  normalizedLoad1m: number;
  connectivityState: "LOCAL_OBSERVED";
}

export interface HostCapabilityVerifiedState {
  devspace: {
    sourceCommit: string;
    sourceDirty: boolean;
    buildId: string;
    serverInstanceId: string;
    startedAt: string;
  };
  capabilityManifest: {
    schema: string;
    capabilities: string[];
    missing: string[];
    manifestSha256: string;
    inputSchemaFingerprint?: string;
  };
}

export interface HostCapabilitySnapshot {
  schema: typeof HOST_CAPABILITY_SNAPSHOT_SCHEMA;
  snapshotId: string;
  static: HostCapabilityStaticFacts;
  dynamic: HostCapabilityDynamicState;
  verified: HostCapabilityVerifiedState;
  freshness: {
    observedAt: string;
    telemetrySha256: string;
  };
}

export interface HostMetrics {
  platform: NodeJS.Platform;
  architecture: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  logicalCpuCount: number;
  loadAverage1m: number;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPrivateIdentityFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Physical host identity must be a regular file, not a symlink.");
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Physical host identity must not grant group/other permissions (use chmod 600).");
    }
    if (stat.nlink !== 1) {
      throw new Error("Physical host identity must be a single-link owner file.");
    }
  }
}

function parseIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

export function parsePhysicalHostIdentity(value: unknown): PhysicalHostIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Physical host identity must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== PHYSICAL_HOST_IDENTITY_SCHEMA) {
    throw new Error(`Physical host identity schema must equal ${PHYSICAL_HOST_IDENTITY_SCHEMA}.`);
  }
  if (typeof record.hostId !== "string" || !HOST_ID.test(record.hostId)) {
    throw new Error("Invalid physical hostId.");
  }
  return {
    schema: PHYSICAL_HOST_IDENTITY_SCHEMA,
    hostId: record.hostId,
    createdAt: parseIso(record.createdAt, "physical host identity createdAt"),
  };
}

export function loadOrCreatePhysicalHostIdentity(options: {
  stateDir: string;
  workspaceRoots?: string[];
  randomUuid?: () => string;
  now?: () => Date;
}): PhysicalHostIdentity {
  const stateDir = resolve(options.stateDir);
  if ((options.workspaceRoots ?? []).some((root) => pathInside(resolve(root), stateDir))) {
    throw new Error("Physical host identity state must live outside active workspace roots.");
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "host-identity.json");

  const readExisting = (): PhysicalHostIdentity => {
    assertPrivateIdentityFile(path);
    return parsePhysicalHostIdentity(JSON.parse(readFileSync(path, "utf8")) as unknown);
  };

  try {
    return readExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const identity: PhysicalHostIdentity = {
    schema: PHYSICAL_HOST_IDENTITY_SCHEMA,
    hostId: `host-${(options.randomUuid ?? randomUUID)()}`,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  parsePhysicalHostIdentity(identity);

  let fd: number | undefined;
  try {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    fd = openSync(path, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Physical host identity target is not a regular file.");
    writeFileSync(fd, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readExisting();
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return readExisting();
}

export interface HostCapabilitySnapshotToolOptions {
  stateDir: string;
  workspaceRoots?: () => string[];
  runtimeIdentity: RuntimeBuildIdentity;
  capabilityManifest: CapabilityManifest;
  observeMetrics?: () => HostMetrics;
  now?: () => Date;
}

export function observeHostMetrics(): HostMetrics {
  const logicalCpuCount = Math.max(1, cpus().length);
  return {
    platform: platform(),
    architecture: arch(),
    totalMemoryBytes: totalmem(),
    availableMemoryBytes: freemem(),
    logicalCpuCount,
    loadAverage1m: loadavg()[0] ?? 0,
  };
}

function memoryClass(totalMemoryBytes: number): string {
  const gib = totalMemoryBytes / (1024 ** 3);
  if (gib < 8) return "LT_8_GIB";
  if (gib < 16) return "8_15_GIB";
  if (gib < 32) return "16_31_GIB";
  if (gib < 64) return "32_63_GIB";
  if (gib < 128) return "64_127_GIB";
  return "128_PLUS_GIB";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function createHostCapabilitySnapshot(input: {
  identity: PhysicalHostIdentity;
  runtimeIdentity: RuntimeBuildIdentity;
  capabilityManifest: CapabilityManifest;
  metrics?: HostMetrics;
  now?: () => Date;
}): HostCapabilitySnapshot {
  const metrics = input.metrics ?? observeHostMetrics();
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const staticFacts: HostCapabilityStaticFacts = {
    hostId: input.identity.hostId,
    platform: metrics.platform,
    architecture: metrics.architecture,
    totalMemoryBytes: metrics.totalMemoryBytes,
    memoryClass: memoryClass(metrics.totalMemoryBytes),
    logicalCpuCount: metrics.logicalCpuCount,
  };
  const dynamic: HostCapabilityDynamicState = {
    availableMemoryBytes: metrics.availableMemoryBytes,
    loadAverage1m: metrics.loadAverage1m,
    normalizedLoad1m: metrics.loadAverage1m / Math.max(1, metrics.logicalCpuCount),
    connectivityState: "LOCAL_OBSERVED",
  };
  const verified: HostCapabilityVerifiedState = {
    devspace: {
      sourceCommit: input.runtimeIdentity.sourceCommit,
      sourceDirty: input.runtimeIdentity.sourceDirty,
      buildId: input.runtimeIdentity.buildId,
      serverInstanceId: input.runtimeIdentity.serverInstanceId,
      startedAt: input.runtimeIdentity.startedAt,
    },
    capabilityManifest: {
      schema: input.capabilityManifest.schema,
      capabilities: [...input.capabilityManifest.capabilities],
      missing: [...input.capabilityManifest.missing],
      manifestSha256: input.capabilityManifest.manifestSha256,
      ...(input.capabilityManifest.inputSchemaFingerprint
        ? { inputSchemaFingerprint: input.capabilityManifest.inputSchemaFingerprint }
        : {}),
    },
  };
  const telemetrySha256 = sha256(dynamic);
  const snapshotCore = {
    schema: HOST_CAPABILITY_SNAPSHOT_SCHEMA,
    static: staticFacts,
    dynamic,
    verified,
    freshness: { observedAt, telemetrySha256 },
  };
  return {
    ...snapshotCore,
    snapshotId: sha256(snapshotCore),
  };
}

function requireFiniteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

export function createLocalHostCapabilitySnapshotReader(
  options: HostCapabilitySnapshotToolOptions,
): () => HostCapabilitySnapshot {
  const currentWorkspaceRoots = () => options.workspaceRoots?.() ?? [];
  const identity = loadOrCreatePhysicalHostIdentity({
    stateDir: options.stateDir,
    workspaceRoots: currentWorkspaceRoots(),
  });
  return () => {
    if (currentWorkspaceRoots().some((root) => pathInside(resolve(root), resolve(options.stateDir)))) {
      throw new Error("Physical host identity state overlaps an active workspace root.");
    }
    return createHostCapabilitySnapshot({
      identity,
      runtimeIdentity: options.runtimeIdentity,
      capabilityManifest: options.capabilityManifest,
      metrics: options.observeMetrics?.(),
      now: options.now,
    });
  };
}

export function registerHostCapabilitySnapshotTool(
  server: McpServer,
  options: HostCapabilitySnapshotToolOptions,
): void {
  const snapshot = createLocalHostCapabilitySnapshotReader(options);
  registerAppTool(
    server,
    "host_capability_snapshot",
    {
      title: "Local host capability snapshot",
      description:
        "Read the local physical host identity, static facts, dynamic telemetry, and verified DevSpace capability identity. This grants no task, mutation, route, placement, retry, or failover authority.",
      inputSchema: {},
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const value = snapshot();
      return {
        content: [{
          type: "text" as const,
          text: `Local physical host ${value.static.hostId}: snapshot=${value.snapshotId}.`,
        }],
        structuredContent: value as unknown as Record<string, unknown>,
      };
    },
  );
}

export function parseHostCapabilitySnapshot(value: unknown): HostCapabilitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host capability snapshot must be an object.");
  }
  const record = value as Record<string, any>;
  if (record.schema !== HOST_CAPABILITY_SNAPSHOT_SCHEMA) {
    throw new Error(`Host capability snapshot schema must equal ${HOST_CAPABILITY_SNAPSHOT_SCHEMA}.`);
  }
  if (typeof record.snapshotId !== "string" || !SHA256.test(record.snapshotId)) {
    throw new Error("Invalid host capability snapshotId.");
  }
  const staticFacts = record.static;
  const dynamic = record.dynamic;
  const verified = record.verified;
  const freshness = record.freshness;
  if (!staticFacts || !dynamic || !verified?.devspace || !verified?.capabilityManifest || !freshness) {
    throw new Error("Host capability snapshot layers are required.");
  }
  const hostId = staticFacts.hostId;
  if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("Invalid host capability snapshot hostId.");
  if (typeof staticFacts.platform !== "string" || typeof staticFacts.architecture !== "string") {
    throw new Error("Invalid host capability static platform/architecture.");
  }
  if (typeof staticFacts.memoryClass !== "string" || typeof staticFacts.logicalCpuCount !== "number" || !Number.isInteger(staticFacts.logicalCpuCount) || staticFacts.logicalCpuCount < 1) {
    throw new Error("Invalid host capability static memory/CPU facts.");
  }
  requireFiniteNonNegative(staticFacts.totalMemoryBytes, "host capability totalMemoryBytes");
  requireFiniteNonNegative(dynamic.availableMemoryBytes, "host capability availableMemoryBytes");
  requireFiniteNonNegative(dynamic.loadAverage1m, "host capability loadAverage1m");
  requireFiniteNonNegative(dynamic.normalizedLoad1m, "host capability normalizedLoad1m");
  if (dynamic.connectivityState !== "LOCAL_OBSERVED") {
    throw new Error("Invalid host capability connectivityState.");
  }
  const manifest = verified.capabilityManifest;
  if (typeof manifest.schema !== "string" || !Array.isArray(manifest.capabilities) || !Array.isArray(manifest.missing) || typeof manifest.manifestSha256 !== "string" || !SHA256.test(manifest.manifestSha256)) {
    throw new Error("Invalid verified capability manifest.");
  }
  const devspace = verified.devspace;
  if (
    typeof devspace.sourceCommit !== "string" ||
    typeof devspace.sourceDirty !== "boolean" ||
    typeof devspace.buildId !== "string" ||
    typeof devspace.serverInstanceId !== "string" ||
    typeof devspace.startedAt !== "string"
  ) {
    throw new Error("Invalid verified DevSpace identity.");
  }
  if (typeof freshness.telemetrySha256 !== "string" || !SHA256.test(freshness.telemetrySha256)) {
    throw new Error("Invalid host capability telemetry digest.");
  }
  parseIso(freshness.observedAt, "host capability observedAt");

  const parsed = record as HostCapabilitySnapshot;
  const expectedTelemetrySha256 = sha256(parsed.dynamic);
  if (parsed.freshness.telemetrySha256 !== expectedTelemetrySha256) {
    throw new Error("Host capability telemetry digest mismatch.");
  }
  const { snapshotId: _snapshotId, ...core } = parsed;
  if (sha256(core) !== parsed.snapshotId) {
    throw new Error("Host capability snapshotId mismatch.");
  }
  return parsed;
}
