import { createOpencode } from "@opencode-ai/sdk/v2";
import {
  allocateOpencodeLoopbackPort,
  type OpencodeClientLike,
  type OpencodeServerLike,
} from "./local-agent-opencode.js";
import {
  acquireOpencodeCatalog,
  refreshOpencodeCatalog,
  type OpencodeCatalogSnapshot,
} from "./local-agent-opencode-catalog.js";

export type McpCatalogLifecycle = { client: OpencodeClientLike; server: OpencodeServerLike };
export type McpCatalogFactory = () => Promise<McpCatalogLifecycle>;

/**
 * The MCP catalog gets an isolated SDK server on a pre-allocated loopback
 * port. OpenCode 1.18.x treats --port=0 as its default 4096 rather than an OS
 * ephemeral-port request, so passing 0 would collide with worker runtimes.
 */
export async function defaultMcpOpencodeCatalogFactory(
  create: typeof createOpencode = createOpencode,
  allocatePort: () => Promise<number> = allocateOpencodeLoopbackPort,
): Promise<McpCatalogLifecycle> {
  const port = await allocatePort();
  return create({ hostname: "127.0.0.1", port, timeout: 30_000 });
}

export function createMcpOpencodeCatalogSource(
  factory: McpCatalogFactory = defaultMcpOpencodeCatalogFactory,
  options: { retryMs?: number; warmupAttempts?: number; warmupDelayMs?: number } = {},
) {
  let lifecycle: Promise<McpCatalogLifecycle> | undefined;
  let closed = false;
  let retryAt = 0;
  const retryMs = options.retryMs ?? 1_000;
  const warmupAttempts = Math.min(8, Math.max(0, Math.trunc(options.warmupAttempts ?? 8)));
  const warmupDelayMs = Math.min(1_000, Math.max(0, Math.trunc(options.warmupDelayMs ?? 250)));

  const getLifecycle = (): Promise<McpCatalogLifecycle> => {
    if (closed) return Promise.reject(new Error("OpenCode MCP catalog source is closed."));
    if (Date.now() < retryAt) return Promise.reject(new Error("OpenCode MCP catalog startup is in backoff."));
    if (lifecycle) return lifecycle;
    const pending = factory().then((created) => {
      if (closed) {
        created.server.close();
        throw new Error("OpenCode MCP catalog source closed during startup.");
      }
      retryAt = 0;
      return created;
    }).catch((error) => {
      if (lifecycle === pending) lifecycle = undefined;
      retryAt = Date.now() + retryMs;
      throw error;
    });
    lifecycle = pending;
    return pending;
  };

  return {
    async acquire(): Promise<OpencodeCatalogSnapshot> {
      if (closed) throw new Error("OpenCode MCP catalog source is closed.");
      try {
        const { client } = await getLifecycle();
        if (closed) throw new Error("OpenCode MCP catalog source is closed.");
        let snapshot = await acquireOpencodeCatalog({ client });
        // OpenCode 1.18.x can report healthy before its SDK model catalog is
        // populated. Treat only fresh+empty SDK observations as bounded startup
        // readiness, retrying the same lifecycle. A persistently empty catalog
        // stays empty and therefore continues to fail exact-model admission.
        for (
          let attempt = 0;
          snapshot.source === "sdk"
            && (snapshot.freshness ?? "unknown") === "fresh"
            && snapshot.entries.length === 0
            && attempt < warmupAttempts;
          attempt += 1
        ) {
          if (warmupDelayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, warmupDelayMs));
          }
          if (closed) throw new Error("OpenCode MCP catalog source is closed.");
          snapshot = await refreshOpencodeCatalog(client);
        }
        return snapshot;
      } catch (error) {
        if (closed) throw error;
        return acquireOpencodeCatalog();
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      const active = lifecycle;
      lifecycle = undefined;
      if (active) void active.then(({ server }) => server.close(), () => undefined);
    },
  };
}
