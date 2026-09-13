import {
  canonicalize,
  ChatSwarmError,
  hashContent,
} from "./chat-swarm-contract.js";
import type {
  ChatSwarmContinuationRequest,
  CreateContinuationRequestInput,
} from "./chat-swarm-continuation-contract.js";

const SHA256 = /^[0-9a-f]{64}$/;

export interface WorkerContinuationSnapshot {
  swarmId: string;
  workerId: string;
  lifecycleState: "AVAILABLE" | "BUSY" | "DISABLED" | "RECONCILE_REQUIRED";
  currentTaskId?: string;
  continuationEpoch: number;
  carrierConversationFingerprint?: string;
  checkpoint?: Record<string, unknown>;
}

export interface PreparedContinuationMaterial {
  sourceEpoch: number;
  targetEpoch: number;
  sourceCarrierFingerprint: string;
  targetCarrierFingerprint: string;
  checkpointHash: string;
}

export function prepareContinuationMaterial(
  worker: WorkerContinuationSnapshot,
  input: CreateContinuationRequestInput,
  authenticatedTargetCarrierFingerprint: string,
): PreparedContinuationMaterial {
  if (worker.swarmId !== input.swarmId || worker.workerId !== input.workerId) {
    throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker does not match requested swarm identity");
  }
  if (worker.lifecycleState !== "AVAILABLE" || worker.currentTaskId) {
    throw new ChatSwarmError("RECONCILIATION_REQUIRED", "worker is not at a safe continuation boundary");
  }
  if (worker.continuationEpoch !== input.sourceEpoch) {
    throw new ChatSwarmError("OWNERSHIP_CONFLICT", "worker continuation epoch changed");
  }
  const sourceCarrierFingerprint = requireFingerprint(
    worker.carrierConversationFingerprint,
    "source carrier fingerprint",
  );
  const targetCarrierFingerprint = requireFingerprint(
    authenticatedTargetCarrierFingerprint,
    "target carrier fingerprint",
  );
  if (sourceCarrierFingerprint === targetCarrierFingerprint) {
    throw new ChatSwarmError("INVALID_INPUT", "target carrier must differ from source carrier");
  }
  if (!worker.checkpoint || Array.isArray(worker.checkpoint) || typeof worker.checkpoint !== "object") {
    throw new ChatSwarmError("RECONCILIATION_REQUIRED", "worker has no bounded continuation checkpoint");
  }

  const checkpointJson = JSON.stringify(canonicalize(worker.checkpoint));
  const checkpointHash = hashContent(checkpointJson);
  const targetEpoch = input.sourceEpoch + 1;

  return {
    sourceEpoch: input.sourceEpoch,
    targetEpoch,
    sourceCarrierFingerprint,
    targetCarrierFingerprint,
    checkpointHash,
  };
}

export function assertContinuationCommitAllowed(
  worker: WorkerContinuationSnapshot,
  request: ChatSwarmContinuationRequest,
): void {
  if (request.status !== "PENDING") {
    throw new ChatSwarmError("INVALID_STATE", "continuation request is not pending");
  }
  if (worker.swarmId !== request.swarmId || worker.workerId !== request.workerId) {
    throw new ChatSwarmError("OWNERSHIP_CONFLICT", "continuation request targets another worker");
  }
  if (worker.lifecycleState !== "AVAILABLE" || worker.currentTaskId) {
    throw new ChatSwarmError("RECONCILIATION_REQUIRED", "worker is not at a safe continuation boundary");
  }
  if (worker.continuationEpoch !== request.sourceEpoch) {
    throw new ChatSwarmError("CAS_DRIFT", "worker continuation epoch changed before transfer");
  }
  if (request.targetEpoch !== request.sourceEpoch + 1) {
    throw new ChatSwarmError("INVALID_STATE", "continuation epoch binding is malformed");
  }
  const sourceCarrierFingerprint = requireFingerprint(
    worker.carrierConversationFingerprint,
    "source carrier fingerprint",
  );
  if (sourceCarrierFingerprint !== request.sourceCarrierFingerprint) {
    throw new ChatSwarmError("CAS_DRIFT", "worker source carrier changed before transfer");
  }
  if (!worker.checkpoint || Array.isArray(worker.checkpoint) || typeof worker.checkpoint !== "object") {
    throw new ChatSwarmError("RECONCILIATION_REQUIRED", "worker checkpoint is unavailable");
  }
  const checkpointHash = hashContent(JSON.stringify(canonicalize(worker.checkpoint)));
  if (checkpointHash !== request.checkpointHash) {
    throw new ChatSwarmError("CAS_DRIFT", "worker checkpoint changed before transfer");
  }
}

function requireFingerprint(value: string | undefined, label: string): string {
  if (!value || !SHA256.test(value)) {
    throw new ChatSwarmError("INVALID_INPUT", `${label} must be a SHA-256 fingerprint`);
  }
  return value;
}
