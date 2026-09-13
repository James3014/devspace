import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import {
  ChatSwarmCarrierManager,
  type ChatSwarmCarrierAdapter,
  type CarrierResult,
  type CarrierStatusResult,
} from "./chat-swarm-carrier.js";
import { ChatSwarmContinuationCoordinator } from "./chat-swarm-continuation-coordinator.js";
import { ChatSwarmContinuationStore } from "./chat-swarm-continuation-store.js";

export type ChatSwarmLifecycleMode = "normal" | "drain" | "reconcile-only";
export type ChatSwarmLifecycleAction =
  | "create"
  | "join"
  | "dispatch"
  | "next"
  | "submit"
  | "status"
  | "collect"
  | "cancel"
  | "reconcile"
  | "close"
  | "peer_status"
  | "inspect"
  | "tasks"
  | "join_request"
  | "approve_join"
  | "continuation_request"
  | "continuation_status"
  | "continuation_approve"
  | "continuation_reconcile";

export interface ChatSwarmLifecycleOptions {
  stateDir: string;
  enabled?: boolean;
  mode?: () => ChatSwarmLifecycleMode;
  carrierAdapter?: ChatSwarmCarrierAdapter;
}

export interface ChatSwarmAdmissionContext {
  existingTask?: boolean;
}

/**
 * Owns one process-level Swarm state domain. Construction opens the durable
 * stores but deliberately does not perform restart recovery; the server must
 * call recoverAfterStartup once it has established its startup authority.
 */
export class ChatSwarmLifecycle {
  readonly enabled: boolean;
  readonly store?: ChatSwarmStore;
  readonly coordinator?: ChatSwarmCoordinator;
  readonly continuationStore?: ChatSwarmContinuationStore;
  readonly continuationCoordinator?: ChatSwarmContinuationCoordinator;
  private readonly modeProvider: () => ChatSwarmLifecycleMode;
  private closed = false;
  private readonly carrierManager?: ChatSwarmCarrierManager;

  constructor(options: ChatSwarmLifecycleOptions) {
    this.enabled = options.enabled ?? true;
    this.modeProvider = options.mode ?? (() => "normal");
    if (this.enabled) {
      const store = new ChatSwarmStore(options.stateDir);
      const coordinator = new ChatSwarmCoordinator(store);
      const continuationStore = new ChatSwarmContinuationStore(options.stateDir);
      this.store = store;
      this.coordinator = coordinator;
      this.continuationStore = continuationStore;
      this.continuationCoordinator = new ChatSwarmContinuationCoordinator(
        continuationStore,
        coordinator,
      );
      if (options.carrierAdapter) {
        this.carrierManager = new ChatSwarmCarrierManager(
          store,
          coordinator,
          options.carrierAdapter,
        );
      }
    }
  }

  recoverAfterStartup(): number {
    this.requireEnabled();
    this.store!.fenceCarrierOperations();
    const taskRecoveryCount = this.store!.recoverAfterRestart();
    this.continuationCoordinator!.recoverAfterRestart();
    return taskRecoveryCount;
  }

  async ensureCarriers(
    meta: unknown,
    input: { swarmId: string; capacity: number; adapterConfigHash: string },
  ): Promise<CarrierResult[]> {
    this.requireCarrierEffects();
    return this.carrierManager!.ensure(
      meta,
      input.swarmId,
      input.capacity,
      input.adapterConfigHash,
    );
  }

  carrierStatus(meta: unknown, swarmId: string): CarrierStatusResult {
    this.requireEnabled();
    if (!this.carrierManager) {
      throw new ChatSwarmError("INVALID_STATE", "carrier adapter is unavailable");
    }
    return this.carrierManager.status(meta, swarmId);
  }

  async carrierWake(
    meta: unknown,
    input: {
      swarmId: string;
      workerId: string;
      expectedEpoch: number;
      taskId?: string;
      adapterConfigHash: string;
    },
  ): Promise<CarrierResult> {
    this.requireCarrierEffects();
    return this.carrierManager!.wake(meta, input);
  }

  admit(
    action: ChatSwarmLifecycleAction,
    context: ChatSwarmAdmissionContext = {},
  ): void {
    this.requireEnabled();
    const mode = this.modeProvider();
    if (mode === "normal") return;

    if (action === "next" && context.existingTask === true) return;
    if (
      [
        "status",
        "collect",
        "cancel",
        "reconcile",
        "submit",
        "peer_status",
        "inspect",
        "tasks",
        "continuation_status",
        "continuation_reconcile",
      ].includes(action)
    ) return;

    throw new ChatSwarmError(
      "INVALID_STATE",
      `chat swarm action '${action}' is unavailable while cutover is ${mode}`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.continuationStore?.close();
    this.store?.close();
  }

  private requireEnabled(): void {
    if (
      !this.enabled ||
      !this.store ||
      !this.coordinator ||
      !this.continuationStore ||
      !this.continuationCoordinator
    ) {
      throw new ChatSwarmError("INVALID_STATE", "chat swarm feature is disabled");
    }
    if (this.closed) {
      throw new ChatSwarmError("INVALID_STATE", "chat swarm lifecycle is closed");
    }
  }

  private requireCarrierEffects(): void {
    this.requireEnabled();
    if (this.modeProvider() !== "normal") {
      throw new ChatSwarmError(
        "INVALID_STATE",
        "carrier effects are unavailable while lifecycle is not normal",
      );
    }
    if (!this.carrierManager) {
      throw new ChatSwarmError("INVALID_STATE", "carrier adapter is unavailable");
    }
  }
}
