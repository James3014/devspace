import {
  defaultOpencodeFactory,
  type OpencodeClientLike,
  type OpencodeServerLike,
} from "./local-agent-opencode.js";
import {
  acquireOpencodeCatalog,
  type OpencodeCatalogSnapshot,
} from "./local-agent-opencode-catalog.js";

/**
 * One lifecycle-scoped, read-only OpenCode SDK catalog client for MCP.
 * The SDK server is started lazily on the first catalog request and is never
 * used for prompts or agent execution. All concurrent callers share it.
 */
export function createMcpOpencodeCatalogSource() {
  let lifecycle: Promise<{ client: OpencodeClientLike; server: OpencodeServerLike }> | undefined;
  let closed = false;

  const getLifecycle = (): Promise<{ client: OpencodeClientLike; server: OpencodeServerLike }> => {
    if (closed) return Promise.reject(new Error("OpenCode MCP catalog source is closed."));
    lifecycle ??= defaultOpencodeFactory(undefined, { agentId: "mcp-catalog", provider: "opencode", workspaceRoot: "." });
    return lifecycle;
  };

  return {
    async acquire(): Promise<OpencodeCatalogSnapshot> {
      try {
        const { client } = await getLifecycle();
        return acquireOpencodeCatalog({ client });
      } catch {
        // SDK startup is optional discovery evidence. Preserve the existing
        // bounded CLI/fallback path rather than blocking workspace opening.
        return acquireOpencodeCatalog();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const active = lifecycle;
      lifecycle = undefined;
      if (active) {
        try {
          const { server } = await active;
          server.close();
        } catch {
          // Discovery must not prevent the MCP server from shutting down.
        }
      }
    },
  };
}
