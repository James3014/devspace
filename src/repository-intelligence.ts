import { spawn } from "node:child_process";

export const REPOSITORY_INTELLIGENCE_TOOL_NAMES = [
  "repository_intelligence_revision",
  "repository_intelligence_readiness",
  "repository_intelligence_overlap",
  "repository_intelligence_ci",
] as const;

export type RepositoryIntelligenceOperation = "revision" | "readiness" | "overlap" | "ci";

export interface RepositoryIntelligenceEngineIdentity {
  head: string;
}

export interface RepositoryIntelligenceRunnerConfig {
  root: string;
  expectedHead?: string;
  pythonBin?: string;
  gitBin?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RepositoryIntelligenceResult {
  operation: RepositoryIntelligenceOperation;
  claim_ceiling: "PR_INTELLIGENCE_ONLY" | "CI_EVIDENCE_ONLY";
  result: Record<string, unknown>;
  engine?: RepositoryIntelligenceEngineIdentity;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export function expectedRepositoryIntelligenceClaimCeiling(
  operation: RepositoryIntelligenceOperation,
): RepositoryIntelligenceResult["claim_ceiling"] {
  return operation === "ci" ? "CI_EVIDENCE_ONLY" : "PR_INTELLIGENCE_ONLY";
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
  streamName: string,
): number {
  const next = currentBytes + chunk.length;
  if (next > maxBytes) {
    throw new Error(`Repository Intelligence ${streamName} exceeded ${maxBytes} byte limit`);
  }
  chunks.push(chunk);
  return next;
}

export async function verifyRepositoryIntelligenceEngineHead(
  root: string,
  expectedHead: string,
  options?: { gitBin?: string; timeoutMs?: number },
): Promise<string> {
  const gitBin = options?.gitBin?.trim() || "git";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const normalizedExpected = expectedHead.trim().toLowerCase();

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(gitBin, ["-C", root, "rev-parse", "HEAD"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Git rev-parse timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      fail(new Error(`Failed to execute git rev-parse: ${error.message}`));
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes = appendBounded(stdoutChunks, buffer, stdoutBytes, 4096, "stdout");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes = appendBounded(stderrChunks, buffer, stderrBytes, 4096, "stderr");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        const detail = stderr || stdout || `exit code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`;
        reject(new Error(`Failed to resolve repository intelligence engine Git HEAD: ${detail.slice(0, 512)}`));
        return;
      }
      const actualHead = stdout.toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(actualHead)) {
        reject(new Error(`Invalid Git HEAD returned by engine root: ${stdout}`));
        return;
      }
      if (actualHead !== normalizedExpected) {
        reject(
          new Error(
            `Repository Intelligence engine HEAD mismatch: expected ${normalizedExpected}, got ${actualHead}`,
          ),
        );
      }
      resolve(actualHead);
    });
  });
}

function validateCanonicalPayload(
  operation: RepositoryIntelligenceOperation,
  value: unknown,
  engine?: RepositoryIntelligenceEngineIdentity,
): RepositoryIntelligenceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Repository Intelligence returned a non-object JSON payload");
  }
  const payload = value as Record<string, unknown>;
  if (payload.operation !== operation) {
    throw new Error(`Repository Intelligence operation mismatch: expected ${operation}`);
  }
  const expectedCeiling = expectedRepositoryIntelligenceClaimCeiling(operation);
  if (payload.claim_ceiling !== expectedCeiling) {
    throw new Error(`Repository Intelligence claim ceiling mismatch: expected ${expectedCeiling}`);
  }
  if (!payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
    throw new Error("Repository Intelligence result is missing or invalid");
  }
  const result = payload.result as Record<string, unknown>;
  if (result.claim_ceiling !== undefined && result.claim_ceiling !== expectedCeiling) {
    throw new Error(`Repository Intelligence nested claim ceiling mismatch: expected ${expectedCeiling}`);
  }
  return {
    operation,
    claim_ceiling: expectedCeiling,
    result,
    ...(engine ? { engine } : {}),
  };
}

export async function runRepositoryIntelligenceOperation(
  config: RepositoryIntelligenceRunnerConfig,
  operation: RepositoryIntelligenceOperation,
  input: unknown,
): Promise<RepositoryIntelligenceResult> {
  let verifiedHead: string | undefined;
  if (config.expectedHead) {
    verifiedHead = await verifyRepositoryIntelligenceEngineHead(
      config.root,
      config.expectedHead,
      {
        gitBin: config.gitBin,
        timeoutMs: config.timeoutMs ? Math.min(config.timeoutMs, DEFAULT_GIT_TIMEOUT_MS) : DEFAULT_GIT_TIMEOUT_MS,
      },
    );
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const pythonBin = config.pythonBin?.trim() || "python3";
  const serialized = JSON.stringify(input);

  return await new Promise<RepositoryIntelligenceResult>((resolve, reject) => {
    const child = spawn(
      pythonBin,
      ["-m", "repository_intelligence.cli", "--operation", operation, "--input", "-"],
      {
        cwd: config.root,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Repository Intelligence timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => fail(new Error(`Repository Intelligence process failed: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes = appendBounded(stdoutChunks, buffer, stdoutBytes, maxStdoutBytes, "stdout");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes = appendBounded(stderrChunks, buffer, stderrBytes, maxStderrBytes, "stderr");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        const detail = stderr || stdout.trim() || `exit code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`;
        reject(new Error(`Repository Intelligence failed: ${detail.slice(0, 4096)}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error("Repository Intelligence returned invalid JSON"));
        return;
      }
      try {
        const engine = verifiedHead ? { head: verifiedHead } : undefined;
        resolve(validateCanonicalPayload(operation, parsed, engine));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin.on("error", (error) => fail(new Error(`Repository Intelligence stdin failed: ${error.message}`)));
    child.stdin.end(serialized);
  });
}
