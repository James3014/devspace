import { createOpencode } from "@opencode-ai/sdk/v2";
import type { OpencodeClientLike, OpencodeServerLike } from "./local-agent-opencode.js";
import { acquireOpencodeCatalog, type OpencodeCatalogSnapshot } from "./local-agent-opencode-catalog.js";

export type McpCatalogLifecycle = { client: OpencodeClientLike; server: OpencodeServerLike };
export type McpCatalogFactory = () => Promise<McpCatalogLifecycle>;

/**
 * The MCP catalog gets an isolated SDK server. Port 0 lets the OS choose an
 * available localhost endpoint, so discovery cannot occupy the dispatch port.
 */
export async function defaultMcpOpencodeCatalogFactory(): Promise<McpCatalogLifecycle> {
  return createOpencode({ hostname: "127.0.0.1", port: 0, timeout: 30_000 });
}

export function createMcpOpencodeCatalogSource(factory: McpCatalogFactory = defaultMcpOpencodeCatalogFactory, options: { retryMs?: number } = {}) {
  let lifecycle: Promise<McpCatalogLifecycle> | undefined;
  let closed = false;
  let retryAt = 0;
  const retryMs = options.retryMs ?? 1_000;

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
        return acquireOpencodeCatalog({ client });
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
