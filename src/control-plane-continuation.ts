import {
  ControlPlaneOwnershipStore,
  type ContinuationCandidate,
  type LatestContinuationResult,
  type TakeoverInput,
  type TakeoverReceipt,
  type ResourceLease,
} from "./control-plane-ownership.js";

/** Thin domain facade for crash-safe session continuation and rollover takeover. */
export class ControlPlaneContinuation {
  constructor(private readonly ownership: ControlPlaneOwnershipStore) {}

  /** Discovers latest unfinished continuation for context rollover. */
  latest(consumerContext: unknown): LatestContinuationResult {
    return this.ownership.latestContinuation(consumerContext);
  }

  /** Executes atomic takeover of an eligible continuation using lease CAS. */
  takeover(
    consumerContext: unknown,
    leaseId: string,
    expectedVersion: number,
    input: TakeoverInput,
  ): TakeoverReceipt {
    return this.ownership.takeover(consumerContext, leaseId, expectedVersion, input);
  }

  /** Reads existing takeover history under current owner/grant CAS. */
  readback(
    consumerContext: unknown,
    leaseId: string,
    previousVersion: number,
    expectedCurrentVersion: number,
  ): { receipt: TakeoverReceipt; currentLease: ResourceLease } {
    return this.ownership.readTakeover(consumerContext, leaseId, previousVersion, expectedCurrentVersion);
  }
}

export type { ContinuationCandidate, LatestContinuationResult, TakeoverInput, TakeoverReceipt };
