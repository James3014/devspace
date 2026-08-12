import assert from "node:assert/strict";
import { HarnessRuntimePool, type HarnessDriver, type HarnessRuntime } from "./local-agent-runtime-pool.js";
import { LocalAgentRuntimeRegistry } from "./local-agent-runtime-registry.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";

class FakeRuntime implements HarnessRuntime {
  readonly prompts: string[] = [];
  readonly reaps: number[] = [];
  closed = false;
  private sessionCount = 0;

  constructor(private readonly name: string) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    assert.equal(this.closed, false);
    this.prompts.push(input.prompt);
    const providerSessionId = input.providerSessionId ?? `${this.name}-session-${++this.sessionCount}`;
    return {
      provider: "opencode",
      providerSessionId,
      finalResponse: `${this.name}:${input.prompt}`,
      items: [],
    };
  }

  isUsable(): boolean {
    return !this.closed;
  }

  async reapIdleSessions(now: number): Promise<void> {
    this.reaps.push(now);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FailingRuntime extends FakeRuntime {
  failed = false;

  override async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (input.prompt === "fail") {
      this.failed = true;
      throw new Error("runtime transport failed");
    }
    return super.run(input);
  }

  override isUsable(): boolean {
    return !this.closed && !this.failed;
  }
}

class BlockingReapRuntime extends FakeRuntime {
  readonly reapStarted = deferred<void>();
  readonly finishReap = deferred<void>();

  override async reapIdleSessions(now: number): Promise<void> {
    this.reaps.push(now);
    this.reapStarted.resolve();
    await this.finishReap.promise;
  }
}

let now = 0;
let created = 0;
const runtimes: FakeRuntime[] = [];
const driver: HarnessDriver = {
  provider: "opencode",
  runtimeKey: () => "shared",
  async createRuntime() {
    created += 1;
    const runtime = new FakeRuntime(`runtime-${created}`);
    runtimes.push(runtime);
    return runtime;
  },
};
const pool = new HarnessRuntimePool({ idleMs: 10, reapIntervalMs: 0, now: () => now });
const registry = new LocalAgentRuntimeRegistry({ pool, opencodeDriver: driver });

try {
  const first = await registry.run("opencode", input("/tmp/a", "first"));
  const second = await registry.run("opencode", input("/tmp/b", "second", first.providerSessionId ?? undefined));

  assert.equal(created, 1, "compatible OpenCode runs should share one live runtime");
  assert.equal(first.providerSessionId, "runtime-1-session-1");
  assert.equal(second.providerSessionId, "runtime-1-session-1");
  assert.deepEqual(runtimes[0]?.prompts, ["first", "second"]);

  now = 9;
  await pool.reapIdle();
  assert.equal(runtimes[0]?.closed, false);
  assert.deepEqual(runtimes[0]?.reaps, [9]);

  now = 10;
  await pool.reapIdle();
  assert.equal(runtimes[0]?.closed, true, "idle runtimes should be reclaimable without touching durable session ids");
  assert.deepEqual(runtimes[0]?.reaps, [9, 10]);

  await registry.run("opencode", input("/tmp/a", "third", second.providerSessionId ?? undefined));
  assert.equal(created, 2, "a later run should recreate an evicted runtime");
  assert.equal(runtimes[1]?.prompts[0], "third");
} finally {
  await registry.shutdown();
}

{
  let failureCreates = 0;
  const failedRuntimes: FailingRuntime[] = [];
  const failureDriver: HarnessDriver = {
    provider: "opencode",
    runtimeKey: () => "failure-recovery",
    async createRuntime() {
      const runtime = new FailingRuntime(`failure-runtime-${++failureCreates}`);
      failedRuntimes.push(runtime);
      return runtime;
    },
  };
  const failurePool = new HarnessRuntimePool({ reapIntervalMs: 0 });

  try {
    await assert.rejects(
      failurePool.run(failureDriver, input("/tmp/a", "fail")),
      /runtime transport failed/,
    );
    assert.equal(failedRuntimes[0]?.closed, true, "an unusable failed runtime should be evicted immediately");

    const recovered = await failurePool.run(failureDriver, input("/tmp/a", "recover"));
    assert.equal(failureCreates, 2, "the next turn should create a fresh runtime after a transport failure");
    assert.equal(recovered.finalResponse, "failure-runtime-2:recover");
  } finally {
    await failurePool.shutdown();
  }
}

{
  let cursorCreated = 0;
  let copilotCreated = 0;
  const acpPool = new HarnessRuntimePool({ reapIntervalMs: 0 });
  const acpRegistry = new LocalAgentRuntimeRegistry({
    pool: acpPool,
    cursorDriver: countingDriver("cursor", () => ++cursorCreated),
    copilotDriver: countingDriver("copilot", () => ++copilotCreated),
  });
  try {
    await acpRegistry.run("cursor", input("/tmp/a", "cursor one"));
    await acpRegistry.run("cursor", input("/tmp/b", "cursor two"));
    await acpRegistry.run("copilot", input("/tmp/a", "copilot one"));

    assert.equal(cursorCreated, 1, "Cursor sessions should share one ACP runtime");
    assert.equal(copilotCreated, 1, "Copilot should use its own ACP runtime");
  } finally {
    await acpRegistry.shutdown();
  }
}

{
  let raceNow = 0;
  let raceCreates = 0;
  const raceRuntimes: FakeRuntime[] = [];
  const raceDriver: HarnessDriver = {
    provider: "opencode",
    runtimeKey: () => "reap-race",
    async createRuntime() {
      raceCreates += 1;
      const runtime = raceCreates === 1
        ? new BlockingReapRuntime("reap-runtime-1")
        : new FakeRuntime(`reap-runtime-${raceCreates}`);
      raceRuntimes.push(runtime);
      return runtime;
    },
  };
  const racePool = new HarnessRuntimePool({ idleMs: 10, reapIntervalMs: 0, now: () => raceNow });

  try {
    await racePool.run(raceDriver, input("/tmp/a", "seed"));
    const firstRuntime = raceRuntimes[0] as BlockingReapRuntime;
    raceNow = 10;
    const reaping = racePool.reapIdle();
    await firstRuntime.reapStarted.promise;

    const concurrentRun = racePool.run(raceDriver, input("/tmp/a", "during reap"));
    await immediate();
    assert.deepEqual(
      firstRuntime.prompts,
      ["seed"],
      "a provider turn must not overlap runtime/session maintenance",
    );

    firstRuntime.finishReap.resolve();
    await reaping;
    const result = await concurrentRun;

    assert.equal(firstRuntime.closed, true, "the previously idle runtime may be reclaimed after maintenance");
    assert.equal(raceCreates, 2, "a waiting turn should reacquire a fresh runtime after idle reclamation");
    assert.equal(result.finalResponse, "reap-runtime-2:during reap");
  } finally {
    await racePool.shutdown();
  }
}

function input(workspace: string, prompt: string, providerSessionId?: string): LocalAgentRunInput {
  return {
    workspace,
    prompt,
    providerSessionId,
    writeMode: "allowed",
  };
}

function countingDriver(provider: string, next: () => number): HarnessDriver {
  return {
    provider,
    runtimeKey: () => "shared",
    async createRuntime() {
      return new FakeRuntime(`${provider}-runtime-${next()}`);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
