import type { ToolMode } from "../config.js";
import { registerCodexTools } from "./codex.js";
import { registerStandardTools } from "./standard.js";
import {
  toolNames,
  type ToolInstructionContext,
  type ToolSurface,
} from "./types.js";

const MINIMAL_INSPECTION = `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `;

const FULL_INSPECTION = `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

const STANDARD_EDITING = `Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.`;

const CODEX_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

const TOOL_SURFACES: Record<ToolMode, ToolSurface> = {
  minimal: {
    register: (context) => registerStandardTools(context, "minimal"),
    instructions: standardInstructions(MINIMAL_INSPECTION),
  },
  full: {
    register: (context) => registerStandardTools(context, "full"),
    instructions: standardInstructions(FULL_INSPECTION),
  },
  codex: {
    register: registerCodexTools,
    instructions: () => CODEX_INSTRUCTIONS,
  },
};

export function getToolSurface(mode: ToolMode): ToolSurface {
  return TOOL_SURFACES[mode];
}

function standardInstructions(inspection: string) {
  return ({ agents, skills }: ToolInstructionContext): string =>
    `${agents}${skills}${inspection}${STANDARD_EDITING}`;
}
