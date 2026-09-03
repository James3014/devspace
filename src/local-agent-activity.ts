/**
 * Providers report liveness at very different granularities. Agy --print mode
 * produces no trustworthy incremental events until the full JSON response
 * arrives, and ACP providers may emit no protocol updates while the model is
 * reasoning. The execution-contract supervisor treats a silent idle clock as
 * "no provider activity" and terminates the worker, so adapters must touch
 * activity on any observable provider output (protocol events and raw
 * stdout/stderr bytes). Touches are throttled because every touch persists to
 * the durable session store.
 */
export const PROVIDER_ACTIVITY_TOUCH_MIN_INTERVAL_MS = 2_000;

export interface ThrottledActivityTouch {
  /** Record one observable provider-output signal (throttled). */
  touch(): void;
}

export function createThrottledActivityTouch(
  touch: () => void,
  minIntervalMs: number = PROVIDER_ACTIVITY_TOUCH_MIN_INTERVAL_MS,
): ThrottledActivityTouch {
  let lastTouchedAtMs = Number.NEGATIVE_INFINITY;
  return {
    touch(): void {
      const nowMs = Date.now();
      if (nowMs - lastTouchedAtMs >= minIntervalMs) {
        lastTouchedAtMs = nowMs;
        touch();
      }
    },
  };
}