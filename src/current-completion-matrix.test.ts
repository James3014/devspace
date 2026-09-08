import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ControlPlaneOwnershipError, initializeControlPlaneOwnershipDatabase } from "./control-plane-ownership.js";
import { getCompletionMatrixRow, upsertCompletionMatrixRow } from "./current-completion-matrix.js";

test("matrix restart preserves opaque revision and rejects stale CAS", () => {
  const sqlite = new Database(":memory:");
  initializeControlPlaneOwnershipDatabase(sqlite);
  const first = upsertCompletionMatrixRow(sqlite, { goal: "g", layer: "Runtime", source: "receipt", revision: "z-revision", status: "READY", freshness: "fresh", gap: "" }, 0);
  assert.equal(first.revision, "z-revision");
  const reopened = getCompletionMatrixRow(sqlite, "g", "Runtime");
  assert.equal(reopened?.version, 1);
  assert.throws(() => upsertCompletionMatrixRow(sqlite, { goal: "g", layer: "Runtime", source: "receipt", revision: "a-revision", status: "PASS", freshness: "fresh", gap: "" }, 1, "a-revision"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "CAS_CONFLICT");
  sqlite.close();
});

test("malformed persisted matrix row fails closed", () => {
  const sqlite = new Database(":memory:");
  initializeControlPlaneOwnershipDatabase(sqlite);
  sqlite.prepare("insert into control_plane_completion_matrix (goal,layer,source,revision,status,freshness,gap,version,updated_at) values (?,?,?,?,?,?,?,?,?)").run("g", "Runtime", "receipt", "rev", "READY", "fresh", null, 0, new Date().toISOString());
  assert.throws(() => getCompletionMatrixRow(sqlite, "g", "Runtime"), (error: unknown) => error instanceof ControlPlaneOwnershipError && error.code === "MALFORMED");
  sqlite.close();
});
