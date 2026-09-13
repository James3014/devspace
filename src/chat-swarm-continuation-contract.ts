export const CHAT_SWARM_CONTINUATION_STATES = [
  "PENDING",
  "APPROVED",
  "EXPIRED",
  "SUPERSEDED",
  "RECONCILE_REQUIRED",
] as const;

export type ChatSwarmContinuationState = (typeof CHAT_SWARM_CONTINUATION_STATES)[number];

export interface ChatSwarmContinuationRequest {
  id: string;
  swarmId: string;
  workerId: string;
  attemptKey: string;
  requestHash: string;
  sourceEpoch: number;
  targetEpoch: number;
  sourceCarrierFingerprint: string;
  targetCarrierFingerprint: string;
  checkpointHash: string;
  ttlSeconds: number;
  version: number;
  status: ChatSwarmContinuationState;
  requestedAt: string;
  expiresAt: string;
  approvedAt?: string;
}

export interface CreateContinuationRequestInput {
  swarmId: string;
  workerId: string;
  attemptKey: string;
  sourceEpoch: number;
  ttlSeconds?: number;
}

export interface ApproveContinuationRequestInput {
  swarmId: string;
  requestId: string;
  expectedRequestVersion: number;
  expectedSwarmVersion: number;
}
