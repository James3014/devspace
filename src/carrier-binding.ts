import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DurableOperationStore, planCutoverStart, cutoverTerminalRecordHash } from "./durable-operations.js";
import { CutoverStateStore, type CutoverServerIdentity } from "./cutover-state.js";
import { openDatabase } from "./db/client.js";
import { ControlPlaneOwnershipError, ControlPlaneOwnershipStore, normalizeRepositoryKey, type GrantEvidenceReference, type ReconciliationEvidence, type ResourceLease } from "./control-plane-ownership.js";
import type { ControlPlaneConsumerOptions, DependencyReconciliationEvidence, EffectSubject } from "./control-plane-consumer.js";
import type { CompletionReaders, CompletionSelection } from "./current-completion-matrix.js";

/** Host-selected evidence access only; this never grants resource authority. */
export interface CarrierCompletionBinding {
  repository: string;
  goal: string;
  subject: string;
  readers: CompletionReaders;
}

export function snapshotCarrierCompletionBindings(bindings: readonly CarrierCompletionBinding[]): readonly CarrierCompletionBinding[] {
  if (!Array.isArray(bindings)) throw new Error("Invalid completion reader bindings.");
  const result: CarrierCompletionBinding[] = [];
  const keys = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("Invalid completion reader binding.");
    const {repository,goal,subject,readers}=binding;
    if (!readers || typeof readers !== "object" || Array.isArray(readers)) throw new Error("Invalid completion reader binding.");
    const {readContract,readEvidence}=readers;
    if (typeof repository !== "string" || !repository.trim() ||
        typeof goal !== "string" || !goal.trim() || typeof subject !== "string" || !subject.trim() ||
        typeof readContract !== "function" || typeof readEvidence !== "function" ||
        Object.keys(binding).some(key=>!["repository","goal","subject","readers"].includes(key)) ||
        Object.keys(readers).some(key=>!["readContract","readEvidence"].includes(key))) {
      throw new Error("Invalid completion reader binding.");
    }
    const normalizedRepository=normalizeRepositoryKey(repository);
    const key = JSON.stringify([normalizedRepository, goal, subject]);
    if (keys.has(key)) throw new Error("Duplicate completion reader binding.");
    keys.add(key);
    result.push(Object.freeze({repository:normalizedRepository,goal,subject,readers:Object.freeze({readContract,readEvidence})}));
  }
  return Object.freeze(result);
}

export interface CarrierContract {
  repository: string;
  goal: string;
  role: "controller" | "worker";
  scope: string[];
  baseRevision: string;
  operations: Array<"dependency_sync" | "cutover_start">;
  expiresAt: string;
  cutover?: CarrierCutoverContract;
}
const nonempty=z.string().min(1).max(4096);
const revision=z.string().regex(/^[a-f0-9]{40,64}$/);
const timestamp=z.string().datetime();
const targetIdentity=z.object({sourceCommit:revision,buildId:nonempty,capabilityManifestSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const cutoverSchema=z.object({
  stateRoot:nonempty,attemptKey:nonempty,
  currentIdentity:targetIdentity.extend({serverInstanceId:nonempty}).strict(),
  expectedIdentity:targetIdentity,expiresAt:timestamp,
  restart:z.object({buildReady:z.object({verifiedBy:nonempty,verifiedAt:timestamp,evidence:nonempty}).strict(),actuator:z.literal("launchd-self"),serviceLabel:nonempty,launchdTarget:nonempty}).strict(),
  finish:z.object({workspaceId:nonempty,agentId:nonempty}).strict(),
}).strict();
export type CarrierCutoverContract=z.infer<typeof cutoverSchema>;
interface BindingRow {
  id: string; client_id: string; credential_hash: string; parent_id: string | null;
  version: number; revoked: number; contract_json: string;
}
interface PairingRow {
  id: string; client_id: string; session_id: string; credential_hash: string;
  expires_at: number; binding_id: string | null;
}
interface Validity { version: number; expires_at: string; }
interface Binding { row: BindingRow; contract: CarrierContract; root: BindingRow; validity: Validity; generation: string; }
const subjectJson = (s: EffectSubject) => JSON.stringify({operationId:s.operationId,requestHash:s.requestHash,workspaceRoot:s.workspaceRoot,baseRevision:s.baseRevision,operation:s.operation});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function deny(message = "A current paired carrier is required"): never {
  throw new ControlPlaneOwnershipError("AUTHORITY_REQUIRED", message);
}
function physical(path: string): string {
  if (!isAbsolute(path)) deny("Scope must be an absolute existing path");
  return realpathSync.native(path).replaceAll("\\", "/");
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"));
}
function transport(context: unknown): {clientId: string; sessionId: string} {
  const value = context as {clientId?: unknown; sessionId?: unknown} | undefined;
  if (typeof value?.clientId !== "string" || !value.clientId || typeof value.sessionId !== "string" || !value.sessionId) deny();
  return {clientId:value.clientId,sessionId:value.sessionId};
}

/** Local approval is intentionally not an MCP method. Sessions prove credential possession;
 * neither OAuth client IDs nor caller-provided conversation metadata prove carrier identity. */
export class CarrierBindingStore {
  private readonly database;
  private readonly sessions = new Map<string, string>();
  private readonly recipients = new WeakMap<object, string>();
  readonly readers: ControlPlaneConsumerOptions;
  readonly ownership: ControlPlaneOwnershipStore;

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now, completionBindings: readonly CarrierCompletionBinding[] = []) {
    const completions = new Map(snapshotCarrierCompletionBindings(completionBindings).map(binding=>[
      JSON.stringify([binding.repository,binding.goal,binding.subject]),binding.readers,
    ]));
    const readCompletion = (context: unknown, selection: Readonly<CompletionSelection>, hook: keyof CompletionReaders) => {
      const before = this.current(context);
      const selected = Object.freeze({...selection});
      if (selected.goal !== before.contract.goal) deny("Completion selection exceeds carrier authority");
      const readers = completions.get(JSON.stringify([before.contract.repository, selected.goal, selected.subject]));
      if (!readers) deny("Trusted completion source binding is unavailable");
      const value = readers[hook](selected);
      const after = this.current(context);
      if (before.row.id !== after.row.id || before.generation !== after.generation) deny("Completion authority changed during read");
      return value;
    };
    this.database = openDatabase(stateDir);
    this.readers = {
      now,
      ...(completions.size ? {
        readCompletionContract: (context: unknown, selection: Readonly<CompletionSelection>) => readCompletion(context, selection, "readContract"),
        readCompletionEvidence: (context: unknown, selection: Readonly<CompletionSelection>) => readCompletion(context, selection, "readEvidence"),
      } : {}),
      resolveOwnerContext: context => ({ownerThread:this.current(context).row.id}),
      verifyGrantEvidence: (grant, owner) => {
        const binding = this.active(owner.ownerThread);
        return JSON.stringify(grant) === JSON.stringify(this.grant(binding));
      },
      resolveEffectBinding: (context, subject) => {
        const binding = this.current(context);
        this.assertSubject(binding.contract, subject);
        if(binding.contract.cutover && Date.parse(binding.contract.cutover.expiresAt)<=this.now()) {
          const persisted=this.database.sqlite.prepare("select request_hash from durable_operations where operation_id=? and kind='cutover_start'").get(subject.operationId) as {request_hash:string}|undefined;
          if(!persisted || persisted.request_hash!==subject.requestHash) deny("Cutover approval expired; only persisted reconciliation is permitted");
        }
        const lease = this.effectLease(binding,subject);
        if (!lease) return undefined;
        return {leaseId:lease.leaseId,leaseVersion:lease.version,requestHash:subject.requestHash,role:binding.contract.role,authorityVersion:binding.generation};
      },
      approveCutoverLifecycle: (context,subject,action) => {
        const binding=this.current(context), approved=binding.contract.cutover;
        this.assertSubject(binding.contract,subject);
        if(!approved || binding.row.parent_id || binding.contract.role!=="controller") return false;
        const file=new CutoverStateStore(approved.stateRoot).get();
        if(!file || file.cutoverId!==action.cutoverId || file.coordinationBinding?.operationHandle!==subject.operationId ||
          file.coordinationBinding.requestHash!==subject.requestHash || file.coordinationBinding.ownerThread!==binding.row.id) return false;
        if(action.action==="finish") {
          const {serverInstanceId,...identity}=action.currentIdentity;
          return !!serverInstanceId && serverInstanceId!==approved.currentIdentity.serverInstanceId &&
            isDeepStrictEqual(identity,approved.expectedIdentity) && isDeepStrictEqual(action,{action:"finish",cutoverId:file.cutoverId,currentIdentity:action.currentIdentity,preferredPair:approved.finish});
        }
        if(Date.parse(approved.expiresAt)<=this.now()) return false;
        if(action.action==="drain") return isDeepStrictEqual(action,{action:"drain",cutoverId:file.cutoverId,currentIdentity:approved.currentIdentity});
        return action.action==="restart" && isDeepStrictEqual(action,{action:"restart",cutoverId:file.cutoverId,currentIdentity:approved.currentIdentity,buildReady:approved.restart.buildReady,
          actuator:{actuator:approved.restart.actuator,serviceLabel:approved.restart.serviceLabel,launchdTarget:approved.restart.launchdTarget}});
      },
      readDependencyReconciliation: (context,subject) => {
        const binding=this.current(context);
        this.assertSubject(binding.contract,subject);
        const lease=this.effectLease(binding,subject);
        if(!lease || (lease.operationHandle!==undefined && lease.operationHandle!==subject.operationId)) return undefined;
        if(lease.operationHandle===undefined) {
          const previous=this.database.sqlite.prepare("select evidence_json from control_plane_reconciliation_receipts where lease_id=? and new_version=?").get(lease.leaseId,lease.version) as {evidence_json:string}|undefined;
          if(!previous) return undefined;
          const proof=JSON.parse(previous.evidence_json);
          const detail=JSON.parse(proof.detail??"{}");
          if(proof.ownerThread!==binding.row.id || proof.operationHandle!==subject.operationId || detail.requestHash!==subject.requestHash) return undefined;
          const {detail:_,...identity}=proof;
          return {...identity,requestHash:detail.requestHash,exitCode:detail.exitCode,frozenInputsUnchanged:detail.frozenInputsUnchanged};
        }
        const witness=this.terminal(subject.operationId);
        if(!witness || witness.request_hash!==subject.requestHash || witness.lease_id!==lease.leaseId) return undefined;
        return {leaseId:lease.leaseId,ownerThread:lease.ownerThread,operationHandle:subject.operationId,operation:subject.operation,baseRevision:subject.baseRevision,leaseVersion:lease.version,
          state:witness.exit_code===0 && witness.frozen_inputs_unchanged===1 ? "finished" : "failed",requestHash:subject.requestHash,exitCode:witness.exit_code,frozenInputsUnchanged:witness.frozen_inputs_unchanged===1};
      },
      verifyDependencyReconciliation: (evidence,subject) => this.verifyTerminal(evidence,subject),
      verifyReconciliationEvidence: (evidence,lease,owner) => {
        this.active(owner.ownerThread);
        if(evidence.operation==="cutover_start") return this.verifyCutoverTerminal(evidence,lease,owner.ownerThread);
        let detail: {requestHash?:unknown;exitCode?:unknown;frozenInputsUnchanged?:unknown};
        try {detail=JSON.parse(evidence.detail??"");} catch {return false;}
        const witness=this.terminal(evidence.operationHandle);
        return !!witness && witness.lease_id===lease.leaseId && lease.ownerThread===owner.ownerThread && evidence.operationHandle===lease.operationHandle &&
          witness.request_hash===detail.requestHash && witness.exit_code===detail.exitCode && (witness.frozen_inputs_unchanged===1)===detail.frozenInputsUnchanged &&
          evidence.state===(witness.exit_code===0 && witness.frozen_inputs_unchanged===1?"finished":"failed");
      },
      resolveHandoffRecipient: (context, handle, lease, receipt) => {
        const sender=this.current(context), recipient=this.active(handle);
        if(sender.contract.cutover || recipient.contract.cutover || lease.operation==="cutover_start") deny("Cutover authority cannot be transferred");
        if (sender.contract.role !== "controller" || sender.contract.repository !== recipient.contract.repository || sender.contract.goal !== recipient.contract.goal || sender.contract.baseRevision !== recipient.contract.baseRevision) deny();
        if(lease.ownerThread!==sender.row.id || lease.baseRevision!==recipient.contract.baseRevision ||
          !recipient.contract.operations.includes(lease.operation as "dependency_sync") ||
          lease.scope.some(path=>!recipient.contract.scope.some(root=>contains(root,physical(path)))) ||
          Date.parse(receipt.expiresAt)>Date.parse(recipient.validity.expires_at)) deny("Transferred lease exceeds recipient authority");
        const proof = Object.freeze({});
        this.recipients.set(proof,handle);
        return proof;
      },
    };
    this.ownership = new ControlPlaneOwnershipStore(this.database.sqlite,this.readers);
  }

  close(): void { this.sessions.clear(); this.database.close(); }
  forgetSession(sessionId: string): void {
    for (const key of this.sessions.keys()) if ((JSON.parse(key) as string[])[1] === sessionId) this.sessions.delete(key);
  }
  requestPairing(context: unknown): {pendingId:string; credential:string; expiresAt:string} {
    const principal=transport(context), credential=randomBytes(32).toString("base64url");
    const id=`pair_${randomUUID()}`, expires=this.now()+10*60*1000;
    this.database.sqlite.prepare("insert into carrier_pairings(id,client_id,session_id,credential_hash,expires_at) values(?,?,?,?,?)")
      .run(id,principal.clientId,principal.sessionId,digest(credential),expires);
    return {pendingId:id,credential,expiresAt:new Date(expires).toISOString()};
  }
  pending(id: string) {
    const row=this.database.sqlite.prepare("select id,client_id,session_id,expires_at,binding_id from carrier_pairings where id=?").get(id) as Omit<PairingRow,"credential_hash">|undefined;
    if (!row || row.expires_at<=this.now()) deny("Pairing request missing or expired");
    return row;
  }
  /** Owner-local bootstrap. Caller supplies an explicit bounded contract, never implicit defaults. */
  approveLocal(pendingId: string, contract: CarrierContract) {
    return this.database.sqlite.transaction(()=>this.issue(pendingId,contract,null)).immediate();
  }
  /** Owner-local recovery rebinds one pending verifier to the same durable carrier. It never creates authority. */
  recoverLocal(pendingId: string, carrierId: string, expectedVersion: number, expectedValidityVersion: number) {
    return this.database.sqlite.transaction(()=>{
      const pending=this.database.sqlite.prepare("select * from carrier_pairings where id=?").get(pendingId) as PairingRow|undefined;
      if(!pending || pending.expires_at<=this.now()) deny("Recovery request missing or expired");
      const before=this.active(carrierId);
      if(before.row.client_id!==pending.client_id) deny("Recovery request OAuth client does not match carrier");
      if(before.row.version!==expectedVersion || before.validity.version!==expectedValidityVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier or validity version changed");
      if(pending.binding_id) {
        if(pending.binding_id!==carrierId || before.row.credential_hash!==pending.credential_hash) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Recovery request already consumed by different state");
        return {carrier:this.public(before),replayed:true};
      }
      const previousHash=before.row.credential_hash;
      const update=this.database.sqlite.prepare("update carrier_bindings set credential_hash=? where id=? and version=? and revoked=0 and credential_hash=?")
        .run(pending.credential_hash,carrierId,expectedVersion,previousHash);
      if(update.changes!==1) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier credential changed");
      this.database.sqlite.prepare("delete from carrier_pairings where binding_id=? and credential_hash=?")
        .run(carrierId,previousHash);
      const claim=this.database.sqlite.prepare("update carrier_pairings set binding_id=? where id=? and binding_id is null")
        .run(carrierId,pendingId);
      if(claim.changes!==1) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Recovery request raced");
      const after=this.active(carrierId);
      if(after.row.version!==before.row.version || after.validity.version!==before.validity.version || after.generation!==before.generation || JSON.stringify(after.contract)!==JSON.stringify(before.contract) || JSON.stringify(this.grant(after))!==JSON.stringify(this.grant(before))) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Recovery changed carrier authority");
      return {carrier:this.public(after),replayed:false};
    }).immediate();
  }
  /** CLI root validation does not turn the state resource into an allowed workspace. */
  validateLocalScope(input: CarrierContract, allowedRoots: string[]): CarrierContract {
    const contract=this.validateContract(input,false);
    if(!contract.cutover && contract.scope.some(path=>!allowedRoots.some(root=>contains(physical(root),path)))) deny("Carrier scope exceeds configured roots");
    return contract;
  }
  delegate(context: unknown, pendingId: string, contract: CarrierContract) {
    return this.database.sqlite.transaction(()=>{
      const parent=this.current(context);
      if(parent.contract.cutover || contract.cutover || contract.operations.includes("cutover_start")) deny("Cutover authority cannot be delegated");
      if(parent.contract.role!=="controller") deny("Workers cannot delegate or promote themselves");
      const child=this.validateContract(contract);
      if(child.role!=="worker") deny("Delegation cannot create a controller");
      this.assertNarrower(parent.contract,child);
      if(Date.parse(child.expiresAt)>Date.parse(parent.validity.expires_at)) deny("Delegation exceeds current parent validity");
      return this.issue(pendingId,child,parent.row.id);
    }).immediate();
  }
  redeem(context: unknown, credentialOrOptions: string | { pendingId?: string; credential?: string; token?: string }) {
    const principal=transport(context);
    const options = typeof credentialOrOptions === "string" ? { credential: credentialOrOptions } : (credentialOrOptions ?? {});
    const cred = options.token ?? options.credential;
    const pendingId = options.pendingId;

    if (!cred && !pendingId) deny("A valid pendingId or credential token is required");

    let bindingId: string | undefined;

    if (cred) {
      if(typeof cred!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(cred)) deny();
      const credHash = digest(cred);
      const row=this.database.sqlite.prepare("select id from carrier_bindings where credential_hash=? and client_id=?").get(credHash,principal.clientId) as {id:string}|undefined;
      if (row) {
        bindingId = row.id;
      } else {
        const pairing = this.database.sqlite.prepare("select id,client_id,session_id,expires_at,binding_id from carrier_pairings where credential_hash=? and client_id=?").get(credHash, principal.clientId) as PairingRow | undefined;
        if (pairing) {
          if (pairing.expires_at <= this.now()) {
            throw new ControlPlaneOwnershipError("EXPIRED", `Pairing ${pairing.id} has expired. Request a new pairing via coordination_pair.`);
          }
          if (!pairing.binding_id) {
            throw new ControlPlaneOwnershipError(
              "AUTHORITY_REQUIRED",
              `Pairing ${pairing.id} is awaiting host Owner approval. Run in terminal: devspace carriers approve ${pairing.id} --contract <contract.json> --confirm ${pairing.id}`,
            );
          }
          bindingId = pairing.binding_id;
        } else {
          deny();
        }
      }
    } else if (pendingId) {
      if (typeof pendingId !== "string" || !/^pair_[A-Za-z0-9_-]+$/.test(pendingId)) deny("Invalid pendingId format");
      const pairing = this.database.sqlite.prepare("select id,client_id,session_id,expires_at,binding_id from carrier_pairings where id=? and client_id=?").get(pendingId, principal.clientId) as PairingRow | undefined;
      if (!pairing) deny("Pairing request not found");
      if (pairing.expires_at <= this.now()) {
        throw new ControlPlaneOwnershipError("EXPIRED", `Pairing ${pairing.id} has expired. Request a new pairing via coordination_pair.`);
      }
      if (!pairing.binding_id) {
        throw new ControlPlaneOwnershipError(
          "AUTHORITY_REQUIRED",
          `Pairing ${pairing.id} is awaiting host Owner approval. Run in terminal: devspace carriers approve ${pairing.id} --contract <contract.json> --confirm ${pairing.id}`,
        );
      }
      if (pairing.session_id !== principal.sessionId) {
        deny("Pairing belongs to a different session; verification token is required to resume from another session");
      }
      bindingId = pairing.binding_id;
    }

    if (!bindingId) deny();
    const binding=this.active(bindingId);
    const key=JSON.stringify([principal.clientId,principal.sessionId]);
    const existing=this.sessions.get(key);
    if(existing && existing!==bindingId) deny("An MCP session cannot change its carrier");
    this.sessions.set(key,bindingId);
    return this.public(binding);
  }
  status(context: unknown) { return this.public(this.current(context)); }
  inspectLocal(id: string) {
    const row=this.database.sqlite.prepare("select id,parent_id,version,revoked,contract_json from carrier_bindings where id=?").get(id) as Omit<BindingRow,"client_id"|"credential_hash">|undefined;
    if(!row) deny("Missing carrier record");
    const validity=this.readValidity(id);
    return {id:row.id,parentId:row.parent_id,version:row.version,revoked:row.revoked!==0,contract:this.validateContract(JSON.parse(row.contract_json),false),validity:{version:validity.version,expiresAt:validity.expires_at}};
  }
  /**
   * Owner-local bridge for one already-approved DRAINED cutover generation.
   * This mints no authority and persists nothing: it only projects the exact
   * existing root carrier into an opaque in-process context consumed by the
   * same ControlPlaneConsumer lifecycle checks used by MCP sessions.
   */
  localDrainedCutoverContext(input: {
    cutoverId: string;
    carrierId: string;
    expectedVersion: number;
    expectedValidityVersion: number;
    carrierCredential: string;
    confirmCutoverId: string;
  }) {
    if(input.confirmCutoverId!==input.cutoverId) deny("Restart confirmation must equal the exact cutover id");
    if(!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1 ||
      !Number.isSafeInteger(input.expectedValidityVersion) || input.expectedValidityVersion<1) {
      throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier or validity version is invalid");
    }
    return this.database.sqlite.transaction(()=>{
      const binding=this.active(input.carrierId);
      if(typeof input.carrierCredential!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(input.carrierCredential) ||
        digest(input.carrierCredential)!==binding.row.credential_hash) {
        deny("Local cutover restart requires possession of the current carrier credential");
      }
      if(binding.row.version!==input.expectedVersion || binding.validity.version!==input.expectedValidityVersion) {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier or validity version changed");
      }
      const approved=binding.contract.cutover;
      if(binding.row.parent_id || binding.contract.role!=="controller" || !approved ||
        binding.contract.operations.length!==1 || binding.contract.operations[0]!=="cutover_start") {
        deny("Local cutover restart requires the exact root controller cutover authority");
      }
      if(physical(approved.stateRoot)!==physical(this.stateDir)) {
        deny("Local cutover restart state root differs from approved authority");
      }
      const plan=planCutoverStart(approved.stateRoot,approved);
      const file=new CutoverStateStore(approved.stateRoot).get();
      if(!file || file.cutoverId!==input.cutoverId || file.phase!=="drained" || !file.coordinationBinding) {
        deny("Local cutover restart requires the exact drained coordination-bound generation");
      }
      if(file.coordinationBinding.ownerThread!==binding.row.id ||
        file.coordinationBinding.operationHandle!==plan.operationId ||
        file.coordinationBinding.requestHash!==plan.requestHash ||
        !isDeepStrictEqual(file.oldServerIdentity,approved.currentIdentity) ||
        !isDeepStrictEqual(file.expectedNewIdentity,approved.expectedIdentity) ||
        file.expiresAt!==approved.expiresAt) {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Cutover generation differs from approved carrier contract");
      }
      const lease=this.effectLease(binding,plan.subject);
      if(!lease || lease.leaseId!==file.coordinationBinding.leaseId ||
        lease.version!==file.coordinationBinding.pinnedLeaseVersion ||
        lease.operationHandle!==plan.operationId ||
        lease.ownerThread!==binding.row.id) {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Cutover lease differs from approved generation");
      }
      const context=Object.freeze({});
      this.recipients.set(context,binding.row.id);
      return {context,carrier:this.public(binding),cutover:approved,lease};
    }).immediate();
  }

  /** Local credential recovery state exposes only a high-entropy verifier hash, never the verifier itself. */
  credentialRotationStateLocal(id: string, expectedVersion: number, expectedValidityVersion: number) {
    const before=this.active(id);
    if(before.row.version!==expectedVersion || before.validity.version!==expectedValidityVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier or validity version changed");
    return {carrier:this.public(before),credentialHash:before.row.credential_hash};
  }
  /** Local credential rotation changes only verifier possession; authority, grant and validity stay fixed. */
  rotateCredentialLocal(id: string, expectedVersion: number, expectedValidityVersion: number, expectedCredentialHash: string, credential: string) {
    if(!/^[a-f0-9]{64}$/.test(expectedCredentialHash)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Invalid expected credential hash");
    if(!/^[A-Za-z0-9_-]{43}$/.test(credential)) deny("Invalid replacement credential");
    return this.database.sqlite.transaction(()=>{
      const before=this.active(id);
      if(before.row.version!==expectedVersion || before.validity.version!==expectedValidityVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier or validity version changed");
      const nextHash=digest(credential);
      if(before.row.credential_hash===nextHash) return {carrier:this.public(before),credentialHash:nextHash,replayed:true};
      if(before.row.credential_hash!==expectedCredentialHash) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier credential changed");
      const update=this.database.sqlite.prepare("update carrier_bindings set credential_hash=? where id=? and version=? and revoked=0 and credential_hash=?")
        .run(nextHash,id,expectedVersion,expectedCredentialHash);
      if(update.changes!==1) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier credential changed");
      this.database.sqlite.prepare("update carrier_pairings set credential_hash=? where binding_id=? and credential_hash=?")
        .run(nextHash,id,expectedCredentialHash);
      const after=this.active(id);
      if(after.row.version!==before.row.version || after.validity.version!==before.validity.version || after.generation!==before.generation || JSON.stringify(after.contract)!==JSON.stringify(before.contract) || JSON.stringify(this.grant(after))!==JSON.stringify(this.grant(before))) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Credential rotation changed carrier authority");
      return {carrier:this.public(after),credentialHash:nextHash,replayed:false};
    }).immediate();
  }
  /** Local validity approval never changes immutable authority or revocation. */
  reauthorizeLocal(id: string, expectedValidityVersion: number, expiresAt: string) {
    return this.database.sqlite.transaction(()=>{
      const binding=this.active(id,new Set(),true);
      if(!Number.isSafeInteger(expectedValidityVersion) || expectedValidityVersion<1 || expectedValidityVersion>=Number.MAX_SAFE_INTEGER || binding.validity.version!==expectedValidityVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Validity version changed");
      const now=this.now(), expiry=Date.parse(expiresAt);
      if(typeof expiresAt!=="string" || !Number.isFinite(expiry) || new Date(expiry).toISOString()!==expiresAt || expiry<=now || expiry>now+24*60*60*1000 || expiry<=Date.parse(binding.validity.expires_at)) deny("Validity approval must extend expiry within the 24-hour lease bound");
      if(binding.row.parent_id && expiry>Date.parse(this.active(binding.row.parent_id).validity.expires_at)) deny("Validity exceeds current parent authorization");
      const update=this.database.sqlite.prepare("update carrier_validity set version=version+1,expires_at=? where carrier_id=? and version=?").run(expiresAt,id,expectedValidityVersion);
      if(update.changes!==1) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Validity approval raced");
      return this.public(this.active(id));
    }).immediate();
  }

  /**
   * Host-local terminal recovery for one expired coordination-bound PREPARED cutover
   * that never recorded drain or restart effects. This does not renew carrier validity,
   * mint new authority, schedule a restart, or touch a different cutover generation.
   */
  recoverExpiredPreparedCutoverLocal(input: {
    cutoverId: string;
    carrierId: string;
    expectedVersion: number;
    expectedValidityVersion: number;
    confirmCutoverId: string;
  }) {
    if(input.confirmCutoverId!==input.cutoverId) deny("Recovery confirmation must equal the exact cutover id");
    const cutoverStore=new CutoverStateStore(this.stateDir,{now:this.now});
    const before=cutoverStore.get();
    if(!before || before.cutoverId!==input.cutoverId || !before.coordinationBinding) deny("Exact coordination-bound cutover is required");
    const binding=this.active(input.carrierId,new Set(),true);
    if(binding.row.id!==before.coordinationBinding.ownerThread || binding.row.version!==input.expectedVersion || binding.validity.version!==input.expectedValidityVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier recovery identity or version changed");
    if(binding.row.parent_id || binding.contract.role!=="controller" || !binding.contract.cutover || binding.contract.operations.length!==1 || binding.contract.operations[0]!=="cutover_start") deny("Expired prepared recovery requires the exact root controller cutover authority");
    if(Date.parse(binding.validity.expires_at)>this.now() || Date.parse(binding.contract.cutover.expiresAt)>this.now()) deny("Expired prepared recovery requires both carrier validity and cutover approval to be expired");
    const approved=binding.contract.cutover;
    if(physical(approved.stateRoot)!==physical(this.stateDir) || !isDeepStrictEqual(before.oldServerIdentity,approved.currentIdentity) || !isDeepStrictEqual(before.expectedNewIdentity,approved.expectedIdentity) || before.expiresAt!==approved.expiresAt) deny("Expired prepared recovery contract does not match the durable cutover generation");
    if(before.phase!=="prepared" && !(before.phase==="closed" && before.expiredPreparedNoEffect)) deny("Expired prepared recovery refuses a non-prepared generation");
    if(before.drainEvidence || before.restartRequest || before.observedReplacement || before.supersession) deny("Expired prepared recovery refuses any drain, restart, observed-replacement, or supersession evidence");
    const plan=planCutoverStart(this.stateDir,approved);
    const correlation=before.coordinationBinding;
    if(plan.subject.operationId!==correlation.operationHandle || plan.requestHash!==correlation.requestHash) deny("Expired prepared recovery operation correlation changed");

    const operations=new DurableOperationStore(this.stateDir);
    try {
      const operation=operations.getByOperationId(correlation.operationHandle);
      if(!operation || operation.kind!=="cutover_start" || operation.status!=="succeeded" || operation.requestHash!==correlation.requestHash || operation.scopeRoot!==physical(this.stateDir)) deny("Expired prepared recovery requires the exact successful cutover_start intent");
      const {coordinationBinding,...request}=operation.request;
      if(!isDeepStrictEqual(coordinationBinding,correlation) || !isDeepStrictEqual(request,plan.request) || operation.receipt?.cutoverId!==before.cutoverId || operation.receipt?.startVerified!==true || operation.receipt?.restartAction!==undefined || operation.receipt?.restartState!==undefined) deny("Expired prepared recovery durable operation binding changed");

      const localContext=Object.freeze({});
      const grant=this.grant(binding);
      const recoveryDetail=JSON.stringify({kind:"cutover_expired_prepared_no_effect",cutoverId:input.cutoverId,requestHash:correlation.requestHash,drainObserved:false,restartRequested:false,restartScheduled:false});
      const localOwnership=operations.createOwnershipStore({
        now:this.now,
        resolveOwnerContext: context=>context===localContext?{ownerThread:binding.row.id}:undefined,
        resolveEffectBinding: ()=>undefined,
        verifyGrantEvidence: (candidate,owner)=>owner.ownerThread===binding.row.id && isDeepStrictEqual(candidate,grant),
        verifyReconciliationEvidence: (evidence,lease,owner)=>{
          const current=cutoverStore.get();
          if(!current || current.cutoverId!==input.cutoverId || !current.coordinationBinding) return false;
          if(current.phase!=="prepared" && !(current.phase==="closed" && current.expiredPreparedNoEffect)) return false;
          if(current.drainEvidence || current.restartRequest || current.observedReplacement || current.supersession) return false;
          return owner.ownerThread===binding.row.id && lease.leaseId===correlation.leaseId && lease.ownerThread===binding.row.id && lease.operation==="cutover_start" && lease.baseRevision===binding.contract.baseRevision && lease.operationHandle===correlation.operationHandle && evidence.leaseId===lease.leaseId && evidence.ownerThread===lease.ownerThread && evidence.operationHandle===correlation.operationHandle && evidence.operation==="cutover_start" && evidence.baseRevision===lease.baseRevision && evidence.leaseVersion===correlation.pinnedLeaseVersion && evidence.state==="finished" && evidence.detail===recoveryDetail;
        },
      });
      const lease=localOwnership.get(correlation.leaseId);
      if(!lease || lease.ownerThread!==binding.row.id || lease.operation!=="cutover_start" || lease.baseRevision!==binding.contract.baseRevision || lease.resource!==physical(this.stateDir) || lease.scope.length!==1 || lease.scope[0]!==physical(this.stateDir) || Date.parse(lease.expiresAt)>this.now()) deny("Expired prepared recovery lease binding changed or is not expired");
      if(lease.version!==correlation.pinnedLeaseVersion && !(lease.version===correlation.pinnedLeaseVersion+1 && lease.terminalState==="expired_reconciled" && lease.operationState==="finished" && lease.operationHandle===undefined)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Expired prepared recovery lease version changed");
      if(lease.version===correlation.pinnedLeaseVersion && (lease.terminalState || lease.operationState!=="active" || lease.operationHandle!==correlation.operationHandle)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Expired prepared recovery requires the original active pin");

      // Reconcile the ownership pin before opening the global cutover fence. If the
      // process crashes after this point, the prepared cutover still blocks all
      // consequential MCP work and a replay can safely finish the remaining steps.
      const evidence:ReconciliationEvidence={leaseId:correlation.leaseId,ownerThread:binding.row.id,operationHandle:correlation.operationHandle,operation:"cutover_start",baseRevision:binding.contract.baseRevision,leaseVersion:correlation.pinnedLeaseVersion,state:"finished",detail:recoveryDetail};
      const reconciliation=localOwnership.reconcile(localContext,correlation.leaseId,correlation.pinnedLeaseVersion,evidence);
      const afterLease=cutoverStore.get();
      if(!afterLease || afterLease.cutoverId!==before.cutoverId || (before.phase==="prepared" && !isDeepStrictEqual(afterLease,before)) || (before.phase==="closed" && !isDeepStrictEqual(afterLease,before))) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Expired prepared recovery cutover changed after lease reconciliation");

      const recovered=cutoverStore.recoverExpiredPreparedNoEffect({cutoverId:input.cutoverId,recoveredBy:binding.row.id});
      const terminalHash=cutoverTerminalRecordHash(recovered.record);
      const current=operations.getByOperationId(correlation.operationHandle);
      if(!current || current.requestHash!==operation.requestHash || !isDeepStrictEqual(current.request,operation.request)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Expired prepared recovery durable intent changed");
      if(current.receipt?.lifecycleTerminal===true) {
        if(current.receipt?.terminalRecordHash!==terminalHash || current.receipt?.recoveryKind!=="expired_prepared_no_effect" || !isDeepStrictEqual(current.receipt?.expiredLeaseRecovery,reconciliation)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Expired prepared recovery terminal receipt changed");
      } else {
        operations.finish(correlation.operationHandle,{status:"succeeded",retrySafe:false,receipt:{...current.receipt,lifecycleTerminal:true,terminalRecordHash:terminalHash,recoveryKind:"expired_prepared_no_effect",expiredLeaseRecovery:reconciliation}});
      }
      const finalOperation=operations.getByOperationId(correlation.operationHandle)!;
      const finalLease=localOwnership.get(correlation.leaseId)!;
      const finalCutover=cutoverStore.get()!;
      if(finalCutover.phase!=="closed" || !finalCutover.expiredPreparedNoEffect || finalLease.terminalState!=="expired_reconciled" || finalLease.operationHandle!==undefined || finalLease.operationState!=="finished" || finalOperation.receipt?.lifecycleTerminal!==true || finalOperation.receipt?.terminalRecordHash!==cutoverTerminalRecordHash(finalCutover)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Expired prepared recovery final readback is incomplete");
      return {cutover:finalCutover,lease:finalLease,reconciliation,operation:finalOperation,replayed:!recovered.newlyRecovered};
    } finally {operations.close();}
  }
  /**
   * Host-local terminal recovery for one coordination-bound DRAINED cutover whose
   * replacement loaded the exact expected source/build but a different capability
   * manifest. This records a failed attempt, reconciles the original pin, and releases
   * the lease. It never accepts the replacement, changes the expected target, or
   * schedules restart. Digest-domain mistakes remain owned by binding repair.
   */
  recoverCapabilityExpectationMismatchLocal(input: {
    cutoverId: string;
    carrierId: string;
    expectedVersion: number;
    expectedValidityVersion: number;
    confirmCutoverId: string;
    observedIdentity: CutoverServerIdentity;
  }) {
    if(input.confirmCutoverId!==input.cutoverId) deny("Recovery confirmation must equal the exact cutover id");
    const cutoverStore=new CutoverStateStore(this.stateDir,{now:this.now});
    const before=cutoverStore.get();
    if(!before || before.cutoverId!==input.cutoverId || !before.coordinationBinding) deny("Exact coordination-bound cutover is required");
    const binding=this.active(input.carrierId,new Set(),true);
    if(binding.row.id!==before.coordinationBinding.ownerThread || binding.row.version!==input.expectedVersion || binding.validity.version!==input.expectedValidityVersion) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Carrier recovery identity or version changed");
    if(binding.row.parent_id || binding.contract.role!=="controller" || !binding.contract.cutover || binding.contract.operations.length!==1 || binding.contract.operations[0]!=="cutover_start") deny("Capability expectation recovery requires the exact root controller cutover authority");
    const approved=binding.contract.cutover;
    if(physical(approved.stateRoot)!==physical(this.stateDir) || !isDeepStrictEqual(before.oldServerIdentity,approved.currentIdentity) || !isDeepStrictEqual(before.expectedNewIdentity,approved.expectedIdentity) || before.expiresAt!==approved.expiresAt) deny("Capability expectation recovery contract does not match the durable cutover generation");
    if(before.phase!=="drained" && !(before.phase==="closed" && before.capabilityExpectationMismatch)) deny("Capability expectation recovery requires the drained generation");
    if(!before.drainEvidence || !before.restartRequest?.restartScheduledAt || !before.restartRequest.restartScheduledForServerInstanceId) deny("Capability expectation recovery requires durable drain and scheduled restart evidence");
    if(before.observedReplacement || before.expiredPreparedNoEffect || before.supersession || before.bindingRepair) deny("Capability expectation recovery refuses conflicting terminal or repair evidence");
    if(input.observedIdentity.serverInstanceId===approved.currentIdentity.serverInstanceId ||
       input.observedIdentity.sourceCommit!==approved.expectedIdentity.sourceCommit ||
       input.observedIdentity.buildId!==approved.expectedIdentity.buildId ||
       !input.observedIdentity.capabilityManifestSha256 ||
       !approved.expectedIdentity.capabilityManifestSha256 ||
       input.observedIdentity.capabilityManifestSha256===approved.expectedIdentity.capabilityManifestSha256) {
      deny("Capability expectation recovery requires an exact replacement source/build whose observed capability differs from the bound expected capability");
    }
    if(before.restartRequest.requestedByServerInstanceId!==approved.currentIdentity.serverInstanceId ||
       before.restartRequest.restartScheduledForServerInstanceId!==approved.currentIdentity.serverInstanceId) deny("Capability expectation recovery restart lineage changed");

    const plan=planCutoverStart(this.stateDir,approved);
    const correlation=before.coordinationBinding;
    if(plan.subject.operationId!==correlation.operationHandle || plan.requestHash!==correlation.requestHash) deny("Capability expectation recovery operation correlation changed");

    const operations=new DurableOperationStore(this.stateDir);
    try {
      const operation=operations.getByOperationId(correlation.operationHandle);
      const terminalReplay=operation?.status==="failed" && operation.receipt?.lifecycleTerminal===true && operation.receipt?.recoveryKind==="capability_expectation_mismatch";
      if(!operation || operation.kind!=="cutover_start" || (operation.status!=="succeeded" && !terminalReplay) || operation.requestHash!==correlation.requestHash || operation.scopeRoot!==physical(this.stateDir)) deny("Capability expectation recovery requires the exact successful cutover_start intent or its exact terminal replay");
      const {coordinationBinding,...request}=operation.request;
      const expectedActuator={actuator:approved.restart.actuator,serviceLabel:approved.restart.serviceLabel,launchdTarget:approved.restart.launchdTarget};
      const restartAction=operation.receipt?.restartAction as {action?:unknown;cutoverId?:unknown;currentIdentity?:unknown;buildReady?:unknown;actuator?:unknown}|undefined;
      if(!isDeepStrictEqual(coordinationBinding,correlation) || !isDeepStrictEqual(request,plan.request) || operation.receipt?.cutoverId!==before.cutoverId || operation.receipt?.startVerified!==true ||
         !restartAction || restartAction.action!=="restart" || restartAction.cutoverId!==before.cutoverId ||
         !isDeepStrictEqual(restartAction.currentIdentity,approved.currentIdentity) ||
         !isDeepStrictEqual(restartAction.buildReady,approved.restart.buildReady) ||
         !isDeepStrictEqual(restartAction.actuator,expectedActuator) ||
         operation.receipt?.restartState!=="requested") deny("Capability expectation recovery durable restart binding changed");

      const localContext=Object.freeze({});
      const grant=this.grant(binding);
      const recoveryDetail=JSON.stringify({kind:"cutover_capability_expectation_mismatch",cutoverId:input.cutoverId,requestHash:correlation.requestHash,observedIdentity:input.observedIdentity});
      const localOwnership=operations.createOwnershipStore({
        now:this.now,
        resolveOwnerContext: context=>context===localContext?{ownerThread:binding.row.id}:undefined,
        resolveEffectBinding: ()=>undefined,
        verifyGrantEvidence: (candidate,owner)=>owner.ownerThread===binding.row.id && isDeepStrictEqual(candidate,grant),
        verifyReconciliationEvidence: (evidence,lease,owner)=>{
          const current=cutoverStore.get();
          if(!current || current.cutoverId!==input.cutoverId || !current.coordinationBinding) return false;
          if(current.phase!=="drained" && !(current.phase==="closed" && current.capabilityExpectationMismatch)) return false;
          return owner.ownerThread===binding.row.id && lease.leaseId===correlation.leaseId && lease.ownerThread===binding.row.id && lease.operation==="cutover_start" &&
            lease.baseRevision===binding.contract.baseRevision && lease.operationHandle===correlation.operationHandle &&
            evidence.leaseId===lease.leaseId && evidence.ownerThread===lease.ownerThread && evidence.operationHandle===correlation.operationHandle &&
            evidence.operation==="cutover_start" && evidence.baseRevision===lease.baseRevision && evidence.leaseVersion===correlation.pinnedLeaseVersion &&
            evidence.state==="failed" && evidence.detail===recoveryDetail;
        },
      });
      let lease=localOwnership.get(correlation.leaseId);
      if(!lease || lease.ownerThread!==binding.row.id || lease.operation!=="cutover_start" || lease.baseRevision!==binding.contract.baseRevision ||
         lease.resource!==physical(this.stateDir) || lease.scope.length!==1 || lease.scope[0]!==physical(this.stateDir)) deny("Capability expectation recovery lease binding changed");
      const replayedReconciliation=lease.version===correlation.pinnedLeaseVersion+1 && lease.operationState==="finished" && lease.operationHandle===undefined;
      const alreadyReleased=lease.version===correlation.pinnedLeaseVersion+2 && lease.operationState==="finished" && lease.operationHandle===undefined && lease.terminalState==="released";
      const expiredReconciled=lease.version===correlation.pinnedLeaseVersion+1 && lease.operationState==="finished" && lease.operationHandle===undefined && lease.terminalState==="expired_reconciled";
      if(lease.version===correlation.pinnedLeaseVersion) {
        if(lease.terminalState || lease.operationState!=="active" || lease.operationHandle!==correlation.operationHandle) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery requires the original active pin");
      } else if(!replayedReconciliation && !alreadyReleased && !expiredReconciled) {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery lease version changed");
      }

      const evidence:ReconciliationEvidence={leaseId:correlation.leaseId,ownerThread:binding.row.id,operationHandle:correlation.operationHandle,operation:"cutover_start",baseRevision:binding.contract.baseRevision,leaseVersion:correlation.pinnedLeaseVersion,state:"failed",detail:recoveryDetail};
      const reconciliation=localOwnership.reconcile(localContext,correlation.leaseId,correlation.pinnedLeaseVersion,evidence);
      const afterLease=cutoverStore.get();
      if(!afterLease || afterLease.cutoverId!==before.cutoverId || (before.phase==="drained" && !isDeepStrictEqual(afterLease,before)) || (before.phase==="closed" && !isDeepStrictEqual(afterLease,before))) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery cutover changed after lease reconciliation");

      const recovered=cutoverStore.recoverCapabilityExpectationMismatch({cutoverId:input.cutoverId,recoveredBy:binding.row.id,observedIdentity:input.observedIdentity});
      const canonicalClosed=cutoverStore.get();
      if(!canonicalClosed || canonicalClosed.cutoverId!==input.cutoverId || canonicalClosed.phase!=="closed" || !canonicalClosed.capabilityExpectationMismatch) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery canonical cutover readback is incomplete");
      const terminalHash=cutoverTerminalRecordHash(canonicalClosed);
      const current=operations.getByOperationId(correlation.operationHandle);
      if(!current || current.requestHash!==operation.requestHash || !isDeepStrictEqual(current.request,operation.request)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery durable intent changed");
      if(current.receipt?.lifecycleTerminal===true) {
        if(current.receipt?.terminalRecordHash!==terminalHash || current.receipt?.recoveryKind!=="capability_expectation_mismatch" || !isDeepStrictEqual(current.receipt?.failedLeaseRecovery,reconciliation)) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery terminal receipt changed");
      } else {
        operations.finish(correlation.operationHandle,{status:"failed",retrySafe:false,receipt:{...current.receipt,lifecycleTerminal:true,terminalRecordHash:terminalHash,recoveryKind:"capability_expectation_mismatch",failedLeaseRecovery:reconciliation},errorCode:"CAPABILITY_EXPECTATION_MISMATCH",errorMessage:"Replacement source/build loaded, but the observed capability manifest differed from the bound expected capability."});
      }

      lease=localOwnership.get(correlation.leaseId)!;
      if(!lease.terminalState) lease=localOwnership.release(localContext,correlation.leaseId,lease.version);
      if(lease.terminalState!=="released" && lease.terminalState!=="expired_reconciled") throw new ControlPlaneOwnershipError("CAS_CONFLICT","Capability expectation recovery lease did not become terminal");

      const finalOperation=operations.getByOperationId(correlation.operationHandle)!;
      const finalCutover=cutoverStore.get()!;
      const finalChecks={
        cutoverClosed:finalCutover.phase==="closed",
        mismatchReceipt:Boolean(finalCutover.capabilityExpectationMismatch),
        terminalReason:finalCutover.reconciliationReceipt?.terminalReason==="CAPABILITY_EXPECTATION_MISMATCH",
        leaseUnpinned:lease.operationHandle===undefined,
        leaseFinished:lease.operationState==="finished",
        operationFailed:finalOperation.status==="failed",
        operationTerminal:finalOperation.receipt?.lifecycleTerminal===true,
        terminalHash:finalOperation.receipt?.terminalRecordHash===cutoverTerminalRecordHash(finalCutover),
      };
      if(Object.values(finalChecks).some(value=>!value)) throw new ControlPlaneOwnershipError("CAS_CONFLICT",`Capability expectation recovery final readback is incomplete: ${JSON.stringify(finalChecks)}`);
      return {cutover:finalCutover,lease,reconciliation,operation:finalOperation,replayed:!recovered.newlyRecovered};
    } finally {operations.close();}
  }

  /**
   * Host-local terminal hygiene for one successfully closed coordination-bound cutover
   * whose original root carrier has already been revoked. This can only destroy the
   * stale lease. It never revives carrier authority, transfers ownership, changes the
   * cutover target, starts work, or schedules a restart.
   */
  releaseClosedCutoverLeaseLocal(input: {
    cutoverId: string;
    leaseId: string;
    expectedLeaseVersion: number;
    carrierId: string;
    expectedCarrierVersion: number;
    expectedTerminalRecordHash: string;
    confirmCutoverId: string;
  }) {
    if(input.confirmCutoverId!==input.cutoverId) deny("Terminal lease release confirmation must equal the exact cutover id");
    if(!Number.isSafeInteger(input.expectedLeaseVersion) || input.expectedLeaseVersion<1 ||
       !Number.isSafeInteger(input.expectedCarrierVersion) || input.expectedCarrierVersion<2 ||
       !/^[a-f0-9]{64}$/.test(input.expectedTerminalRecordHash)) {
      throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release identity is invalid");
    }

    const cutoverStore=new CutoverStateStore(this.stateDir,{now:this.now});
    const closed=cutoverStore.get();
    if(!closed || closed.cutoverId!==input.cutoverId || closed.phase!=="closed" || !closed.coordinationBinding) {
      deny("Terminal lease release requires the exact closed coordination-bound cutover");
    }
    if(closed.coordinationBinding.leaseId!==input.leaseId ||
       closed.expiredPreparedNoEffect || closed.capabilityExpectationMismatch || closed.observedReplacement ||
       closed.supersession || closed.bindingRepair ||
       !closed.drainEvidence || !closed.restartRequest?.restartScheduledAt ||
       !closed.reconciliationReceipt?.workspaceQueryable || !closed.reconciliationReceipt.agentQueryable ||
       !closed.reconciliationReceipt.agentReconciled) {
      deny("Terminal lease release requires one normally completed cutover generation");
    }

    const row=this.database.sqlite.prepare("select * from carrier_bindings where id=?").get(input.carrierId) as BindingRow|undefined;
    if(!row || row.revoked!==1 || row.version!==input.expectedCarrierVersion || row.parent_id) {
      deny("Terminal lease release requires the exact revoked root carrier");
    }
    const contract=this.validateContract(JSON.parse(row.contract_json) as CarrierContract,false);
    if(JSON.stringify(contract)!==row.contract_json || contract.role!=="controller" ||
       contract.operations.length!==1 || contract.operations[0]!=="cutover_start" || !contract.cutover) {
      deny("Terminal lease release requires canonical root cutover authority");
    }
    const approved=contract.cutover;
    if(closed.coordinationBinding.ownerThread!==row.id ||
       physical(approved.stateRoot)!==physical(this.stateDir) ||
       !isDeepStrictEqual(closed.oldServerIdentity,approved.currentIdentity) ||
       !isDeepStrictEqual(closed.expectedNewIdentity,approved.expectedIdentity) ||
       closed.expiresAt!==approved.expiresAt) {
      throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release cutover generation changed");
    }

    const plan=planCutoverStart(this.stateDir,approved);
    const correlation=closed.coordinationBinding;
    if(correlation.operationHandle!==plan.operationId || correlation.requestHash!==plan.requestHash) {
      throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release operation correlation changed");
    }
    const terminalHash=cutoverTerminalRecordHash(closed);
    if(terminalHash!==input.expectedTerminalRecordHash) {
      throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal cutover record hash changed");
    }

    const operations=new DurableOperationStore(this.stateDir);
    try {
      const operation=operations.getByOperationId(correlation.operationHandle);
      if(!operation || operation.kind!=="cutover_start" || operation.status!=="succeeded" ||
         operation.requestHash!==correlation.requestHash || operation.scopeRoot!==physical(this.stateDir) ||
         operation.receipt?.cutoverId!==closed.cutoverId || operation.receipt?.startVerified!==true ||
         operation.receipt?.lifecycleTerminal!==true || operation.receipt?.terminalRecordHash!==terminalHash) {
        deny("Terminal lease release requires the exact successful terminal cutover operation");
      }
      const {coordinationBinding,...request}=operation.request;
      if(!isDeepStrictEqual(coordinationBinding,correlation) || !isDeepStrictEqual(request,plan.request)) {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release durable operation binding changed");
      }

      const localContext=Object.freeze({});
      const grant:GrantEvidenceReference={
        repository:contract.repository,
        goal:contract.goal,
        coordinatorThread:row.id,
        evidenceHash:digest(row.contract_json),
      };
      const localOwnership=operations.createOwnershipStore({
        now:this.now,
        resolveOwnerContext: context=>context===localContext?{ownerThread:row.id}:undefined,
        resolveEffectBinding: ()=>undefined,
        verifyGrantEvidence: (candidate,owner)=>owner.ownerThread===row.id && isDeepStrictEqual(candidate,grant),
      });
      let lease=localOwnership.get(input.leaseId);
      if(!lease || lease.leaseId!==correlation.leaseId || lease.ownerThread!==row.id ||
         lease.operation!=="cutover_start" || lease.baseRevision!==contract.baseRevision ||
         lease.resource!==physical(this.stateDir) || lease.scope.length!==1 || lease.scope[0]!==physical(this.stateDir) ||
         lease.operationHandle!==undefined || lease.operationState!=="finished") {
        deny("Terminal lease release lease binding changed or is not terminal");
      }

      if(lease.terminalState!==undefined) {
        if(lease.terminalState!=="released" || lease.version!==input.expectedLeaseVersion+1) {
          throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release replay changed");
        }
        return {cutover:closed,lease,operation,replayed:true};
      }
      if(lease.version!==input.expectedLeaseVersion) {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release version changed");
      }

      lease=localOwnership.release(localContext,input.leaseId,input.expectedLeaseVersion);

      const afterCutover=cutoverStore.get();
      const afterOperation=operations.getByOperationId(correlation.operationHandle);
      if(!afterCutover || !isDeepStrictEqual(afterCutover,closed) ||
         !afterOperation || !isDeepStrictEqual(afterOperation,operation) ||
         lease.terminalState!=="released" || lease.version!==input.expectedLeaseVersion+1 ||
         lease.operationHandle!==undefined || lease.operationState!=="finished") {
        throw new ControlPlaneOwnershipError("CAS_CONFLICT","Terminal lease release post-effect readback changed");
      }
      return {cutover:afterCutover,lease,operation:afterOperation,replayed:false};
    } finally {operations.close();}
  }

  readLease(context: unknown, leaseId: string) {
    const binding=this.current(context), lease=this.ownership.get(leaseId);
    if(!lease || lease.ownerThread!==binding.row.id || lease.baseRevision!==binding.contract.baseRevision || !binding.contract.operations.includes(lease.operation as "dependency_sync") || lease.scope.some(path=>!binding.contract.scope.some(root=>contains(root,physical(path))))) deny("Lease is outside this carrier authority");
    return lease;
  }
  releaseLease(context: unknown, leaseId: string, expectedVersion: number) {
    return this.database.sqlite.transaction(()=>{
      const lease=this.readLease(context,leaseId);
      if(lease.operationHandle || lease.operationState==="active") deny("Pinned effects must be reconciled before release");
      return this.ownership.release(context,leaseId,expectedVersion);
    }).immediate();
  }
  private readValidity(id: string): Validity {
    const validity=this.database.sqlite.prepare("select version,expires_at from carrier_validity where carrier_id=?").get(id) as Validity|undefined;
    if(!validity || !Number.isSafeInteger(validity.version) || validity.version<1 || typeof validity.expires_at!=="string" || !Number.isFinite(Date.parse(validity.expires_at)) || new Date(validity.expires_at).toISOString()!==validity.expires_at) deny("Invalid or missing carrier validity");
    return validity;
  }
  revokeLocal(id: string, expectedVersion: number) {
    return this.database.sqlite.transaction(()=>this.revoke(id,expectedVersion)).immediate();
  }
  revokeDelegation(context: unknown, id: string, expectedVersion: number) {
    return this.database.sqlite.transaction(()=>{
      const parent=this.current(context), child=this.active(id);
      if(parent.contract.role!=="controller" || child.row.parent_id!==parent.row.id) deny();
      return this.revoke(id,expectedVersion);
    }).immediate();
  }
  /** Bind the exact planned effect before execution; ordinary reader lookups never mutate state. */
  prepareEffect(context: unknown, subject: EffectSubject) {
    return this.database.sqlite.transaction(()=>{
      const binding=this.current(context);
      this.assertSubject(binding.contract,subject);
      if(binding.contract.cutover && Date.parse(binding.contract.cutover.expiresAt)<=this.now()) deny("Cutover preparation approval expired");
      const transferred=this.effectLease(binding,subject);
      if(transferred) return this.ownership.assertHeld(context,transferred.leaseId,transferred.version,subject.operation,subject.baseRevision);
      const existing=this.database.sqlite.prepare("select subject_json,lease_id from carrier_effect_bindings where binding_id=? and operation_id=?").get(binding.row.id,subject.operationId) as {subject_json:string;lease_id:string}|undefined;
      if(existing) {
        if(existing.subject_json!==subjectJson(subject)) deny("Operation already binds different inputs");
        return this.ownership.assertHeld(context,existing.lease_id,this.ownership.get(existing.lease_id)!.version,subject.operation,subject.baseRevision);
      }
      const grant=this.grant(binding);
      const index=this.ownership.getGrantEvidence(grant.repository,grant.goal,grant.coordinatorThread);
      if(!index) this.ownership.putGrantEvidence(context,grant,0);
      const owned=this.database.sqlite.prepare("select lease_id from control_plane_resource_leases where owner_thread=? and resource=? and operation=? and base_revision=? and terminal_state is null").all(binding.row.id,physical(subject.workspaceRoot),subject.operation,subject.baseRevision) as Array<{lease_id:string}>;
      if(owned.length>1) deny("Ambiguous owned resource");
      const held=owned[0] ? this.ownership.get(owned[0].lease_id) : undefined;
      if(held?.operationHandle) deny("Reconcile the pinned operation before preparing another");
      const lease=held ? this.ownership.assertHeld(context,held.leaseId,held.version,subject.operation,subject.baseRevision) : this.ownership.acquire(context,{
        repositoryKey:binding.contract.repository,resourceKind:"filesystem",resourceId:subject.workspaceRoot,
        resource:subject.workspaceRoot,scope:[subject.workspaceRoot],operation:subject.operation,
        baseRevision:subject.baseRevision,expiresAt:binding.validity.expires_at,idempotencyKey:subject.operationId,grant,
      });
      this.database.sqlite.prepare("insert into carrier_effect_bindings values(?,?,?,?)").run(binding.row.id,subject.operationId,subjectJson(subject),lease.leaseId);
      return lease;
    }).immediate();
  }
  private terminal(operationId: string) {
    return this.database.sqlite.prepare("select * from dependency_terminal_witnesses where operation_id=?").get(operationId) as {operation_id:string;request_hash:string;lease_id:string;exit_code:number;frozen_inputs_unchanged:number}|undefined;
  }
  private verifyCutoverTerminal(evidence: Readonly<ReconciliationEvidence>, lease: Readonly<ResourceLease>, ownerThread: string): boolean {
    const binding=this.active(ownerThread), approved=binding.contract.cutover;
    if(!approved || binding.row.parent_id || binding.contract.role!=="controller" || evidence.state!=="finished" || lease.ownerThread!==ownerThread || lease.operationHandle!==evidence.operationHandle) return false;
    const plan=planCutoverStart(approved.stateRoot,approved);
    if(evidence.operationHandle!==plan.operationId || evidence.baseRevision!==plan.subject.baseRevision || lease.resource!==approved.stateRoot) return false;
    const row=this.database.sqlite.prepare("select request_hash,request_json from durable_operations where operation_id=? and kind='cutover_start'").get(plan.operationId) as {request_hash:string;request_json:string}|undefined;
    if(!row || row.request_hash!==plan.requestHash) return false;
    let request:Record<string,unknown>,detail:unknown;
    try {request=JSON.parse(row.request_json);detail=JSON.parse(evidence.detail??"");} catch {return false;}
    const {coordinationBinding,...original}=request;
    const file=new CutoverStateStore(approved.stateRoot).get();
    if(!file || file.phase!=="closed" || !isDeepStrictEqual(original,JSON.parse(JSON.stringify(plan.request))) ||
      !isDeepStrictEqual(file.coordinationBinding,coordinationBinding) || file.coordinationBinding?.leaseId!==lease.leaseId || file.coordinationBinding.ownerThread!==ownerThread ||
      file.coordinationBinding.operationHandle!==plan.operationId || file.coordinationBinding.requestHash!==plan.requestHash ||
      !isDeepStrictEqual(file.oldServerIdentity,approved.currentIdentity) || !isDeepStrictEqual(file.expectedNewIdentity,approved.expectedIdentity) || file.expiresAt!==approved.expiresAt) return false;
    const witness=file.reconciliationReceipt;
    if(!witness || !witness.closedByServerInstanceId || witness.closedByServerInstanceId===approved.currentIdentity.serverInstanceId ||
      !witness.workspaceQueryable || !witness.agentQueryable || !witness.agentReconciled || witness.witnessWorkspaceId!==approved.finish.workspaceId || witness.witnessAgentId!==approved.finish.agentId ||
      !Number.isFinite(Date.parse(witness.reconciledAt)) || Date.parse(witness.reconciledAt)>this.now()) return false;
    return isDeepStrictEqual(detail,{kind:"cutover_terminal",cutoverId:file.cutoverId,requestHash:plan.requestHash,terminalRecordHash:cutoverTerminalRecordHash(file)});
  }
  private verifyTerminal(evidence: Readonly<DependencyReconciliationEvidence>, subject: Readonly<EffectSubject>): boolean {
    const witness=this.terminal(subject.operationId);
    return !!witness && witness.request_hash===subject.requestHash && witness.lease_id===evidence.leaseId &&
      Number.isSafeInteger(witness.exit_code) && [0,1].includes(witness.frozen_inputs_unchanged) && witness.exit_code===evidence.exitCode &&
      (witness.frozen_inputs_unchanged===1)===evidence.frozenInputsUnchanged && evidence.state===(witness.exit_code===0 && witness.frozen_inputs_unchanged===1?"finished":"failed");
  }
  private effectLease(binding: Binding, subject: EffectSubject) {
    const rows=this.database.sqlite.prepare("select subject_json,lease_id from carrier_effect_bindings where operation_id=?").all(subject.operationId) as Array<{subject_json:string;lease_id:string}>;
    const leases=rows.filter(row=>row.subject_json===subjectJson(subject)).map(row=>this.ownership.get(row.lease_id))
      .filter(lease=>lease && lease.ownerThread===binding.row.id);
    if(leases.length>1) deny("Ambiguous effect binding");
    return leases[0];
  }
  private current(context: unknown): Binding {
    if(context && typeof context==="object") {
      const recipient=this.recipients.get(context);
      if(recipient) return this.active(recipient);
    }
    const principal=transport(context), id=this.sessions.get(JSON.stringify([principal.clientId,principal.sessionId]));
    if(!id) deny();
    const binding=this.active(id);
    if(binding.row.client_id!==principal.clientId) deny();
    return binding;
  }
  private active(id: string, seen = new Set<string>(), allowExpiredSelf = false): Binding {
    if(seen.has(id) || seen.size>=32) deny("Invalid delegation lineage");
    seen.add(id);
    const row=this.database.sqlite.prepare("select * from carrier_bindings where id=?").get(id) as BindingRow|undefined;
    if(!row || row.revoked!==0 || row.version!==1) deny("Carrier expired or revoked");
    const validity=this.readValidity(id);
    if(!allowExpiredSelf && Date.parse(validity.expires_at)<=this.now()) deny("Carrier validity expired");
    const contract=this.validateContract(JSON.parse(row.contract_json) as CarrierContract,false);
    if(JSON.stringify(contract)!==row.contract_json) deny("Persisted contract is not canonical");
    if(row.parent_id) {
      const parent=this.active(row.parent_id,seen);
      if(parent.contract.role!=="controller" || contract.role!=="worker") deny();
      this.assertNarrower(parent.contract,contract);
      if(Date.parse(validity.expires_at)>Date.parse(parent.validity.expires_at)) deny("Child validity exceeds parent");
      return {row,contract,root:parent.root,validity,generation:`${parent.generation}/${id}:${validity.version}`};
    }
    return {row,contract,root:row,validity,generation:`${id}:${validity.version}`};
  }
  private issue(pendingId: string, input: CarrierContract, parentId: string|null) {
    const contract=this.validateContract(input);
    const pending=this.database.sqlite.prepare("select * from carrier_pairings where id=?").get(pendingId) as PairingRow|undefined;
    if(!pending || pending.expires_at<=this.now() || pending.binding_id) deny("Pairing request missing, expired or already approved");
    const id=`carrier_${randomUUID()}`;
    this.database.sqlite.prepare("insert into carrier_bindings(id,client_id,credential_hash,parent_id,version,contract_json) values(?,?,?,?,1,?)")
      .run(id,pending.client_id,pending.credential_hash,parentId,JSON.stringify(contract));
    this.database.sqlite.prepare("insert into carrier_validity(carrier_id,version,expires_at) values(?,1,?)").run(id,contract.expiresAt);
    this.database.sqlite.prepare("update carrier_pairings set binding_id=? where id=? and binding_id is null").run(id,pendingId);
    const binding=this.active(id);
    const grant=this.grant(binding);
    if(!this.ownership.getGrantEvidence(grant.repository,grant.goal,grant.coordinatorThread)) {
      const proof=Object.freeze({}); this.recipients.set(proof,id);
      this.ownership.putGrantEvidence(proof,grant,0);
    }
    return this.public(binding);
  }
  private revoke(id: string, expectedVersion: number) {
    if(!Number.isSafeInteger(expectedVersion) || expectedVersion<1) deny();
    const result=this.database.sqlite.prepare("update carrier_bindings set revoked=1,version=version+1 where id=? and version=? and revoked=0").run(id,expectedVersion);
    if(result.changes!==1) throw new ControlPlaneOwnershipError("CAS_CONFLICT","Revocation version changed");
    return {id,version:expectedVersion+1,revoked:true};
  }
  private public(binding: Binding) { return {id:binding.row.id,version:binding.row.version,parentId:binding.row.parent_id,contract:binding.contract,grant:this.grant(binding),validity:{version:binding.validity.version,expiresAt:binding.validity.expires_at},authorityVersion:binding.generation}; }
  private grant(binding: Binding): GrantEvidenceReference {
    const root=JSON.parse(binding.root.contract_json) as CarrierContract;
    return {repository:root.repository,goal:root.goal,coordinatorThread:binding.root.id,evidenceHash:digest(binding.root.contract_json)};
  }
  private validateContract(input: CarrierContract, requireFuture = true): CarrierContract {
    if(!input || !["controller","worker"].includes(input.role) || typeof input.goal!=="string" || !input.goal.trim() || input.goal.length>160 ||
      !/^[a-f0-9]{40,64}$/.test(input.baseRevision) || !Array.isArray(input.scope) || input.scope.length<1 || input.scope.length>64 ||
      !Array.isArray(input.operations) || input.operations.length<1 || input.operations.some(op=>op!=="dependency_sync" && op!=="cutover_start") ||
      !Number.isFinite(Date.parse(input.expiresAt)) || (requireFuture && Date.parse(input.expiresAt)<=this.now())) deny("Invalid or expired carrier contract");
    let cutover:CarrierCutoverContract|undefined;
    if(input.operations.includes("cutover_start") || input.cutover!==undefined) {
      const parsed=cutoverSchema.safeParse(input.cutover);
      if(!parsed.success || Object.keys(input).some(key=>!["repository","goal","role","scope","baseRevision","operations","expiresAt","cutover"].includes(key))) deny("Invalid cutover approval");
      cutover=parsed.data;
      if(input.role!=="controller" || input.operations.length!==1 || input.operations[0]!=="cutover_start" || input.scope.length!==1 ||
        physical(cutover.stateRoot)!==physical(this.stateDir) || cutover.stateRoot!==physical(cutover.stateRoot) || physical(input.scope[0]!)!==cutover.stateRoot ||
        input.baseRevision!==cutover.currentIdentity.sourceCommit || Date.parse(cutover.expiresAt)>Date.parse(input.expiresAt) ||
        (requireFuture && Date.parse(cutover.expiresAt)<=this.now()) || Date.parse(cutover.restart.buildReady.verifiedAt)>this.now()) deny("Cutover approval exceeds exact local resource or validity");
      planCutoverStart(cutover.stateRoot,cutover);
    }
    return {repository:normalizeRepositoryKey(input.repository),goal:input.goal,role:input.role,
      scope:[...new Set(input.scope.map(physical))].sort(),baseRevision:input.baseRevision,
      operations:[...new Set(input.operations)].sort(),expiresAt:new Date(input.expiresAt).toISOString(),...(cutover?{cutover}:{})};
  }
  private assertNarrower(parent: CarrierContract, child: CarrierContract) {
    if(parent.repository!==child.repository || parent.goal!==child.goal || parent.baseRevision!==child.baseRevision ||
      child.operations.some(op=>!parent.operations.includes(op)) ||
      child.scope.some(path=>!parent.scope.some(root=>contains(root,path)))) deny("Delegation exceeds parent scope");
  }
  private assertSubject(contract: CarrierContract, subject: EffectSubject) {
    if(!subject || !/^[a-f0-9]{64}$/.test(subject.requestHash) || !/^[A-Za-z0-9._:-]{1,160}$/.test(subject.operationId) ||
      !contract.operations.includes(subject.operation) || subject.baseRevision!==contract.baseRevision ||
      !contract.scope.some(root=>contains(root,physical(subject.workspaceRoot)))) deny("Effect exceeds paired authority");
    if(contract.cutover && !isDeepStrictEqual(subject,planCutoverStart(contract.cutover.stateRoot,contract.cutover).subject)) deny("Effect differs from exact approved cutover request");
  }
}
