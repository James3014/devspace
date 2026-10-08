import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController, registerCutoverHttpRoutes } from "./mcp-cutover.js";

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-readonly-"));
  const handlers = new Map<string, Function[]>();
  const app = {
    get(path: string, ...fns: Function[]) { handlers.set(`GET ${path}`, fns); },
    post(path: string, ...fns: Function[]) { handlers.set(`POST ${path}`, fns); },
  };
  const controller = new McpCutoverController(
    new CutoverStateStore(stateDir, { newId: () => "readonly-cutover" }),
    {
      serverInstanceId: "source-server",
      sourceCommit: "source-commit",
      buildId: "source-build",
    },
  );
  let activeSessions = 2;
  const authenticate = (_req: unknown, _res: unknown, next: () => void) => next();
  registerCutoverHttpRoutes(app, {
    controller,
    authenticate,
    transportEvidence: () => ({ activeSessions, oldestAgeMs: 12_000 }),
    reconcileDurableState: async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    }),
  });
  const invokeStatus = () => {
    const middleware = handlers.get("GET /api/cutover/status");
    assert.ok(middleware);
    assert.equal(middleware.length, 2, "status must retain authentication");
    let authObserved = false;
    middleware[0]({}, {}, () => { authObserved = true; });
    assert.ok(authObserved);
    let body: unknown;
    middleware[1]({}, { json(value: unknown) { body = value; } }, () => {});
    assert.ok(body);
    return body as Record<string, unknown>;
  };
  return {
    handlers,
    controller,
    invokeStatus,
    setActiveSessions(value: number) { activeSessions = value; },
    close() { rmSync(stateDir, { recursive: true, force: true }); },
  };
}

test("legacy cutover HTTP is read-only and cannot grant release authority", () => {
  const f = fixture();
  try {
    assert.deepEqual([...f.handlers.keys()], ["GET /api/cutover/status"]);
    const status = f.invokeStatus();
    assert.equal(status.reconciliationRequired, false);
    assert.equal((status.transportEvidence as { activeSessions: number }).activeSessions, 2);
    assert.equal(f.controller.record(), undefined, "HTTP status cannot create a cutover");
    const response = JSON.stringify(status).toLowerCase();
    assert.equal(response.includes("token"), false);
    assert.equal(response.includes("mcp-session-id"), false);
  } finally {
    f.close();
  }
});

test("HTTP status still reports the durable cutover/reconciliation state", () => {
  const f = fixture();
  try {
    f.controller.begin({ sourceCommit: "approved-source", buildId: "approved-build" });
    f.setActiveSessions(1);
    const status = f.invokeStatus();
    assert.equal(status.reconciliationRequired, true);
    assert.equal((status.cutover as { cutoverId: string }).cutoverId, "readonly-cutover");
    assert.equal((status.transportEvidence as { activeSessions: number }).activeSessions, 1);
    assert.deepEqual([...f.handlers.keys()], ["GET /api/cutover/status"]);
  } finally {
    f.close();
  }
});
