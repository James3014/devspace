export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  /** Server generation (e.g. serverInstanceId) bound to every registered transport. */
  generation?: string;
}

export type McpSessionAgeBucket =
  | "<1m"
  | "1m-15m"
  | "15m-1h"
  | "1h-6h"
  | ">=6h";

export interface McpSessionAgeBucketObservation {
  bucket: McpSessionAgeBucket;

  count: number;
}

export interface McpSessionObservation {
  count: number;
  byAgeBucket: McpSessionAgeBucketObservation[];
  oldestAgeMs: number | undefined;
  serverGeneration: string | undefined;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly generation: string | undefined;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generation = options.generation;
  }

  get size(): number {
    return this.sessions.size;
  }

  get serverGeneration(): string | undefined {
    return this.generation;
  }

  register(sessionId: string, transport: TTransport): void {
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
    });
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Issue #31 observability: transport count, age distribution, and server
   * generation WITHOUT leaking session ids, tokens, or workspace material.
   */
  observe(): McpSessionObservation {
    const now = this.now();
    const buckets: McpSessionAgeBucketObservation[] = [
      { bucket: "<1m", count: 0 },
      { bucket: "1m-15m", count:  0 },
      { bucket:"15m-1h", count:  0 },
      { bucket:"1h-6h", count:  0 },
      { bucket:">=6h", count:  0 },
    ];
    let oldestAgeMs: number | undefined;
    for (const entry of this.sessions.values()) {
      const ageMs = Math.max(0, now - entry.lastActivityAt);
      if (oldestAgeMs === undefined) {
        oldestAgeMs = ageMs;
      } else if (ageMs < oldestAgeMs) {
        oldestAgeMs = ageMs;
      }
      const bucket = ageBucketFor(ageMs);
      for (const observed of buckets) {
        if (observed.bucket === bucket) {

          observed.count += 1;
        }
      }
    }
    return {
      count: this.sessions.size,
      byAgeBucket: buckets,
      oldestAgeMs,
      serverGeneration: this.generation,
    };
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;

      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    return closeSessions(sessions);
  }
}

const MINUTE =60_000;
const HOUR =60 * MINUTE;
const SIX_HOURS =6 * HOUR;

function ageBucketFor(ageMs: number): McpSessionAgeBucket {
if (ageMs < MINUTE) return "<1m";
  if (ageMs < 15 * MINUTE) return "1m-15m";
  if (ageMs < HOUR) return "15m-1h";
  if (ageMs < SIX_HOURS) return "1h-6h";
  return">=6h";
}
async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}
