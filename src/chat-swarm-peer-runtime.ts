import { ChatSwarmCoordinator } from "./chat-swarm-coordinator.js";
import type { ChatSwarmTask, ChatSwarmWorker } from "./chat-swarm-contract.js";

export class ChatSwarmPeerRuntime {
  constructor(readonly coordinator: ChatSwarmCoordinator) {}
  join(meta: unknown, swarmId: string, input: Parameters<ChatSwarmCoordinator["joinWorker"]>[2]): ChatSwarmWorker { return this.coordinator.joinWorker(meta, swarmId, input); }
  next(meta: unknown, workerId: string): ChatSwarmTask | undefined { return this.coordinator.nextTask(meta, workerId); }
  submit(meta: unknown, workerId: string, taskId: string, result: string): ChatSwarmTask { return this.coordinator.submit(meta, workerId, taskId, result); }
  checkpoint(meta: unknown, workerId: string, epoch: number, leaseExpiresAt: string, checkpoint: Record<string, unknown>): ChatSwarmWorker { return this.coordinator.checkpoint(meta, workerId, epoch, leaseExpiresAt, checkpoint); }
}
