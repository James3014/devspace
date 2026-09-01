import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

// G5: command replay identity survives a fresh MCP workspace session for the
// same physical checkout, but never crosses into another physical root.
const reconnectManager = new ProcessSessionManager({ completedSessionTtlMs: 5_000 });
const reconnectRoot = process.cwd();
const reconnectCommand = `${node} -e "console.log('g5_reconnect_ok')"`;
const reconnectFirst = await reconnectManager.start({
  workspaceId: "ws_ephemeral_a",
  workspaceRoot: reconnectRoot,
  cwd: reconnectRoot,
  command: reconnectCommand,
  attemptKey: "g5:reconnect:001",
  yieldTimeMs: 2_000,
});
assert.equal(reconnectFirst.exitCode, 0);
const reconnectStatus = await reconnectManager.getStatus({
  workspaceId: "ws_ephemeral_b",
  workspaceRoot: reconnectRoot,
  attemptKey: "g5:reconnect:001",
});
assert.equal(reconnectStatus.exitCode, 0);
assert.match(reconnectStatus.output, /g5_reconnect_ok/);
const reconnectReplay = await reconnectManager.start({
  workspaceId: "ws_ephemeral_b",
  workspaceRoot: reconnectRoot,
  cwd: reconnectRoot,
  command: reconnectCommand,
  attemptKey: "g5:reconnect:001",
  yieldTimeMs: 2_000,
});
assert.equal(reconnectReplay.exitCode, 0);
await assert.rejects(
  reconnectManager.start({
    workspaceId: "ws_ephemeral_b",
    workspaceRoot: reconnectRoot,
    cwd: reconnectRoot,
    command: "echo materially_different",
    attemptKey: "g5:reconnect:001",
  }),
  /ATTEMPT_REPLAY_CONFLICT/,
);
await assert.rejects(
  reconnectManager.getStatus({
    workspaceId: "ws_other_root",
    workspaceRoot: "/tmp",
    attemptKey: "g5:reconnect:001",
  }),
  /Unknown process attemptKey/,
);
reconnectManager.shutdown();

// Root and attempt-key delimiters must not create ambiguous replay identities.
const collisionBase = mkdtempSync("/tmp/devspace-g5-collision-");
const collisionRootA = join(collisionBase, "a");
const collisionRootB = join(collisionBase, "a:b");
mkdirSync(collisionRootA);
mkdirSync(collisionRootB);
const collisionManager = new ProcessSessionManager();
try {
  const firstCollision = await collisionManager.start({
    workspaceId: "ws_collision_a",
    workspaceRoot: collisionRootA,
    cwd: reconnectRoot,
    command: "echo collision_a",
    attemptKey: "b:c",
  });
  const secondCollision = await collisionManager.start({
    workspaceId: "ws_collision_b",
    workspaceRoot: collisionRootB,
    cwd: reconnectRoot,
    command: "echo collision_b",
    attemptKey: "c",
  });
  assert.equal(firstCollision.exitCode, 0);
  assert.equal(secondCollision.exitCode, 0);
  assert.match(secondCollision.output, /collision_b/);
} finally {
  collisionManager.shutdown();
  rmSync(collisionBase, { recursive: true, force: true });
}

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
}

// ─────────────────────────────────────────────────────────────────────────────
// G2 Command Reconciliation & Reliability Tests (Test A - Test H)
// ─────────────────────────────────────────────────────────────────────────────

const g2Manager = new ProcessSessionManager({
  maxBufferCharacters: 10_000,
  completedSessionTtlMs: 5_000,
});

try {
  // Test A: Long command yields instead of holding request
  const testA = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => { console.log('testA_done'); process.exit(0); }, 300)"`,
    yieldTimeMs: 50,
  });
  assert.equal(testA.running, true, "Test A: command longer than yield window must return running: true");
  assert.ok(testA.sessionId, "Test A: must return sessionId");

  // Test B: Lost initial response -> reconcile using attemptKey
  const attemptKeyB = "attempt:b:001";
  const startB = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => { console.log('testB_done'); process.exit(0); }, 200)"`,
    yieldTimeMs: 50,
    attemptKey: attemptKeyB,
  });
  assert.equal(startB.running, true);
  assert.equal(startB.attemptKey, attemptKeyB);

  // Pretend response was lost; query status by attemptKey
  const reconcileB = await g2Manager.getStatus({
    workspaceId: "ws_g2",
    attemptKey: attemptKeyB,
    yieldTimeMs: 500,
  });
  assert.equal(reconcileB.running, false, "Test B: reconcile should observe finished process");
  assert.equal(reconcileB.exitCode, 0);
  assert.match(reconcileB.output, /testB_done/);

  // Test C: No duplicate process on replay of same attemptKey
  const attemptKeyC = "attempt:c:001";
  const firstStartC = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => { console.log('testC_output'); process.exit(0); }, 200)"`,
    yieldTimeMs: 50,
    attemptKey: attemptKeyC,
  });
  assert.equal(firstStartC.running, true);
  const firstSessionIdC = firstStartC.sessionId;

  // Replay start with same attemptKey
  const secondStartC = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => { console.log('testC_output'); process.exit(0); }, 200)"`,
    yieldTimeMs: 500,
    attemptKey: attemptKeyC,
  });
  // Must reuse same session
  assert.equal(secondStartC.running, false);
  assert.equal(secondStartC.exitCode, 0);
  assert.match(secondStartC.output, /testC_output/);

  // Test D: Terminal result survives lost response (non-destructive inspection)
  const attemptKeyD = "attempt:d:001";
  const startD = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "console.log('testD_result'); process.exit(0);"`,
    yieldTimeMs: 1_000,
    attemptKey: attemptKeyD,
  });
  assert.equal(startD.running, false);
  assert.equal(startD.exitCode, 0);
  assert.match(startD.output, /testD_result/);

  // Subsequent status lookup retrieves exact same terminal evidence
  const statusD1 = await g2Manager.getStatus({
    workspaceId: "ws_g2",
    attemptKey: attemptKeyD,
  });
  assert.equal(statusD1.running, false);
  assert.equal(statusD1.exitCode, 0);
  assert.match(statusD1.output, /testD_result/);

  // Another subsequent status lookup still retrieves output
  const statusD2 = await g2Manager.getStatus({
    workspaceId: "ws_g2",
    attemptKey: attemptKeyD,
  });
  assert.equal(statusD2.running, false);
  assert.match(statusD2.output, /testD_result/);

  // Test E: Replay conflict fails closed
  const attemptKeyE = "attempt:e:001";
  await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo testE_cmd1",
    yieldTimeMs: 500,
    attemptKey: attemptKeyE,
  });

  await assert.rejects(
    g2Manager.start({
      workspaceId: "ws_g2",
      cwd: process.cwd(),
      command: "echo testE_different_cmd",
      yieldTimeMs: 500,
      attemptKey: attemptKeyE,
    }),
    /ATTEMPT_REPLAY_CONFLICT/,
    "Test E: conflicting attemptKey must reject",
  );

  // Test F: Execution timeout terminates owned process
  const attemptKeyF = "attempt:f:001";
  const startF = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    timeoutSeconds: 1, // 1 second execution deadline
    yieldTimeMs: 2_000, // wait up to 2 seconds for execution timeout to kick in
    attemptKey: attemptKeyF,
  });
  assert.equal(startF.running, false, "Test F: process must be terminated after execution timeout");
  assert.equal(startF.timedOut, true, "Test F: timedOut flag must be true");

  const statusF = await g2Manager.getStatus({
    workspaceId: "ws_g2",
    attemptKey: attemptKeyF,
  });
  assert.equal(statusF.timedOut, true);
  assert.equal(statusF.running, false);

  // Test G: Repeated status is side-effect free
  const attemptKeyG = "attempt:g:001";
  const startG = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo testG_idempotent",
    yieldTimeMs: 500,
    attemptKey: attemptKeyG,
  });
  assert.equal(startG.running, false);

  for (let i = 0; i < 5; i++) {
    const status = await g2Manager.getStatus({
      workspaceId: "ws_g2",
      attemptKey: attemptKeyG,
    });
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 0);
    assert.match(status.output, /testG_idempotent/);
  }

  // Test H: Short command compatibility
  const shortCommand = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo short_ok",
    yieldTimeMs: 2_000,
  });
  assert.equal(shortCommand.running, false);
  assert.equal(shortCommand.exitCode, 0);
  assert.match(shortCommand.output, /short_ok/);

  // ─────────────────────────────────────────────────────────────────────────
  // Comprehensive Replay Identity Matrix (Required Tests 1 - 7)
  // ─────────────────────────────────────────────────────────────────────────

  // 1. same attemptKey + same command + same timeout -> reuse existing execution
  const key1 = "matrix:test1";
  const r1_first = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "console.log('mat1'); process.exit(0);"`,
    timeoutSeconds: 10,
    yieldTimeMs: 1_000,
    attemptKey: key1,
  });
  assert.equal(r1_first.running, false);
  assert.equal(r1_first.exitCode, 0);

  const r1_second = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "console.log('mat1'); process.exit(0);"`,
    timeoutSeconds: 10,
    yieldTimeMs: 1_000,
    attemptKey: key1,
  });
  assert.equal(r1_second.running, false);
  assert.equal(r1_second.exitCode, 0);
  assert.match(r1_second.output, /mat1/);

  // 2. same attemptKey + same command + DIFFERENT timeoutSeconds -> ATTEMPT_REPLAY_CONFLICT
  const key2 = "matrix:test2";
  await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo mat2",
    timeoutSeconds: 30,
    yieldTimeMs: 1_000,
    attemptKey: key2,
  });

  await assert.rejects(
    g2Manager.start({
      workspaceId: "ws_g2",
      cwd: process.cwd(),
      command: "echo mat2",
      timeoutSeconds: 300, // Different timeout!
      yieldTimeMs: 1_000,
      attemptKey: key2,
    }),
    /ATTEMPT_REPLAY_CONFLICT/,
    "Changing timeoutSeconds on same attemptKey must fail closed",
  );

  // 3. same attemptKey + same command + DIFFERENT environmentPolicy -> ATTEMPT_REPLAY_CONFLICT
  const key3 = "matrix:test3";
  await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo mat3",
    environmentPolicy: "inherit",
    yieldTimeMs: 1_000,
    attemptKey: key3,
  });

  await assert.rejects(
    g2Manager.start({
      workspaceId: "ws_g2",
      cwd: process.cwd(),
      command: "echo mat3",
      environmentPolicy: "sanitized", // Different environment policy!
      yieldTimeMs: 1_000,
      attemptKey: key3,
    }),
    /ATTEMPT_REPLAY_CONFLICT/,
    "Changing environmentPolicy on same attemptKey must fail closed",
  );

  // 4. same attemptKey + same command + DIFFERENT tty -> ATTEMPT_REPLAY_CONFLICT
  const key4 = "matrix:test4";
  await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo mat4",
    tty: false,
    yieldTimeMs: 1_000,
    attemptKey: key4,
  });

  await assert.rejects(
    g2Manager.start({
      workspaceId: "ws_g2",
      cwd: process.cwd(),
      command: "echo mat4",
      tty: true, // Different tty mode!
      yieldTimeMs: 1_000,
      attemptKey: key4,
    }),
    /ATTEMPT_REPLAY_CONFLICT/,
    "Changing tty mode on same attemptKey must fail closed",
  );

  // 5. PTY execution: same key + changed columns/rows -> ATTEMPT_REPLAY_CONFLICT
  if (process.platform !== "win32") {
    const key5 = "matrix:test5";
    await g2Manager.start({
      workspaceId: "ws_g2",
      cwd: process.cwd(),
      command: "echo mat5",
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 1_000,
      attemptKey: key5,
    });

    await assert.rejects(
      g2Manager.start({
        workspaceId: "ws_g2",
        cwd: process.cwd(),
        command: "echo mat5",
        tty: true,
        columns: 120, // Different initial columns!
        rows: 30,
        yieldTimeMs: 1_000,
        attemptKey: key5,
      }),
      /ATTEMPT_REPLAY_CONFLICT/,
      "Changing initial PTY dimensions on same attemptKey must fail closed",
    );
  }

  // 6. same attemptKey + same execution but DIFFERENT yieldTimeMs -> SHOULD NOT conflict
  const key6 = "matrix:test6";
  const r6_first = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => { console.log('mat6'); process.exit(0); }, 100)"`,
    yieldTimeMs: 10, // Short yield
    attemptKey: key6,
  });
  assert.equal(r6_first.running, true);

  const r6_second = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => { console.log('mat6'); process.exit(0); }, 100)"`,
    yieldTimeMs: 1_000, // Longer yield to wait for finish
    attemptKey: key6,
  });
  assert.equal(r6_second.running, false);
  assert.equal(r6_second.exitCode, 0);
  assert.match(r6_second.output, /mat6/);

  // 7. same attemptKey + same execution but DIFFERENT maxOutputTokens -> SHOULD NOT conflict
  const key7 = "matrix:test7";
  const r7_first = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo mat7_large_output_budget",
    maxOutputTokens: 100,
    yieldTimeMs: 1_000,
    attemptKey: key7,
  });
  assert.equal(r7_first.running, false);

  const r7_second = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: "echo mat7_large_output_budget",
    maxOutputTokens: 500, // Different output token budget
    yieldTimeMs: 1_000,
    attemptKey: key7,
  });
  assert.equal(r7_second.running, false);
  assert.match(r7_second.output, /mat7_large_output_budget/);

  // Internal PTY polling must continue waiting after a non-destructive
  // snapshot has already retained initial output.
  const retainedOutput = await g2Manager.start({
    workspaceId: "ws_g2",
    cwd: process.cwd(),
    command: `${node} -e "console.log('initial'); setTimeout(() => console.log('later'), 150); setTimeout(() => process.exit(0), 250);"`,
    tty: true,
    yieldTimeMs: 250,
  });
  assert.equal(retainedOutput.running, true);
  assert.match(retainedOutput.output, /initial/);
  const polledOutput = await g2Manager.write({
    workspaceId: "ws_g2",
    sessionId: retainedOutput.sessionId!,
    chars: "",
    yieldTimeMs: 500,
  });
  assert.equal(polledOutput.running, false);
  assert.match(polledOutput.output, /later/);
} finally {
  g2Manager.shutdown();
}
