import { ChatSwarmError } from "./chat-swarm-contract.js";
import type {
  ApproveContinuationRequestInput,
  ChatSwarmContinuationRequest,
  CreateContinuationRequestInput,
} from "./chat-swarm-continuation-contract.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { resolveChatSwarmIdentity } from "./request-meta.js";

export class ChatSwarmContinuationCoordinator {
  constructor(
    readonly store: ChatSwarmContinuationStore,
    readonly swarmCoordinator: ChatSwarmCoordinator,
  ) {}

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
    this.swarmCoordinator.assertOwnerForLifecycle(meta, input.swarmId);
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.approveRequest(identity.fingerprint, input);
  }

  reconcileNoEffect(
    meta: unknown,
    swarmId: string,
    requestId: string,
  ): ChatSwarmContinuationRequest {
    this.swarmCoordinator.assertOwnerForLifecycle(meta, swarmId);
    const request = this.store.getRequest(requestId);
    if (!request || request.swarmId !== swarmId) {
      throw new ChatSwarmError(
        "OWNERSHIP_CONFLICT",
        "continuation request does not belong to asserted swarm",
      );
    }
    const identity = resolveChatSwarmIdentity(meta);
    return this.store.reconcileUnknownNoEffect(identity.fingerprint, requestId);
  }

  recoverAfterRestart(): number {
    return this.store.recoverAfterRestart();
  }
}
