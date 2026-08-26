import assert from "node:assert/strict";
import {
  ACTOR_ROLES,
  BATCH_ACTIONS,
  CAUSAL_RELATIONS,
  ROUTINE_EVENT_TYPES,
  TRUE_BLOCKER_TYPES,
  authorizeBatchAction,
  evaluateAutonomousEvent,
  isActorRole,
  isBatchAction,
  isCausalRelation,
  isMergeAction,
  isRoutineEvent,
  isTrueBlocker,
  parseBatchAutonomyGrant,
  safeParseBatchAutonomyGrant,
  validateChildTaskDelegation,
  type BatchAutonomyGrant,
} from "./batch-autonomy-grant.js";

const now = 1700000000000;
const validGrantInput = {
  grantId: "grant-123",
  repository: "owner/repo",
  goal: "Fix bug #42 and update test coverage",
  mainControllerId: "controller-agent-1",
  allowedActions: ["read", "write", "edit", "command", "test", "lint", "CREATE_CHILD_TASK", "GITHUB_MERGE"],
  validityWindow: {
    validFrom: now - 1000,
    validTo: now + 3600000,
  },
  revoked: false,
};

// 1. Valid Grant Parsing
{
  const grant = parseBatchAutonomyGrant(validGrantInput);
  assert.equal(grant.grantId, "grant-123");
  assert.equal(grant.repository, "owner/repo");
  assert.equal(grant.goal, "Fix bug #42 and update test coverage");
  assert.equal(grant.mainControllerId, "controller-agent-1");
  assert.deepEqual(grant.allowedActions, [
    "read",
    "write",
    "edit",
    "command",
    "test",
    "lint",
    "CREATE_CHILD_TASK",
    "GITHUB_MERGE",
  ]);
  assert.equal(grant.validityWindow.validFrom, now - 1000);
  assert.equal(grant.validityWindow.validTo, now + 3600000);
  assert.equal(grant.revoked, false);
  assert.equal(grant.revokedAt, undefined);

  const safe = safeParseBatchAutonomyGrant(validGrantInput);
  assert.equal(safe.success, true);
  if (safe.success) {
    assert.equal(safe.data.grantId, "grant-123");
  }
}

// 2. Grant Parsing Rejections: Alias fields, unknown fields, coercion attempts
{
  // Malformed root shapes
  assert.throws(() => parseBatchAutonomyGrant(null), /Grant must be a non-null object/);
  assert.throws(() => parseBatchAutonomyGrant(undefined), /Grant must be a non-null object/);
  assert.throws(() => parseBatchAutonomyGrant([]), /Grant must be a non-null object/);
  assert.throws(() => parseBatchAutonomyGrant("not an object"), /Grant must be a non-null object/);
  assert.throws(() => parseBatchAutonomyGrant(123), /Grant must be a non-null object/);

  // Alias field 'id' instead of 'grantId'
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        id: "grant-123",
        repository: "owner/repo",
        goal: "Fix bug",
        mainControllerId: "controller-1",
        allowedActions: ["read"],
        validityWindow: { validFrom: now, validTo: now + 1000 },
        revoked: false,
      }),
    /Unknown or forbidden top-level field in grant: 'id'/,
  );

  // Alias field 'actions' instead of 'allowedActions'
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        grantId: "grant-123",
        repository: "owner/repo",
        goal: "Fix bug",
        mainControllerId: "controller-1",
        actions: ["read"],
        validityWindow: { validFrom: now, validTo: now + 1000 },
        revoked: false,
      }),
    /Unknown or forbidden top-level field in grant: 'actions'/,
  );

  // Alias field 'controllerId'
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        grantId: "grant-123",
        repository: "owner/repo",
        goal: "Fix bug",
        controllerId: "controller-1",
        allowedActions: ["read"],
        validityWindow: { validFrom: now, validTo: now + 1000 },
        revoked: false,
      }),
    /Unknown or forbidden top-level field in grant: 'controllerId'/,
  );

  // Alias field 'mainController' object
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        grantId: "grant-123",
        repository: "owner/repo",
        goal: "Fix bug",
        mainController: { id: "controller-1" },
        allowedActions: ["read"],
        validityWindow: { validFrom: now, validTo: now + 1000 },
        revoked: false,
      }),
    /Unknown or forbidden top-level field in grant: 'mainController'/,
  );

  // Top-level validFrom / validTo aliases
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        grantId: "grant-123",
        repository: "owner/repo",
        goal: "Fix bug",
        mainControllerId: "controller-1",
        allowedActions: ["read"],
        validFrom: now,
        validTo: now + 1000,
        revoked: false,
      }),
    /Unknown or forbidden top-level field in grant: 'validFrom'/,
  );

  // Unknown top-level authority fields
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        extraAuthorityField: "unauthorized",
      }),
    /Unknown or forbidden top-level field in grant: 'extraAuthorityField'/,
  );

  // Unknown validityWindow fields
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        validityWindow: { validFrom: now, validTo: now + 1000, timezone: "UTC" },
      }),
    /Unknown or forbidden field in validityWindow: 'timezone'/,
  );

  // Missing or empty grantId / repository / goal / mainControllerId
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, grantId: "" }), /grantId/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, grantId: "   " }), /grantId/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, repository: "" }), /repository/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, goal: "" }), /goal/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, mainControllerId: "" }), /mainControllerId/);

  // Malformed allowedActions
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: [] }), /allowedActions/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: "read" }), /allowedActions/);
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: ["read", "DESTROY_ALL"] }),
    /Unknown or invalid BatchAction/,
  );
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: ["spawn_child"] }),
    /Unknown or invalid BatchAction/,
  );
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: ["create_child"] }),
    /Unknown or invalid BatchAction/,
  );
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: ["run_command"] }),
    /Unknown or invalid BatchAction/,
  );
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, allowedActions: ["github_merge"] }),
    /Unknown or invalid BatchAction/,
  );

  // Boolean coercion rejection
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, revoked: "false" }), /Field 'revoked' must be boolean/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, revoked: "true" }), /Field 'revoked' must be boolean/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, revoked: 0 }), /Field 'revoked' must be boolean/);
  assert.throws(() => parseBatchAutonomyGrant({ ...validGrantInput, revoked: 1 }), /Field 'revoked' must be boolean/);

  // Numeric string timestamp coercion & Date object coercion rejection
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        validityWindow: { validFrom: "1700000000000" as any, validTo: now + 1000 },
      }),
    /Field 'validityWindow.validFrom' must be a finite number/,
  );
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        validityWindow: { validFrom: new Date(now) as any, validTo: now + 1000 },
      }),
    /Field 'validityWindow.validFrom' must be a finite number/,
  );
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        validityWindow: { validFrom: NaN, validTo: now + 1000 },
      }),
    /Field 'validityWindow.validFrom' must be a finite number/,
  );
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        validityWindow: { validFrom: now, validTo: Infinity },
      }),
    /Field 'validityWindow.validTo' must be a finite number/,
  );
  assert.throws(
    () =>
      parseBatchAutonomyGrant({
        ...validGrantInput,
        validityWindow: { validFrom: now + 1000, validTo: now },
      }),
    /validityWindow validFrom.*cannot be greater than validTo/,
  );

  // Malformed revokedAt
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, revoked: true, revokedAt: "2026-01-01" as any }),
    /Field 'revokedAt' must be a finite number/,
  );
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, revoked: true, revokedAt: null as any }),
    /Field 'revokedAt' must be a finite number/,
  );
  assert.throws(
    () => parseBatchAutonomyGrant({ ...validGrantInput, revoked: true, revokedAt: NaN }),
    /Field 'revokedAt' must be a finite number/,
  );
}

// 3. Exact Canonical Vocabularies & Alias Rejections
{
  // Roles
  assert.equal(isActorRole("main_controller"), true);
  assert.equal(isActorRole("worker"), true);
  assert.equal(isActorRole("descendant"), true);
  assert.equal(isActorRole("controller"), false); // alias role removed
  assert.equal(isActorRole("admin"), false);
  assert.equal(isActorRole(null), false);

  // Actions
  assert.equal(isBatchAction("read"), true);
  assert.equal(isBatchAction("write"), true);
  assert.equal(isBatchAction("edit"), true);
  assert.equal(isBatchAction("command"), true);
  assert.equal(isBatchAction("test"), true);
  assert.equal(isBatchAction("lint"), true);
  assert.equal(isBatchAction("git_commit"), true);
  assert.equal(isBatchAction("git_worktree"), true);
  assert.equal(isBatchAction("CREATE_CHILD_TASK"), true);
  assert.equal(isBatchAction("GITHUB_MERGE"), true);
  // Rejection of aliases and synonyms (Probe 5 check)
  assert.equal(isBatchAction("github_merge"), false);
  assert.equal(isBatchAction("spawn_child"), false);
  assert.equal(isBatchAction("create_child"), false);
  assert.equal(isBatchAction("run_command"), false);
  assert.equal(isBatchAction("DROP_TABLE"), false);

  // Merge Action Check
  assert.equal(isMergeAction("GITHUB_MERGE"), true);
  assert.equal(isMergeAction("github_merge"), false);

  // Causal Relations
  assert.equal(isCausalRelation("WITHIN_GOAL_NECESSARY"), true);
  assert.equal(isCausalRelation("WITHIN_GOAL_ROUTINE"), true);
  assert.equal(isCausalRelation("OFF_GOAL"), true);
  assert.equal(isCausalRelation("unknown_relation"), false);
}

// 4. Event Evaluation: Exact kinds vs True Blockers vs Malformed/Object/Alias Probes
{
  // Exact routine events
  for (const ev of ROUTINE_EVENT_TYPES) {
    assert.equal(isRoutineEvent(ev), true, `Expected ${ev} to be routine`);
    assert.equal(isTrueBlocker(ev), false, `Expected ${ev} not to be blocker`);
    const evalRes = evaluateAutonomousEvent(ev);
    assert.equal(evalRes.isRoutine, true);
    assert.equal(evalRes.isBlocker, false);
    assert.equal(evalRes.type, ev);
  }

  // Exact True Blockers (including production_data_mutation and unresolved_new_api_semantics)
  for (const bl of TRUE_BLOCKER_TYPES) {
    assert.equal(isTrueBlocker(bl), true, `Expected ${bl} to be blocker`);
    assert.equal(isRoutineEvent(bl), false, `Expected ${bl} not to be routine`);
    const evalRes = evaluateAutonomousEvent(bl);
    assert.equal(evalRes.isBlocker, true);
    assert.equal(evalRes.isRoutine, false);
    assert.equal(evalRes.type, bl);
  }

  // Free-form / unnormalized strings fail closed as True Blocker
  assert.equal(isTrueBlocker("ordinary bug"), true);
  assert.equal(isRoutineEvent("ordinary bug"), false);
  assert.equal(isTrueBlocker("test failure"), true);
  assert.equal(isRoutineEvent("test failure"), false);
  assert.equal(isTrueBlocker("unknown_custom_event"), true);
  assert.equal(isRoutineEvent("unknown_custom_event"), false);

  // Hidden Probe 1: Object with eventKind fails closed as True Blocker
  const probeEventKind = { eventKind: "ordinary_bug" };
  assert.equal(isTrueBlocker(probeEventKind), true);
  assert.equal(isRoutineEvent(probeEventKind), false);
  const evalProbeEventKind = evaluateAutonomousEvent(probeEventKind);
  assert.equal(evalProbeEventKind.isBlocker, true);
  assert.equal(evalProbeEventKind.isRoutine, false);
  assert.equal(evalProbeEventKind.type, "malformed_event");

  // Hidden Probe 2: Object with mystery authority/extra fields fails closed as True Blocker
  const probeMystery = { type: "ordinary_bug", mysteryAuthority: true };
  assert.equal(isTrueBlocker(probeMystery), true);
  assert.equal(isRoutineEvent(probeMystery), false);
  const evalProbeMystery = evaluateAutonomousEvent(probeMystery);
  assert.equal(evalProbeMystery.isBlocker, true);
  assert.equal(evalProbeMystery.isRoutine, false);
  assert.equal(evalProbeMystery.type, "malformed_event");

  // Object forms of routine events fail closed
  const objRoutine = { type: "ordinary_bug" };
  assert.equal(isTrueBlocker(objRoutine), true);
  assert.equal(isRoutineEvent(objRoutine), false);
  assert.equal(evaluateAutonomousEvent(objRoutine).type, "malformed_event");

  // Flags / aliases / extra fields / arrays / null / numbers / booleans fail closed
  const legacyProdFlag = { type: "ordinary_bug", touchesProductionData: true };
  assert.equal(isTrueBlocker(legacyProdFlag), true);
  assert.equal(isRoutineEvent(legacyProdFlag), false);
  assert.equal(evaluateAutonomousEvent(legacyProdFlag).type, "malformed_event");

  const legacyApiFlag = { type: "implementation_choice", hasUnresolvedApiSemantics: true };
  assert.equal(isTrueBlocker(legacyApiFlag), true);
  assert.equal(isRoutineEvent(legacyApiFlag), false);
  assert.equal(evaluateAutonomousEvent(legacyApiFlag).type, "malformed_event");

  assert.equal(isTrueBlocker(null), true);
  assert.equal(isRoutineEvent(null), false);
  assert.equal(evaluateAutonomousEvent(null).type, "malformed_event");

  assert.equal(isTrueBlocker(undefined), true);
  assert.equal(isRoutineEvent(undefined), false);

  assert.equal(isTrueBlocker(123), true);
  assert.equal(isRoutineEvent(123), false);

  assert.equal(isTrueBlocker(true), true);
  assert.equal(isRoutineEvent(true), false);

  assert.equal(isTrueBlocker(false), true);
  assert.equal(isRoutineEvent(false), false);

  assert.equal(isTrueBlocker([]), true);
  assert.equal(isRoutineEvent([]), false);

  assert.equal(isTrueBlocker(["ordinary_bug"]), true);
  assert.equal(isRoutineEvent(["ordinary_bug"]), false);
}

// 5. Probe 1 & Child Task Delegation: Explicit causalRelation, CREATE_CHILD_TASK grant check, and sub-actions
{
  const grant = parseBatchAutonomyGrant(validGrantInput);

  // Success: Main controller creates causal child task with explicit causalRelation & subset actions
  const okDelegation = validateChildTaskDelegation({
    parentGrant: grant,
    actor: { id: "controller-agent-1", role: "main_controller" },
    childGoal: "Run lint and unit tests for bug #42 fix",
    causalRelation: "WITHIN_GOAL_NECESSARY",
    childActions: ["read", "edit", "test", "lint"],
    now,
  });
  assert.equal(okDelegation.authorized, true);
  assert.ok(okDelegation.childGrant);
  assert.equal(okDelegation.childGrant?.goal, "Run lint and unit tests for bug #42 fix");
  assert.deepEqual(okDelegation.childGrant?.allowedActions, ["read", "edit", "test", "lint"]);

  // Probe 1: Off-goal child string 'rewrite unrelated billing system' with OFF_GOAL causalRelation is denied
  const offGoalDelegation = validateChildTaskDelegation({
    parentGrant: grant,
    actor: { id: "controller-agent-1", role: "main_controller" },
    childGoal: "rewrite unrelated billing system",
    causalRelation: "OFF_GOAL",
    childActions: ["read", "write"],
    now,
  });
  assert.equal(offGoalDelegation.authorized, false);
  assert.match(offGoalDelegation.reason || "", /causalRelation must be WITHIN_GOAL_NECESSARY or WITHIN_GOAL_ROUTINE/);

  // Missing causalRelation is denied
  const missingCausal = validateChildTaskDelegation({
    parentGrant: grant,
    actor: { id: "controller-agent-1", role: "main_controller" },
    childGoal: "rewrite unrelated billing system",
    childActions: ["read", "write"],
    now,
  });
  assert.equal(missingCausal.authorized, false);

  // Missing CREATE_CHILD_TASK in parent grant denies child creation
  const grantWithoutCreateChild = parseBatchAutonomyGrant({
    ...validGrantInput,
    allowedActions: ["read", "write", "test"],
  });
  const noCreateChildRes = validateChildTaskDelegation({
    parentGrant: grantWithoutCreateChild,
    actor: { id: "controller-agent-1", role: "main_controller" },
    childGoal: "Run sub-test",
    causalRelation: "WITHIN_GOAL_ROUTINE",
    childActions: ["read", "test"],
    now,
  });
  assert.equal(noCreateChildRes.authorized, false);
  assert.match(noCreateChildRes.reason || "", /does not allow CREATE_CHILD_TASK/);

  // Descendants never inherit GITHUB_MERGE
  const mergeChild = validateChildTaskDelegation({
    parentGrant: grant,
    actor: { id: "controller-agent-1", role: "main_controller" },
    childGoal: "Merge PR",
    causalRelation: "WITHIN_GOAL_NECESSARY",
    childActions: ["read", "GITHUB_MERGE"],
    now,
  });
  assert.equal(mergeChild.authorized, false);
  assert.match(mergeChild.reason || "", /Descendants never inherit GITHUB_MERGE authority/);

  // Worker cannot delegate child tasks
  const workerDelegation = validateChildTaskDelegation({
    parentGrant: grant,
    actor: { id: "worker-1", role: "worker" },
    childGoal: "Sub-task",
    causalRelation: "WITHIN_GOAL_NECESSARY",
    childActions: ["read"],
    now,
  });
  assert.equal(workerDelegation.authorized, false);
  assert.match(workerDelegation.reason || "", /Only main_controller can delegate child tasks/);
}

// 6. Probe 2 & Action Authorization: MAIN_CONTROLLER-only parent batch grant enforcement
{
  const grant = parseBatchAutonomyGrant(validGrantInput);

  // Success: Main controller authorized for routine action
  const okAction = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "edit",
    now,
  });
  assert.equal(okAction.authorized, true);

  // Probe 2: Arbitrary worker ID on parent grant is DENIED for read
  const workerReadAction = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "arbitrary-worker-id", role: "worker" },
    action: "read",
    now,
  });
  assert.equal(workerReadAction.authorized, false);
  assert.match(workerReadAction.reason || "", /restricted to main_controller/);

  // Descendant role is also DENIED
  const descendantAction = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "child-agent-1", role: "descendant" },
    action: "read",
    now,
  });
  assert.equal(descendantAction.authorized, false);

  // Controller role alias is DENIED
  const controllerAliasAction = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "controller" as any },
    action: "read",
    now,
  });
  assert.equal(controllerAliasAction.authorized, false);

  // Mismatched controller ID is DENIED
  const imposterController = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "imposter-controller", role: "main_controller" },
    action: "read",
    now,
  });
  assert.equal(imposterController.authorized, false);
  assert.match(imposterController.reason || "", /Actor ID mismatch/);

  // Repository mismatch is DENIED
  const badRepo = authorizeBatchAction({
    grant,
    repository: "different/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "read",
    now,
  });
  assert.equal(badRepo.authorized, false);

  // Goal mismatch is DENIED
  const badGoal = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Completely unrelated goal",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "read",
    now,
  });
  assert.equal(badGoal.authorized, false);

  // Action not in grant allowedActions is DENIED
  const grantNoWrite = parseBatchAutonomyGrant({
    ...validGrantInput,
    allowedActions: ["read", "test"],
  });
  const ungrantedAction = authorizeBatchAction({
    grant: grantNoWrite,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "write",
    now,
  });
  assert.equal(ungrantedAction.authorized, false);
  assert.match(ungrantedAction.reason || "", /not permitted by the grant/);
}

// 7. Probe 3, Probe 5 & Independent Acceptance: GITHUB_MERGE Gate & Rules
{
  const grant = parseBatchAutonomyGrant(validGrantInput);

  // Success: Exact Main Controller + grant has GITHUB_MERGE + mergeGatesPassed === true + independentAcceptancePassed === true
  const mergeSuccess = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      mergeGatesPassed: true,
      independentAcceptancePassed: true,
    },
  });
  assert.equal(mergeSuccess.authorized, true);

  // Negative Case: independentAcceptancePassed is false
  const acceptanceFalseMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      mergeGatesPassed: true,
      independentAcceptancePassed: false,
    },
  });
  assert.equal(acceptanceFalseMerge.authorized, false);
  assert.match(acceptanceFalseMerge.reason || "", /requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true/);

  // Negative Case: independentAcceptancePassed is missing
  const acceptanceMissingMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      mergeGatesPassed: true,
    } as any,
  });
  assert.equal(acceptanceMissingMerge.authorized, false);
  assert.match(acceptanceMissingMerge.reason || "", /requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true/);

  // Negative Case: mergeGatesPassed is false
  const mergeGatesFalseMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      mergeGatesPassed: false,
      independentAcceptancePassed: true,
    },
  });
  assert.equal(mergeGatesFalseMerge.authorized, false);
  assert.match(mergeGatesFalseMerge.reason || "", /requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true/);

  // Negative Case: mergeGatesPassed is missing
  const mergeGatesMissingMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      independentAcceptancePassed: true,
    } as any,
  });
  assert.equal(mergeGatesMissingMerge.authorized, false);
  assert.match(mergeGatesMissingMerge.reason || "", /requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true/);

  // Probe 3: Merge DENIED when only ciPassed + reviewsApproved are provided without mergeGatesPassed + independentAcceptancePassed
  const partialGatesMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      ciPassed: true,
      reviewsApproved: true,
      mergeable: true,
    } as any,
  });
  assert.equal(partialGatesMerge.authorized, false);
  assert.match(partialGatesMerge.reason || "", /requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true/);

  // workerReportedPass alone NEVER authorizes merge
  const workerReportedMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
    externalGates: {
      workerReportedPass: true,
    } as any,
  });
  assert.equal(workerReportedMerge.authorized, false);
  assert.match(workerReportedMerge.reason || "", /requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true/);

  // Missing externalGates DENIES merge
  const noGatesMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "GITHUB_MERGE",
    now,
  });
  assert.equal(noGatesMerge.authorized, false);

  // Probe 5: Lowercase github_merge alias is rejected as unknown action
  const lowercaseMerge = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "github_merge",
    now,
    externalGates: { mergeGatesPassed: true, independentAcceptancePassed: true },
  });
  assert.equal(lowercaseMerge.authorized, false);
  assert.match(lowercaseMerge.reason || "", /Unknown or malformed action/);
}

// 8. Expired & Revoked Grants
{
  const grant = parseBatchAutonomyGrant(validGrantInput);

  // Expired validity window
  const expiredAction = authorizeBatchAction({
    grant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "read",
    now: now + 10000000,
  });
  assert.equal(expiredAction.authorized, false);
  assert.match(expiredAction.reason || "", /validity window is expired/);

  // Revoked grant
  const revokedGrant = parseBatchAutonomyGrant({ ...validGrantInput, revoked: true });
  const revokedAction = authorizeBatchAction({
    grant: revokedGrant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "read",
    now,
  });
  assert.equal(revokedAction.authorized, false);
  assert.match(revokedAction.reason || "", /Grant has been revoked/);

  // Revoked at timestamp
  const revokedAtGrant = parseBatchAutonomyGrant({ ...validGrantInput, revokedAt: now - 10 });
  const revokedAtAction = authorizeBatchAction({
    grant: revokedAtGrant,
    repository: "owner/repo",
    goal: "Fix bug #42 and update test coverage",
    actor: { id: "controller-agent-1", role: "main_controller" },
    action: "read",
    now,
  });
  assert.equal(revokedAtAction.authorized, false);
  assert.match(revokedAtAction.reason || "", /Grant has been revoked at revokedAt/);
}

console.log("All batch-autonomy grant tests passed successfully!");
