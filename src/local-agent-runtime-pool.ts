import type { LocalAgentRunInput, LocalAgentRunResult } from "./local-agent-runtime.js";

const DEFAULT_RUNTIME_IDLE_MS = 5 * 60 * 1_000;
const DEFAULT_REAP_INTERVAL_MS = 30 * 1_000;

export interface HarnessRuntime {
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
  isUsable(): boolean;
  reapIdleSessions?(now: number): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessDriver {
  readonly provider: string;
  runtimeKey(input: LocalAgentRunInput): string;
  createRuntime(input: LocalAgentRunInput): Promise<HarnessRuntime>;
}

type RuntimeSlot =
  | {
      status: "starting";
      promise: Promise<HarnessRuntime>;
    }
  | {
      status: "ready";
      runtime: HarnessRuntime;
      activeRuns: number;
      lastUsedAt: number;
      maintenance?: Promise<void>;
    };

interface HarnessRuntimePoolOptions {
  idleMs?: number;
  reapIntervalMs?: number;
  now?: () => number;
}

/**
 * Caches live harness resources; it never owns durable provider session state.
 * A runtime may disappear after idling or failure and callers must be able to
 * resume from the provider session id kept outside this pool.
 */
export class HarnessRuntimePool {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly reaper?: NodeJS.Timeout;
  private closing = false;

  constructor(options: HarnessRuntimePoolOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_RUNTIME_IDLE_MS;
    this.now = options.now ?? Date.now;
    const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    if (reapIntervalMs > 0) {
      this.reaper = setInterval(() => {
        void this.reapIdle().catch(() => undefined);
      }, reapIntervalMs);
      this.reaper.unref();
    }
  }

  async run(
    driver: HarnessDriver,
    input: LocalAgentRunInput,
  ): Promise<LocalAgentRunResult> {
    if (this.closing) throw new Error("Harness runtime pool is shutting down.");
    const key = `${driver.provider}\0${driver.runtimeKey(input)}`;
    const slot = await this.acquireForRun(key, driver, input);
    try {
      return await slot.runtime.run(input);
    } finally {
      slot.activeRuns -= 1;
      slot.lastUsedAt = this.now();
      if (slot.activeRuns === 0 && !slot.runtime.isUsable()) {
        if (this.slots.get(key) === slot) this.slots.delete(key);
        await slot.runtime.close().catch(() => undefined);
      }
    }
  }

  async reapIdle(now = this.now()): Promise<void> {
    const maintenance: Promise<void>[] = [];
    for (const [key, slot] of this.slots) {
      if (slot.status !== "ready" || slot.activeRuns > 0 || slot.maintenance) continue;
      const task = this.maintainSlot(key, slot, now);
      slot.maintenance = task;
      maintenance.push((async () => {
        try {
          await task;
        } finally {
          if (slot.maintenance === task) slot.maintenance = undefined;
        }
      })());
    }
    await Promise.allSettled(maintenance);
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.reaper) clearInterval(this.reaper);
    const slots = Array.from(this.slots.values());
    this.slots.clear();

    await Promise.allSettled(slots.map(async (slot) => {
      const runtime = slot.status === "ready" ? slot.runtime : await slot.promise;
      if (slot.status === "ready") await slot.maintenance?.catch(() => undefined);
      await runtime.close();
    }));
  }

  private async acquireForRun(
    key: string,
    driver: HarnessDriver,
    input: LocalAgentRunInput,
  ): Promise<Extract<RuntimeSlot, { status: "ready" }>> {
    for (;;) {
      if (this.closing) throw new Error("Harness runtime pool is shutting down.");
      const existing = this.slots.get(key);
      if (existing?.status === "ready") {
        if (existing.maintenance) {
          await existing.maintenance.catch(() => undefined);
          continue;
        }
        if (existing.runtime.isUsable()) {
          existing.activeRuns += 1;
          return existing;
        }
        this.slots.delete(key);
        await existing.runtime.close().catch(() => undefined);
        continue;
      }
      if (existing?.status === "starting") {
        await existing.promise;
        continue;
      }

      const starting: RuntimeSlot = {
        status: "starting",
        promise: driver.createRuntime(input),
      };
      this.slots.set(key, starting);
      try {
        const runtime = await starting.promise;
        if (this.closing) throw new Error("Harness runtime pool is shutting down.");
        if (this.slots.get(key) !== starting) {
          await runtime.close();
          continue;
        }
        const ready: Extract<RuntimeSlot, { status: "ready" }> = {
          status: "ready",
          runtime,
          activeRuns: 1,
          lastUsedAt: this.now(),
        };
        this.slots.set(key, ready);
        return ready;
      } catch (error) {
        if (this.slots.get(key) === starting) this.slots.delete(key);
        throw error;
      }
    }
  }

  private async maintainSlot(
    key: string,
    slot: Extract<RuntimeSlot, { status: "ready" }>,
    now: number,
  ): Promise<void> {
    await slot.runtime.reapIdleSessions?.(now).catch(() => undefined);
    if (this.slots.get(key) !== slot || slot.activeRuns > 0) return;
    if (now - slot.lastUsedAt < this.idleMs) return;
    this.slots.delete(key);
    await slot.runtime.close();
  }
}
