import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { loadDevspaceFiles, type DevspaceFiles } from "./user-config.js";

export type ToolNamingMode = "legacy" | "short";
export type WidgetMode = "off" | "changes" | "full";
export type SurfaceProfile = "raw_devspace" | "canonical_gateway_proxy";
export type ProtocolMode = "legacy" | "dual" | "modern";
export type ToolSource = "devspace_builtin" | "canonical_gateway_manifest";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  minimalTools: boolean;
  toolNaming: ToolNamingMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  surfaceProfile: SurfaceProfile;
  protocolMode: ProtocolMode;
  gatewayProxyUrl?: string;
  gatewayProxyToken?: string;
  logging: LoggingConfig;
}

export interface ObservedManifestIdentity {
  count: number;
  revision: string;
  sha256?: string;
}

export interface SurfaceIdentity {
  surface_profile: SurfaceProfile;
  protocol_mode: ProtocolMode;
  tool_source: ToolSource;
  observed_manifest_count: number | null;
  observed_manifest_revision: string | null;
  observed_manifest_sha256: string | null;
  proxy_mode: boolean;
  gateway_url: string | null;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseMinimalTools(env: NodeJS.ProcessEnv): boolean {
  if (env.DEVSPACE_TOOL_MODE === "minimal") return true;
  if (env.DEVSPACE_TOOL_MODE === "full") return false;
  if (env.DEVSPACE_TOOL_MODE) {
    throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${env.DEVSPACE_TOOL_MODE}`);
  }
  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS);
  return true;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(expandHomePath(entry))) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseToolNaming(value: string | undefined): ToolNamingMode {
  if (!value || value === "short") return "short";
  if (value === "legacy") return "legacy";

  throw new Error(`Invalid DEVSPACE_TOOL_NAMING: ${value}`);
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseSurfaceProfile(value: string | undefined): SurfaceProfile | undefined {
  if (!value) return undefined;
  if (value === "raw_devspace" || value === "canonical_gateway_proxy") return value;

  throw new Error(`Invalid NEXUS_MCP_SURFACE_PROFILE: ${value}`);
}

function parseProtocolMode(value: string | undefined): ProtocolMode {
  if (!value || value === "dual") return "dual";
  if (value === "legacy") return "legacy";
  if (value === "dual" || value === "modern") return value;

  throw new Error(`Invalid MCP_PROTOCOL_MODE: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseGatewayProxyUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('NEXUS_GATEWAY_PROXY_URL must use http or https');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('NEXUS_GATEWAY_PROXY_URL must not contain credentials or a fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function parseGatewayProxyToken(value: string | undefined, url: string | undefined): string | undefined {
  const token = value?.trim();
  if (!url) {
    throw new Error("NEXUS_GATEWAY_PROXY_URL is required when canonical gateway proxy surface is selected");
  }
  if (!token) throw new Error('NEXUS_GATEWAY_PROXY_TOKEN is required when gateway proxy mode is enabled');
  if (token.length < 16) throw new Error('NEXUS_GATEWAY_PROXY_TOKEN must be at least 16 characters long');
  return token;
}

function isLocalPublicBaseUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function resolveSurfaceProfile(
  env: NodeJS.ProcessEnv,
  publicBaseUrl: string,
  gatewayProxyUrl: string | undefined,
  gatewayProxyToken: string | undefined,
): SurfaceProfile {
  const explicit = parseSurfaceProfile(env.NEXUS_MCP_SURFACE_PROFILE ?? env.DEVSPACE_SURFACE_PROFILE);
  if (explicit) {
    if (explicit === "canonical_gateway_proxy" && !gatewayProxyUrl) {
      throw new Error("NEXUS_GATEWAY_PROXY_URL is required when canonical gateway proxy surface is selected");
    }
    if (explicit === "raw_devspace" && (gatewayProxyUrl || gatewayProxyToken)) {
      throw new Error("NEXUS_GATEWAY_PROXY_* must be unset for the raw_devspace maintenance surface");
    }
    if (explicit === "raw_devspace" && !isLocalPublicBaseUrl(publicBaseUrl)) {
      throw new Error("raw_devspace maintenance surface requires a loopback public base URL");
    }
    return explicit;
  }

  // A configured gateway or a non-loopback public origin is a public candidate
  // and therefore defaults to the canonical surface. Loopback stays usable for
  // local maintenance without silently advertising a public gateway.
  if (gatewayProxyUrl || gatewayProxyToken || !isLocalPublicBaseUrl(publicBaseUrl)) {
    return "canonical_gateway_proxy";
  }
  return "raw_devspace";
}

export function getSurfaceIdentity(
  config: Pick<ServerConfig, "surfaceProfile" | "protocolMode" | "gatewayProxyUrl">,
  observedManifest?: ObservedManifestIdentity,
): SurfaceIdentity {
  const proxyMode = config.surfaceProfile === "canonical_gateway_proxy";
  return {
    surface_profile: config.surfaceProfile,
    protocol_mode: config.protocolMode,
    tool_source: proxyMode ? "canonical_gateway_manifest" : "devspace_builtin",
    observed_manifest_count: observedManifest?.count ?? null,
    observed_manifest_revision: observedManifest?.revision ?? null,
    observed_manifest_sha256: observedManifest?.sha256 ?? null,
    proxy_mode: proxyMode,
    gateway_url: config.gatewayProxyUrl ?? null,
  };
}

/** Build-time identity helper without loading OAuth or user config files. */
export function getConfiguredSurfaceIdentity(
  env: NodeJS.ProcessEnv = process.env,
  observedManifest?: ObservedManifestIdentity,
): SurfaceIdentity {
  const profile = parseSurfaceProfile(env.NEXUS_MCP_SURFACE_PROFILE ?? env.DEVSPACE_SURFACE_PROFILE)
    ?? (env.NEXUS_GATEWAY_PROXY_URL || env.NEXUS_GATEWAY_PROXY_TOKEN
      ? "canonical_gateway_proxy"
      : "raw_devspace");
  return getSurfaceIdentity(
    {
      surfaceProfile: profile,
      protocolMode: parseProtocolMode(env.MCP_PROTOCOL_MODE ?? env.NEXUS_MCP_PROTOCOL_MODE),
      gatewayProxyUrl: env.NEXUS_GATEWAY_PROXY_URL?.trim() || undefined,
    },
    observedManifest,
  );
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Programmatic callers that pass an explicit environment receive an
  // isolated configuration unless they also opt into a DEVSPACE_CONFIG_DIR.
  // This prevents tests and embedding hosts from silently inheriting a public
  // tunnel URL or credentials from the interactive user's home directory.
  const files: Pick<DevspaceFiles, "config" | "auth"> = env === process.env || env.DEVSPACE_CONFIG_DIR !== undefined
    ? loadDevspaceFiles(env)
    : { config: {}, auth: {} };
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const gatewayProxyUrlCandidate = parseGatewayProxyUrl(env.NEXUS_GATEWAY_PROXY_URL);
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  const gatewayProxyTokenCandidate = env.NEXUS_GATEWAY_PROXY_TOKEN?.trim();
  const surfaceProfile = resolveSurfaceProfile(
    env,
    publicBaseUrl,
    gatewayProxyUrlCandidate,
    gatewayProxyTokenCandidate,
  );
  const gatewayProxyUrl = surfaceProfile === "canonical_gateway_proxy" ? gatewayProxyUrlCandidate : undefined;
  const gatewayProxyToken = surfaceProfile === "canonical_gateway_proxy"
    ? parseGatewayProxyToken(gatewayProxyTokenCandidate, gatewayProxyUrl)
    : undefined;

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    minimalTools: parseMinimalTools(env),
    toolNaming: parseToolNaming(env.DEVSPACE_TOOL_NAMING),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    surfaceProfile,
    protocolMode: parseProtocolMode(env.MCP_PROTOCOL_MODE ?? env.NEXUS_MCP_PROTOCOL_MODE),
    gatewayProxyUrl,
    gatewayProxyToken,
    logging: parseLoggingConfig(env),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
