import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController, registerCutoverHttpRoutes } from "./mcp-cutover.js";

test("cutover HTTP lifecycle is durable, exact-bound, and secret-free", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-"));
  const routes = new Map<string, Function>();
  const app = {
    get(path: string, ...handlers: Function[]) { routes.set(`GET ${path}`, handlers.at(-1)!); },
    post(path: string, ...handlers: Function[]) { routes.set(`POST ${path}`, handlers.at(-1)!); },
  };
  const old = new McpCutoverController(
    new CutoverStateStore(stateDir, { newId: () => "cutover-http" }),
    {
      serverInstanceId: "old-server",
      sourceCommit: "old-source",
      buildId: "old-build",
      capabilityManifestSha256: "cap",
    },
  );
  let activeSessions = 3;
  registerCutoverHttpRoutes(app, {
    controller: old,
    authenticate: (_req, _res, next) => next(),
    transportEvidence: () => ({ activeSessions, oldestAgeMs: 12_000 }),
    reconcileDurableState: async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    }),
  });
  try {
    const start = await invoke(routes.get("POST /api/cutover/start")!, {
      expectedSourceCommit: "new-source",
      expectedBuildId: "new-build",
    });
    assert.equal(start.statusCode, 201);
    assert.equal(start.body.cutover.cutoverId, "cutover-http");

    const statusBody = (await invoke(routes.get("GET /api/cutover/status")!)).body;
    assert.equal(statusBody.transportEvidence.oldestAgeMs, 12_000);
    assert.equal(statusBody.reconciliationRequired, true);
    assert.equal(statusBody.comparison.serverInstanceChanged, false);
    const serialized = JSON.stringify(statusBody).toLowerCase();
    assert.equal(serialized.includes("mcp-session-id"), false);
    assert.equal(serialized.includes("token"), false);

    activeSessions = 1;
    const drain = await invoke(routes.get("POST /api/cutover/drain")!, { cutoverId: "cutover-http" });
    assert.equal(drain.body.cutover.drainEvidence.activeSessions, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cutover HTTP replacement recovery is identity-bound and caller supplies no drain evidence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-recovery-"));
  const store = new CutoverStateStore(stateDir, { newId: () => "cutover-http-recovery" });
  new McpCutoverController(store, {
    serverInstanceId: "old-server",
    sourceCommit: "old-source",
    buildId: "old-build",
    capabilityManifestSha256: "cap",
  }).begin({ sourceCommit: "new-source", buildId: "new-build", capabilityManifestSha256: "cap" });

  const routes = new Map<string, Function>();
  const app = {
    get(path: string, ...handlers: Function[]) { routes.set(`GET ${path}`, handlers.at(-1)!); },
    post(path: string, ...handlers: Function[]) { routes.set(`POST ${path}`, handlers.at(-1)!); },
  };
  const replacement = new McpCutoverController(
    new CutoverStateStore(stateDir),
    {
      serverInstanceId: "new-server",
      sourceCommit: "new-source",
      buildId: "new-build",
      capabilityManifestSha256: "cap",
    },
  );
  registerCutoverHttpRoutes(app, {
    controller: replacement,
    authenticate: (_req, _res, next) => next(),
    transportEvidence: () => ({ activeSessions: 2, oldestAgeMs: 500 }),
    reconcileDurableState: async () => ({
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
    }),
  });
  try {
    const recovered = await invoke(
      routes.get("POST /api/cutover/recover-drain")!,
      { cutoverId: "cutover-http-recovery", activeSessions: 999, oldestAgeMs: 999 },
    );
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.body.cutover.phase, "recovered");
    assert.deepEqual(recovered.body.cutover.recoveryEvidence.transportEvidence, {
      activeSessions: 2,
      oldestAgeMs: 500,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

async function invoke(handler: Function, body?: unknown): Promise<{ statusCode: number; body: any }> {
  const response = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  await handler({ body }, response, () => {});
  return response;
}
