/**
 * Issue #33 regression tests: conversation-scoped checkout collision detection.
 * These tests are written FIRST and designed to FAIL on the old behavior
 * (no conversation isolation module) and PASS only after fix is implemented.
 *
 * Harness: node:test
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  detectPhysicalRootCollision,
  checkCrossSessionCapacity,
  enforceWriteScopeFencing,
  CONVERSATION_COLLISION_DETECTED,
  AGENT_SLOT_EXHAUSTED,
  PROVIDER_RATE_LIMITED,
  MUTATION_OWNERSHIP_BYPASS_BLOCKED,
} from "./conversation-isolation.js";

void test("Issue #33: detectPhysicalRootCollision — FAILS on old behavior", async (t: TestContext) => {
  // OLD: module doesn't exist → import error
  // NEW: returns { collision: true, reason: CONVERSATION_COLLISION_DETECTED }
  const result = detectPhysicalRootCollision({
    conversationId: "conv_A",
    stateDir: "/shared/checkout_root",
    existingCheckouts: [{ conversationId: "conv_B", stateDir: "/shared/checkout_root" }],
  });
  assert.equal(result.collision, true);
  assert.equal(result.reason, CONVERSATION_COLLISION_DETECTED);
});

void test("Issue #33: detectPhysicalRootCollision — allows conversation-scoped reuse", async () => {
  const result = detectPhysicalRootCollision({
    conversationId: "conv_A",
    stateDir: "/shared/checkout_root",
    existingCheckouts: [{ conversationId: "conv_A", stateDir: "/shared/checkout_root" }],
  });
  assert.equal(result.collision, false);
  assert.equal(result.reason, undefined);
});

void test("Issue #33: detectPhysicalRootCollision — different paths same conversation OK", async () => {
  const result = detectPhysicalRootCollision({
    conversationId: "conv_A",
    stateDir: "/different/path",
    existingCheckouts: [{ conversationId: "conv_A", stateDir: "/shared/checkout_root" }],
  });
  assert.equal(result.collision, false);
});

void test("Issue #33: checkCrossSessionCapacity — local slot exhaustion distinguishable", async () => {
  const result = checkCrossSessionCapacity({
    activeLocalAgents: 10,
    maxAgentSlots: 10,
    providerQuotaRemaining: 100,
  });
  assert.equal(result.isLocalExhaustion, true);
  assert.equal(result.reason, AGENT_SLOT_EXHAUSTED);
  assert.equal(result.isRateLimited, false);
});

void test("Issue #33: checkCrossSessionCapacity — provider rate limit distinguishable", async () => {
  const result = checkCrossSessionCapacity({
    activeLocalAgents: 5,
    maxAgentSlots: 10,
    providerQuotaRemaining: 0,
  });
  assert.equal(result.isLocalExhaustion, false);
  assert.equal(result.reason, PROVIDER_RATE_LIMITED);
  assert.equal(result.isRateLimited, true);
});

void test("Issue #33: enforceWriteScopeFencing — blocks bypass via different path", async () => {
  const result = enforceWriteScopeFencing({
    conversationId: "conv_A",
    targetPath: "/other/physical/checkout",
    assignedCheckout: "/shared/checkout_root",
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, MUTATION_OWNERSHIP_BYPASS_BLOCKED);
});

void test("Issue #33: enforceWriteScopeFencing — same checkout allowed", async () => {
  const result = enforceWriteScopeFencing({
    conversationId: "conv_A",
    targetPath: "/shared/checkout_root",
    assignedCheckout: "/shared/checkout_root",
  });
  assert.equal(result.blocked, false);
  assert.equal(result.reason, undefined);
});
