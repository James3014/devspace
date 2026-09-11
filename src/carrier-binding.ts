import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { openDatabase } from "./db/client.js";
import { ControlPlaneOwnershipError, ControlPlaneOwnershipStore, normalizeRepositoryKey, type GrantEvidenceReference } from "./control-plane-ownership.js";
import type { ControlPlaneConsumerOptions, DependencyReconciliationEvidence, EffectSubject } from "./control-plane-consumer.js";

export interface CarrierContract {
  repository: string;
  goal: string;
  role: "controller" | "worker";
  scope: string[];
  baseRevision: string;
  operations: Array<"dependency_sync" | "cutover_start">;
  expiresAt: string;
}
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

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.database = openDatabase(stateDir);
    this.readers = {
      now,
      resolveOwnerContext: context => ({ownerThread:this.current(context).row.id}),
      verifyGrantEvidence: (grant, owner) => {
        const binding = this.active(owner.ownerThread);
        return JSON.stringify(grant) === JSON.stringify(this.grant(binding));
      },
      resolveEffectBinding: (context, subject) => {
        const binding = this.current(context);
        this.assertSubject(binding.contract, subject);
        const lease = this.effectLease(binding,subject);
        if (!lease) return undefined;
        return {leaseId:lease.leaseId,leaseVersion:lease.version,requestHash:subject.requestHash,role:binding.contract.role,authorityVersion:binding.generation};
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
        let detail: {requestHash?:unknown;exitCode?:unknown;frozenInputsUnchanged?:unknown};
        try {detail=JSON.parse(evidence.detail??"");} catch {return false;}
        const witness=this.terminal(evidence.operationHandle);
        return !!witness && witness.lease_id===lease.leaseId && lease.ownerThread===owner.ownerThread && evidence.operationHandle===lease.operationHandle &&
          witness.request_hash===detail.requestHash && witness.exit_code===detail.exitCode && (witness.frozen_inputs_unchanged===1)===detail.frozenInputsUnchanged &&
          evidence.state===(witness.exit_code===0 && witness.frozen_inputs_unchanged===1?"finished":"failed");
      },
      resolveHandoffRecipient: (context, handle, lease, receipt) => {
        const sender=this.current(context), recipient=this.active(handle);
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
  delegate(context: unknown, pendingId: string, contract: CarrierContract) {
    return this.database.sqlite.transaction(()=>{
      const parent=this.current(context);
      if(parent.contract.role!=="controller") deny("Workers cannot delegate or promote themselves");
      const child=this.validateContract(contract);
      if(child.role!=="worker") deny("Delegation cannot create a controller");
      this.assertNarrower(parent.contract,child);
      if(Date.parse(child.expiresAt)>Date.parse(parent.validity.expires_at)) deny("Delegation exceeds current parent validity");
      return this.issue(pendingId,child,parent.row.id);
    }).immediate();
  }
  redeem(context: unknown, credential: string) {
    const principal=transport(context);
    if(typeof credential!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(credential)) deny();
    const row=this.database.sqlite.prepare("select id from carrier_bindings where credential_hash=? and client_id=?").get(digest(credential),principal.clientId) as {id:string}|undefined;
    if(!row) deny();
    const binding=this.active(row.id);
    const key=JSON.stringify([principal.clientId,principal.sessionId]);
    const existing=this.sessions.get(key);
    if(existing && existing!==row.id) deny("An MCP session cannot change its carrier");
    this.sessions.set(key,row.id);
    return this.public(binding);
  }
  status(context: unknown) { return this.public(this.current(context)); }
  inspectLocal(id: string) {
    const row=this.database.sqlite.prepare("select id,parent_id,version,revoked,contract_json from carrier_bindings where id=?").get(id) as Omit<BindingRow,"client_id"|"credential_hash">|undefined;
    if(!row) deny("Missing carrier record");
    const validity=this.readValidity(id);
    return {id:row.id,parentId:row.parent_id,version:row.version,revoked:row.revoked!==0,contract:this.validateContract(JSON.parse(row.contract_json),false),validity:{version:validity.version,expiresAt:validity.expires_at}};
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
      !Array.isArray(input.operations) || input.operations.length<1 || input.operations.some(op=>op!=="dependency_sync") ||
      !Number.isFinite(Date.parse(input.expiresAt)) || (requireFuture && Date.parse(input.expiresAt)<=this.now())) deny("Invalid or expired carrier contract");
    if(input.operations.includes("cutover_start")) deny("Built-in carrier pairing currently supports dependency operations only");
    return {repository:normalizeRepositoryKey(input.repository),goal:input.goal,role:input.role,
      scope:[...new Set(input.scope.map(physical))].sort(),baseRevision:input.baseRevision,
      operations:[...new Set(input.operations)].sort(),expiresAt:new Date(input.expiresAt).toISOString()};
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
  }
}
