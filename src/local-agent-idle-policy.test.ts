import assert from "node:assert/strict";
import test from "node:test";
import { parseExecutionContract } from "./local-agent-contract.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import { resolveEffectiveExecutionIdlePolicy } from "./local-agent-idle-policy.js";

function profile(provider: LocalAgentProfile["provider"], extra: Partial<LocalAgentProfile> = {}): LocalAgentProfile {
  return {
    name: `test-${provider}`,
    description: "test",
    provider,
    filePath: "test.md",
    body: "",
    disabled: false,
    ...extra,
  };
}

test("omitted idle timeout resolves to trustworthy provider default", () => {
  assert.deepEqual(resolveEffectiveExecutionIdlePolicy(profile("codex"), undefined), {
    source: "PROFILE_DEFAULT",
    activityCapability: "TRUSTWORTHY",
    timeoutMs: 300_000,
  });
});

test("non-incremental provider default does not create a silence termination fence", () => {
  assert.deepEqual(resolveEffectiveExecutionIdlePolicy(profile("agy"), undefined), {
    source: "PROFILE_DEFAULT",
    activityCapability: "UNAVAILABLE",
  });
});

test("probe-sized caller override is rejected unless it satisfies explicit profile policy", () => {
  assert.throws(
    () => resolveEffectiveExecutionIdlePolicy(profile("codex"), {
      idleTimeoutMode: "EXPLICIT_OVERRIDE",
      idleTimeoutMs: 1,
    }),
    /below profile minimum/,
  );
});

test("valid explicit override is honored and source is machine-distinguishable", () => {
  assert.deepEqual(resolveEffectiveExecutionIdlePolicy(profile("codex"), {
    idleTimeoutMode: "EXPLICIT_OVERRIDE",
    idleTimeoutMs: 60_000,
  }), {
    source: "EXPLICIT_OVERRIDE",
    activityCapability: "TRUSTWORTHY",
    timeoutMs: 60_000,
  });
});

test("provider without trustworthy activity rejects terminating explicit idle policy", () => {
  assert.throws(
    () => resolveEffectiveExecutionIdlePolicy(profile("agy"), {
      idleTimeoutMode: "EXPLICIT_OVERRIDE",
      idleTimeoutMs: 60_000,
    }),
    /use maxExecutionMs/,
  );
});

test("raw idleTimeoutMs cannot masquerade as an ordinary optional hint", () => {
  assert.throws(
    () => parseExecutionContract({ idleTimeoutMs: 60_000 }),
    /requires idleTimeoutMode=EXPLICIT_OVERRIDE/,
  );
  assert.deepEqual(parseExecutionContract({
    idleTimeoutMode: "EXPLICIT_OVERRIDE",
    idleTimeoutMs: 60_000,
  }), {
    idleTimeoutMode: "EXPLICIT_OVERRIDE",
    idleTimeoutMs: 60_000,
  });
});

test("a continuation-style re-resolution does not inherit a prior explicit override", () => {
  const codexProfile = profile("codex");
  const firstTurn = resolveEffectiveExecutionIdlePolicy(codexProfile, {
    idleTimeoutMode: "EXPLICIT_OVERRIDE",
    idleTimeoutMs: 60_000,
  });
  const nextTurn = resolveEffectiveExecutionIdlePolicy(codexProfile, undefined);
  assert.equal(firstTurn.source, "EXPLICIT_OVERRIDE");
  assert.equal(firstTurn.timeoutMs, 60_000);
  assert.equal(nextTurn.source, "PROFILE_DEFAULT");
  assert.equal(nextTurn.timeoutMs, 300_000);
});

test("profile may raise its default and explicit override floor", () => {
  const configured = profile("codex", {
    execution_idle_timeout_ms: 600_000,
    execution_idle_min_override_ms: 120_000,
  });
  assert.equal(resolveEffectiveExecutionIdlePolicy(configured, undefined).timeoutMs, 600_000);
  assert.throws(
    () => resolveEffectiveExecutionIdlePolicy(configured, {
      idleTimeoutMode: "EXPLICIT_OVERRIDE",
      idleTimeoutMs: 60_000,
    }),
    /below profile minimum 120000ms/,
  );
});
