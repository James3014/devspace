import type { SessionGenerationSnapshot } from "./deployment-convergence.js";
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
  snapshot?: SessionGenerationSnapshot;
  server?: any;
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

  register(
    sessionId: string,
    transport: TTransport,
    metadata?: { snapshot?: SessionGenerationSnapshot; server?: any },
  ): void {
    const evicted: Array<{ sessionId: string; transport: TTransport }> =
      this.maxSessions !== undefined ? this.evictIdleToLimit() : [];
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
      inFlight: 0,
      pendingClose: false,
      snapshot: metadata?.snapshot,
      server: metadata?.server,
    });
    void closeSessions(evicted);
  }


  getSnapshot(sessionId: string): SessionGenerationSnapshot | undefined {
    return this.sessions.get(sessionId)?.snapshot;
  }

  setSnapshot(sessionId: string, snapshot: SessionGenerationSnapshot): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.snapshot = snapshot;
  }

  /** Record the exact generation an active session acknowledged via tools/list. */
  acknowledgeToolsList(sessionId: string, snapshot: SessionGenerationSnapshot): boolean {
    const entry = this.sessions.get(sessionId);
    const current = entry?.snapshot;
    if (!current) return false;
    if (
      current.serverInstanceId !== snapshot.serverInstanceId ||
      current.sourceCommit !== snapshot.sourceCommit ||
      current.buildId !== snapshot.buildId ||
      current.freshness !== snapshot.freshness
    ) return false;
    entry.snapshot = {
      ...current,
      capabilityManifestSha256: snapshot.capabilityManifestSha256,
      catalogGeneration: snapshot.catalogGeneration,
    };
    return true;
  }

  getServer(sessionId: string): any | undefined {
    return this.sessions.get(sessionId)?.server;
  }

  setServer(sessionId: string, server: any): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.server = server;
  }

  getAllServers(): any[] {
    const servers: any[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.server) servers.push(entry.server);
    }
    return servers;
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
