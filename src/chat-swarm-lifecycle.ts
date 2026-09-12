import { ChatSwarmError } from "./chat-swarm-contract.js";
import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import { ChatSwarmStore } from "./chat-swarm-store.js";

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
  | "approve_join";

export interface ChatSwarmLifecycleOptions {
  stateDir: string;
  enabled?: boolean;
  mode?: () => ChatSwarmLifecycleMode;
}

export interface ChatSwarmAdmissionContext {
  existingTask?: boolean;
}

/**
 * Owns one process-level Swarm store/coordinator pair. Construction opens the
 * durable store but deliberately does not perform restart recovery; the server
 * must call recoverAfterRestart once it has established its startup authority.
 */
export class ChatSwarmLifecycle {
  readonly enabled: boolean;
  readonly store?: ChatSwarmStore;
  readonly coordinator?: ChatSwarmCoordinator;
  private readonly modeProvider: () => ChatSwarmLifecycleMode;
  private closed = false;

  constructor(options: ChatSwarmLifecycleOptions) {
    this.enabled = options.enabled ?? true;
    this.modeProvider = options.mode ?? (() => "normal");
    if (this.enabled) {
      const store = new ChatSwarmStore(options.stateDir);
      this.store = store;
      this.coordinator = new ChatSwarmCoordinator(store);
    }
  }

  recoverAfterStartup(): number {
    this.requireEnabled();
    return this.store!.recoverAfterRestart();
  }

  admit(action: ChatSwarmLifecycleAction, context: ChatSwarmAdmissionContext = {}): void {
    this.requireEnabled();
    const mode = this.modeProvider();
    if (mode === "normal") return;

    if (action === "next" && context.existingTask === true) return;
    if (["status", "collect", "cancel", "reconcile", "submit", "peer_status", "inspect", "tasks"].includes(action)) return;

    throw new ChatSwarmError(
      "INVALID_STATE",
      `chat swarm action '${action}' is unavailable while cutover is ${mode}`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store?.close();
  }

  private requireEnabled(): void {
    if (!this.enabled || !this.store || !this.coordinator) {
      throw new ChatSwarmError("INVALID_STATE", "chat swarm feature is disabled");
    }
    if (this.closed) throw new ChatSwarmError("INVALID_STATE", "chat swarm lifecycle is closed");
  }
}
