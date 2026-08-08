import type { LocalAgentObserver, LocalAgentUsageSnapshot } from "./local-agent-runtime.js";
import type { WorkflowStore } from "./workflow-store.js";

const USAGE_WRITE_INTERVAL_MS = 5_000;

export function createWorkflowAgentObserver(
  store: WorkflowStore,
  runId: string,
  callIndex: number,
  intervalMs = USAGE_WRITE_INTERVAL_MS,
): LocalAgentObserver & { close(): void } {
  let lastUsageWrite = 0;
  let pendingUsage: LocalAgentUsageSnapshot | undefined;
  let timer: NodeJS.Timeout | undefined;

  const persistUsage = (usage: LocalAgentUsageSnapshot): void => {
    pendingUsage = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastUsageWrite = Date.now();
    store.updateAgentUsage(runId, callIndex, usage);
  };

  const scheduleUsage = (): void => {
    if (timer) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastUsageWrite));
    timer = setTimeout(() => {
      if (pendingUsage) persistUsage(pendingUsage);
    }, wait);
    timer.unref();
  };

  return {
    onSession(providerSessionId) {
      store.attachAgentSession(runId, callIndex, providerSessionId);
    },
    onActivity(activity) {
      store.appendAgentActivity({ runId, callIndex, ...activity });
    },
    onUsage(usage) {
      if (usage.state === "final" || Date.now() - lastUsageWrite >= intervalMs) {
        persistUsage(usage);
        return;
      }
      pendingUsage = usage;
      scheduleUsage();
    },
    close() {
      if (pendingUsage) persistUsage(pendingUsage);
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
