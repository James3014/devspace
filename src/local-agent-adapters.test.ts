import assert from "node:assert/strict";
import { delimiter } from "node:path";
import {
  claudeCommandEnvironment,
  createLocalAgentAdapter,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  extractPiStreamingText,
  piCommandEnvironment,
  resolveAcpModelConfigUpdate,
  resolveAcpThinkingConfigUpdate,
} from "./local-agent-adapters.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import { LocalAgentProviderError } from "./local-agent-runtime.js";

const providers: LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "omp",
  "pi",
  "cursor",
  "copilot",
  "agy",
];

for (const provider of providers) {
  const adapter = createLocalAgentAdapter(provider);
  assert.equal(adapter.provider, provider);
  assert.equal(typeof adapter.run, "function");
}

assert.deepEqual(
  resolveAcpModelConfigUpdate({
    sessionId: "session_model_1",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          options: [
            { value: "claude-sonnet-4.5", name: "Sonnet" },
            { value: "gpt-5.4", name: "GPT 5.4" },
          ],
        },
      ],
    },
  }, "gpt-5.4", "cursor"),
  { sessionId: "session_model_1", configId: "model", value: "gpt-5.4" },
);

assert.deepEqual(
  resolveAcpModelConfigUpdate({
    sessionId: "session_model_2",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model_config",
          category: "model",
          options: [
            {
              group: "claude",
              name: "Claude",
              options: [
                { value: "claude-sonnet-4.5", name: "Sonnet" },
                { value: "claude-opus-4.5", name: "Opus" },
              ],
            },
          ],
        },
      ],
    },
  }, "claude-opus-4.5", "copilot"),
  { sessionId: "session_model_2", configId: "model_config", value: "claude-opus-4.5" },
);

assert.throws(
  () => resolveAcpModelConfigUpdate({
    sessionId: "session_model_3",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          options: [{ value: "gpt-5.4", name: "GPT 5.4" }],
        },
      ],
    },
  }, "unknown-model", "cursor"),
  /Available values: gpt-5\.4/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate(undefined, "gpt-5.4", "cursor"),
  /session metadata/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate({ newSessionResponse: { configOptions: [] } }, "gpt-5.4", "cursor"),
  /session id/,
);

assert.throws(
  () => resolveAcpModelConfigUpdate({
    sessionId: "session_model_4",
    newSessionResponse: { configOptions: [] },
  }, "gpt-5.4", "cursor"),
  /does not expose a model/,
);

assert.deepEqual(
  resolveAcpThinkingConfigUpdate({
    sessionId: "session_1",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "effort",
          category: "thought_level",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
  }, "high", "cursor"),
  { sessionId: "session_1", configId: "effort", value: "high" },
);

assert.deepEqual(
  resolveAcpThinkingConfigUpdate({
    sessionId: "session_2",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "thoughts",
          category: "thought_level",
          options: [
            {
              group: "reasoning",
              name: "Reasoning",
              options: [
                { value: "medium", name: "Medium" },
                { value: "xhigh", name: "X High" },
              ],
            },
          ],
        },
      ],
    },
  }, "xhigh", "copilot"),
  { sessionId: "session_2", configId: "thoughts", value: "xhigh" },
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({
    sessionId: "session_3",
    newSessionResponse: {
      configOptions: [
        {
          type: "select",
          id: "thoughts",
          category: "thought_level",
          options: [{ value: "low", name: "Low" }],
        },
      ],
    },
  }, "max", "cursor"),
  /Available values: low/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate(undefined, "high", "copilot"),
  /session metadata/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({ newSessionResponse: { configOptions: [] } }, "high", "copilot"),
  /session id/,
);

assert.throws(
  () => resolveAcpThinkingConfigUpdate({
    sessionId: "session_4",
    newSessionResponse: { configOptions: [] },
  }, "high", "copilot"),
  /does not expose a thinking option/,
);

{
  const env = claudeCommandEnvironment({
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_AGENT_SDK_VERSION: "test",
    PATH: "/usr/bin",
  });

  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
  assert.equal(env.CLAUDE_AGENT_SDK_VERSION, undefined);
  assert.equal(env.PATH, "/usr/bin");
}

assert.equal(
  extractOpenCodeFinalResponse({
    data: [
      {
        info: { id: "msg_user", role: "user" },
        parts: [{ type: "text", text: "Review the change." }],
      },
      {
        info: { id: "msg_assistant", role: "assistant" },
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "grep", input: { pattern: "secret" }, output: "src/foo.ts" },
          { type: "text", text: "Final OpenCode response." },
        ],
      },
    ],
  }),
  "Final OpenCode response.",
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: [
      {
        id: "msg_user",
        type: "user",
        text: "Review the change.",
      },
      {
        id: "msg_assistant",
        type: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", name: "grep", state: { status: "completed", result: "src/foo.ts" } },
          { type: "text", text: "Final OpenCode v2 response." },
        ],
      },
    ],
  }),
  "Final OpenCode v2 response.",
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: {
      info: {
        id: "msg_structured",
        role: "assistant",
        structured: { summary: "structured answer" },
      },
      parts: [{ type: "reasoning", text: "thinking" }],
    },
  }),
  '{"summary":"structured answer"}',
);

assert.equal(
  extractOpenCodeFinalResponse({
    data: {
      info: { id: "msg_tool_only", role: "assistant" },
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "tool", tool: "bash", input: { command: "cat src/secret.ts" }, output: "secret" },
      ],
    },
  }),
  "",
);

assert.equal(
  extractPiFinalResponse({
    data: {
      messages: [
        { role: "user", content: "Review the change." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/foo.ts" } },
            { type: "text", text: "Final Pi response." },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "tool output" }],
        },
      ],
    },
  }),
  "Final Pi response.",
);

assert.equal(
  extractPiFinalResponse({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first part" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
          { type: "text", text: "second part" },
        ],
      },
    ],
  }),
  "first part\n\nsecond part",
);

assert.equal(
  extractPiFinalResponse({
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: "secret output" },
      { role: "bashExecution", command: "cat src/secret.ts", output: "secret output", timestamp: 1 },
    ],
  }),
  "",
);

assert.equal(
  extractPiProviderError({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "(0 , _piAi.streamSimpleOpenAIResponses) is not a function",
      },
    ],
  }),
  "(0 , _piAi.streamSimpleOpenAIResponses) is not a function",
);

assert.equal(
  extractPiStreamingText([
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Final " }] },
      assistantMessageEvent: { type: "text_delta", delta: "Final " },
    },
    {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Pi response." }] },
      assistantMessageEvent: { type: "text_delta", delta: "Pi response." },
    },
  ]),
  "Final Pi response.",
);

{
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const userBin = "/home/user/.local/bin";
  assert.equal(
    removeDevspaceNodeModulesBinFromPath([devspaceBin, userBin].join(delimiter)),
    userBin,
  );

  const env = piCommandEnvironment({
    PATH: [devspaceBin, userBin].join(delimiter),
  });

  assert.equal(env.PATH, userBin);
}

{
  const devspaceBin = `${process.cwd()}/node_modules/.bin`;
  const env = piCommandEnvironment({
    PI_COMMAND: "/custom/pi",
    PATH: [devspaceBin, "/home/user/.local/bin"].join(delimiter),
  });

  assert.equal(env.PATH, [devspaceBin, "/home/user/.local/bin"].join(delimiter));
}

// ==========================================
// Agy Local Agent Adapter Tests
// ==========================================
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupProviderScratch, createProviderScratch } from "./provider-scratch.js";

const mockAgySource = `#!/usr/bin/env node
const { existsSync, realpathSync } = require("node:fs");
const { isAbsolute, join, relative, sep } = require("node:path");
const args = process.argv.slice(2);
const canonical = (path) => {
  try { return realpathSync(path); } catch { return path; }
};

const expectedScratch = process.env.EXPECTED_AGY_PROVIDER_SCRATCH;
const isolatedHome = process.env.HOME;
if (!expectedScratch || !isolatedHome) {
  console.error("MISSING_AGY_ISOLATION_ENV");
  process.exit(93);
}
const homeRelativeToScratch = relative(canonical(expectedScratch), canonical(isolatedHome));
if (!homeRelativeToScratch || isAbsolute(homeRelativeToScratch) || homeRelativeToScratch === ".." || homeRelativeToScratch.startsWith(\`..\${sep}\`)) {
  console.error("AGY_HOME_OUTSIDE_PROVIDER_SCRATCH");
  process.exit(92);
}
if (process.env.AMBIENT_AGY_HOME && canonical(isolatedHome) === canonical(process.env.AMBIENT_AGY_HOME)) {
  console.error("INHERITED_AMBIENT_AGY_HOME");
  process.exit(91);
}
if (existsSync(join(isolatedHome, ".gemini", "config", "mcp_config.json"))) {
  console.error("INHERITED_AMBIENT_MCP_CONFIG");
  process.exit(90);
}
const expectedAppData = process.env.EXPECTED_AGY_APPDATA;
const isolatedAppData = join(isolatedHome, ".gemini", "antigravity-cli");
if (!expectedAppData) {
  console.error("MISSING_EXPECTED_AGY_APPDATA");
  process.exit(88);
}
for (const name of ["antigravity-oauth-token", "conversations"]) {
  if (canonical(join(isolatedAppData, name)) !== canonical(join(expectedAppData, name))) {
    console.error(\`AGY_PROVIDER_STATE_LINK_MISMATCH_\${name}\`);
    process.exit(87);
  }
}
for (const forbidden of ["mcp", "scratch"]) {
  if (existsSync(join(isolatedAppData, forbidden))) {
    console.error(\`AGY_FORBIDDEN_PROVIDER_STATE_EXPOSED_\${forbidden}\`);
    process.exit(86);
  }
}
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
  const value = process.env[key];
  const rel = value ? relative(canonical(isolatedHome), canonical(value)) : "";
  if (!value || isAbsolute(rel) || rel === ".." || rel.startsWith(\`..\${sep}\`)) {
    console.error(\`AGY_\${key}_OUTSIDE_ISOLATED_HOME\`);
    process.exit(89);
  }
}

// Secret leak check (Sentinel)
if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) {
  console.error("LEAKED_SECRET_FOUND: DEVSPACE_OAUTH_OWNER_TOKEN is present!");
  process.exit(98);
}
if (process.env.DEVSPACE_OAUTH_SCOPES) {
  console.error("LEAKED_SECRET_FOUND: DEVSPACE_OAUTH_SCOPES is present!");
  process.exit(98);
}
if (process.env.DEVSPACE_SENSITIVE_SECRET) {
  console.error("LEAKED_SECRET_FOUND: DEVSPACE_SENSITIVE_SECRET is present!");
  process.exit(98);
}

if (!args.includes("--dangerously-skip-permissions")) {
  console.error("MISSING_DANGEROUSLY_SKIP_PERMISSIONS");
  process.exit(99);
}

if (args.includes("--version")) {
  console.log("1.1.12");
  process.exit(0);
}

if (args.includes("--print")) {
  const promptIdx = args.indexOf("--print") + 1;
  const prompt = args[promptIdx];
  const addDirs = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : []);
  if (!addDirs.map(canonical).includes(canonical(process.cwd()))) {
    console.error("MISSING_OR_WRONG_ADD_DIR");
    process.exit(97);
  }
  if (process.env.EXPECTED_AGY_GIT_DIR && !addDirs.map(canonical).includes(canonical(process.env.EXPECTED_AGY_GIT_DIR))) {
    console.error("MISSING_GIT_METADATA_ADD_DIR");
    process.exit(96);
  }
  if (process.env.UNEXPECTED_AGY_GIT_DIR && addDirs.map(canonical).includes(canonical(process.env.UNEXPECTED_AGY_GIT_DIR))) {
    console.error("LEAKED_REPO_COMMON_GIT_DIR");
    process.exit(94);
  }
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";
  const effort = args.includes("--effort") ? args[args.indexOf("--effort") + 1] : "";
  if (model === "gemini-3.7-flash-medium" && args.includes("--effort")) {
    console.error("UNSUPPORTED_EFFORT_FOR_PRESET_MODEL");
    process.exit(95);
  }

  if (prompt === "TEST_HOSTILE_TIMEOUT") {
    process.on("SIGTERM", () => {
      console.error("MOCK_AGY: IGNORED_SIGTERM");
    });
    setInterval(() => {}, 10000);
    return;
  }
  if (prompt === "FORCE_ERROR") {
    process.exit(1);
  }
  if (prompt === "MALFORMED_JSON") {
    console.log("{malformed");
    process.exit(0);
  }
  if (prompt === "STATUS_FAILED") {
    console.log(JSON.stringify({ status: "FAILED", conversation_id: "123", response: "hello" }));
    process.exit(0);
  }
  if (prompt === "MISSING_CONV") {
    console.log(JSON.stringify({ status: "SUCCESS", response: "hello" }));
    process.exit(0);
  }
  if (prompt === "MISSING_RESP") {
    console.log(JSON.stringify({ status: "SUCCESS", conversation_id: "123" }));
    process.exit(0);
  }

  const responseObj = {
    status: "SUCCESS",
    conversation_id: args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : "new-conv-id",
    response: \`Processed: \${prompt} (mode=\${args[args.indexOf("--mode") + 1] || ""}, model=\${args[args.indexOf("--model") + 1] || ""}, effort=\${effort}, newProject=\${args.includes("--new-project")})\`,
  };
  console.log(JSON.stringify(responseObj));
  process.exit(0);
}
`;

const tempMockDir = mkdtempSync(join(tmpdir(), "devspace-mock-agy-"));
const tempMockPath = join(tempMockDir, "mock-agy.js");
writeFileSync(tempMockPath, mockAgySource, { mode: 0o755 });
const ambientAgyHome = join(tempMockDir, "ambient-home");
const ambientMcpConfig = join(ambientAgyHome, ".gemini", "config", "mcp_config.json");
const ambientAgyAppData = join(ambientAgyHome, ".gemini", "antigravity-cli");
mkdirSync(join(ambientAgyHome, ".gemini", "config"), { recursive: true });
mkdirSync(join(ambientAgyAppData, "conversations"), { recursive: true });
writeFileSync(ambientMcpConfig, '{"serena":{"command":"UNRELATED_GLOBAL_MCP_SENTINEL"}}\n');
writeFileSync(join(ambientAgyAppData, "antigravity-oauth-token"), "TEST_AUTH_TOKEN\n", { mode: 0o600 });
const agyScratch = createProviderScratch(`adapter_test_${process.pid}_${Date.now()}`);
const originalEnv = process.env;

try {
  const testEnv = {
    ...process.env,
    AGY_COMMAND: tempMockPath,
    HOME: ambientAgyHome,
    USERPROFILE: ambientAgyHome,
    XDG_CONFIG_HOME: join(ambientAgyHome, "xdg-config"),
    XDG_DATA_HOME: join(ambientAgyHome, "xdg-data"),
    XDG_CACHE_HOME: join(ambientAgyHome, "xdg-cache"),
    XDG_STATE_HOME: join(ambientAgyHome, "xdg-state"),
    DEVSPACE_PROVIDER_SCRATCH: agyScratch.root,
    EXPECTED_AGY_PROVIDER_SCRATCH: agyScratch.root,
    EXPECTED_AGY_APPDATA: ambientAgyAppData,
    AMBIENT_AGY_HOME: ambientAgyHome,
    DEVSPACE_OAUTH_OWNER_TOKEN: "DO_NOT_LEAK",
    DEVSPACE_OAUTH_SCOPES: "devspace",
    DEVSPACE_SENSITIVE_SECRET: "DO_NOT_LEAK",
  };
  process.env = testEnv;

  const adapter = createLocalAgentAdapter("agy");

  // A. 新會話測試 (同時也驗證了環境變數隔離，如果隔離失敗，mockAgy 會以 98 退出，此處會拋出異常)
  {
    const result = await adapter.run({
      prompt: "hello-task",
      workspace: process.cwd(),
      writeMode: "allowed",
      model: "gemini-3.6",
      thinking: "high",
    });
    assert.equal(result.provider, "agy");
    assert.equal(result.providerSessionId, "new-conv-id");
    assert.match(result.finalResponse, /Processed: hello-task/);
    assert.match(result.finalResponse, /mode=accept-edits/);
    assert.match(result.finalResponse, /model=gemini-3.6/);
    assert.match(result.finalResponse, /effort=high/);
    assert.match(result.finalResponse, /newProject=true/);
    assert.equal(
      readFileSync(ambientMcpConfig, "utf8"),
      '{"serena":{"command":"UNRELATED_GLOBAL_MCP_SENTINEL"}}\n',
      "bounded Agy adapter must not mutate the ambient global MCP config",
    );
  }

  // B. Missing or forged scratch must fail closed before Agy can inherit HOME.
  {
    process.env = { ...testEnv };
    delete process.env.DEVSPACE_PROVIDER_SCRATCH;
    await assert.rejects(
      () => adapter.run({
        prompt: "missing-scratch",
        workspace: process.cwd(),
        writeMode: "read_only",
      }),
      /requires DevSpace-owned provider scratch/,
    );

    process.env = { ...testEnv, DEVSPACE_PROVIDER_SCRATCH: ambientAgyHome };
    await assert.rejects(
      () => adapter.run({
        prompt: "unowned-scratch",
        workspace: process.cwd(),
        writeMode: "read_only",
      }),
      /refused unowned provider scratch/,
    );
    process.env = testEnv;
  }

  // C. Agy 1.1.18 preset model must not receive a redundant --effort flag.
  {
    const result = await adapter.run({
      prompt: "preset-model-task",
      workspace: process.cwd(),
      writeMode: "allowed",
      model: "gemini-3.7-flash-medium",
      thinking: "medium",
    });
    assert.match(result.finalResponse, /model=gemini-3.7-flash-medium/);
    assert.match(result.finalResponse, /effort=,/);
  }

  // D. 唯讀新會話測試
  {
    const result = await adapter.run({
      prompt: "hello-task",
      workspace: process.cwd(),
      writeMode: "read_only",
    });
    assert.equal(result.providerSessionId, "new-conv-id");
    assert.match(result.finalResponse, /mode=plan/);
  }

  // E. 恢復會話測試 (Resume)
  {
    const result = await adapter.run({
      prompt: "resume-task",
      workspace: process.cwd(),
      providerSessionId: "existing-session-123",
      writeMode: "allowed",
    });
    assert.equal(result.providerSessionId, "existing-session-123");
    assert.match(result.finalResponse, /newProject=false/);
  }

  // F. 錯誤處理測試 - exit code != 0
  await assert.rejects(
    () => adapter.run({
      prompt: "FORCE_ERROR",
      workspace: process.cwd(),
    }),
    /Agy exited with non-zero code 1/,
  );

  // G. 錯誤處理測試 - Malformed JSON
  await assert.rejects(
    () => adapter.run({
      prompt: "MALFORMED_JSON",
      workspace: process.cwd(),
    }),
    /Failed to parse Agy JSON output/,
  );

  // H. 錯誤處理測試 - status != SUCCESS
  await assert.rejects(
    () => adapter.run({
      prompt: "STATUS_FAILED",
      workspace: process.cwd(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalAgentProviderError);
      assert.match(error.message, /Agy execution status is not SUCCESS/);
      assert.equal(error.providerSessionId, "123");
      assert.equal(error.finalResponse, "hello");
      return true;
    },
  );

  // I. 錯誤處理測試 - missing conversation_id
  await assert.rejects(
    () => adapter.run({
      prompt: "MISSING_CONV",
      workspace: process.cwd(),
    }),
    /missing conversation_id/,
  );

  // J. 錯誤處理測試 - missing response
  await assert.rejects(
    () => adapter.run({
      prompt: "MISSING_RESP",
      workspace: process.cwd(),
    }),
    /missing response content/,
  );

  // K. Focused Test - Timeout clearance and resource disposal on exit
  {
    const createdTimers = new Set<NodeJS.Timeout>();
    const clearedTimers = new Set<NodeJS.Timeout>();

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    global.setTimeout = ((cb: any, ms: number, ...args: any[]) => {
      const timer = originalSetTimeout(cb, ms, ...args);
      createdTimers.add(timer);
      return timer;
    }) as any;

    global.clearTimeout = ((timer: any) => {
      if (timer) clearedTimers.add(timer);
      originalClearTimeout(timer);
    }) as any;

    try {
      await adapter.run({
        prompt: "hello-timer-test",
        workspace: process.cwd(),
        writeMode: "read_only",
      });
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }

    assert.ok(createdTimers.size > 0, "Expected at least one timer to be created");
    for (const timer of createdTimers) {
      assert.ok(clearedTimers.has(timer), "Expected timer to be cleared on exit");
    }
  }

  // L. Hostile timeout test (SIGTERM ignored, SIGKILL fallback)
  {
    const createdTimers = new Set<NodeJS.Timeout>();
    const clearedTimers = new Set<NodeJS.Timeout>();

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    global.setTimeout = ((cb: any, ms: number, ...args: any[]) => {
      const timer = originalSetTimeout(cb, ms, ...args);
      createdTimers.add(timer);
      return timer;
    }) as any;

    global.clearTimeout = ((timer: any) => {
      if (timer) clearedTimers.add(timer);
      originalClearTimeout(timer);
    }) as any;

    const hostileEnv = {
      ...process.env,
      DEVSPACE_AGY_TIMEOUT_MS: "100",
      DEVSPACE_AGY_GRACE_MS: "100",
    };
    const savedEnv = process.env;
    process.env = hostileEnv;

    try {
      await assert.rejects(
        () => adapter.run({
          prompt: "TEST_HOSTILE_TIMEOUT",
          workspace: process.cwd(),
          writeMode: "read_only",
        }),
        /Agy execution timed out\./,
      );
    } finally {
      process.env = savedEnv;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }

    assert.ok(createdTimers.size > 0, "Expected timers to be created in hostile timeout");
    for (const timer of createdTimers) {
      assert.ok(clearedTimers.has(timer), "Expected timer to be cleared in hostile timeout exit");
    }
  }

  // M. Managed linked worktrees expose only their verified worktree-scoped
  // Git metadata directory, never the repo-common .git.
  {
    const root = mkdtempSync(join(tmpdir(), "devspace-agy-worktree-"));
    const sourceRepo = join(root, "source");
    const linkedWorktree = join(root, "worktree");
    mkdirSync(sourceRepo);
    try {
      const git = (args: string[], cwd: string) => execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).trim();
      git(["init", "--initial-branch=main"], sourceRepo);
      git(["config", "user.email", "test@example.com"], sourceRepo);
      git(["config", "user.name", "Test User"], sourceRepo);
      writeFileSync(join(sourceRepo, "readme.md"), "# test\n");
      git(["add", "."], sourceRepo);
      git(["commit", "-m", "initial"], sourceRepo);
      git(["worktree", "add", "--detach", linkedWorktree, "HEAD"], sourceRepo);

      process.env = {
        ...testEnv,
        EXPECTED_AGY_GIT_DIR: join(sourceRepo, ".git", "worktrees", basename(linkedWorktree)),
        UNEXPECTED_AGY_GIT_DIR: join(sourceRepo, ".git"),
      };
      const result = await adapter.run({
        prompt: "linked-worktree",
        workspace: linkedWorktree,
        writeMode: "read_only",
      });
      assert.equal(result.providerSessionId, "new-conv-id");
    } finally {
      process.env = testEnv;
      rmSync(root, { recursive: true, force: true });
    }
  }

} finally {
  process.env = originalEnv;
  cleanupProviderScratch(agyScratch.root);
  rmSync(tempMockDir, { recursive: true, force: true });
}
