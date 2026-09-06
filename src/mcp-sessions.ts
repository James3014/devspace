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
  inFlight: number;
  pendingClose: boolean;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
}

export interface McpSessionMetrics {
  activeSessions: number;
  oldestAgeMs: number;
}

export interface McpSessionInFlightStats {
  inFlightRequestCount: number;
  sessionsWithInFlight: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxSessions?: number;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions;
  }

  get size(): number {
    return this.sessions.size;
  }

  register(sessionId: string, transport: TTransport): void {
    const evicted: Array<{ sessionId: string; transport: TTransport }> =
      this.maxSessions !== undefined ? this.evictIdleToLimit() : [];
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
      inFlight: 0,
      pendingClose: false,
    });
    void closeSessions(evicted);
  }

  private evictIdleToLimit(): Array<{ sessionId: string; transport: TTransport }> {
    const evicted: Array<{ sessionId: string; transport: TTransport }> = [];
    while (this.sessions.size >= this.maxSessions!) {
      let oldestIdleId: string | undefined;
      let oldestIdleActivity = Number.POSITIVE_INFINITY;
      for (const [sessionId, entry] of this.sessions) {
        if (entry.inFlight > 0 || entry.pendingClose) continue;
        if (entry.lastActivityAt < oldestIdleActivity) {
          oldestIdleActivity = entry.lastActivityAt;
          oldestIdleId = sessionId;
        }
      }
      if (oldestIdleId === undefined) break;
      const entry = this.sessions.get(oldestIdleId)!;
      this.sessions.delete(oldestIdleId);
      evicted.push({ sessionId: oldestIdleId, transport: entry.transport });
    }
    return evicted;
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  beginRequest(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    entry.inFlight += 1;
    entry.lastActivityAt = this.now();
    return true;
  }

  async endRequest(
    sessionId: string,
  ): Promise<McpSessionCloseResult | undefined> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    if (entry.inFlight > 0) entry.inFlight -= 1;
    entry.lastActivityAt = this.now();

    if (entry.pendingClose && entry.inFlight === 0) {
      this.sessions.delete(sessionId);
      return closeSession(sessionId, entry.transport);
    }
    return undefined;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  inFlightStats(): McpSessionInFlightStats {
    let inFlightRequestCount = 0;
    let sessionsWithInFlight = 0;
    for (const entry of this.sessions.values()) {
      if (entry.inFlight > 0) {
        inFlightRequestCount += entry.inFlight;
        sessionsWithInFlight += 1;
      }
    }
    return { inFlightRequestCount, sessionsWithInFlight };
  }

  /** Aggregate-only transport evidence. Never returns session identifiers. */
  metrics(): McpSessionMetrics {
    const now = this.now();
    let oldestAgeMs = 0;
    for (const entry of this.sessions.values()) {
      oldestAgeMs = Math.max(oldestAgeMs, Math.max(0, now - entry.lastActivityAt));
    }
    return { activeSessions: this.sessions.size, oldestAgeMs };
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;
      if (entry.inFlight > 0) continue;
      if (entry.pendingClose) continue;

      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions: Array<{ sessionId: string; transport: TTransport }> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight > 0) {
        entry.pendingClose = true;
        continue;
      }
      this.sessions.delete(sessionId);
      sessions.push({ sessionId, transport: entry.transport });
    }
    return closeSessions(sessions);
  }
}

async function closeSession<TTransport extends ClosableMcpTransport>(
  sessionId: string,
  transport: TTransport,
): Promise<McpSessionCloseResult> {
  try {
    await transport.close();
    return { sessionId };
  } catch (error) {
    return { sessionId, error };
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(sessions.map(({ sessionId, transport }) => closeSession(sessionId, transport)));
}
