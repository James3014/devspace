import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { LocalAgentSessionManager } from "./local-agent-sessions.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import { LocalAgentProviderError } from "./local-agent-runtime.js";
import { MINIMUM_CODEX_RUNTIME_VERSION } from "./codex-runtime.js";

const originalDependencyRoot = process.env.DEVSPACE_DEPENDENCY_ROOT;
const codexRuntimeRoot = mkdtempSync(join(tmpdir(), "devspace-continuation-codex-runtime-"));
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk"), { recursive: true });
mkdirSync(join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin"), { recursive: true });
writeFileSync(
  join(codexRuntimeRoot, "node_modules", "@openai", "codex-sdk", "package.json"),
  JSON.stringify({ name: "@openai/codex-sdk", version: MINIMUM_CODEX_RUNTIME_VERSION }),
);
writeFileSync(
  join(codexRuntimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
  `#!/bin/sh\necho 'codex-cli ${MINIMUM_CODEX_RUNTIME_VERSION}'\n`,
  { mode: 0o755 },
);
process.env.DEVSPACE_DEPENDENCY_ROOT = codexRuntimeRoot;

after(() => {
  if (originalDependencyRoot === undefined) delete process.env.DEVSPACE_DEPENDENCY_ROOT;
  else process.env.DEVSPACE_DEPENDENCY_ROOT = originalDependencyRoot;
  rmSync(codexRuntimeRoot, { recursive: true, force: true });
});

function runGitRaw(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function setupGitFixture() {
  const root = mkdtempSync(join(tmpdir(), "devspace-continuation-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  runGitRaw(["init", "--initial-branch=main"], repo);
  runGitRaw(["config", "user.email", "test@example.com"], repo);
  runGitRaw(["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "readme.md"), "# Readme\n");
  runGitRaw(["add", "."], repo);
  runGitRaw(["commit", "-m", "initial"], repo);
  const head = runGitRaw(["rev-parse", "HEAD"], repo);
  return { root, repo, head, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function setupManager(overrides: Record<string, unknown> = {}, turnRunner?: any) {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-continuation-state-"));
  const config = {
    stateDir,
    subagents: true,
    oauth: { scopes: ["devspace"] },
    agentMaxConcurrent: 8,
    toolchains: [],
    devspaceAgentsDir: join(stateDir, "agents"),
    ...overrides,
  } as any;
  const manager = new LocalAgentSessionManager(
    config,
    async () => undefined,
    async () => true,
    turnRunner,
  );
  return { manager, clean: () => rmSync(stateDir, { recursive: true, force: true }) };
}

const mockProfiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "test",
    provider: "codex",
    disabled: false,
    filePath: "reviewer.md",
    body: "reviewer prompt",
    write_mode: "allowed",
  },
];

test("continuation is admitted after a clean within-scope turn", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({}, async (_profile: unknown, record: any, _prompt: string) => {
    mkdirSync(join(f.repo, "src"), { recursive: true });
    writeFileSync(join(f.repo, "src", "turn-output.ts"), `// turn for ${record.id}\n`);
    return {
      provider: "codex",
      providerSessionId: "sess-1",
      items: [],
      finalResponse: "done",
    };
  });
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_cont_ok",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"] },
    });
    const launched = (manager as any).store.getById(started.agentId);
    // Simulate the spawned worker executing its turn in-process.
    const promptFile = `${f.root}/prompt-${started.agentId}.txt`;
    writeFileSync(promptFile, "work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, launched.workerToken!);

    const status = await manager.getAgentStatus({
      workspaceId: "ws_cont_ok",
      workspaceRoot: f.repo,
      agentId: started.agentId,
    });
    assert.equal(status.status, "idle");

    const continued = await manager.continueAgent({
      workspaceId: "ws_cont_ok",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "continue work",
    });
    assert.equal(continued.continued, true);
  } finally {
    f.clean();
    clean();
  }
});

test("continuation is rejected BEFORE mutation when a foreign mutation happened after the terminal turn", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({}, async () => ({ provider: "codex", providerSessionId: "sess-test", items: [], finalResponse: "done" }));
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_foreign",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "work",
      profiles: mockProfiles,
    });
    const record = (manager as any).store.getById(started.agentId);
    const promptFile = `${f.root}/prompt-${started.agentId}.txt`;
    writeFileSync(promptFile, "work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);

    // Foreign edit after the terminal turn: not attributable to the worker.
    writeFileSync(join(f.repo, "foreign-edit.txt"), "not the worker\n");

    const before = (manager as any).store.getById(started.agentId);
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_foreign",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "continue",
      }),
      (err: any) =>
        err.code === "CONTINUATION_ADMISSION_FAILED" &&
        /foreign/i.test(err.message),
    );
    // Rejected before mutation: status/error untouched by continueAgent.
    const after = (manager as any).store.getById(started.agentId);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.updatedAt, before.updatedAt);
  } finally {
    f.clean();
    clean();
  }
});

test("continuation rejects a foreign edit to a PREVIOUSLY WORKER-MODIFIED path", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({}, async () => {
    mkdirSync(join(f.repo, "src"), { recursive: true });
    writeFileSync(join(f.repo, "src", "a.ts"), "worker output v1\n");
    return { provider: "codex", providerSessionId: "sess-test", items: [], finalResponse: "done" };
  });
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_same_path",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "work",
      profiles: mockProfiles,
    });
    let record = (manager as any).store.getById(started.agentId);
    const promptFile = `${f.root}/prompt-same.txt`;
    writeFileSync(promptFile, "work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);

    record = (manager as any).store.getById(started.agentId);
    assert.equal(record.status, "idle");
    // The worker path is durably recorded in cumulative state...
    assert.ok((record.lifecycleState?.cumulativeChangedPaths ?? []).includes("src/a.ts"));

    // ...but a HUMAN/foreign process edits the SAME src/a.ts after the
    // terminal turn. Cumulative worker ownership must NOT whitelist it.
    writeFileSync(join(f.repo, "src", "a.ts"), "human override after the fact\n");

    const before = (manager as any).store.getById(started.agentId);
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_same_path",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "continue",
      }),
      (err: any) =>
        err.code === "CONTINUATION_ADMISSION_FAILED" &&
        /src\/a\.ts/.test(err.message) &&
        /foreign/i.test(err.message),
    );
    // Rejected before durable mutation.
    const after = (manager as any).store.getById(started.agentId);
    assert.equal(after.status, before.status);
    assert.deepEqual(after.updatedAt, before.updatedAt);
    assert.deepEqual(after.latestResponse, before.latestResponse);
  } finally {
    f.clean();
    clean();
  }
});

test("continuation cannot widen scope: maxFiles stays enforced across turns", async () => {
  const f = setupGitFixture();
  let turn = 0;
  const { manager, clean } = setupManager({}, async () => {
    turn += 1;
    mkdirSync(join(f.repo, "src"), { recursive: true });
    writeFileSync(join(f.repo, "src", `file-turn${turn}.ts`), `export const t${turn} = ${turn};\n`);
    return { provider: "codex", providerSessionId: "sess-test", items: [], finalResponse: `turn ${turn} done` };
  });
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_widen",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "work",
      profiles: mockProfiles,
      executionContract: { writePaths: ["src"], maxFiles: 1 },
    });

    // Turn 1: one file — within scope.
    let record = (manager as any).store.getById(started.agentId);
    let promptFile = `${f.root}/prompt-1.txt`;
    writeFileSync(promptFile, "work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);
    record = (manager as any).store.getById(started.agentId);
    assert.equal(record.scopeState, "WITHIN_SCOPE");

    // Continuation itself is admitted (no foreign edits).
    await manager.continueAgent({
      workspaceId: "ws_widen",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "one more file",
    });
    record = (manager as any).store.getById(started.agentId);

    // Turn 2 writes a SECOND distinct file: cumulative count (2) exceeds maxFiles.
    promptFile = `${f.root}/prompt-2.txt`;
    writeFileSync(promptFile, "more work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);
    record = (manager as any).store.getById(started.agentId);
    assert.equal(record.scopeState, "SCOPE_VIOLATION");
    assert.match(record.error ?? "", /write scope/);
  } finally {
    f.clean();
    clean();
  }
});

test("continuation is rejected when HEAD advanced past recorded lineage", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({}, async () => ({ provider: "codex", providerSessionId: "sess-test", items: [], finalResponse: "done" }));
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_head",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "work",
      profiles: mockProfiles,
    });
    const record = (manager as any).store.getById(started.agentId);
    const promptFile = `${f.root}/prompt-head.txt`;
    writeFileSync(promptFile, "work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);

    // Someone commits after the terminal turn.
    writeFileSync(join(f.repo, "committed-by-user.txt"), "x");
    runGitRaw(["add", "."], f.repo);
    runGitRaw(["commit", "-m", "external commit"], f.repo);

    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_head",
        workspaceRoot: f.repo,
        agentId: started.agentId,
        prompt: "continue",
      }),
      (err: any) => err.code === "CONTINUATION_ADMISSION_FAILED" && /HEAD/.test(err.message),
    );
  } finally {
    f.clean();
    clean();
  }
});

test("continuation is rejected while execution capacity is exhausted", async () => {
  const f = setupGitFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-capacity-state-"));
  const release: Array<() => void> = [];
  const manager = new LocalAgentSessionManager(
    {
      stateDir,
      subagents: true,
      oauth: { scopes: ["devspace"] },
      agentMaxConcurrent: 2,
      toolchains: [],
      devspaceAgentsDir: join(stateDir, "agents"),
    } as any,
    async () => undefined,
    async () => true,
    async (_profile, _record, prompt) => {
      if (prompt === "block") {
        await new Promise<void>((resolve) => release.push(resolve));
      }
      return { provider: "codex", providerSessionId: "sess-test", items: [], finalResponse: "done" };
    },
  );
  try {
    const startAndRun = async (workspaceId: string, prompt: string) => {
      const started = await manager.startAgent({
        workspaceId,
        workspaceRoot: f.repo,
        profileName: "reviewer",
        prompt,
        profiles: mockProfiles,
      });
      const record = (manager as any).store.getById(started.agentId);
      const promptFile = join(f.root, `prompt-${started.agentId}.txt`);
      writeFileSync(promptFile, prompt);
      await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);
      return started;
    };

    // One worker holds an execution slot...
    void startAndRun("ws_cap_a", "block");
    // ...while another agent finishes cleanly and stays terminal...
    const finished = await startAndRun("ws_cap_b", "finish");
    // ...and a second active worker exhausts configured capacity.
    void startAndRun("ws_cap_c", "block");
    await assert.rejects(
      manager.continueAgent({
        workspaceId: "ws_cap_b",
        workspaceRoot: f.repo,
        agentId: finished.agentId,
        prompt: "continue",
      }),
      (err: any) => err.code === "CONTINUATION_ADMISSION_FAILED" && /capacity/i.test(err.message),
    );
  } finally {
    for (const resolvePending of release) resolvePending();
    rmSync(stateDir, { recursive: true, force: true });
    f.clean();
  }
});

test("worker turn refuses a workspace outside configured allowed roots before mutation", async () => {
  const outside = mkdtempSync(join(tmpdir(), "devspace-outside-root-"));
  try {
    const { manager, clean } = setupManager({
      allowedRoots: [join(tmpdir(), "definitely-not-this-root")],
    }, async () => ({ provider: "codex", providerSessionId: "sess-test", items: [], finalResponse: "done" }));
    try {
      const started = await manager.startAgent({
        workspaceId: "ws_outside",
        workspaceRoot: outside,
        profileName: "reviewer",
        prompt: "work",
        profiles: mockProfiles,
      });
      const record = (manager as any).store.getById(started.agentId);
      const promptFile = join(outside, `prompt-${started.agentId}.txt`);
      writeFileSync(promptFile, "work");
      await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);
      const after = (manager as any).store.getById(started.agentId);
      assert.equal(after.status, "error");
      assert.equal(after.terminalReason, "launch_failed");
      assert.match(after.error ?? "", /allowed root/i);
    } finally {
      clean();
      rmSync(outside, { recursive: true, force: true });
    }
  } catch {
    // outer cleanup guard
  }
});

test("provider error mid-turn still records turn-end baseline and preserves candidate evidence", async () => {
  const f = setupGitFixture();
  const { manager, clean } = setupManager({}, async () => {
    writeFileSync(join(f.repo, "partial-work.txt"), "partial\n");
    throw new LocalAgentProviderError("provider exploded", {});
  });
  try {
    const started = await manager.startAgent({
      workspaceId: "ws_err",
      workspaceRoot: f.repo,
      profileName: "reviewer",
      prompt: "work",
      profiles: mockProfiles,
    });
    const record = (manager as any).store.getById(started.agentId);
    const promptFile = `${f.root}/prompt-err.txt`;
    writeFileSync(promptFile, "work");
    await manager.runWorkerTurnFromFile(started.agentId, promptFile, record.workerToken!);

    const reconciled = await manager.reconcileAgent({
      workspaceId: "ws_err",
      workspaceRoot: f.repo,
      isolated: true,
      agentId: started.agentId,
    });
    assert.equal(reconciled.candidate.present, true);
    assert.deepEqual(reconciled.candidate.changedPaths, ["partial-work.txt"]);

    // No foreign edits since turn end: continuation is admissible.
    await manager.continueAgent({
      workspaceId: "ws_err",
      workspaceRoot: f.repo,
      agentId: started.agentId,
      prompt: "retry",
    });
  } finally {
    f.clean();
    clean();
  }
});
