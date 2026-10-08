import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController, registerCutoverHttpRoutes } from "./mcp-cutover.js";

/**
 * A bearer-authenticated transport caller does not thereby own a Nexus
 * deployment authorization. This witnesses the old HTTP bypass without
 * running launchd, replacing a release pointer, or writing live runtime state.
 */
test("legacy HTTP request cannot create an unbound cutover release decision", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-399-no-legacy-release-authority-"));
  try {
    const routes = new Map<string, Function>();
    const app = {
      get(path: string, ...handlers: Function[]) { routes.set(`GET ${path}`, handlers.at(-1)!); },
      post(path: string, ...handlers: Function[]) { routes.set(`POST ${path}`, handlers.at(-1)!); },
    };
    const controller = new McpCutoverController(
      new CutoverStateStore(stateDir, { newId: () => "cutover-unauthorized" }),
      { serverInstanceId: "old-server", sourceCommit: "old-source", buildId: "old-build" },
    );
    registerCutoverHttpRoutes(app, {
      controller,
      authenticate: (_req, _res, next) => next(),
      transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
      reconcileDurableState: async () => ({
        workspaceQueryable: true,
        agentQueryable: true,
        agentReconciled: true,
      }),
    });
    const start = routes.get("POST /api/cutover/start");
    if (start) {
      let statusCode = 200;
      await start(
        { body: { expectedSourceCommit: "attacker-picked-source", expectedBuildId: "attacker-picked-build" } },
        { status(code: number) { statusCode = code; return this; }, json(_body: unknown) { return this; } },
        () => {},
      );
      assert.notEqual(statusCode, 201, "transport authentication must not authorize deployment");
    }
    assert.equal(controller.record(), undefined, "no release decision may be persisted");
    assert.ok(routes.has("GET /api/cutover/status"), "read-only observability remains available");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
