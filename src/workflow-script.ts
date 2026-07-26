import { createHash } from "node:crypto";
import vm from "node:vm";
import { WORKFLOW_LIMITS, type WorkflowMeta } from "./workflow-types.js";
import { workflowMetaSchema } from "./workflow-contracts.js";

export class WorkflowScriptError extends Error {
  constructor(
    readonly kind: "syntax" | "meta" | "script_too_large",
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "WorkflowScriptError";
  }
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  source: string;
  scriptHash: string;
  /** Compiled async factory. Workflow APIs are installed as sandbox globals. */
  script: vm.Script;
  filename: string;
}

const META_EXPORT = /export\s+const\s+meta\s*=/;

/**
 * Parse + compile a workflow script.
 * Expects `export const meta = {…}` as the first statement (optional leading comments/blank).
 */
export function parseWorkflowScript(
  source: string,
  options: { filename?: string } = {},
): ParsedWorkflowScript {
  if (Buffer.byteLength(source, "utf8") > WORKFLOW_LIMITS.scriptSourceBytes) {
    throw new WorkflowScriptError(
      "script_too_large",
      `Script exceeds ${WORKFLOW_LIMITS.scriptSourceBytes} bytes`,
    );
  }

  const filename = options.filename ?? "workflow:inline";
  const normalized = source.replace(/^﻿/, "");
  const { metaLiteral } = extractMetaLiteral(normalized);
  const meta = validateMeta(evaluateMetaLiteral(metaLiteral, filename));

  // Strip only the leading `export ` so line numbers stay aligned (7 spaces).
  const body = normalized.replace(META_EXPORT, "       const meta =");

  // Workflow APIs are installed as context-realm globals by the sandbox child.
  // Keeping the factory argument-free avoids handing host-realm functions or
  // constructors directly to model-authored workflow code.
  const wrapped = `(async () => {\n${body}\n})`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, {
      filename,
      // Outer async wrapper adds one line before user source
      lineOffset: -1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = parseErrorLine(message);
    throw new WorkflowScriptError("syntax", message, line);
  }

  return {
    meta,
    source: normalized,
    scriptHash: hashSource(normalized),
    script,
    filename,
  };
}

export function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function extractMetaLiteral(source: string): { metaLiteral: string; metaEndIndex: number } {
  const match = META_EXPORT.exec(source);
  if (!match || match.index === undefined) {
    throw new WorkflowScriptError(
      "meta",
      "Workflow script must start with `export const meta = { … }`",
    );
  }

  // Ensure only whitespace/comments before export
  const before = source.slice(0, match.index);
  if (!isOnlyPreamble(before)) {
    throw new WorkflowScriptError(
      "meta",
      "`export const meta` must be the first statement (comments/blank lines OK)",
    );
  }

  const afterAssign = source.slice(match.index + match[0].length);
  const trimmedStart = afterAssign.match(/^\s*/)?.[0].length ?? 0;
  const objectStart = match.index + match[0].length + trimmedStart;
  if (source[objectStart] !== "{") {
    throw new WorkflowScriptError("meta", "meta value must be an object literal `{…}`");
  }

  const end = scanBalancedObject(source, objectStart);
  const metaLiteral = source.slice(objectStart, end + 1);

  assertPureMetaLiteral(metaLiteral);

  return { metaLiteral, metaEndIndex: end + 1 };
}

function scanBalancedObject(source: string, start: number): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new WorkflowScriptError("meta", "Unclosed meta object literal");
}

function assertPureMetaLiteral(literal: string): void {
  for (let i = 0; i < literal.length; i += 1) {
    const ch = literal[i]!;
    const next = literal[i + 1];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(literal, i, ch);
      continue;
    }
    if (ch === "/" && next === "/") {
      i = skipLineComment(literal, i + 2);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(literal, i + 2);
      continue;
    }
    if (ch === "`") {
      throw new WorkflowScriptError("meta", "meta must be a pure literal (no templates)");
    }
    if (literal.startsWith("...", i)) {
      throw new WorkflowScriptError("meta", "meta must be a pure literal (no spreads)");
    }
    if (literal.startsWith("=>", i)) {
      throw new WorkflowScriptError("meta", "meta must be a pure literal (no functions)");
    }
    if (!/[A-Za-z_$]/.test(ch)) continue;

    const identifierStart = i;
    i += 1;
    while (i < literal.length && /[\w$]/.test(literal[i]!)) i += 1;
    const identifier = literal.slice(identifierStart, i);
    if (identifier === "function" || identifier === "class" || identifier === "new") {
      throw new WorkflowScriptError("meta", "meta must be a pure literal (no executable values)");
    }
    i = skipTrivia(literal, i) - 1;
    if (literal[i + 1] === "(") {
      throw new WorkflowScriptError("meta", "meta must be a pure literal (no function calls)");
    }
  }
}

function skipQuoted(source: string, start: number, quote: '"' | "'"): number {
  let escape = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === quote) return i;
  }
  return source.length - 1;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length - 1 : newline;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start);
  return end < 0 ? source.length - 1 : end + 1;
}

function skipTrivia(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (/\s/.test(source[i]!)) {
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      i = skipLineComment(source, i + 2) + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      i = skipBlockComment(source, i + 2) + 1;
      continue;
    }
    break;
  }
  return i;
}

function isOnlyPreamble(text: string): boolean {
  // strip block comments, line comments, whitespace
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim();
  return stripped.length === 0;
}

function evaluateMetaLiteral(literal: string, filename: string): unknown {
  try {
    const value = vm.runInNewContext(`(${literal})`, Object.create(null), {
      filename: `${filename}:meta`,
      timeout: 1000,
    });
    // Rehydrate into the host realm — vm values keep context prototypes which
    // break assert.deepEqual and other host identity checks.
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptError("meta", `Invalid meta literal: ${message}`);
  }
}

function validateMeta(value: unknown): WorkflowMeta {
  const parsed = workflowMetaSchema.safeParse(value, { reportInput: true });
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `meta.${issue.path.join(".")}` : "meta";
  if (issue?.code === "invalid_type" && issue.input === undefined) {
    throw new WorkflowScriptError("meta", `${path} is required`);
  }
  if (issue?.code === "invalid_format" && issue.format === "regex") {
    throw new WorkflowScriptError("meta", `${path} must match /^[a-z0-9-]+$/`);
  }
  throw new WorkflowScriptError(
    "meta",
    `${path}: ${issue?.message ?? "validation failed"}`,
  );
}

function parseErrorLine(message: string): number | undefined {
  const match = message.match(/:(\d+)(?::\d+)?\)?$/m) ?? message.match(/line\s+(\d+)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}
