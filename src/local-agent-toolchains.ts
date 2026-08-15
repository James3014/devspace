import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Allowlisted toolchain registry for bounded repository verification.
 *
 * Dev MCP never installs packages, creates a .venv, or mutates repository
 * configuration to locate verifier executables. If a toolchain is not already
 * configured, the verification call fails explicitly.
 */

export interface ToolchainSpec {
  id: string;
  root: string;
  /** verifier name -> executable path (absolute or relative to root). */
  verifiers: Record<string, string>;
}

export interface ResolvedToolchainExecutable {
  executable: string;
  root: string;
}

export interface ToolchainVerificationResult {
  toolchainId: string;
  verifier: string;
  executable: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

export function parseToolchains(value: string | undefined): ToolchainSpec[] {
  if (!value || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`DEVSPACE_TOOLCHAINS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DEVSPACE_TOOLCHAINS must be a JSON array of toolchain objects.");
  }

  const toolchains: ToolchainSpec[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("DEVSPACE_TOOLCHAINS entries must be objects.");
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
    const root = typeof record.root === "string" && record.root.trim() ? record.root.trim() : undefined;
    const verifiers = record.verifiers;
    if (!id || !root) {
      throw new Error(`DEVSPACE_TOOLCHAINS entry must have string id and root.`);
    }
    if (!verifiers || typeof verifiers !== "object" || Array.isArray(verifiers)) {
      throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' must have a verifiers mapping.`);
    }
    const resolvedVerifiers: Record<string, string> = {};
    for (const [name, executable] of Object.entries(verifiers)) {
      if (typeof executable !== "string" || !executable.trim()) {
        throw new Error(`DEVSPACE_TOOLCHAINS entry '${id}' verifier '${name}' must be a string.`);
      }
      resolvedVerifiers[name] = executable.trim();
    }
    toolchains.push({ id, root, verifiers: resolvedVerifiers });
  }
  return toolchains;
}

export function resolveToolchainExecutable(
  toolchains: ToolchainSpec[],
  toolchainId: string,
  verifier: string,
): ResolvedToolchainExecutable | undefined {
  const toolchain = toolchains.find((candidate) => candidate.id === toolchainId);
  if (!toolchain) return undefined;

  const configured = toolchain.verifiers[verifier];
  if (!configured) return undefined;

  const executable = isAbsolute(configured)
    ? resolve(configured)
    : resolve(toolchain.root, configured);

  if (!existsSync(executable)) return undefined;
  try {
    return { executable: realpathSync(executable), root: toolchain.root };
  } catch {
    return undefined;
  }
}

export function describeToolchainExecutables(
  toolchains: ToolchainSpec[],
  toolchainId: string,
): Record<string, string> | undefined {
  const toolchain = toolchains.find((candidate) => candidate.id === toolchainId);
  if (!toolchain) return undefined;
  const executables: Record<string, string> = {};
  for (const [verifier, configured] of Object.entries(toolchain.verifiers)) {
    const resolved = resolveToolchainExecutable(toolchains, toolchainId, verifier);
    executables[verifier] = resolved?.executable ?? configured;
  }
  return executables;
}

/**
 * Run one allowlisted verifier executable with a bounded cwd, bounded timeout,
 * and structured output. No shell, no redirection, no environment mutation,
 * no package installation.
 */
export function runToolchainVerifier(input: {
  toolchains: ToolchainSpec[];
  toolchainId: string;
  verifier: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<ToolchainVerificationResult> {
  const resolved = resolveToolchainExecutable(input.toolchains, input.toolchainId, input.verifier);
  if (!resolved) {
    return Promise.reject(
      new Error(
        `Toolchain '${input.toolchainId}' verifier '${input.verifier}' is not configured or not resolvable.`,
      ),
    );
  }

  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let completed = false;
    let timer: NodeJS.Timeout | undefined;

    const child = execFile(
      resolved.executable,
      input.args,
      {
        cwd: input.cwd,
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeout(timer);
        const timedOut = Boolean(
          error &&
            typeof error === "object" &&
            "killed" in error &&
            (error as { killed?: unknown }).killed === true &&
            typeof error === "object" &&
            "signal" in error &&
            (error as { signal?: unknown }).signal === "SIGTERM",
        );
        resolvePromise({
          toolchainId: input.toolchainId,
          verifier: input.verifier,
          executable: resolved.executable,
          exitCode: error ? (error as { code?: number | null }).code ?? null : 0,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: (stdout ?? "").toString(),
          stderr: (stderr ?? "").toString(),
        });
      },
    );

    timer = setTimeout(() => {
      if (completed) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }, timeoutMs);
  });
}
