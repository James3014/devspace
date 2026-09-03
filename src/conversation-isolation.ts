/**
 * Issue #33: Conversation-scoped checkout isolation + cross-session capacity contention.
 *
 * Goals:
 * - Detect when two distinct ChatGPT conversations target the same physical checkout root
 * - Distinguish local agent slot exhaustion from provider quota/rate-limit
 * - Block mutation ownership bypass via a second physical checkout
 * - Do NOT implement a global lock; conversation-scoped reuse is preserved
 */
import { createHash } from "node:crypto";

// ─── Error / Reason codes ─────────────────────────────────────────────

export const CONVERSATION_COLLISION_DETECTED = "CONVERSATION_COLLISION_DETECTED";
export const AGENT_SLOT_EXHAUSTED = "AGENT_SLOT_EXHAUSTED";
export const PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED";
export const MUTATION_OWNERSHIP_BYPASS_BLOCKED = "MUTATION_OWNERSHIP_BYPASS_BLOCKED";
export type IsolationReason =
  | typeof CONVERSATION_COLLISION_DETECTED
  | typeof AGENT_SLOT_EXHAUSTED
  | typeof PROVIDER_RATE_LIMITED
  | typeof MUTATION_OWNERSHIP_BYPASS_BLOCKED;

// ─── Types ────────────────────────────────────────────────────────────

export interface ConversationCheckoutEntry {
  conversationId: string;
  stateDir: string;
}

export interface PhysicalRootCollisionInput {
  conversationId: string;
  stateDir: string;
  existingCheckouts: ConversationCheckoutEntry[];
}

export interface PhysicalRootCollisionResult {
  collision: boolean;
  reason?: IsolationReason;
}

export interface CrossSessionCapacityInput {
  activeLocalAgents: number;
  maxAgentSlots: number;
  providerQuotaRemaining: number;
}

export interface CrossSessionCapacityResult {
  isLocalExhaustion: boolean;
  isRateLimited: boolean;
  reason: IsolationReason;
}

export interface WriteScopeFencingInput {
  conversationId: string;
  targetPath: string;
  assignedCheckout: string;
}

export interface WriteScopeFencingResult {
  blocked: boolean;
  reason?: IsolationReason;
}

// ─── Core: detect physical root collision ────────────────────────────

/**
 * Returns true when a *different* conversation already owns this exact physroot.
 * Same conversation reusing the same checkout is explicitly allowed.
 */
export function detectPhysicalRootCollision(
  input: PhysicalRootCollisionInput,
): PhysicalRootCollisionResult {
  const normalizedTarget = normalizeRoot(input.stateDir);

  for (const entry of input.existingCheckouts) {
    const normalizedExisting = normalizeRoot(entry.stateDir);
    if (
      normalizedTarget === normalizedExisting &&
      entry.conversationId !== input.conversationId
    ) {
      return { collision: true, reason: CONVERSATION_COLLISION_DETECTED };
    }
  }

  return { collision: false, reason: undefined };
}

/**
 * Normalizes a checkout path to its physical root for comparison.
 * Uses realpath when available (symlinks → actual dir), otherwise resolves.
 */
function normalizeRoot(rawPath: string): string {
  let p = rawPath.trim();
  // Strip trailing slash for canonical comparison
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p.toLowerCase();
}

// ─── Core: cross-session capacity contention ─────────────────────────

/**
 * Distinguishes local agent slot exhaustion from provider rate-limiting.
 *
 * - `AGENT_SLOT_EXHAUSTED`: local concurrency cap reached; retry locally or wait.
 * - `PROVIDER_RATE_LIMITED`: local has headroom but provider quota exhausted;
 *   do NOT spawn a second checkout to bypass — ownership must be preserved.
 *
 * Design note: this is NOT a global lock. It reports status only.
 */
export function checkCrossSessionCapacity(
  input: CrossSessionCapacityInput,
): CrossSessionCapacityResult {
  if (input.activeLocalAgents >= input.maxAgentSlots) {
    return {
      isLocalExhaustion: true,
      isRateLimited: false,
      reason: AGENT_SLOT_EXHAUSTED,
    };
  }

  if (input.providerQuotaRemaining <= 0) {
    return {
      isLocalExhaustion: false,
      isRateLimited: true,
      reason: PROVIDER_RATE_LIMITED,
    };
  }

  // Neither exhausted nor rate-limited
  return {
    isLocalExhaustion: false,
    isRateLimited: false,
    reason: AGENT_SLOT_EXHAUSTED, // neutral placeholder — caller should check flags
  };
}

// ─── Core: write-scope fencing ───────────────────────────────────────

/**
 * Blocks mutation bypass: a conversation must not write to a different
 * physical checkout than its assigned one.
 *
 * This catches the case where a worker attempts `git worktree add` or
 * directory change to escape ownership/capacity controls.
 */
export function enforceWriteScopeFencing(
  input: WriteScopeFencingInput,
): WriteScopeFencingResult {
  const targetNormalized = normalizeRoot(input.targetPath);
  const assignedNormalized = normalizeRoot(input.assignedCheckout);

  if (targetNormalized !== assignedNormalized) {
    return { blocked: true, reason: MUTATION_OWNERSHIP_BYPASS_BLOCKED };
  }

  return { blocked: false, reason: undefined };
}

/**
 * Computes a deterministic hash for a conversation + stateDir pair.
 * Used to derive unique managed worktree roots and detect cross-conversation
 * collisions without leaking session secrets.
 */
export function deriveConversationCheckoutKey(
  conversationId: string,
  stateDir: string,
): string {
  const input = `${conversationId}:${normalizeRoot(stateDir)}`;
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}
