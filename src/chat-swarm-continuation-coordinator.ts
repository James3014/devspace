import type {
  ApproveContinuationRequestInput,
  ChatSwarmContinuationRequest,
  CreateContinuationRequestInput,
} from "./chat-swarm-continuation-contract.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";

export class ChatSwarmContinuationCoordinator {
  constructor(readonly store: ChatSwarmContinuationStore) {}

  request(
    meta: unknown,
    input: CreateContinuationRequestInput,
  ): { request: ChatSwarmContinuationRequest; created: boolean } {
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.createRequest(identity.fingerprint, input);
  }

  targetStatus(meta: unknown, swarmId: string): ChatSwarmContinuationRequest | undefined {
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.getLatestForTarget(swarmId, identity.fingerprint);
  }

  approve(meta: unknown, input: ApproveContinuationRequestInput): ChatSwarmContinuationRequest {
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.approveRequest(identity.fingerprint, input);
  }

  reconcileNoEffect(meta: unknown, requestId: string): ChatSwarmContinuationRequest {
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.reconcileUnknownNoEffect(identity.fingerprint, requestId);
  }

  recoverAfterRestart(): number {
    return this.store.recoverAfterRestart();
  }
}
