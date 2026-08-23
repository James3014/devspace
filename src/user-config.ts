import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { expandHomePath } from "./roots.js";
import { storedSubagentsConfigSchema } from "./local-agent-config.js";

const devspaceUserConfigSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  allowedRoots: z.array(z.string()).optional(),
  publicBaseUrl: z.string().nullable().optional(),
  allowedHosts: z.array(z.string()).optional(),
  stateDir: z.string().optional(),
  worktreeRoot: z.string().optional(),
  artifactsEnabled: z.boolean().optional(),
  artifactMaxFileBytes: z.number().optional(),
  agentDir: z.string().optional(),
  subagents: storedSubagentsConfigSchema.optional(),
});

const devspaceAuthConfigSchema = z.object({
  ownerToken: z.string().optional(),
});

export type DevspaceUserConfig = z.infer<typeof devspaceUserConfigSchema>;

export type DevspaceAuthConfig = z.infer<typeof devspaceAuthConfigSchema>;

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
  configDocument: Record<string, unknown>;
}

export function devspaceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace")));
}

export function devspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "config.json");
}

export function devspaceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "auth.json");
}

export function devspaceSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "skills");
}

export function devspaceAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(devspaceConfigDir(env), "agents");
}

export function loadDevspaceFiles(env: NodeJS.ProcessEnv = process.env): DevspaceFiles {
  const dir = devspaceConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  const configDocument = configExists ? readJsonObject(configPath) : {};
  const authDocument = authExists ? readJsonObject(authPath) : {};

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: parseDocument(devspaceUserConfigSchema, configDocument, configPath),
    auth: parseDocument(devspaceAuthConfigSchema, authDocument, authPath),
    configDocument,
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
  existingDocument: Record<string, unknown> = {},
): string {
  const filePath = devspaceConfigPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, { ...existingDocument, ...config }, 0o600);
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devspaceAuthPath(env);
  mkdirSync(devspaceConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function parseDocument<T>(
  schema: z.ZodType<T>,
  document: Record<string, unknown>,
  filePath: string,
): T {
  const result = schema.safeParse(document);
  if (result.success) return result.data;

  throw new Error(`Invalid ${filePath}: ${z.prettifyError(result.error)}`);
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
