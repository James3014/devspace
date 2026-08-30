import { spawn } from "node:child_process";

export const REPOSITORY_INTELLIGENCE_TOOL_NAMES = [
  "repository_intelligence_revision",
  "repository_intelligence_readiness",
  "repository_intelligence_overlap",
  "repository_intelligence_ci",
  "repository_intelligence_impact",
  "repository_intelligence_cfi",
  "repository_intelligence_eia",
] as const;

export type RepositoryIntelligenceOperation = "revision" | "readiness" | "overlap" | "ci" | "impact" | "cfi" | "eia";

export interface RepositoryIntelligenceRunnerConfig {
  root: string;
  pythonBin?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RepositoryIntelligenceResult {
  operation: RepositoryIntelligenceOperation;
  claim_ceiling: "PR_INTELLIGENCE_ONLY" | "CI_EVIDENCE_ONLY" | "AUTOMATION_ADVISORY_ONLY";
  result: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export function expectedRepositoryIntelligenceClaimCeiling(
  operation: RepositoryIntelligenceOperation,
): RepositoryIntelligenceResult["claim_ceiling"] {
  if (operation === "ci" || operation === "cfi") return "CI_EVIDENCE_ONLY";
  if (operation === "eia") return "AUTOMATION_ADVISORY_ONLY";
  return "PR_INTELLIGENCE_ONLY";
}

function validateCanonicalPayload(
  operation: RepositoryIntelligenceOperation,
  value: unknown,
): RepositoryIntelligenceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Repository Intelligence returned a non-object JSON payload");
  }
  const payload = value as Record<string, unknown>;
  if (payload.operation !== operation) {
    throw new Error(`Repository Intelligence operation mismatch: expected ${operation}`);
  }
  const expected = expectedRepositoryIntelligenceClaimCeiling(operation);
  if (payload.claim_ceiling !== expected) {
    throw new Error(`Repository Intelligence claim ceiling mismatch: expected ${expected}`);
  }
  if (!payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
    throw new Error("Repository Intelligence result is missing or invalid");
  }
  const result = payload.result as Record<string, unknown>;
  if (result.claim_ceiling !== undefined && result.claim_ceiling !== expected) {
    throw new Error(`Repository Intelligence nested claim ceiling mismatch: expected ${expected}`);
  }
  return { operation, claim_ceiling: expected, result };
}

export async function runRepositoryIntelligenceOperation(
  config: RepositoryIntelligenceRunnerConfig,
  operation: RepositoryIntelligenceOperation,
  input: unknown,
): Promise<RepositoryIntelligenceResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const pythonBin = config.pythonBin?.trim() || "python3";
  const serialized = JSON.stringify(input);

  return await new Promise<RepositoryIntelligenceResult>((resolve, reject) => {
    const child = spawn(
      pythonBin,
      ["-m", "reviewer.intelligence_cli", "--operation", operation, "--input", "-"],
      {
        cwd: config.root,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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
    const timer = setTimeout(
      () => fail(new Error(`Repository Intelligence timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();

    child.on("error", (error) => fail(new Error(`Repository Intelligence process failed: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail(new Error(`Repository Intelligence stdout exceeded ${maxStdoutBytes} byte limit`));
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes > maxStderrBytes) {
        fail(new Error(`Repository Intelligence stderr exceeded ${maxStderrBytes} byte limit`));
        return;
      }
      stderr.push(buffer);
    });
    child.stdin.on("error", (error) => fail(new Error(`Repository Intelligence stdin failed: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const detail = err || out.trim() || `exit code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`;
        reject(new Error(`Repository Intelligence failed: ${detail.slice(0, 4096)}`));
        return;
      }
      try {
        resolve(validateCanonicalPayload(operation, JSON.parse(out)));
      } catch (error) {
        reject(error instanceof SyntaxError
          ? new Error("Repository Intelligence returned invalid JSON")
          : error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(serialized);
  });
}
