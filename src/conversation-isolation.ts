export const CONVERSATION_CHECKOUT_SHARED = "CONVERSATION_CHECKOUT_SHARED" as const;
export const CONVERSATION_WORKSPACE_REBIND_REQUIRED = "CONVERSATION_WORKSPACE_REBIND_REQUIRED" as const;

export type ConversationMutationSafetyState =
  | "ISOLATED_WORKTREE"
  | "SINGLE_CONVERSATION_CHECKOUT"
  | "SHARED_CHECKOUT"
  | "UNSCOPED";

export interface ConversationMutationSafety {
  state: ConversationMutationSafetyState;
  sharedCheckout: boolean;
  competingConversationCount: number;
  mutationAllowed: boolean;
  reason?: typeof CONVERSATION_CHECKOUT_SHARED | typeof CONVERSATION_WORKSPACE_REBIND_REQUIRED;
  recommendation?: string;
}

const SIMPLE_READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "tree",
  "rg",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "stat",
  "which",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "merge-base",
]);

/**
 * Conservative classification used only to decide whether a shell command may
 * run while two ChatGPT conversations share one physical checkout. Unknown or
 * compound commands are consequential by default.
 */
export function isReadOnlyInspectionCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (/[;|<>`\n]/.test(trimmed) || trimmed.includes("$(") || trimmed.includes("||")) {
    return false;
  }

  const segments = trimmed.split(/\s*&&\s*/).filter(Boolean);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const command = tokens[0]!;

  if (SIMPLE_READ_ONLY_COMMANDS.has(command)) return true;
  if (command === "test" || command === "[") return true;
  if (command === "command") return tokens[1] === "-v";

  if (command !== "git") return false;
  const subcommand = tokens[1];
  if (!subcommand) return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "remote") {
    return tokens.length === 2 || tokens[2] === "-v" || tokens[2] === "get-url";
  }
  if (subcommand === "worktree") return tokens[2] === "list";
  if (subcommand === "branch") {
    return tokens.includes("--show-current") || tokens.includes("--contains") || tokens.includes("--merged") || tokens.includes("--no-merged") || tokens.includes("-a") || tokens.includes("--all");
  }
  return false;
}
