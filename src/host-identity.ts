import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";

export const HOST_IDENTITY_SCHEMA = "devspace.host_identity.v1" as const;

export interface HostIdentityBinding {
  schema: typeof HOST_IDENTITY_SCHEMA;
  hostId: string;
  platform: NodeJS.Platform;
  arch: string;
  homePathSha256: string;
  pathEnvSha256: string;
  nodeMajor: number;
  stateRootSha256: string;
  devspaceBuildId: string;
  devspaceSourceCommit: string;
  hostIdentityHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payload(input: Omit<HostIdentityBinding, "hostIdentityHash">): Record<string, unknown> {
  return {
    schema: input.schema,
    hostId: input.hostId,
    platform: input.platform,
    arch: input.arch,
    homePathSha256: input.homePathSha256,
    pathEnvSha256: input.pathEnvSha256,
    nodeMajor: input.nodeMajor,
    stateRootSha256: input.stateRootSha256,
    devspaceBuildId: input.devspaceBuildId,
    devspaceSourceCommit: input.devspaceSourceCommit,
  };
}

export function buildHostIdentityBinding(input: {
  environment?: NodeJS.ProcessEnv;
  stateRoot: string;
  devspaceBuildId: string;
  devspaceSourceCommit: string;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  hostname?: string;
}): HostIdentityBinding {
  const environment = input.environment ?? process.env;
  const hostId = environment.DEVSPACE_HOST_ID?.trim() || input.hostname?.trim() || hostname();
  if (!hostId || hostId.includes("\0")) throw new Error("Host identity requires a non-empty hostId.");
  const nodeMajor = Number.parseInt((input.nodeVersion ?? process.versions.node).split(".")[0] ?? "", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 1) throw new Error("Host identity requires a valid Node major version.");
  const withoutHash: Omit<HostIdentityBinding, "hostIdentityHash"> = {
    schema: HOST_IDENTITY_SCHEMA,
    hostId,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    homePathSha256: sha256(environment.HOME ?? homedir()),
    pathEnvSha256: sha256(environment.PATH ?? ""),
    nodeMajor,
    stateRootSha256: sha256(resolve(input.stateRoot)),
    devspaceBuildId: input.devspaceBuildId,
    devspaceSourceCommit: input.devspaceSourceCommit,
  };
  return {
    ...withoutHash,
    hostIdentityHash: sha256(JSON.stringify(payload(withoutHash))),
  };
}

export function parseHostIdentityBinding(value: unknown): HostIdentityBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host identity must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== HOST_IDENTITY_SCHEMA) throw new Error("host identity schema mismatch");
  for (const field of [
    "hostId",
    "platform",
    "arch",
    "homePathSha256",
    "pathEnvSha256",
    "stateRootSha256",
    "devspaceBuildId",
    "devspaceSourceCommit",
    "hostIdentityHash",
  ]) {
    if (typeof record[field] !== "string" || !record[field]) throw new Error(`host identity ${field} is required`);
  }
  for (const field of ["homePathSha256", "pathEnvSha256", "stateRootSha256", "hostIdentityHash"]) {
    if (!/^[0-9a-f]{64}$/.test(String(record[field]))) throw new Error(`host identity ${field} must be sha256 hex`);
  }
  if (!Number.isInteger(record.nodeMajor) || Number(record.nodeMajor) < 1) {
    throw new Error("host identity nodeMajor must be a positive integer");
  }
  const parsed: HostIdentityBinding = {
    schema: HOST_IDENTITY_SCHEMA,
    hostId: String(record.hostId),
    platform: String(record.platform) as NodeJS.Platform,
    arch: String(record.arch),
    homePathSha256: String(record.homePathSha256),
    pathEnvSha256: String(record.pathEnvSha256),
    nodeMajor: Number(record.nodeMajor),
    stateRootSha256: String(record.stateRootSha256),
    devspaceBuildId: String(record.devspaceBuildId),
    devspaceSourceCommit: String(record.devspaceSourceCommit),
    hostIdentityHash: String(record.hostIdentityHash),
  };
  const expected = sha256(JSON.stringify(payload(parsed)));
  if (parsed.hostIdentityHash !== expected) throw new Error("host identity hash mismatch");
  return parsed;
}
