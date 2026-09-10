import type Database from "better-sqlite3";
import { initializeControlPlaneOwnershipDatabase, ControlPlaneOwnershipError } from "./control-plane-ownership.js";

export type CompletionLayer = "Implementation" | "Source verification" | "Integration" | "Install/package" | "Runtime" | "Deployment" | "Native/real entrypoint" | "Authorization";
export type CompletionStatus = "未實作" | "已實作" | "未驗收" | "PASS" | "FAIL" | "未接線" | "已接線" | "未執行" | "未部署" | "已部署" | "READY" | "BLOCKED" | "EXPIRED";
export interface CompletionMatrixRow { goal: string; layer: CompletionLayer; source: string; revision: string; status: CompletionStatus; freshness: string; gap: string; version: number; updatedAt: string; }

export function initializeCompletionMatrixDatabase(sqlite: Database.Database): void { initializeControlPlaneOwnershipDatabase(sqlite); }
export function upsertCompletionMatrixRow(sqlite: Database.Database, input: Omit<CompletionMatrixRow, "version" | "updatedAt">, expectedVersion: number, expectedCurrentRevision?: string, now = Date.now()): CompletionMatrixRow {
  if (!input.goal || !input.layer || !input.source || !input.revision || !input.status || !input.freshness) throw new ControlPlaneOwnershipError("INVALID_INPUT", "completion matrix fields are required");
  const tx = sqlite.transaction(() => { const existing = sqlite.prepare("select * from control_plane_completion_matrix where goal=? and layer=?").get(input.goal, input.layer) as Record<string, unknown> | undefined; if (!existing) { if (expectedVersion !== 0 || expectedCurrentRevision !== undefined) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "matrix row does not exist"); sqlite.prepare("insert into control_plane_completion_matrix (goal,layer,source,revision,status,freshness,gap,version,updated_at) values (?,?,?,?,?,?,?,?,?)").run(input.goal, input.layer, input.source, input.revision, input.status, input.freshness, input.gap, 1, new Date(now).toISOString()); } else { if (expectedCurrentRevision === undefined || Number(existing.version) !== expectedVersion || existing.revision !== expectedCurrentRevision) throw new ControlPlaneOwnershipError("CAS_CONFLICT", "matrix version and current revision are both required"); sqlite.prepare("update control_plane_completion_matrix set source=?,revision=?,status=?,freshness=?,gap=?,version=version+1,updated_at=? where goal=? and layer=? and version=? and revision=?").run(input.source, input.revision, input.status, input.freshness, input.gap, new Date(now).toISOString(), input.goal, input.layer, expectedVersion, expectedCurrentRevision); } return row(sqlite.prepare("select * from control_plane_completion_matrix where goal=? and layer=?").get(input.goal, input.layer) as Record<string, unknown>); }); return tx.immediate();
}
function row(value: Record<string, unknown>): CompletionMatrixRow {
  const required = ["goal", "layer", "source", "revision", "status", "freshness", "version", "updated_at"];
  if (required.some((key) => typeof value[key] !== "string" && key !== "version") || !Number.isInteger(Number(value.version)) || Number(value.version) < 1) throw new ControlPlaneOwnershipError("MALFORMED", "completion matrix row is malformed");
  return { goal: String(value.goal), layer: value.layer as CompletionLayer, source: String(value.source), revision: String(value.revision), status: value.status as CompletionStatus, freshness: String(value.freshness), gap: value.gap === null ? "" : String(value.gap ?? ""), version: Number(value.version), updatedAt: String(value.updated_at) };
}
export function getCompletionMatrixRow(sqlite: Database.Database, goal: string, layer: CompletionLayer): CompletionMatrixRow | undefined { const value = sqlite.prepare("select * from control_plane_completion_matrix where goal=? and layer=?").get(goal, layer) as Record<string, unknown> | undefined; return value ? row(value) : undefined; }

/** These readers belong to the host, never to a caller-supplied PASS payload. */
export interface CompletionReaders {
  readContract(selection: Readonly<CompletionSelection>): unknown;
  readEvidence(selection: Readonly<CompletionSelection>): unknown;
}
export interface CompletionSelection { goal: string; candidate: string; subject: string; }
export const DELIVERY_LAYERS = ["SOURCE", "CI", "PACKAGE", "DEPLOYMENT", "NATIVE_SINGLE", "NATIVE_SWARM", "CONTINUITY"] as const;
export type DeliveryLayer = typeof DELIVERY_LAYERS[number];
import { z } from "zod";
const text = z.string().trim().min(1);
const layerSchema = z.enum(DELIVERY_LAYERS);
const criterionSchema = z.object({
  id:text, layer:layerSchema, sourceRevision:text, environment:text, surface:text,
  independent:z.boolean(), maxAgeMs:z.number().int().positive().max(30*86400000),
}).strict();
const contractSchema = z.object({
  goal:text,candidate:text,subject:text,source:text,
  requiredLayers:z.array(layerSchema).min(1),criteria:z.array(criterionSchema).min(1),
}).strict();
const evidenceSchema = z.object({
  criterionId:text,layer:layerSchema,sourceRevision:text,candidate:text,subject:text,source:text,command:text,
  result:z.enum(["PASS","FAIL"]),artifactSha256:z.string().regex(/^[a-f0-9]{64}$/),environment:text,surface:text,
  verifier:text,implementer:text,verificationState:z.enum(["INDEPENDENTLY_VERIFIED","VERIFIED","HANDOFF_REPORTED"]),
  observedAt:z.string().datetime({offset:true}),expiresAt:z.string().datetime({offset:true}),
  limitations:z.array(text),nextGate:text,
}).strict();
export type CompletionEvidence = z.infer<typeof evidenceSchema>;
export interface CriterionProjection { id:string; layer:DeliveryLayer; status:"PASS"|"FAIL"|"BLOCKED"; gap:string; evidence?:Readonly<CompletionEvidence>; }
export interface CompletionProjection {
  authoritative:false; selection:Readonly<CompletionSelection>; contractSource?:string;
  status:"COMPLETE"|"INCOMPLETE"|"BLOCKED"; gap:string;
  criteria:ReadonlyArray<Readonly<CriterionProjection>>;
  layers:Readonly<Record<DeliveryLayer,{status:"PASS"|"FAIL"|"BLOCKED"|"NOT_REQUIRED";criteria:ReadonlyArray<string>}>>;
}
function freezeProjection<T>(value:T):T {
  if(value && typeof value==="object") { for(const child of Object.values(value)) freezeProjection(child); Object.freeze(value); }
  return value;
}

/** Rebuilds from the entire trusted contract. Stored display rows never supply acceptance. */
export function projectCompletion(selection:CompletionSelection, readers:CompletionReaders, now=Date.now()):CompletionProjection {
  const selected=Object.freeze({...selection});
  const layers=Object.fromEntries(DELIVERY_LAYERS.map(layer=>[layer,{status:"NOT_REQUIRED",criteria:[]}])) as unknown as Record<DeliveryLayer,{status:"PASS"|"FAIL"|"BLOCKED"|"NOT_REQUIRED";criteria:string[]}>;
  const blocked=(gap:string):CompletionProjection=>freezeProjection({authoritative:false,selection:selected,status:"BLOCKED",gap,criteria:[],layers});
  if(!Number.isFinite(now)||!selected.goal||!selected.candidate||!selected.subject) return blocked("INVALID_SELECTION");
  let contract:z.infer<typeof contractSchema>;let records:unknown[];
  try {
    contract=freezeProjection(contractSchema.parse(readers.readContract(selected)));
    if(contract.goal!==selected.goal||contract.candidate!==selected.candidate||contract.subject!==selected.subject) return blocked("CONTRACT_BINDING_MISMATCH");
    const ids=contract.criteria.map(c=>c.id);
    if(new Set(ids).size!==ids.length||new Set(contract.requiredLayers).size!==contract.requiredLayers.length||
      contract.criteria.some(c=>!contract.requiredLayers.includes(c.layer))||contract.requiredLayers.some(layer=>!contract.criteria.some(c=>c.layer===layer))) return blocked("INCOMPLETE_OR_AMBIGUOUS_CONTRACT");
    for(const layer of contract.requiredLayers) layers[layer].status="BLOCKED";
    // Snapshot before evaluation: callbacks cannot mutate previously captured evidence.
    const raw=readers.readEvidence(selected);
    if(!Array.isArray(raw)) return blocked("MALFORMED_EVIDENCE_SET");
    records=JSON.parse(JSON.stringify(raw));
  } catch { return blocked("TRUSTED_READER_OR_SCHEMA_UNAVAILABLE"); }
  const criteria:CriterionProjection[]=contract.criteria.map(c=>{
    const candidates=records.filter(r=>r!==null&&typeof r==="object"&&(r as Record<string,unknown>).criterionId===c.id);
    const row:CriterionProjection={id:c.id,layer:c.layer,status:"BLOCKED",gap:"MISSING_EVIDENCE"};
    if(candidates.length!==1){row.gap=candidates.length?"AMBIGUOUS_EVIDENCE":"MISSING_EVIDENCE";return row;}
    const parsed=evidenceSchema.safeParse(candidates[0]);if(!parsed.success){row.gap="MALFORMED_EVIDENCE";return row;}
    const e=parsed.data;row.evidence=e;
    if(e.layer!==c.layer||e.candidate!==selected.candidate||e.subject!==selected.subject||e.sourceRevision!==c.sourceRevision){row.gap="STALE_SUBJECT_OR_REVISION";return row;}
    const observed=Date.parse(e.observedAt),expires=Date.parse(e.expiresAt);
    if(observed>now||expires<=now||expires<=observed||now-observed>c.maxAgeMs){row.gap="STALE_OR_FUTURE_EVIDENCE";return row;}
    if(e.verificationState==="HANDOFF_REPORTED"||c.independent&&(e.verificationState!=="INDEPENDENTLY_VERIFIED"||e.verifier===e.implementer)){row.gap="VERIFICATION_NOT_ESTABLISHED";return row;}
    if(e.environment!==c.environment||e.surface!==c.surface){row.gap="REQUIRED_EXECUTION_SURFACE_MISSING";return row;}
    if(e.result==="FAIL"){row.status="FAIL";row.gap="VERIFIED_FAILURE";return row;}
    if(e.limitations.length){row.gap="UNRESOLVED_LIMITATIONS";return row;}
    row.status="PASS";row.gap="";return row;
  });
  for(const layer of contract.requiredLayers){const rows=criteria.filter(c=>c.layer===layer);layers[layer]={status:rows.some(r=>r.status==="FAIL")?"FAIL":rows.every(r=>r.status==="PASS")?"PASS":"BLOCKED",criteria:rows.map(r=>r.id)};}
  const complete=criteria.length>0&&criteria.every(c=>c.status==="PASS");
  return freezeProjection({authoritative:false,selection:selected,contractSource:contract.source,status:complete?"COMPLETE":"INCOMPLETE",gap:complete?"":"REQUIRED_CRITERIA_NOT_SATISFIED",criteria,layers});
}
