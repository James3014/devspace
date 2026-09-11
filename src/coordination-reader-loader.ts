import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parse } from "acorn";
import type { ControlPlaneConsumerOptions } from "./control-plane-consumer.js";
import { snapshotCarrierCompletionBindings, type CarrierCompletionBinding } from "./carrier-binding.js";

export interface CoordinationReaderSelection { modulePath: string; sha256: string; }
export interface ServeReaderSelections { coordination?: CoordinationReaderSelection; completion?: CoordinationReaderSelection; }

export function parseServeReaderArgs(args: string[]): ServeReaderSelections {
  const completion = args.some(arg=>arg.startsWith("--completion-reader-"));
  const coordination = args.some(arg=>arg.startsWith("--coordination-reader-"));
  if (completion && coordination) throw new Error("Completion-only and coordination reader modes are mutually exclusive.");
  if (!completion) return {coordination:parseCoordinationReaderArgs(args)};
  const converted=args.map((arg,index)=>index%2===0 ? arg.replace(/^--completion-reader-/,"--coordination-reader-") : arg);
  return {completion:parseCoordinationReaderArgs(converted)};
}

export function parseCoordinationReaderArgs(args: string[]): CoordinationReaderSelection | undefined {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!["--coordination-reader-module", "--coordination-reader-sha256"].includes(flag) || values.has(flag) || !value || value.startsWith("--")) {
      throw new Error("Invalid coordination reader arguments.");
    }
    values.set(flag, value);
  }
  if (values.size === 0) return undefined;
  const modulePath = values.get("--coordination-reader-module");
  const sha256 = values.get("--coordination-reader-sha256");
  if (!modulePath || !isAbsolute(modulePath) || !modulePath.endsWith(".mjs") || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("Coordination readers require an absolute .mjs path and its SHA-256 together.");
  }
  return { modulePath, sha256: sha256.toLowerCase() };
}

const requiredHooks = ["resolveOwnerContext", "verifyGrantEvidence", "resolveEffectBinding"] as const;
const optionalHooks = ["resolveResourceIdentity", "verifyReconciliationEvidence", "now", "newId", "approveCutoverLifecycle", "readCompletionContract", "readCompletionEvidence", "resolveHandoffRecipient", "readDependencyReconciliation", "verifyDependencyReconciliation"] as const;

/** Artifact policy only. Operator-supplied code still runs with host privileges. */
function validateModule(source: string): void {
  const pending: unknown[] = [parse(source, { ecmaVersion: "latest", sourceType: "module" })];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (record.type === "ImportExpression") throw new Error("Dynamic imports are unsupported.");
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(String(record.type)) && record.source) {
      const specifier = (record.source as { value?: unknown }).value;
      if (typeof specifier !== "string" || !specifier.startsWith("node:")) throw new Error("Only node: static imports are supported.");
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
}

async function loadVerifiedModule(selection: CoordinationReaderSelection): Promise<Record<string, unknown>> {
  const bytes = await readFile(selection.modulePath);
  if (createHash("sha256").update(bytes).digest("hex") !== selection.sha256) throw new Error("Digest mismatch.");
  validateModule(bytes.toString("utf8"));
  return import(`data:text/javascript;base64,${bytes.toString("base64")}`);
}

export async function loadCompletionBindings(selection: CoordinationReaderSelection | undefined, stateDir: string): Promise<readonly CarrierCompletionBinding[] | undefined> {
  if (!selection) return undefined;
  try {
    const module=await loadVerifiedModule(selection);
    if (typeof module.createCompletionBindings !== "function") throw new Error("Factory missing.");
    const bindings=await module.createCompletionBindings(Object.freeze({stateDir}));
    return snapshotCarrierCompletionBindings(bindings);
  } catch {
    throw new Error("Completion reader bootstrap failed; verify the selected artifact and reader contract.");
  }
}

export async function loadCoordinationReaders(selection: CoordinationReaderSelection | undefined, stateDir: string): Promise<ControlPlaneConsumerOptions | undefined> {
  if (!selection) return undefined;
  try {
    // Read once: the imported data URL contains exactly the bytes whose digest was checked.
    const module = await loadVerifiedModule(selection);
    if (typeof module.createCoordinationReaders !== "function") throw new Error("Factory missing.");
    const readers: unknown = await module.createCoordinationReaders(Object.freeze({ stateDir }));
    if (!readers || typeof readers !== "object" || Array.isArray(readers)) throw new Error("Invalid readers.");
    const input = readers as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of [...requiredHooks, ...optionalHooks]) {
      const hook = input[key];
      if (hook === undefined && !(requiredHooks as readonly string[]).includes(key)) continue;
      if (typeof hook !== "function") throw new Error("Invalid reader hook.");
      result[key] = hook;
    }
    return Object.freeze(result) as unknown as ControlPlaneConsumerOptions;
  } catch {
    // Factory/parser errors may contain secrets or source bytes. Do not echo them.
    throw new Error("Coordination reader bootstrap failed; verify the selected artifact and reader contract.");
  }
}
