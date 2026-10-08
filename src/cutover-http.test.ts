import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CutoverStateStore } from "./cutover-state.js";
import { McpCutoverController, registerCutoverHttpRoutes } from "./mcp-cutover.js";

test("cutover HTTP surface is authenticated read-only status only", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-readonly-"));
  try {
    const routes = new Map<string, Function[]>();
    const app = {
      get(path: string, ...handlers: Function[]) {
        routes.set(`GET ${path}`, handlers);
      },
      post(path: string, ...handlers: Function[]) {
        routes.set(`POST ${path}`, handlers);
      },
    };
    const controller = new McpCutoverController(
      new CutoverStateStore(stateDir, { newId: () => "cutover-http" }),
      {
        serverInstanceId: "server-current",
        sourceCommit: "source-current",
        buildId: "build-current",
        capabilityManifestSha256: "cap-current",
      },
    );
    let authenticateCalls = 0;
    registerCutoverHttpRoutes(app, {
      controller,
      authenticate: (_req, _res, next) => {
        authenticateCalls += 1;
        next();
      },
      transportEvidence: () => ({ activeSessions: 3, oldestAgeMs: 12_000 }),
    });

    const statusHandlers = routes.get("GET /api/cutover/status");
    assert.ok(statusHandlers);
    assert.equal(statusHandlers.length, 2);

    for (const path of [
      "/api/cutover/start",
      "/api/cutover/drain",
      "/api/cutover/restart",
      "/api/cutover/advance",
      "/api/cutover/recover",
      "/api/cutover/finish",
    ]) {
      assert.equal(
        routes.has(`POST ${path}`),
        false,
        `legacy mutation route ${path} must not be registered`,
      );
    }

    const response = {
      statusCode: 200,
      body: undefined as any,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        this.body = value;
        return this;
      },
    };
    let nextCalled = false;
    statusHandlers[0]!({}, response, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(authenticateCalls, 1);

    await statusHandlers[1]!({}, response, () => {});
    assert.equal(response.body.transportEvidence.activeSessions, 3);
    assert.equal(response.body.transportEvidence.oldestAgeMs, 12_000);
    assert.equal(response.body.reconciliationRequired, false);
    assert.equal(response.body.mode, "normal");

    const serialized = JSON.stringify(response.body).toLowerCase();
    assert.equal(serialized.includes("mcp-session-id"), false);
    assert.equal(serialized.includes("token"), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("HTTP caller cannot mint a cutover target identity", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-cutover-http-no-authority-"));
  try {
    const routes = new Map<string, Function[]>();
    const app = {
      get(path: string, ...handlers: Function[]) {
        routes.set(`GET ${path}`, handlers);
      },
      post(path: string, ...handlers: Function[]) {
        routes.set(`POST ${path}`, handlers);
      },
    };
    const controller = new McpCutoverController(
      new CutoverStateStore(stateDir, { newId: () => "cutover-never-created" }),
      {
        serverInstanceId: "server-current",
        sourceCommit: "source-current",
        buildId: "build-current",
      },
    );

    registerCutoverHttpRoutes(app, {
      controller,
      authenticate: (_req, _res, next) => next(),
      transportEvidence: () => ({ activeSessions: 0, oldestAgeMs: 0 }),
    });

    assert.equal(routes.has("POST /api/cutover/start"), false);
    assert.equal(routes.has("POST /api/cutover/restart"), false);
    assert.equal(controller.record(), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
