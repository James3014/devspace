import assert from "node:assert/strict";
import { HarnessRuntimePool, type HarnessDriver, type HarnessRuntime } from "./local-agent-runtime-pool.js";
import { LocalAgentRuntimeRegistry } from "./local-agent-runtime-registry.js";
import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";

class FakeRuntime implements HarnessRuntime {
  readonly prompts: string[] = [];
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

  now = 10;
  await pool.reapIdle();
  assert.equal(runtimes[0]?.closed, true, "idle runtimes should be reclaimable without touching durable session ids");

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
