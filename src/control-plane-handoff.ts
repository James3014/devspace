import { ControlPlaneOwnershipStore, type HandoffInput, type HandoffReceipt } from "./control-plane-ownership.js";

/** Thin domain facade; authentication and grant verification remain injected into the ownership store. */
export class ControlPlaneHandoff {
  constructor(private readonly ownership: ControlPlaneOwnershipStore) {}

  transfer(
    consumerContext: unknown,
    leaseId: string,
    expectedVersion: number,
    recipientContext: unknown,
    receipt: HandoffInput,
  ): HandoffReceipt {
    return this.ownership.handoff(consumerContext, leaseId, expectedVersion, recipientContext, receipt);
  }
}

export type { HandoffInput, HandoffReceipt };
