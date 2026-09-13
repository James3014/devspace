import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";

const MAX_HOSTS = 16;
const MAX_IDENTITY_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CAPABILITY_MANIFEST_SCHEMA = "devspace.capability_manifest.v1";

export interface PhysicalHostExpectedIdentity {
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256: string;
}

export interface PhysicalHostDefinition {
  hostId: string;
  identityUrl: string;
  expected: PhysicalHostExpectedIdentity;
}

export interface RemoteCapabilityManifest {
  schema: string;
  capabilities: string[];
  missing: string[];
  manifestSha256: string;
  inputSchemaFingerprint?: string;
}

export interface RemoteDevspaceIdentity {
  product: "devspace";
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
  buildId: string;
  serverInstanceId: string;
  startedAt?: string;
  capabilityManifest: RemoteCapabilityManifest;
}

export type PhysicalHostIdentityState =
  | "MATCH"
  | "IDENTITY_MISMATCH"
  | "UNREACHABLE"
  | "INVALID_RESPONSE";

export interface PhysicalHostStatus {
  hostId: string;
  state: PhysicalHostIdentityState;
  checkedAt: string;
  expected: PhysicalHostExpectedIdentity;
  observed?: RemoteDevspaceIdentity;
  mismatches?: string[];
  errorCode?: string;
  error?: string;
}

interface PhysicalHostFile {
  hosts: PhysicalHostDefinition[];
}

export interface PhysicalHostRegistryOptions {
  registryPath?: string;
  allowedRoots: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function expandOwnerPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (!isAbsolute(path)) {
    throw new Error("Physical host registry path must be absolute or start with ~/.");
  }
  return resolve(path);
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function validateIdentityUrl(value: unknown): string {
  const raw = exactString(value, "identityUrl");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("identityUrl must not contain credentials, query parameters, or fragments.");
  }
  if (url.pathname !== "/identity") {
    throw new Error("identityUrl must target the exact /identity endpoint.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("identityUrl must use HTTPS; HTTP is allowed only for loopback hosts.");
  }
  return url.toString();
}

function parseHost(value: unknown): PhysicalHostDefinition {
  const record = objectRecord(value, "host");
  const expected = objectRecord(record.expected, "host.expected");
  return {
    hostId: exactString(record.hostId, "hostId", HOST_ID),
    identityUrl: validateIdentityUrl(record.identityUrl),
    expected: {
      sourceCommit: exactString(expected.sourceCommit, "expected.sourceCommit", SOURCE_COMMIT),
      buildId: exactString(expected.buildId, "expected.buildId"),
      capabilityManifestSha256: exactString(
        expected.capabilityManifestSha256,
        "expected.capabilityManifestSha256",
        SHA256,
      ),
    },
  };
}

function parseHostFile(raw: unknown): PhysicalHostFile {
  const record = objectRecord(raw, "physical host registry");
  if (!Array.isArray(record.hosts) || record.hosts.length > MAX_HOSTS) {
    throw new Error(`physical host registry must contain an array of at most ${MAX_HOSTS} hosts.`);
  }
  const hosts = record.hosts.map(parseHost);
  const seen = new Set<string>();
  for (const host of hosts) {
    if (seen.has(host.hostId)) throw new Error(`Duplicate physical host id: ${host.hostId}`);
    seen.add(host.hostId);
  }
  return { hosts };
}

function readPrivateRegistry(path: string, allowedRoots: string[]): PhysicalHostFile {
  const configuredPath = expandOwnerPath(path);
  const link = lstatSync(configuredPath);
  if (link.isSymbolicLink() || !link.isFile()) {
    throw new Error("Physical host registry must be a regular file, not a symlink.");
  }
  if (process.platform !== "win32") {
    if ((link.mode & 0o077) !== 0) {
      throw new Error("Physical host registry must not grant group/other permissions (use chmod 600).");
    }
    if (link.nlink !== 1) {
      throw new Error("Physical host registry must be a single-link owner file.");
    }
  }
  const resolvedPath = realpathSync(configuredPath);
  const resolvedRoots = allowedRoots.map((root) => realpathSync(root));
  if (resolvedRoots.some((root) => pathInside(root, resolvedPath))) {
    throw new Error("Physical host registry must live outside DEVSPACE_ALLOWED_ROOTS.");
  }
  return parseHostFile(JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown);
}

function parseCapabilityManifest(value: unknown): RemoteCapabilityManifest {
  const record = objectRecord(value, "capabilityManifest");
  if (record.schema !== CAPABILITY_MANIFEST_SCHEMA) {
    throw new Error(`capabilityManifest.schema must equal ${CAPABILITY_MANIFEST_SCHEMA}.`);
  }
  const capabilities = record.capabilities;
  const missing = record.missing;
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")) {
    throw new Error("Invalid capabilityManifest.capabilities.");
  }
  if (!Array.isArray(missing) || missing.some((item) => typeof item !== "string")) {
    throw new Error("Invalid capabilityManifest.missing.");
  }
  return {
    schema: CAPABILITY_MANIFEST_SCHEMA,
    capabilities: [...capabilities] as string[],
    missing: [...missing] as string[],
    manifestSha256: exactString(record.manifestSha256, "capabilityManifest.manifestSha256", SHA256),
    ...(typeof record.inputSchemaFingerprint === "string"
      ? { inputSchemaFingerprint: record.inputSchemaFingerprint }
      : {}),
  };
}

function parseRemoteIdentity(value: unknown): RemoteDevspaceIdentity {
  const record = objectRecord(value, "remote identity");
  if (record.product !== "devspace") throw new Error("Remote identity product must be devspace.");
  if (typeof record.sourceDirty !== "boolean") throw new Error("Remote identity sourceDirty must be boolean.");
  return {
    product: "devspace",
    version: exactString(record.version, "remote identity version"),
    sourceCommit: exactString(record.sourceCommit, "remote sourceCommit", SOURCE_COMMIT),
    sourceDirty: record.sourceDirty,
    buildId: exactString(record.buildId, "remote buildId"),
    serverInstanceId: exactString(record.serverInstanceId, "remote serverInstanceId"),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    capabilityManifest: parseCapabilityManifest(record.capabilityManifest),
  };
}

async function boundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IDENTITY_BYTES) {
    throw new Error("Remote identity response exceeds the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_IDENTITY_BYTES) {
      await reader.cancel();
      throw new Error("Remote identity response exceeds the size limit.");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class PhysicalHostRegistry {
  readonly hosts: readonly PhysicalHostDefinition[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(hosts: PhysicalHostDefinition[], options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.hosts = hosts;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  list(): Array<{ hostId: string; expected: PhysicalHostExpectedIdentity }> {
    return this.hosts.map((host) => ({ hostId: host.hostId, expected: { ...host.expected } }));
  }

  private get(hostId: string): PhysicalHostDefinition {
    const host = this.hosts.find((entry) => entry.hostId === hostId);
    if (!host) throw new Error(`Unknown physical host: ${hostId}`);
    return host;
  }

  async status(hostId: string): Promise<PhysicalHostStatus> {
    const host = this.get(hostId);
    const checkedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(host.identityUrl, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return {
          hostId,
          state: "UNREACHABLE",
          checkedAt,
          expected: { ...host.expected },
          errorCode: `HTTP_${response.status}`,
          error: `Remote identity endpoint returned HTTP ${response.status}.`,
        };
      }
      let observed: RemoteDevspaceIdentity;
      try {
        observed = parseRemoteIdentity(JSON.parse(await boundedText(response)) as unknown);
      } catch (error) {
        return {
          hostId,
          state: "INVALID_RESPONSE",
          checkedAt,
          expected: { ...host.expected },
          errorCode: "INVALID_IDENTITY_RESPONSE",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const mismatches: string[] = [];
      if (observed.sourceDirty) mismatches.push("sourceDirty");
      if (observed.sourceCommit !== host.expected.sourceCommit) mismatches.push("sourceCommit");
      if (observed.buildId !== host.expected.buildId) mismatches.push("buildId");
      if (observed.capabilityManifest.manifestSha256 !== host.expected.capabilityManifestSha256) {
        mismatches.push("capabilityManifestSha256");
      }
      return {
        hostId,
        state: mismatches.length === 0 ? "MATCH" : "IDENTITY_MISMATCH",
        checkedAt,
        expected: { ...host.expected },
        observed,
        ...(mismatches.length > 0 ? { mismatches } : {}),
      };
    } catch (error) {
      return {
        hostId,
        state: "UNREACHABLE",
        checkedAt,
        expected: { ...host.expected },
        errorCode: controller.signal.aborted ? "IDENTITY_TIMEOUT" : "IDENTITY_FETCH_FAILED",
        error: controller.signal.aborted
          ? `Remote identity read exceeded ${this.timeoutMs}ms.`
          : error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async capabilities(hostId: string): Promise<Record<string, unknown>> {
    const status = await this.status(hostId);
    return {
      hostId,
      admitted: status.state === "MATCH",
      identityState: status.state,
      ...(status.state === "MATCH" && status.observed
        ? { capabilityManifest: status.observed.capabilityManifest }
        : {}),
      ...(status.mismatches ? { mismatches: status.mismatches } : {}),
      ...(status.errorCode ? { errorCode: status.errorCode } : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  }
}

export function loadPhysicalHostRegistry(options: PhysicalHostRegistryOptions): PhysicalHostRegistry | undefined {
  const path = options.registryPath?.trim();
  if (!path) return undefined;
  const file = readPrivateRegistry(path, options.allowedRoots);
  return new PhysicalHostRegistry(file.hosts, {
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

const READ_ONLY_REMOTE = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerPhysicalHostRegistryTools(
  server: McpServer,
  options: PhysicalHostRegistryOptions,
): void {
  const registry = loadPhysicalHostRegistry(options);
  if (!registry) return;

  registerAppTool(
    server,
    "host_registry_list",
    {
      title: "List physical hosts",
      description: "List owner-configured physical host IDs and their expected DevSpace identity. No network request or remote execution occurs.",
      inputSchema: {},
      _meta: {},
      annotations: { ...READ_ONLY_REMOTE, openWorldHint: false },
    },
    async () => {
      const hosts = registry.list();
      return {
        content: [{ type: "text" as const, text: `Configured physical hosts: ${hosts.length}.` }],
        structuredContent: { hosts },
      };
    },
  );

  const hostInput = {
    hostId: z.string().regex(HOST_ID).describe("Exact owner-configured physical host ID."),
  };

  registerAppTool(
    server,
    "host_registry_status",
    {
      title: "Physical host status",
      description: "Read and verify one configured remote DevSpace /identity endpoint. This never invokes remote MCP tools, shell commands, workers, or mutations.",
      inputSchema: hostInput,
      _meta: {},
      annotations: READ_ONLY_REMOTE,
    },
    async ({ hostId }) => {
      const status = await registry.status(hostId);
      return {
        content: [{ type: "text" as const, text: `Host ${hostId}: identity=${status.state}.` }],
        structuredContent: status as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppTool(
    server,
    "host_capabilities",
    {
      title: "Physical host capabilities",
      description: "Return the capability manifest only after the configured remote DevSpace identity matches the owner-pinned source/build/manifest identity. Capability visibility grants no task, workspace, worker, mutation, or retry authority.",
      inputSchema: hostInput,
      _meta: {},
      annotations: READ_ONLY_REMOTE,
    },
    async ({ hostId }) => {
      const output = await registry.capabilities(hostId);
      return {
        content: [{
          type: "text" as const,
          text: `Host ${hostId}: capability admission=${String(output.admitted)} (${String(output.identityState)}).`,
        }],
        structuredContent: output,
      };
    },
  );
}
