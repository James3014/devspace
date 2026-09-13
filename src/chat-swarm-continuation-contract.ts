export const CHAT_SWARM_CONTINUATION_STATES = ["PENDING", "APPROVED", "EXPIRED"] as const;

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
  targetCarrierFingerprint: string;
  ttlSeconds?: number;
}

export interface ApproveContinuationRequestInput {
  swarmId: string;
  requestId: string;
  ownerIdentityFingerprint: string;
  expectedRequestVersion: number;
  expectedSwarmVersion: number;
}
