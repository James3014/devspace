import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import type { OrchestrationOutcome } from "./cutover-orchestration.js";
import type { SelfRestartActuator } from "./cutover-restart.js";
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

test("restart route gates on attestation and probe and schedules exactly once; advance route reports outcomes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-restart-"));
  try {
    const routes = new Map<string, Function>();
    const app = {
      get(path: string, ...handlers: Function[]) { routes.set(`GET ${path}`, handlers.at(-1)!); },
      post(path: string, ...handlers: Function[]) { routes.set(`POST ${path}`, handlers.at(-1)!); },
    };
    const old = new McpCutoverController(
      new CutoverStateStore(stateDir, { newId: () => "cutover-restart-http" }),
      {
        serverInstanceId: "old-server",
        sourceCommit: "old-source",
        buildId: "old-build",
        capabilityManifestSha256: "cap",
      },
    );
    const actuator: SelfRestartActuator & { calls: number } = {
      calls: 0,
      actuator: "launchd-self",
      serviceLabel: "com.example.devspace",
      launchdTarget: "gui/501/com.example.devspace",
      schedule: () => {
        actuator.calls += 1;
        return {
          scheduled: true,
          actuator: "launchd-self",
          serviceLabel: "com.example.devspace",
          launchdTarget: "gui/501/com.example.devspace",
        };
      },
    };
    let probeBuildReady = true;
    let advanceOutcome: OrchestrationOutcome = {
      outcome: "restart_already_scheduled",
      reason: "already scheduled durably",
      scheduledFor: "com.example.devspace",
    };
    registerCutoverHttpRoutes(app, {
      controller: old,
      authenticate: (_req, _res, next) => next(),
      transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
      reconcileDurableState: async () => ({
        workspaceQueryable: true,
        agentQueryable: true,
        agentReconciled: true,
      }),
      restartSelf: actuator,
      probeBuildReady: (expected) => ({
        buildReady: probeBuildReady,
        verifiedBy: "build-identity-file",
        verifiedAt: new Date().toISOString(),
        expectedSourceCommit: expected.sourceCommit,
        expectedBuildId: expected.buildId,
        actualSourceCommit: expected.sourceCommit,
        actualBuildId: expected.buildId,
        detail: probeBuildReady ? "matches" : "mismatch",
      }),
      advance: async () => advanceOutcome,
    });

    await invoke(routes.get("POST /api/cutover/start")!, {
      expectedSourceCommit: "new-source",
      expectedBuildId: "new-build",
    });
    await invoke(routes.get("POST /api/cutover/drain")!, { cutoverId: "cutover-restart-http" });

    const ungated = await invoke(routes.get("POST /api/cutover/restart")!, {
      cutoverId: "cutover-restart-http",
    });
    assert.equal(ungated.statusCode, 409);
    assert.equal(ungated.body.error.code, "CUTOVER_BUILD_NOT_READY");

    const malformed = await invoke(routes.get("POST /api/cutover/restart")!, {
      cutoverId: "cutover-restart-http",
      buildReady: { verifiedBy: "op", verifiedAt: "not-a-date" },
    });
    assert.equal(malformed.statusCode, 409);

    probeBuildReady = false;
    const probeBlocked = await invoke(routes.get("POST /api/cutover/restart")!, {
      cutoverId: "cutover-restart-http",
      buildReady: { verifiedBy: "op", verifiedAt: new Date().toISOString() },
    });
    assert.equal(probeBlocked.statusCode, 409);
    assert.equal(probeBlocked.body.error.code, "CUTOVER_BUILD_NOT_READY");
    assert.equal(actuator.calls, 0);

    probeBuildReady = true;
    const ok = await invoke(routes.get("POST /api/cutover/restart")!, {
      cutoverId: "cutover-restart-http",
      buildReady: { verifiedBy: "op", verifiedAt: new Date().toISOString() },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.restart.scheduled, true);
    assert.equal(ok.body.restart.alreadyRequested, false);
    assert.equal(actuator.calls, 1);

    const duplicate = await invoke(routes.get("POST /api/cutover/restart")!, {
      cutoverId: "cutover-restart-http",
      buildReady: { verifiedBy: "op", verifiedAt: new Date().toISOString() },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.restart.alreadyRequested, true);
    assert.equal(duplicate.body.restart.scheduled, false);
    assert.equal(actuator.calls, 1);

    advanceOutcome = {
      outcome: "blocked",
      code: "CUTOVER_RECONCILIATION_REQUIRED",
      reason: "no durable drain evidence",
    };
    const blocked = await invoke(routes.get("POST /api/cutover/advance")!, {});
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.error.code, "CUTOVER_RECONCILIATION_REQUIRED");

    advanceOutcome = {
      outcome: "restart_scheduled",
      reason: "scheduled",
      scheduledFor: "com.example.devspace",
    };
    const advanced = await invoke(routes.get("POST /api/cutover/advance")!, {});
    assert.equal(advanced.statusCode, 200);
    assert.equal(advanced.body.outcome.outcome, "restart_scheduled");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advance and restart routes fail closed when their dependencies are unavailable", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-unavailable-"));
  try {
    const routes = new Map<string, Function>();
    const app = {
      get(path: string, ...handlers: Function[]) { routes.set(`GET ${path}`, handlers.at(-1)!); },
      post(path: string, ...handlers: Function[]) { routes.set(`POST ${path}`, handlers.at(-1)!); },
    };
    const controller = new McpCutoverController(
      new CutoverStateStore(stateDir, { newId: () => "cutover-unavailable" }),
      {
        serverInstanceId: "old-server",
        sourceCommit: "old-source",
        buildId: "old-build",
      },
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

    await invoke(routes.get("POST /api/cutover/start")!, {
      expectedSourceCommit: "new-source",
      expectedBuildId: "new-build",
    });
    await invoke(routes.get("POST /api/cutover/drain")!, { cutoverId: "cutover-unavailable" });

    const ungated = await invoke(routes.get("POST /api/cutover/restart")!, {
      cutoverId: "cutover-unavailable",
      buildReady: { verifiedBy: "op", verifiedAt: new Date().toISOString() },
    });
    assert.equal(ungated.statusCode, 409);
    assert.match(ungated.body.error.message, /unavailable in this environment/);

    const advance = await invoke(routes.get("POST /api/cutover/advance")!, {});
    assert.equal(advance.statusCode, 409);
    assert.match(advance.body.error.message, /unavailable in this environment/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
