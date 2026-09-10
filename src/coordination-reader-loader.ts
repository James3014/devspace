import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parse } from "acorn";
import type { ControlPlaneConsumerOptions } from "./control-plane-consumer.js";

export interface CoordinationReaderSelection { modulePath: string; sha256: string; }

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

export async function loadCoordinationReaders(selection: CoordinationReaderSelection | undefined, stateDir: string): Promise<ControlPlaneConsumerOptions | undefined> {
  if (!selection) return undefined;
  try {
    // Read once: the imported data URL contains exactly the bytes whose digest was checked.
    const bytes = await readFile(selection.modulePath);
    if (createHash("sha256").update(bytes).digest("hex") !== selection.sha256) throw new Error("Digest mismatch.");
    validateModule(bytes.toString("utf8"));
    const module = await import(`data:text/javascript;base64,${bytes.toString("base64")}`) as { createCoordinationReaders?: unknown };
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
