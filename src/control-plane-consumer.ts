import { ControlPlaneOwnershipError, ControlPlaneOwnershipStore, type ControlPlaneOwnershipOptions, type ReconciliationEvidence } from "./control-plane-ownership.js";

export interface EffectSubject {
  operationId: string;
  requestHash: string;
  workspaceRoot: string;
  baseRevision: string;
  operation: "dependency_sync" | "cutover_start";
}
export interface EffectBinding {
  leaseId: string;
  leaseVersion: number;
  requestHash: string;
  role: "controller" | "worker";
}
export interface DependencyReconciliationEvidence extends ReconciliationEvidence {
  requestHash: string;
  exitCode: number;
  frozenInputsUnchanged: boolean;
}
export interface ControlPlaneConsumerOptions extends ControlPlaneOwnershipOptions {
  readDependencyReconciliation?(context: unknown, subject: Readonly<EffectSubject>): DependencyReconciliationEvidence | undefined;
  /** Verifies an external terminal witness, including exit code and frozen-input result. */
  verifyDependencyReconciliation?(evidence: Readonly<DependencyReconciliationEvidence>, subject: Readonly<EffectSubject>): boolean;
  /** Trusted host injection, never populated from caller claims alone. Workers remain scoped workers. */
  resolveEffectBinding(context: unknown, subject: Readonly<EffectSubject>): EffectBinding | undefined;
}

/** Runs inside the durable store transaction. It creates no grants or independent database. */
export class ControlPlaneConsumer {
  constructor(private readonly ownership: ControlPlaneOwnershipStore, private readonly options: ControlPlaneConsumerOptions) {}

  cutoverBinding(context: unknown, subject: EffectSubject, binding: EffectBinding, pinnedVersion: number) {
    if (subject.operation !== "cutover_start" || binding.role !== "controller") throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "cutover requires controller authority");
    this.assertPinned(context, subject, binding, pinnedVersion);
    return Object.freeze({leaseId:binding.leaseId,pinnedLeaseVersion:pinnedVersion,operationHandle:subject.operationId,requestHash:subject.requestHash,ownerThread:this.ownership.get(binding.leaseId)!.ownerThread});
  }

  readHandoff(context: unknown, leaseId: string, previousVersion: number, expectedCurrentVersion: number) {
    return this.ownership.readHandoff(context, leaseId, previousVersion, expectedCurrentVersion);
  }

  authorize(context: unknown, subject: EffectSubject): EffectBinding {
    const binding = this.options.resolveEffectBinding(context, Object.freeze({...subject}));
    if (!binding || !["controller", "worker"].includes(binding.role) || binding.requestHash !== subject.requestHash) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "trusted effect binding required");
    const lease = this.ownership.assertHeld(context, binding.leaseId, binding.leaseVersion, subject.operation, subject.baseRevision);
    const normalizedRoot = subject.workspaceRoot.replaceAll("\\", "/");
    if (lease.scope.length !== 1 || lease.scope[0] !== normalizedRoot || lease.resource !== normalizedRoot) throw new ControlPlaneOwnershipError("OWNERSHIP_CONFLICT", "lease must bind the actual dependency workspace");
    return {...binding};
  }

  readReconciliation(context: unknown, subject: EffectSubject): DependencyReconciliationEvidence {
    const evidence = this.options.readDependencyReconciliation?.(context, Object.freeze({...subject}));
    if (!evidence) throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "trusted same-operation terminal witness is unavailable");
    return evidence;
  }

  reconcile(context: unknown, subject: EffectSubject, evidence: DependencyReconciliationEvidence): void {
    const proof = Object.freeze({...evidence});
    const binding = this.options.resolveEffectBinding(context, Object.freeze({...subject}));
    if (!binding || !["controller", "worker"].includes(binding.role) || binding.requestHash !== subject.requestHash ||
        proof.requestHash !== subject.requestHash || proof.operationHandle !== subject.operationId ||
        proof.baseRevision !== subject.baseRevision || proof.operation !== subject.operation ||
        proof.leaseId !== binding.leaseId || !Number.isInteger(proof.exitCode) ||
        typeof proof.frozenInputsUnchanged !== "boolean" ||
        !["finished", "failed"].includes(proof.state) ||
        this.options.verifyDependencyReconciliation?.(proof, Object.freeze({...subject})) !== true) {
      throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", "verified terminal effect witness required");
    }
    const currentBinding = this.options.resolveEffectBinding(context, Object.freeze({...subject}));
    if (JSON.stringify(currentBinding) !== JSON.stringify(binding)) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "terminal witness authority changed");
    const lease = this.ownership.get(binding.leaseId);
    if (!lease || lease.resource !== subject.workspaceRoot || lease.scope.length !== 1 || lease.scope[0] !== subject.workspaceRoot) {
      throw new ControlPlaneOwnershipError("CAS_CONFLICT", "reconciliation workspace changed");
    }
    const {requestHash, exitCode, frozenInputsUnchanged, ...ownershipProof} = proof;
    this.ownership.reconcile(context, binding.leaseId, proof.leaseVersion, {
      ...ownershipProof,
      detail: JSON.stringify({requestHash, exitCode, frozenInputsUnchanged, detail:proof.detail}),
    });
  }

  pin(context: unknown, subject: EffectSubject, expected: EffectBinding): number {
    const current = this.authorize(context, subject);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "effect authority changed before pin");
    return this.ownership.beginOperation(context, current.leaseId, current.leaseVersion, subject.operationId).version;
  }

  assertPinned(context: unknown, subject: EffectSubject, binding: EffectBinding, pinnedVersion: number): void {
    const current = this.authorize(context, subject);
    if (current.leaseId !== binding.leaseId || current.leaseVersion !== pinnedVersion || current.role !== binding.role) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "effect completion authority changed");
    const lease = this.ownership.get(binding.leaseId);
    if (lease?.operationHandle !== subject.operationId || lease.version !== pinnedVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "operation pin changed");
  }

  finish(context: unknown, subject: EffectSubject, binding: EffectBinding, pinnedVersion: number): void {
    this.assertPinned(context, subject, binding, pinnedVersion);
    this.ownership.finishOperation(context, binding.leaseId, pinnedVersion, subject.operationId);
  }
}
