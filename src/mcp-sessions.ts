import type { SessionGenerationSnapshot } from "./deployment-convergence.js";
export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

export type McpSessionDisposalReason = "capacity_eviction" | "idle_timeout" | "server_shutdown";

export type McpSessionRegistrationResult =
  | { accepted: true; evicted: number }
  | { accepted: false; reason: "capacity_exhausted" | "duplicate_session" };

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
  inFlight: number;
  pendingClose: boolean;
  snapshot?: SessionGenerationSnapshot;
  server?: any;
}

export interface McpSessionRegistryOptions<TTransport extends ClosableMcpTransport = ClosableMcpTransport> {
  now?: () => number;
  maxSessions?: number;
  idleTimeoutMs?: number;
  onDispose?: (sessionId: string, transport: TTransport, reason: McpSessionDisposalReason) => void;
}

export interface McpSessionMetrics {
  activeSessions: number;
  oldestAgeMs: number;
  highWaterActiveSessions: number;
  registrations: number;
  reusedRequests: number;
  idleCloses: number;
  capacityEvictions: number;
  capacityRejections: number;
  closeErrors: number;
  disposalCallbackErrors: number;
  inFlightRequestCount: number;
  sessionsWithInFlight: number;
  sessionsPendingClose: number;
  configuredMaxSessions?: number;
  configuredIdleTimeoutMs?: number;
}

export interface McpSessionInFlightStats {
  inFlightRequestCount: number;
  sessionsWithInFlight: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxSessions?: number;
  private readonly idleTimeoutMs?: number;
  private readonly onDispose?: McpSessionRegistryOptions<TTransport>["onDispose"];
  private highWaterActiveSessions = 0;
  private registrations = 0;
  private reusedRequests = 0;
  private idleCloses = 0;
  private capacityEvictions = 0;
  private capacityRejections = 0;
  private closeErrors = 0;
  private disposalCallbackErrors = 0;

  constructor(options: McpSessionRegistryOptions<TTransport> = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onDispose = options.onDispose;
  }

  get size(): number {
    return this.sessions.size;
  }

  canAcceptRegistration(): boolean {
    if (this.maxSessions === undefined || this.sessions.size < this.maxSessions) return true;
    return this.hasEligibleIdleSession(this.now());
  }

  /**
   * Advisory admission check for callers that must reject before allocating a
   * transport. A failed check is one counted capacity rejection; a later
   * register() call, if admission changed, owns any separate rejection.
   */
  admitRegistration(): boolean {
    if (this.canAcceptRegistration()) return true;
    this.capacityRejections += 1;
    return false;
  }

  register(
    sessionId: string,
    transport: TTransport,
    metadata?: { snapshot?: SessionGenerationSnapshot; server?: any },
  ): McpSessionRegistrationResult {
    if (this.sessions.has(sessionId)) {
      void this.closeUnregisteredTransport(transport);
      return { accepted: false, reason: "duplicate_session" };
    }
    const evicted: Array<{ sessionId: string; transport: TTransport }> =
      this.maxSessions !== undefined ? this.evictIdleToLimit() : [];
    if (this.maxSessions !== undefined && this.sessions.size >= this.maxSessions) {
      this.capacityRejections += 1;
      void this.closeUnregisteredTransport(transport);
      return { accepted: false, reason: "capacity_exhausted" };
    }
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
      inFlight: 0,
      pendingClose: false,
      snapshot: metadata?.snapshot,
      server: metadata?.server,
    });
    this.registrations += 1;
    this.capacityEvictions += evicted.length;
    this.highWaterActiveSessions = Math.max(this.highWaterActiveSessions, this.sessions.size);
    void this.closeAndRecord(evicted);
    return { accepted: true, evicted: evicted.length };
  }

  async closeUnregisteredTransport(transport: TTransport): Promise<{ error?: unknown }> {
    try {
      await transport.close();
      return {};
    } catch (error) {
      this.closeErrors += 1;
      return { error };
    }
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
    if (!entry || entry.pendingClose) return false;
    const current = entry?.snapshot;
    if (!current) {
      entry.snapshot = snapshot;
      return true;
    }
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
    if (this.idleTimeoutMs === undefined) return evicted;
    const cutoff = this.now() - this.idleTimeoutMs;
    while (this.sessions.size >= this.maxSessions!) {
      let oldestIdleId: string | undefined;
      let oldestIdleActivity = Number.POSITIVE_INFINITY;
      for (const [sessionId, entry] of this.sessions) {
        if (entry.inFlight > 0 || entry.pendingClose) continue;
        if (entry.lastActivityAt > cutoff) continue;
        if (entry.lastActivityAt < oldestIdleActivity) {
          oldestIdleActivity = entry.lastActivityAt;
          oldestIdleId = sessionId;
        }
      }
      if (oldestIdleId === undefined) break;
      const entry = this.sessions.get(oldestIdleId)!;
      this.notifyDispose(oldestIdleId, entry.transport, "capacity_eviction");
      this.sessions.delete(oldestIdleId);
      evicted.push({ sessionId: oldestIdleId, transport: entry.transport });
    }
    return evicted;
  }

  private hasEligibleIdleSession(now: number): boolean {
    if (this.idleTimeoutMs === undefined) return false;
    const cutoff = now - this.idleTimeoutMs;
    for (const entry of this.sessions.values()) {
      if (entry.inFlight === 0 && !entry.pendingClose && entry.lastActivityAt <= cutoff) return true;
    }
    return false;
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    this.reusedRequests += 1;
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
      this.notifyDispose(sessionId, entry.transport, "server_shutdown");
      this.sessions.delete(sessionId);
      const [result] = await this.closeAndRecord([{ sessionId, transport: entry.transport }]);
      return result;
    }
    return undefined;
  }

  remove(sessionId: string, expectedTransport?: TTransport): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || (expectedTransport !== undefined && entry.transport !== expectedTransport)) return false;
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
    let sessionsPendingClose = 0;
    for (const entry of this.sessions.values()) {
      oldestAgeMs = Math.max(oldestAgeMs, Math.max(0, now - entry.lastActivityAt));
      if (entry.pendingClose) sessionsPendingClose += 1;
    }
    const inFlight = this.inFlightStats();
    return {
      activeSessions: this.sessions.size,
      oldestAgeMs,
      highWaterActiveSessions: this.highWaterActiveSessions,
      registrations: this.registrations,
      reusedRequests: this.reusedRequests,
      idleCloses: this.idleCloses,
      capacityEvictions: this.capacityEvictions,
      capacityRejections: this.capacityRejections,
      closeErrors: this.closeErrors,
      disposalCallbackErrors: this.disposalCallbackErrors,
      inFlightRequestCount: inFlight.inFlightRequestCount,
      sessionsWithInFlight: inFlight.sessionsWithInFlight,
      sessionsPendingClose,
      ...(this.maxSessions === undefined ? {} : { configuredMaxSessions: this.maxSessions }),
      ...(this.idleTimeoutMs === undefined ? {} : { configuredIdleTimeoutMs: this.idleTimeoutMs }),
    };
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;
      if (entry.inFlight > 0) continue;
      if (entry.pendingClose) continue;

      this.notifyDispose(sessionId, entry.transport, "idle_timeout");
      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    this.idleCloses += idleSessions.length;
    return this.closeAndRecord(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions: Array<{ sessionId: string; transport: TTransport }> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.inFlight > 0) {
        entry.pendingClose = true;
        continue;
      }
      this.notifyDispose(sessionId, entry.transport, "server_shutdown");
      this.sessions.delete(sessionId);
      sessions.push({ sessionId, transport: entry.transport });
    }
    return this.closeAndRecord(sessions);
  }

  private async closeAndRecord(
    sessions: Array<{ sessionId: string; transport: TTransport }>,
  ): Promise<McpSessionCloseResult[]> {
    const results = await closeSessions(sessions);
    this.closeErrors += results.filter((result) => result.error !== undefined).length;
    return results;
  }

  private notifyDispose(
    sessionId: string,
    transport: TTransport,
    reason: McpSessionDisposalReason,
  ): void {
    try {
      this.onDispose?.(sessionId, transport, reason);
    } catch {
      this.disposalCallbackErrors += 1;
    }
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
