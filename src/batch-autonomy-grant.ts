/**
 * Pure typed / fail-closed batch-autonomy grant primitives.
 */

export const ACTOR_ROLES = [
  "main_controller",
  "worker",
  "descendant",
] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

export const BATCH_ACTIONS = [
  "read",
  "write",
  "edit",
  "command",
  "test",
  "lint",
  "git_commit",
  "git_worktree",
  "CREATE_CHILD_TASK",
  "GITHUB_MERGE",
] as const;

export type BatchAction = (typeof BATCH_ACTIONS)[number];

export const CAUSAL_RELATIONS = [
  "WITHIN_GOAL_NECESSARY",
  "WITHIN_GOAL_ROUTINE",
  "OFF_GOAL",
] as const;

export type CausalRelation = (typeof CAUSAL_RELATIONS)[number];

export const ROUTINE_EVENT_TYPES = [
  "implementation_choice",
  "ordinary_bug",
  "test_failure",
  "lint_failure",
  "merge_conflict",
  "worker_timeout",
  "worker_replacement",
  "review_fix",
  "ci_rerun",
] as const;

export type RoutineEventType = (typeof ROUTINE_EVENT_TYPES)[number];

export const TRUE_BLOCKER_TYPES = [
  "intent_change",
  "scope_widening",
  "security_weakening",
  "governance_weakening",
  "new_irreversible_external_effect",
  "release_production_public_commitment",
  "materially_unknowable_authority_or_truth",
  "unresolved_new_api_semantics",
  "production_data_mutation",
] as const;

export type TrueBlockerType = (typeof TRUE_BLOCKER_TYPES)[number];

export interface ValidityWindow {
  validFrom: number;
  validTo: number;
}

export interface BatchAutonomyGrant {
  grantId: string;
  repository: string;
  goal: string;
  mainControllerId: string;
  allowedActions: BatchAction[];
  validityWindow: ValidityWindow;
  revoked: boolean;
  revokedAt?: number;
}

export interface Actor {
  id: string;
  role: ActorRole;
}

export interface MergeExternalGates {
  mergeGatesPassed: boolean;
  independentAcceptancePassed: boolean;
  workerReportedPass?: boolean;
}

export interface AuthorizationRequest {
  grant: unknown;
  repository: string;
  goal: string;
  actor: {
    id: string;
    role: ActorRole;
  };
  action: BatchAction | string;
  now?: number;
  externalGates?: MergeExternalGates;
}

export interface AuthorizationResult {
  authorized: boolean;
  reason?: string;
}

export interface ChildDelegationRequest {
  parentGrant: unknown;
  actor:
    | {
        id: string;
        role: ActorRole;
      }
    | unknown;
  childGoal: string;
  causalRelation: CausalRelation | string;
  childActions: BatchAction[] | unknown;
  now?: number;
}

export interface ChildDelegationResult {
  authorized: boolean;
  reason?: string;
  childGrant?: BatchAutonomyGrant;
}


export interface EventEvaluationResult {
  isBlocker: boolean;
  isRoutine: boolean;
  type?: string;
  reason?: string;
}

export function isActorRole(role: unknown): role is ActorRole {
  return typeof role === "string" && (ACTOR_ROLES as readonly string[]).includes(role);
}

export function isBatchAction(action: unknown): action is BatchAction {
  return typeof action === "string" && (BATCH_ACTIONS as readonly string[]).includes(action);
}

export function isCausalRelation(relation: unknown): relation is CausalRelation {
  return typeof relation === "string" && (CAUSAL_RELATIONS as readonly string[]).includes(relation);
}

export function isMergeAction(action: unknown): boolean {
  return action === "GITHUB_MERGE";
}

const ALLOWED_GRANT_KEYS = new Set([
  "grantId",
  "repository",
  "goal",
  "mainControllerId",
  "allowedActions",
  "validityWindow",
  "revoked",
  "revokedAt",
]);

const ALLOWED_VW_KEYS = new Set(["validFrom", "validTo"]);

/**
 * Validate and parse an unknown runtime input into a BatchAutonomyGrant.
 * Fails closed on any malformed, coerced, non-finite, missing data, or unknown/alias fields.
 */
export function parseBatchAutonomyGrant(input: unknown): BatchAutonomyGrant {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Grant must be a non-null object");
  }

  const raw = input as Record<string, unknown>;

  // Reject alias fields & unknown top-level authority fields
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_GRANT_KEYS.has(key)) {
      throw new Error(`Unknown or forbidden top-level field in grant: '${key}'`);
    }
  }

  // grantId
  if (typeof raw.grantId !== "string" || !raw.grantId.trim()) {
    throw new Error("Grant must have a non-empty string grantId");
  }
  const grantId = raw.grantId.trim();

  // repository
  if (typeof raw.repository !== "string" || !raw.repository.trim()) {
    throw new Error("Grant must have a non-empty string repository");
  }
  const repository = raw.repository.trim();

  // goal
  if (typeof raw.goal !== "string" || !raw.goal.trim()) {
    throw new Error("Grant must have a non-empty string goal");
  }
  const goal = raw.goal.trim();

  // mainControllerId
  if (typeof raw.mainControllerId !== "string" || !raw.mainControllerId.trim()) {
    throw new Error("Grant must specify a valid non-empty mainControllerId");
  }
  const mainControllerId = raw.mainControllerId.trim();

  // allowedActions
  if (!Array.isArray(raw.allowedActions) || raw.allowedActions.length === 0) {
    throw new Error("Grant allowedActions must be a non-empty array");
  }
  const allowedActions: BatchAction[] = [];
  for (let i = 0; i < raw.allowedActions.length; i++) {
    const act = raw.allowedActions[i];
    if (typeof act !== "string" || !isBatchAction(act)) {
      throw new Error(`Unknown or invalid BatchAction at index ${i}: ${String(act)}`);
    }
    if (!allowedActions.includes(act)) {
      allowedActions.push(act);
    }
  }

  // validityWindow
  if (!raw.validityWindow || typeof raw.validityWindow !== "object" || Array.isArray(raw.validityWindow)) {
    throw new Error("Grant must specify validityWindow object");
  }
  const vw = raw.validityWindow as Record<string, unknown>;
  for (const key of Object.keys(vw)) {
    if (!ALLOWED_VW_KEYS.has(key)) {
      throw new Error(`Unknown or forbidden field in validityWindow: '${key}'`);
    }
  }

  if (typeof vw.validFrom !== "number" || !Number.isFinite(vw.validFrom) || Number.isNaN(vw.validFrom)) {
    throw new Error(`Field 'validityWindow.validFrom' must be a finite number, got ${vw.validFrom}`);
  }
  if (typeof vw.validTo !== "number" || !Number.isFinite(vw.validTo) || Number.isNaN(vw.validTo)) {
    throw new Error(`Field 'validityWindow.validTo' must be a finite number, got ${vw.validTo}`);
  }

  const validFrom = vw.validFrom;
  const validTo = vw.validTo;

  if (validFrom > validTo) {
    throw new Error(`validityWindow validFrom (${validFrom}) cannot be greater than validTo (${validTo})`);
  }

  // revoked
  if (typeof raw.revoked !== "boolean") {
    throw new Error(`Field 'revoked' must be boolean if provided, got ${typeof raw.revoked}`);
  }
  const revoked = raw.revoked;

  // revokedAt
  let revokedAt: number | undefined = undefined;
  if (raw.revokedAt !== undefined) {
    if (typeof raw.revokedAt !== "number" || !Number.isFinite(raw.revokedAt) || Number.isNaN(raw.revokedAt)) {
      throw new Error(`Field 'revokedAt' must be a finite number, got ${raw.revokedAt}`);
    }
    revokedAt = raw.revokedAt;
  }

  return {
    grantId,
    repository,
    goal,
    mainControllerId,
    allowedActions,
    validityWindow: { validFrom, validTo },
    revoked,
    revokedAt,
  };
}

/**
 * Safely parse a grant without throwing, returning a result object.
 */
export function safeParseBatchAutonomyGrant(
  input: unknown,
): { success: true; data: BatchAutonomyGrant } | { success: false; error: string } {
  try {
    return { success: true, data: parseBatchAutonomyGrant(input) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Evaluate an autonomous event or blocker payload.
 * Fails closed on malformed, alias, object, or unknown events.
 * Accepts ONLY exact finite string event kinds from ROUTINE_EVENT_TYPES or TRUE_BLOCKER_TYPES.
 */
export function evaluateAutonomousEvent(event: unknown): EventEvaluationResult {
  if (typeof event === "string") {
    if ((TRUE_BLOCKER_TYPES as readonly string[]).includes(event)) {
      return {
        isBlocker: true,
        isRoutine: false,
        type: event,
        reason: `Event '${event}' is a True Blocker`,
      };
    }
    if ((ROUTINE_EVENT_TYPES as readonly string[]).includes(event)) {
      return {
        isBlocker: false,
        isRoutine: true,
        type: event,
        reason: `Event '${event}' is an autonomous routine event`,
      };
    }
    return {
      isBlocker: true,
      isRoutine: false,
      type: "unknown_event",
      reason: `Unknown or unnormalized event '${event}' fails closed as a True Blocker`,
    };
  }

  return {
    isBlocker: true,
    isRoutine: false,
    type: "malformed_event",
    reason: "Event must be an exact string event kind; objects, aliases, arrays, and malformed inputs fail closed as True Blocker",
  };
}

export function isRoutineEvent(event: unknown): boolean {
  const res = evaluateAutonomousEvent(event);
  return res.isRoutine && !res.isBlocker;
}

export function isTrueBlocker(event: unknown): boolean {
  const res = evaluateAutonomousEvent(event);
  return res.isBlocker;
}

/**
 * Validate and create a child task delegation.
 * Main Controller may create a child task only when explicit causalRelation is WITHIN_GOAL_NECESSARY or WITHIN_GOAL_ROUTINE,
 * parent grant contains CREATE_CHILD_TASK, and child actions are a subset of parent grant actions.
 * Descendants NEVER inherit GITHUB_MERGE or Owner-only authority.
 */
export function validateChildTaskDelegation(params: unknown): ChildDelegationResult {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { authorized: false, reason: "Delegation parameters must be a non-null object" };
  }

  const p = params as Record<string, unknown>;

  let grant: BatchAutonomyGrant;
  try {
    grant = parseBatchAutonomyGrant(p.parentGrant);
  } catch (err: any) {
    return { authorized: false, reason: `Invalid parent grant: ${err.message}` };
  }

  // Parent grant must explicitly contain CREATE_CHILD_TASK
  if (!grant.allowedActions.includes("CREATE_CHILD_TASK")) {
    return { authorized: false, reason: "Parent grant does not allow CREATE_CHILD_TASK action" };
  }

  let currentTime = Date.now();
  if (p.now !== undefined) {
    if (typeof p.now !== "number" || !Number.isFinite(p.now) || Number.isNaN(p.now)) {
      return { authorized: false, reason: "Field 'now' must be a finite number" };
    }
    currentTime = p.now;
  }

  if (currentTime < grant.validityWindow.validFrom || currentTime > grant.validityWindow.validTo) {
    return { authorized: false, reason: "Parent grant validity window is expired or not yet active" };
  }
  if (grant.revoked) {
    return { authorized: false, reason: "Parent grant has been revoked" };
  }
  if (grant.revokedAt !== undefined && currentTime >= grant.revokedAt) {
    return { authorized: false, reason: "Parent grant has been revoked at revokedAt" };
  }

  if (!p.actor || typeof p.actor !== "object" || Array.isArray(p.actor)) {
    return { authorized: false, reason: "Actor must be a non-null object" };
  }
  const actor = p.actor as Record<string, unknown>;
  const actorId = actor.id;
  const actorRole = actor.role;

  if (typeof actorId !== "string" || !actorId.trim()) {
    return { authorized: false, reason: "Actor id must be a non-empty string" };
  }
  if (actorRole !== "main_controller") {
    return { authorized: false, reason: "Only main_controller can delegate child tasks" };
  }
  if (actorId.trim() !== grant.mainControllerId) {
    return { authorized: false, reason: "Only the exact Main Controller can delegate child tasks" };
  }

  const childGoal = p.childGoal;
  if (typeof childGoal !== "string" || !childGoal.trim()) {
    return { authorized: false, reason: "Child goal must be a non-empty string" };
  }

  // Explicit finite causalRelation check
  const causalRelation = p.causalRelation;
  if (
    causalRelation !== "WITHIN_GOAL_NECESSARY" &&
    causalRelation !== "WITHIN_GOAL_ROUTINE"
  ) {
    return {
      authorized: false,
      reason: `Child task causalRelation must be WITHIN_GOAL_NECESSARY or WITHIN_GOAL_ROUTINE, got '${String(causalRelation)}'`,
    };
  }

  const rawChildActions = p.childActions;
  if (!Array.isArray(rawChildActions) || rawChildActions.length === 0) {
    return { authorized: false, reason: "Child actions must be a non-empty array" };
  }

  const childActions: BatchAction[] = [];
  for (let i = 0; i < rawChildActions.length; i++) {
    const act = rawChildActions[i];
    if (typeof act !== "string" || !isBatchAction(act)) {
      return { authorized: false, reason: `Unknown batch action at index ${i}: ${String(act)}` };
    }
    if (!grant.allowedActions.includes(act)) {
      return { authorized: false, reason: `Action '${act}' is not permitted by parent grant` };
    }
    if (act === "GITHUB_MERGE") {
      return { authorized: false, reason: "Descendants never inherit GITHUB_MERGE authority" };
    }
    if (!childActions.includes(act)) {
      childActions.push(act);
    }
  }

  const childGrant: BatchAutonomyGrant = {
    grantId: `${grant.grantId}:child:${currentTime}`,
    repository: grant.repository,
    goal: childGoal.trim(),
    mainControllerId: grant.mainControllerId,
    allowedActions: childActions,
    validityWindow: {
      validFrom: currentTime,
      validTo: grant.validityWindow.validTo,
    },
    revoked: false,
  };

  return {
    authorized: true,
    childGrant,
  };
}

/**
 * Authorize an action under a grant, requiring exact repository, Goal, actor, and action binding.
 * Parent batch grant actions are MAIN_CONTROLLER-only in this gate. Arbitrary worker/descendant actor IDs are denied.
 * GITHUB_MERGE requires explicit grant action, exact Main Controller, current validity window, and upstream facts mergeGatesPassed === true and independentAcceptancePassed === true.
 */
export function authorizeBatchAction(params: unknown): AuthorizationResult {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { authorized: false, reason: "Authorization parameters must be a non-null object" };
  }

  const p = params as Record<string, unknown>;

  // 1. Parse & validate grant
  let grant: BatchAutonomyGrant;
  try {
    grant = parseBatchAutonomyGrant(p.grant);
  } catch (err: any) {
    return { authorized: false, reason: `Invalid grant: ${err.message}` };
  }

  // 2. Exact repository binding
  const repo = p.repository;
  if (typeof repo !== "string" || !repo.trim()) {
    return { authorized: false, reason: "Repository context must be a non-empty string" };
  }
  if (repo.trim() !== grant.repository) {
    return { authorized: false, reason: `Repository mismatch: expected '${grant.repository}', got '${repo.trim()}'` };
  }

  // 3. Exact goal binding
  const goal = p.goal;
  if (typeof goal !== "string" || !goal.trim()) {
    return { authorized: false, reason: "Goal context must be a non-empty string" };
  }
  if (goal.trim() !== grant.goal) {
    return { authorized: false, reason: `Goal mismatch: expected '${grant.goal}', got '${goal.trim()}'` };
  }

  // 4. Exact actor binding - Parent batch grant actions are MAIN_CONTROLLER-only in this gate
  if (!p.actor || typeof p.actor !== "object" || Array.isArray(p.actor)) {
    return { authorized: false, reason: "Actor context must be a non-null object" };
  }
  const actor = p.actor as Record<string, unknown>;
  const actorId = actor.id;
  const actorRole = actor.role;

  if (typeof actorId !== "string" || !actorId.trim()) {
    return { authorized: false, reason: "Actor ID must be a non-empty string" };
  }
  if (actorRole !== "main_controller") {
    return { authorized: false, reason: `Parent batch grant actions are restricted to main_controller (got '${String(actorRole)}')` };
  }
  if (actorId.trim() !== grant.mainControllerId) {
    return { authorized: false, reason: `Actor ID mismatch: expected '${grant.mainControllerId}', got '${actorId.trim()}'` };
  }

  // 5. Validity window
  let currentTime = Date.now();
  if (p.now !== undefined) {
    if (typeof p.now !== "number" || !Number.isFinite(p.now) || Number.isNaN(p.now)) {
      return { authorized: false, reason: "Field 'now' must be a finite number" };
    }
    currentTime = p.now;
  }

  if (currentTime < grant.validityWindow.validFrom || currentTime > grant.validityWindow.validTo) {
    return { authorized: false, reason: "Grant validity window is expired or not yet active" };
  }

  // 6. Revocation checks
  if (grant.revoked) {
    return { authorized: false, reason: "Grant has been revoked" };
  }
  if (grant.revokedAt !== undefined && currentTime >= grant.revokedAt) {
    return { authorized: false, reason: "Grant has been revoked at revokedAt" };
  }

  // 7. Action validation
  const actionRaw = p.action;
  if (typeof actionRaw !== "string" || !isBatchAction(actionRaw)) {
    return { authorized: false, reason: `Unknown or malformed action: ${String(actionRaw)}` };
  }

  if (!grant.allowedActions.includes(actionRaw)) {
    return { authorized: false, reason: `Action '${actionRaw}' is not permitted by the grant` };
  }

  // 8. GITHUB_MERGE rules: requires exact upstream facts mergeGatesPassed === true AND independentAcceptancePassed === true
  if (actionRaw === "GITHUB_MERGE") {
    const gatesRaw = p.externalGates;
    if (!gatesRaw || typeof gatesRaw !== "object" || Array.isArray(gatesRaw)) {
      return { authorized: false, reason: "External merge gates missing or malformed" };
    }

    const gates = gatesRaw as Record<string, unknown>;
    if (gates.mergeGatesPassed !== true || gates.independentAcceptancePassed !== true) {
      return {
        authorized: false,
        reason: "Merge authorization requires both externalGates.mergeGatesPassed === true and externalGates.independentAcceptancePassed === true",
      };
    }
  }

  return { authorized: true };
}
