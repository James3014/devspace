import { isDeepStrictEqual } from "node:util";
import type { ControlPlaneServiceBinding } from "./control-plane-convergence.js";
import {
  DurableOperationError,
  durableOperationId,
  hashDurableRequest,
  type DurableOperationRecord,
  type DurableOperationStore,
} from "./durable-operations.js";
import { ChatSwarmStore, type ChatSwarmMigrationBundle, type ChatSwarmMigrationReadback } from "./chat-swarm-store.js";
import { redactSensitiveText } from "./sensitive-redaction.js";

export interface ChatSwarmMigrationPreparation {
  operationId: string;
  requestHash: string;
  bundle: ChatSwarmMigrationBundle;
  destinationBinding: ControlPlaneServiceBinding;
  preReadback?: ChatSwarmMigrationReadback;
}

export function chatSwarmMigrationOperationId(destinationStateDirectory: string, attemptKey: string): string {
  return durableOperationId("chat_swarm_reconciliation", destinationStateDirectory, attemptKey);
}

export class ChatSwarmMigrationCoordinator {
  constructor(
    private readonly store: DurableOperationStore,
    private readonly destinationStateDirectory: string,
  ) {}

  prepareChatSwarmMigration(input: {
    attemptKey: string;
    bundle: ChatSwarmMigrationBundle;
    destinationBinding: ControlPlaneServiceBinding;
  }): ChatSwarmMigrationPreparation {
    const expectedOperationId = chatSwarmMigrationOperationId(this.destinationStateDirectory, input.attemptKey);
    if (input.bundle.operationId !== expectedOperationId) {
      throw new DurableOperationError("OPERATION_REPLAY_CONFLICT", "migration bundle operationId is not bound to the exact attemptKey");
    }
    if (!isDeepStrictEqual(input.bundle.destinationBinding, input.destinationBinding)) {
      throw new DurableOperationError("RECONCILIATION_REQUIRED", "migration destination identity does not match the requested canonical binding");
    }
    const request = {
      schema: "devspace.chat_swarm_migration_request.v1",
      operationId: expectedOperationId,
      contentHash: input.bundle.contentHash,
      sourceBinding: input.bundle.sourceBinding,
      destinationBinding: input.destinationBinding,
      counts: {
        swarms: input.bundle.swarms.length,
        workers: input.bundle.workers.length,
        tasks: input.bundle.tasks.length,
        attempts: input.bundle.attempts.length,
        carrierOperations: input.bundle.carrierOperations.length,
      },
    };
    const requestHash = hashDurableRequest(request);
    const { record } = this.store.createOrReplay({
      operationId: expectedOperationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "chat_swarm_reconciliation",
      authorityMode: "OWNER_DIRECT",
      scopeRoot: this.destinationStateDirectory,
      request,
    });
    if (record.requestHash !== requestHash) throw new DurableOperationError("OPERATION_REPLAY_CONFLICT", "migration request hash changed", record);
    return { operationId: expectedOperationId, requestHash, bundle: input.bundle, destinationBinding: input.destinationBinding };
  }

  applyChatSwarmMigration(preparation: ChatSwarmMigrationPreparation, destinationStore: ChatSwarmStore): DurableOperationRecord {
    const record = this.store.getByOperationId(preparation.operationId);
    if (!record || record.kind !== "chat_swarm_reconciliation" || record.requestHash !== preparation.requestHash) {
      throw new DurableOperationError("RECONCILIATION_REQUIRED", "migration operation identity is not present in the canonical durable ledger");
    }
    if (record.status === "succeeded" || record.status === "failed") return record;
    if (record.status === "outcome_unknown") throw new DurableOperationError("OPERATION_OUTCOME_UNKNOWN", "migration effect is unknown; reconcile the exact destination readback before another effect", record);
    let preReadback: ChatSwarmMigrationReadback;
    try {
      preReadback = destinationStore.readMigrationReadback(preparation.bundle);
      const postReadback = destinationStore.importMigrationBundle(preparation.bundle, preparation.destinationBinding);
      if (!migrationReadbackMatches(preparation.bundle, postReadback)) {
        return this.store.finish(preparation.operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED", errorMessage: "migration post-readback did not prove the exact domain bundle", receipt: { preReadback, postReadback, contentHash: preparation.bundle.contentHash } });
      }
      return this.store.finish(preparation.operationId, {
        status: "succeeded",
        retrySafe: false,
        receipt: { schema: "devspace.chat_swarm_migration_receipt.v1", sourceBinding: preparation.bundle.sourceBinding, destinationBinding: preparation.destinationBinding, contentHash: preparation.bundle.contentHash, preReadback, postReadback, unresolvedTaskIds: postReadback.unresolvedTaskIds },
      });
    } catch (error) {
      return this.store.finish(preparation.operationId, { status: "failed", retrySafe: false, errorCode: "MIGRATION_APPLY_FAILED", errorMessage: redactSensitiveText(error instanceof Error ? error.message : String(error)) });
    }
  }

  reconcileChatSwarmMigration(preparation: ChatSwarmMigrationPreparation, destinationStore: ChatSwarmStore): DurableOperationRecord {
    const record = this.store.getByOperationId(preparation.operationId);
    if (!record || record.kind !== "chat_swarm_reconciliation" || record.requestHash !== preparation.requestHash) throw new DurableOperationError("RECONCILIATION_REQUIRED", "migration reconciliation requires the exact durable operation identity");
    if (record.status !== "outcome_unknown") return record;
    const readback = destinationStore.readMigrationReadback(preparation.bundle);
    if (!migrationReadbackMatches(preparation.bundle, readback)) {
      return record;
    }
    return this.store.finish(preparation.operationId, { status: "succeeded", retrySafe: false, receipt: { ...(record.receipt ?? {}), reconciliation: "physical_readback", postReadback: readback } });
}
}

function migrationReadbackMatches(bundle: ChatSwarmMigrationBundle, readback: ChatSwarmMigrationReadback): boolean {
  const expectedUnresolved = bundle.tasks.filter((task) => task.lifecycleState === "RECONCILE_REQUIRED").map((task) => task.id).sort();
  return readback.operationId === bundle.operationId &&
    readback.contentHash === bundle.contentHash &&
    readback.counts.swarms === bundle.swarms.length &&
    readback.counts.workers === bundle.workers.length &&
    readback.counts.tasks === bundle.tasks.length &&
    readback.counts.attempts === bundle.attempts.length &&
    readback.counts.carrierOperations === bundle.carrierOperations.length &&
    isDeepStrictEqual(readback.unresolvedTaskIds, expectedUnresolved);
}
