import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cancelCodegTask,
  codegExecutionIdentity,
  formatCodegTaskHandle,
  inspectCodegTask,
  parseCodegTaskHandle,
  resolveCodegGatewayConfig,
  runCodegLocalAgent,
} from "./local-agent-codeg.js";

type RequestRecord = {
  path: string;
  body: any;
  authorization?: string;
};

function response(value: unknown, status = 200): Response {
  return new Response(value === undefined ? "" : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envFor(provider: string): NodeJS.ProcessEnv {
  return {
    DEVSPACE_CODEG_PROVIDERS: provider,
    DEVSPACE_CODEG_URL: "http://127.0.0.1:31817",
    DEVSPACE_CODEG_TOKEN: "secret-token",
    DEVSPACE_CODEG_REQUEST_TIMEOUT_MS: "1000",
    DEVSPACE_CODEG_POLL_INTERVAL_MS: "1",
  };
}

function createFakeCodeg(options: {
  provider?: string;
  model?: string;
  existingTasks?: any[];
  taskStates?: any[];
  changedFiles?: Array<{ file: string; additions: number; deletions: number }>;
  folderPath?: string;
  loseCreateAckOnce?: boolean;
  loseStartAckOnce?: boolean;
  loseCreateWithoutEffectOnce?: boolean;
  loseStartWithoutEffectOnce?: boolean;
  cancelStatus?: string;
}) {
  const requests: RequestRecord[] = [];
  let nextTaskId = 41;
  const tasks = new Map<number, any>();
  for (const task of options.existingTasks ?? []) tasks.set(task.id, { ...task });
  const stateQueue = [...(options.taskStates ?? [])];
  let loseCreateAck = options.loseCreateAckOnce === true;
  let loseStartAck = options.loseStartAckOnce === true;
  let loseCreateWithoutEffect = options.loseCreateWithoutEffectOnce === true;
  let loseStartWithoutEffect = options.loseStartWithoutEffectOnce === true;

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({
      path: url.pathname,
      body,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
    });

    switch (url.pathname) {
      case "/api/add_folder_to_history":
        return response({ id: 7, path: body.path });
      case "/api/work_task_list":
        return response([...tasks.values()]);
      case "/api/work_task_create": {
        if (loseCreateWithoutEffect) {
          loseCreateWithoutEffect = false;
          throw new TypeError("simulated create acknowledgement loss before effect");
        }
        const task = {
          id: nextTaskId++,
          status: "todo",
          title: body.draft.title,
          ...body.draft,
        };
        tasks.set(task.id, task);
        if (loseCreateAck) {
          loseCreateAck = false;
          throw new TypeError("simulated create acknowledgement loss");
        }
        return response(task);
      }
      case "/api/work_task_start": {
        const task = tasks.get(body.id);
        if (!task) return response({ error: "missing" }, 404);
        if (loseStartWithoutEffect) {
          loseStartWithoutEffect = false;
          throw new TypeError("simulated start acknowledgement loss before effect");
        }
        task.status = "running";
        if (loseStartAck) {
          loseStartAck = false;
          throw new TypeError("simulated start acknowledgement loss");
        }
        return response(undefined);
      }
      case "/api/work_task_get": {
        const task = tasks.get(body.id);
        if (!task) return response({ error: "missing" }, 404);
        if (stateQueue.length > 0) Object.assign(task, stateQueue.shift());
        return response(task);
      }
      case "/api/work_task_return": {
        const task = tasks.get(body.id);
        if (!task) return response({ error: "missing" }, 404);
        task.status = "running";
        return response(undefined);
      }
      case "/api/work_task_changed_files":
        return response(options.changedFiles ?? []);
      case "/api/get_folder":
        return response({ id: body.folderId, path: options.folderPath ?? "/tmp/fake-codeg-worktree" });
      case "/api/work_task_cancel": {
        const task = tasks.get(body.id);
        if (!task) return response({ error: "missing" }, 404);
        task.status = options.cancelStatus ?? "canceled";
        return response(undefined);
      }
      default:
        return response({ error: "unexpected" }, 404);
    }
  };

  return { fetchImpl, requests, tasks };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("Codeg gateway is explicit, fail-closed, and secret-free in identity", () => {
  assert.equal(resolveCodegGatewayConfig("codex", {}), undefined);
  assert.throws(
    () => resolveCodegGatewayConfig("codex", { DEVSPACE_CODEG_PROVIDERS: "codex" }),
    /incomplete/,
  );
  assert.throws(
    () => resolveCodegGatewayConfig("codex", {
      DEVSPACE_CODEG_PROVIDERS: "codex",
      DEVSPACE_CODEG_URL: "http://codeg.example.test",
      DEVSPACE_CODEG_TOKEN: "secret-token",
    }),
    /loopback/,
  );

  const identity = codegExecutionIdentity("codex", envFor("codex"));
  assert.ok(identity);
  assert.match(identity.identity, /^codeg:http:\/\/127\.0\.0\.1:31817:codex$/);
  assert.equal(identity.identity.includes("secret-token"), false);
});

test("Codeg task handles round-trip exactly", () => {
  assert.equal(formatCodegTaskHandle(17), "codeg-work-task:17");
  assert.equal(parseCodegTaskHandle("codeg-work-task:17"), 17);
  assert.equal(parseCodegTaskHandle("codeg-work-task:0"), undefined);
  assert.equal(parseCodegTaskHandle("native-session"), undefined);
});

test("Cline direct Codeg task normalizes exact ACP model and binds handle before start", async () => {
  const fake = createFakeCodeg({
    taskStates: [
      { status: "running" },
      { status: "review", result_summary: "cline done" },
    ],
  });
  const events: string[] = [];
  const result = await runCodegLocalAgent(
    "agt-cline-1",
    "cline",
    {
      prompt: "bounded cline task",
      workspaceRoot: "/tmp/codeg-cline-workspace",
      writeMode: "allowed",
      model: "z-ai/glm-5.3-flash",
    },
    {
      onSessionId: async (handle) => { events.push(`session:${handle}`); },
      onExecutionStarted: async () => { events.push("execution"); },
      onActivity: async () => { events.push("activity"); },
    },
    envFor("cline"),
    fake.fetchImpl,
  );

  assert.equal(result.providerSessionId, "codeg-work-task:41");
  assert.equal(result.finalResponse, "cline done");
  const create = fake.requests.find((entry) => entry.path === "/api/work_task_create");
  assert.ok(create);
  assert.equal(create.body.draft.config.agent_type, "cline");
  assert.equal(create.body.draft.config.mode_id, "act");
  assert.equal(create.body.draft.config.config_values.model, "zai/glm-5.3-flash");
  assert.equal(create.body.draft.config.config_values.auto_approve, "true");
  const bindIndex = events.findIndex((value) => value.startsWith("session:"));
  const startIndex = fake.requests.findIndex((entry) => entry.path === "/api/work_task_start");
  const createIndex = fake.requests.findIndex((entry) => entry.path === "/api/work_task_create");
  assert.ok(bindIndex >= 0);
  assert.ok(startIndex > createIndex);
  assert.ok(events.indexOf("execution") > bindIndex);
  assert.equal(fake.requests.every((entry) => entry.authorization === "Bearer secret-token"), true);
});

test("Agy direct Codeg task uses built-in antigravity auto_edit and never yolo", async () => {
  const fake = createFakeCodeg({
    taskStates: [
      { status: "running" },
      { status: "review", result_summary: "agy done" },
    ],
  });
  const result = await runCodegLocalAgent(
    "agt-agy-1",
    "agy",
    {
      prompt: "bounded agy task",
      workspaceRoot: "/tmp/codeg-agy-workspace",
      writeMode: "allowed",
      model: "gemini-3.8-flash-high",
    },
    undefined,
    envFor("agy"),
    fake.fetchImpl,
  );

  assert.equal(result.providerSessionId, "codeg-work-task:41");
  const create = fake.requests.find((entry) => entry.path === "/api/work_task_create");
  assert.ok(create);
  assert.equal(create.body.draft.config.agent_type, "antigravity");
  assert.equal(create.body.draft.config.mode_id, "auto_edit");
  assert.notEqual(create.body.draft.config.mode_id, "yolo");
  assert.equal(create.body.draft.config.config_values.model, "gemini-3.8-flash-high");
});

test("ambiguous create recovery reuses one exact Codeg task and refuses duplicates", async () => {
  const title = "[devspace:agt-opencode-1] opencode";
  const existing = {
    id: 77,
    title,
    status: "review",
    result_summary: "existing result",
  };
  const reused = createFakeCodeg({ existingTasks: [existing] });
  const result = await runCodegLocalAgent(
    "agt-opencode-1",
    "opencode",
    {
      prompt: "bounded task",
      workspaceRoot: "/tmp/codeg-opencode-workspace",
      writeMode: "allowed",
    },
    undefined,
    envFor("opencode"),
    reused.fetchImpl,
  );
  assert.equal(result.providerSessionId, "codeg-work-task:77");
  assert.equal(
    reused.requests.filter((entry) => entry.path === "/api/work_task_create").length,
    0,
  );

  const duplicate = createFakeCodeg({
    existingTasks: [
      existing,
      { ...existing, id: 78 },
    ],
  });
  await assert.rejects(
    runCodegLocalAgent(
      "agt-opencode-1",
      "opencode",
      {
        prompt: "bounded task",
        workspaceRoot: "/tmp/codeg-opencode-workspace",
        writeMode: "allowed",
      },
      undefined,
      envFor("opencode"),
      duplicate.fetchImpl,
    ),
    /ambiguous duplicate ownership/,
  );
  assert.equal(
    duplicate.requests.filter((entry) => entry.path === "/api/work_task_create").length,
    0,
  );
});

test("lost create acknowledgement reconciles the one durable task without duplicate create", async () => {
  const fake = createFakeCodeg({
    loseCreateAckOnce: true,
    taskStates: [
      { status: "running" },
      { status: "review", result_summary: "create ack recovered" },
    ],
  });
  const handles: string[] = [];

  const result = await runCodegLocalAgent(
    "agt-create-lost-ack",
    "codex",
    {
      prompt: "recover create ack",
      workspaceRoot: "/tmp/codeg-create-lost-ack",
      writeMode: "allowed",
    },
    {
      onSessionId: async (handle) => { handles.push(handle); },
    },
    envFor("codex"),
    fake.fetchImpl,
  );

  assert.equal(result.providerSessionId, "codeg-work-task:41");
  assert.deepEqual(handles, ["codeg-work-task:41"]);
  assert.equal(
    fake.requests.filter((entry) => entry.path === "/api/work_task_create").length,
    1,
  );
  assert.equal(fake.tasks.size, 1);
});

test("lost start acknowledgement reconciles the same bound task without re-start", async () => {
  const fake = createFakeCodeg({
    loseStartAckOnce: true,
    taskStates: [
      { status: "running" },
      { status: "review", result_summary: "start ack recovered" },
    ],
  });
  const events: string[] = [];

  const result = await runCodegLocalAgent(
    "agt-start-lost-ack",
    "codex",
    {
      prompt: "recover start ack",
      workspaceRoot: "/tmp/codeg-start-lost-ack",
      writeMode: "allowed",
    },
    {
      onSessionId: async (handle) => { events.push(`session:${handle}`); },
      onExecutionStarted: async () => { events.push("execution"); },
    },
    envFor("codex"),
    fake.fetchImpl,
  );

  assert.equal(result.providerSessionId, "codeg-work-task:41");
  assert.equal(
    fake.requests.filter((entry) => entry.path === "/api/work_task_start").length,
    1,
  );
  assert.ok(events[0]?.startsWith("session:codeg-work-task:41"));
  assert.equal(events.includes("execution"), true);
});

test("lost create acknowledgement with no observable task never retries create", async () => {
  const fake = createFakeCodeg({ loseCreateWithoutEffectOnce: true });

  await assert.rejects(
    runCodegLocalAgent(
      "agt-create-unknown",
      "codex",
      {
        prompt: "do not resend create",
        workspaceRoot: "/tmp/codeg-create-unknown",
        writeMode: "allowed",
      },
      undefined,
      envFor("codex"),
      fake.fetchImpl,
    ),
    /outcome is unknown.*create was not retried/i,
  );

  assert.equal(
    fake.requests.filter((entry) => entry.path === "/api/work_task_create").length,
    1,
  );
  assert.equal(fake.tasks.size, 0);
});

test("lost start acknowledgement with task still todo never retries start", async () => {
  const fake = createFakeCodeg({ loseStartWithoutEffectOnce: true });

  await assert.rejects(
    runCodegLocalAgent(
      "agt-start-unknown",
      "codex",
      {
        prompt: "do not resend start",
        workspaceRoot: "/tmp/codeg-start-unknown",
        writeMode: "allowed",
      },
      undefined,
      envFor("codex"),
      fake.fetchImpl,
    ),
    /outcome is unresolved.*start was not retried/i,
  );

  assert.equal(
    fake.requests.filter((entry) => entry.path === "/api/work_task_start").length,
    1,
  );
  const task = [...fake.tasks.values()][0];
  assert.equal(task?.status, "todo");
});

test("continuation addresses the same Codeg handle instead of creating a replacement", async () => {
  const existing = {
    id: 88,
    title: "[devspace:agt-codex-1] codex",
    status: "review",
    result_summary: "first result",
  };
  const fake = createFakeCodeg({
    existingTasks: [existing],
    taskStates: [
      { status: "review", result_summary: "first result" },
      { status: "running", result_summary: null },
      { status: "review", result_summary: "second result" },
    ],
  });
  const result = await runCodegLocalAgent(
    "agt-codex-1",
    "codex",
    {
      prompt: "follow up",
      workspaceRoot: "/tmp/codeg-codex-workspace",
      providerSessionId: "codeg-work-task:88",
      writeMode: "allowed",
      model: "gpt-5.6-luna",
    },
    undefined,
    envFor("codex"),
    fake.fetchImpl,
  );

  assert.equal(result.providerSessionId, "codeg-work-task:88");
  assert.equal(result.finalResponse, "second result");
  assert.equal(fake.requests.some((entry) => entry.path === "/api/work_task_create"), false);
  const returned = fake.requests.find((entry) => entry.path === "/api/work_task_return");
  assert.equal(returned?.body.id, 88);
  assert.equal(returned?.body.feedback, "follow up");
});

test("same-task recollection polls a bound running Codeg task without create, start, or return", async () => {
  const fake = createFakeCodeg({
    existingTasks: [{
      id: 89,
      title: "[devspace:agt-codex-recollect] codex",
      status: "running",
      result_summary: null,
    }],
    taskStates: [
      { status: "running", result_summary: null },
      { status: "review", result_summary: "recollected result" },
    ],
  });

  const result = await runCodegLocalAgent(
    "agt-codex-recollect",
    "codex",
    {
      prompt: "recovery worker must not send this as new feedback",
      workspaceRoot: "/tmp/codeg-codex-recollect",
      providerSessionId: "codeg-work-task:89",
      writeMode: "allowed",
    },
    undefined,
    envFor("codex"),
    fake.fetchImpl,
  );

  assert.equal(result.providerSessionId, "codeg-work-task:89");
  assert.equal(result.finalResponse, "recollected result");
  assert.equal(fake.requests.some((entry) => entry.path === "/api/work_task_create"), false);
  assert.equal(fake.requests.some((entry) => entry.path === "/api/work_task_start"), false);
  assert.equal(fake.requests.some((entry) => entry.path === "/api/work_task_return"), false);
  const gets = fake.requests.filter((entry) => entry.path === "/api/work_task_get");
  assert.ok(gets.length >= 2);
  assert.equal(gets.every((entry) => entry.body.id === 89), true);
});

test("exact cancel touches only the bound Codeg task", async () => {
  const fake = createFakeCodeg({
    existingTasks: [
      { id: 91, title: "[devspace:a] grok", status: "running" },
      { id: 92, title: "[devspace:b] grok", status: "running" },
    ],
  });
  const stopped = await cancelCodegTask(
    "grok",
    "codeg-work-task:91",
    envFor("grok"),
    fake.fetchImpl,
  );
  assert.equal(stopped, true);
  assert.equal(fake.tasks.get(91)?.status, "canceled");
  assert.equal(fake.tasks.get(92)?.status, "running");
  const cancel = fake.requests.find((entry) => entry.path === "/api/work_task_cancel");
  assert.deepEqual(cancel?.body, {
    id: 91,
    reason: "cancelled by DevSpace",
    deleteWorktree: false,
  });
});

test("cancel does not treat a non-canceled terminal observation as confirmed cancellation", async () => {
  const fake = createFakeCodeg({
    existingTasks: [{ id: 93, title: "[devspace:agt-cancel-ambiguous] codex", status: "running" }],
    cancelStatus: "failed",
  });

  const stopped = await cancelCodegTask(
    "codex",
    "codeg-work-task:93",
    envFor("codex"),
    fake.fetchImpl,
  );

  assert.equal(stopped, false);
  assert.equal(fake.tasks.get(93)?.status, "failed");
});

test("reconciliation can recover the exact task by deterministic agent title", async () => {
  const fake = createFakeCodeg({
    existingTasks: [{
      id: 101,
      title: "[devspace:agt-reconcile] codex",
      status: "running",
    }],
  });
  const inspection = await inspectCodegTask(
    "codex",
    undefined,
    "agt-reconcile",
    "/tmp/codeg-reconcile-workspace",
    envFor("codex"),
    fake.fetchImpl,
  );
  assert.deepEqual(inspection, {
    taskId: 101,
    status: "running",
    terminal: false,
    success: false,
    summary: undefined,
  });
  assert.equal(fake.requests.some((entry) => entry.path === "/api/work_task_create"), false);
});

test("successful Codeg task materializes exact authorized worktree files into the DevSpace workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-materialize-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  mkdirSync(workspace, { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/materialize", codegWorktree, base);

    mkdirSync(join(codegWorktree, "allowed"), { recursive: true });
    writeFileSync(join(codegWorktree, "allowed", "result.txt"), "MATERIALIZED\n");

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 151,
        title: "[devspace:agt-materialize] codex",
        status: "review",
        result_summary: "materialize",
        worktree_folder_id: 22,
        base_sha: base,
      }],
      changedFiles: [{ file: "allowed/result.txt", additions: 1, deletions: 0 }],
      folderPath: codegWorktree,
    });

    const result = await runCodegLocalAgent(
      "agt-materialize",
      "codex",
      {
        prompt: "materialize bounded result",
        workspaceRoot: workspace,
        writeMode: "allowed",
        writePaths: ["allowed"],
      },
      undefined,
      envFor("codex"),
      fake.fetchImpl,
    );

    assert.equal(result.providerSessionId, "codeg-work-task:151");
    assert.equal(readFileSync(join(workspace, "allowed", "result.txt"), "utf8"), "MATERIALIZED\n");
    assert.equal(git(workspace, "status", "--short"), "?? allowed/");
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg materialization rejects out-of-scope changed files before touching DevSpace workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-scope-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  mkdirSync(workspace, { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/scope", codegWorktree, base);
    writeFileSync(join(codegWorktree, "forbidden.txt"), "NOPE\n");

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 152,
        title: "[devspace:agt-scope] codex",
        status: "review",
        result_summary: "scope",
        worktree_folder_id: 23,
        base_sha: base,
      }],
      changedFiles: [{ file: "forbidden.txt", additions: 1, deletions: 0 }],
      folderPath: codegWorktree,
    });

    await assert.rejects(
      runCodegLocalAgent(
        "agt-scope",
        "codex",
        {
          prompt: "scope",
          workspaceRoot: workspace,
          writeMode: "allowed",
          writePaths: ["allowed"],
        },
        undefined,
        envFor("codex"),
        fake.fetchImpl,
      ),
      /outside the DevSpace write scope/,
    );
    assert.equal(git(workspace, "status", "--short"), "");
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg materialization preflights every changed path before touching the DevSpace workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-preflight-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  mkdirSync(workspace, { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/preflight", codegWorktree, base);

    mkdirSync(join(codegWorktree, "allowed"), { recursive: true });
    writeFileSync(join(codegWorktree, "allowed", "first.txt"), "FIRST\n");
    symlinkSync(join(codegWorktree, "README.md"), join(codegWorktree, "allowed", "second.txt"));

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 153,
        title: "[devspace:agt-preflight] codex",
        status: "review",
        result_summary: "preflight",
        worktree_folder_id: 24,
        base_sha: base,
      }],
      changedFiles: [
        { file: "allowed/first.txt", additions: 1, deletions: 0 },
        { file: "allowed/second.txt", additions: 1, deletions: 0 },
      ],
      folderPath: codegWorktree,
    });

    await assert.rejects(
      runCodegLocalAgent(
        "agt-preflight",
        "codex",
        {
          prompt: "preflight all paths",
          workspaceRoot: workspace,
          writeMode: "allowed",
          writePaths: ["allowed"],
        },
        undefined,
        envFor("codex"),
        fake.fetchImpl,
      ),
      /not a regular file/,
    );
    assert.equal(existsSync(join(workspace, "allowed", "first.txt")), false);
    assert.equal(git(workspace, "status", "--short"), "");
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg materialization refuses an unproven missing-source deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-delete-proof-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  mkdirSync(workspace, { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/delete-proof", codegWorktree, base);

    mkdirSync(join(workspace, "allowed"), { recursive: true });
    writeFileSync(join(workspace, "allowed", "victim.txt"), "PREEXISTING\n");

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 154,
        title: "[devspace:agt-delete-proof] codex",
        status: "review",
        result_summary: "delete proof",
        worktree_folder_id: 25,
        base_sha: base,
      }],
      changedFiles: [{ file: "allowed/victim.txt", additions: 0, deletions: 1 }],
      folderPath: codegWorktree,
    });

    await assert.rejects(
      runCodegLocalAgent(
        "agt-delete-proof",
        "codex",
        {
          prompt: "do not erase unrelated local file",
          workspaceRoot: workspace,
          writeMode: "allowed",
          writePaths: ["allowed"],
        },
        undefined,
        envFor("codex"),
        fake.fetchImpl,
      ),
      /missing-source deletion is not proven by Git/,
    );
    assert.equal(readFileSync(join(workspace, "allowed", "victim.txt"), "utf8"), "PREEXISTING\n");
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg materialization applies a deletion only when exact-base Git proves D status", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-delete-positive-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  mkdirSync(join(workspace, "allowed"), { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    writeFileSync(join(workspace, "allowed", "delete-me.txt"), "DELETE\n");
    git(workspace, "add", "README.md", "allowed/delete-me.txt");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/delete-positive", codegWorktree, base);
    rmSync(join(codegWorktree, "allowed", "delete-me.txt"));

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 155,
        title: "[devspace:agt-delete-positive] codex",
        status: "review",
        result_summary: "delete positive",
        worktree_folder_id: 26,
        base_sha: base,
      }],
      changedFiles: [{ file: "allowed/delete-me.txt", additions: 0, deletions: 1 }],
      folderPath: codegWorktree,
    });

    await runCodegLocalAgent(
      "agt-delete-positive",
      "codex",
      {
        prompt: "apply proven deletion",
        workspaceRoot: workspace,
        writeMode: "allowed",
        writePaths: ["allowed"],
      },
      undefined,
      envFor("codex"),
      fake.fetchImpl,
    );

    assert.equal(existsSync(join(workspace, "allowed", "delete-me.txt")), false);
    assert.match(git(workspace, "status", "--short"), /D allowed\/delete-me\.txt/);
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg materialization requires an exact task base before any physical write", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-base-required-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  mkdirSync(workspace, { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/base-required", codegWorktree, base);
    mkdirSync(join(codegWorktree, "allowed"), { recursive: true });
    writeFileSync(join(codegWorktree, "allowed", "result.txt"), "NO-BASE\n");

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 156,
        title: "[devspace:agt-base-required] codex",
        status: "review",
        result_summary: "base missing",
        worktree_folder_id: 27,
        base_sha: null,
      }],
      changedFiles: [{ file: "allowed/result.txt", additions: 1, deletions: 0 }],
      folderPath: codegWorktree,
    });

    await assert.rejects(
      runCodegLocalAgent(
        "agt-base-required",
        "codex",
        {
          prompt: "must not materialize without exact base",
          workspaceRoot: workspace,
          writeMode: "allowed",
          writePaths: ["allowed"],
        },
        undefined,
        envFor("codex"),
        fake.fetchImpl,
      ),
      /has no exact base_sha/,
    );
    assert.equal(existsSync(join(workspace, "allowed", "result.txt")), false);
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg materialization refuses a symlinked DevSpace parent directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-codeg-target-parent-"));
  const workspace = join(root, "repo");
  const codegWorktree = join(root, "codeg-task");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    git(workspace, "init");
    git(workspace, "config", "user.name", "DevSpace Test");
    git(workspace, "config", "user.email", "devspace@example.test");
    writeFileSync(join(workspace, "README.md"), "base\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "base");
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "worktree", "add", "-b", "task/target-parent", codegWorktree, base);

    mkdirSync(join(codegWorktree, "allowed"), { recursive: true });
    writeFileSync(join(codegWorktree, "allowed", "result.txt"), "MUST-STAY-IN-WORKSPACE\n");
    symlinkSync(outside, join(workspace, "allowed"));

    const fake = createFakeCodeg({
      existingTasks: [{
        id: 157,
        title: "[devspace:agt-target-parent] codex",
        status: "review",
        result_summary: "target parent",
        worktree_folder_id: 28,
        base_sha: base,
      }],
      changedFiles: [{ file: "allowed/result.txt", additions: 1, deletions: 0 }],
      folderPath: codegWorktree,
    });

    await assert.rejects(
      runCodegLocalAgent(
        "agt-target-parent",
        "codex",
        {
          prompt: "reject symlinked target parent",
          workspaceRoot: workspace,
          writeMode: "allowed",
          writePaths: ["allowed"],
        },
        undefined,
        envFor("codex"),
        fake.fetchImpl,
      ),
      /parent.*symbolic link/i,
    );
    assert.equal(existsSync(join(outside, "result.txt")), false);
  } finally {
    try { git(workspace, "worktree", "remove", "--force", codegWorktree); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codeg backend fails closed for read-only and projected execution until hard enforcement exists", async () => {
  const fake = createFakeCodeg({});
  await assert.rejects(
    runCodegLocalAgent(
      "agt-readonly",
      "codex",
      {
        prompt: "read only",
        workspaceRoot: "/tmp/codeg-readonly",
        writeMode: "read_only",
      },
      undefined,
      envFor("codex"),
      fake.fetchImpl,
    ),
    /requires writeMode=allowed/,
  );
  await assert.rejects(
    runCodegLocalAgent(
      "agt-projected",
      "opencode",
      {
        prompt: "projected",
        workspaceRoot: "/tmp/codeg-projected",
        writeMode: "allowed",
        selectedToolIntents: [],
      },
      undefined,
      envFor("opencode"),
      fake.fetchImpl,
    ),
    /does not expose a proven DevSpace ToolProjection/,
  );
});
