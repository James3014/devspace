import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  LocalAgentProviderError,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";

const DEFAULT_OMP_TIMEOUT_MS = 600_000;
const OMP_WRITE_TOOLS = "read,edit,write,grep,glob,todo";
const OMP_READ_ONLY_TOOLS = "read,grep,glob,todo";

const OMP_DEVSPACE_CONFIG = `advisor:\n  enabled: false\ntools:\n  approvalMode: write\n  approval:\n    bash: deny\n    ask: deny\n    debug: deny\n    eval: deny\n    github: deny\n    inspect_image: deny\n    browser: deny\n    computer: deny\n    checkpoint: deny\n    rewind: deny\n    security_scan: deny\n    task: deny\n    hub: deny\n    web_search: deny\n    memory_edit: deny\n    retain: deny\n    recall: deny\n    reflect: deny\n    learn: deny\n    manage_skill: deny\nmcp:\n  enableProjectConfig: false\nbrowser:\n  enabled: false\nweb_search:\n  enabled: false\nasync:\n  enabled: false\nprewalk:\n  enabled: false\n`;

export function ompCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const githubCredentialNames = new Set([
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_PAT",
    "COPILOT_GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GH_COPILOT_TOKEN",
  ]);

  for (const key of Object.keys(next)) {
    const upper = key.toUpperCase();
    const devspaceSecret =
      upper.startsWith("DEVSPACE_") &&
      (upper.includes("TOKEN") ||
        upper.includes("SECRET") ||
        upper.includes("AUTH") ||
        upper.includes("KEY") ||
        upper.includes("PASSWORD"));
    const githubSecret =
      githubCredentialNames.has(upper) ||
      (upper.includes("GITHUB") &&
        (upper.includes("TOKEN") ||
          upper.includes("SECRET") ||
          upper.includes("KEY") ||
          upper.includes("PAT")));
    if (devspaceSecret || githubSecret) delete next[key];
  }

  Object.assign(next, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GH_PROMPT_DISABLED: "1",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_1: "omp-devspace-disabled://origin",
  });
  return next;
}

export function buildOmpAcpArgs(input: LocalAgentRunInput, configPath: string): string[] {
  const args = [
    "--cwd",
    input.workspaceRoot,
    "--config",
    configPath,
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-prewalk",
    "--no-lsp",
    "--no-pty",
    "--approval-mode",
    "write",
    "--tools",
    input.writeMode === "allowed" ? OMP_WRITE_TOOLS : OMP_READ_ONLY_TOOLS,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--thinking", input.effort);
  args.push("acp");
  return args;
}

export async function runOmpAcpLocalAgent(
  input: LocalAgentRunInput,
  callbacks?: LocalAgentRunCallbacks,
): Promise<LocalAgentRunResult> {
  const { client, methods, ndJsonStream, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
  const tempRoot = await mkdtemp(join(tmpdir(), "devspace-omp-acp-"));
  const configPath = join(tempRoot, "omp-devspace.yml");
  await writeFile(configPath, OMP_DEVSPACE_CONFIG, { encoding: "utf8", mode: 0o600 });

  const environment = input.environment ?? process.env;
  const command = environment.OMP_COMMAND ?? "omp";
  const child = spawn(command, buildOmpAcpArgs(input, configPath), {
    cwd: input.workspaceRoot,
    env: ompCommandEnvironment(environment),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  assertPipedChild(child);

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  let activeSessionId = input.providerSessionId ?? null;
  const textParts: string[] = [];
  const items: unknown[] = [];
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const timeoutMs = readPositiveTimeout(environment.DEVSPACE_OMP_TIMEOUT_MS);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const run = client({ name: "DevSpace" })
      .onRequest(methods.client.session.requestPermission, (context) => {
        const selected =
          context.params.options.find((option) => option.kind === "allow_once") ??
          context.params.options.find((option) => option.kind === "allow_always");
        return selected
          ? { outcome: { outcome: "selected" as const, optionId: selected.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      })
      .onNotification(methods.client.session.update, (context) => {
        const notification = context.params;
        if (activeSessionId && notification.sessionId !== activeSessionId) return;
        items.push(notification);
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content;
        if (content.type === "text") textParts.push(content.text);
      })
      .connectWith(stream, async (agent) => {
        const initialized = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        items.push(initialized);

        if (input.providerSessionId) {
          if (!initialized.agentCapabilities?.sessionCapabilities?.resume) {
            throw new Error("OMP ACP does not advertise session/resume; refusing to replay a continued prompt as a new session.");
          }
          await agent.request(methods.agent.session.resume, {
            sessionId: input.providerSessionId,
            cwd: input.workspaceRoot,
            additionalDirectories: [],
          });
          activeSessionId = input.providerSessionId;
        } else {
          const session = await agent.request(methods.agent.session.new, {
            cwd: input.workspaceRoot,
            mcpServers: [],
          });
          activeSessionId = session.sessionId;
          items.push(session);
        }

        if (callbacks?.onExecutionStarted) {
          await callbacks.onExecutionStarted();
        }

        const response = await agent.request(methods.agent.session.prompt, {
          sessionId: activeSessionId!,
          prompt: [{ type: "text", text: input.prompt }],
        });
        items.push(response);
        return response;
      });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`OMP ACP execution timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    await Promise.race([run, timeoutPromise]);
    const finalResponse = textParts.join("").trim();
    if (!finalResponse) {
      throw new Error(`OMP ACP did not return assistant text.${stderr.trim() ? ` Stderr: ${stderr.trim()}` : ""}`);
    }
    if (!activeSessionId) throw new Error("OMP ACP did not return a session id.");

    return {
      provider: "omp",
      providerSessionId: activeSessionId,
      finalResponse,
      items,
    };
  } catch (error) {
    const detail = stderr.trim();
    throw new LocalAgentProviderError(
      `OMP ACP run failed: ${errorMessage(error)}${detail ? `\n${detail}` : ""}`,
      {
        providerSessionId: activeSessionId,
        finalResponse: textParts.join("").trim(),
      },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill("SIGTERM");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function readPositiveTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_OMP_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OMP_TIMEOUT_MS;
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("OMP ACP process did not expose stdio pipes.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
