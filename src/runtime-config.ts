import { isArtifactDownloadSupportedPlatform } from "./artifact-platform.js";
import type { ResolvedConfig, ToolMode, WidgetMode } from "./config.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

export type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

export type ToolSurface =
  | {
      kind: "classic";
      inspection: "shell" | "dedicated";
      instructions: string;
      shellDescription: string;
    }
  | {
      kind: "codex";
      instructions: string;
    };

export type PresentationProfile =
  | { kind: "off"; widgetKinds: readonly ToolWidgetKind[]; instructions: "" }
  | { kind: "inline"; widgetKinds: readonly ToolWidgetKind[]; instructions: "" }
  | { kind: "changes"; widgetKinds: readonly ToolWidgetKind[]; instructions: string };

export type SkillsCapability =
  | {
      status: "enabled";
      instructions: string;
      readDescription: string;
      readPathDescription: string;
      workspaceInstruction: string;
    }
  | {
      status: "disabled";
      instructions: "";
      readDescription: "";
      readPathDescription: string;
      workspaceInstruction: string;
    };

export type ArtifactCapability =
  | { status: "available"; maxFileBytes: number; instructions: string }
  | { status: "unavailable"; reason: "disabled" | "unsupported-platform"; instructions: "" };

export interface RuntimeConfig {
  config: ResolvedConfig;
  tools: ToolSurface;
  presentation: PresentationProfile;
  skills: SkillsCapability;
  artifacts: ArtifactCapability;
  instructions: string;
}

const ALL_WIDGET_KINDS: readonly ToolWidgetKind[] = [
  "workspace",
  "read",
  "write",
  "edit",
  "search",
  "directory",
  "shell",
  "show_changes",
];

const CHANGE_WIDGET_KINDS: readonly ToolWidgetKind[] = ["workspace", "show_changes"];

const TOOL_SURFACES: Record<ToolMode, ToolSurface> = {
  minimal: classicSurface("shell"),
  full: classicSurface("dedicated"),
  codex: {
    kind: "codex",
    instructions: `Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes.`,
  },
};

const PRESENTATION_PROFILES: Record<WidgetMode, PresentationProfile> = {
  off: { kind: "off", widgetKinds: [], instructions: "" },
  full: { kind: "inline", widgetKinds: ALL_WIDGET_KINDS, instructions: "" },
  changes: {
    kind: "changes",
    widgetKinds: CHANGE_WIDGET_KINDS,
    instructions:
      " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs.",
  },
};

export function compileRuntime(config: ResolvedConfig): RuntimeConfig {
  const tools = TOOL_SURFACES[config.toolMode];
  const presentation = PRESENTATION_PROFILES[config.widgets];
  const skills = skillsCapability(config.skillsEnabled);
  const artifacts = artifactCapability(config);
  const common = `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected.`;
  const instructionParts = tools.kind === "codex"
    ? [common, tools.instructions, `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`]
    : [common, agentsInstruction(), skills.instructions, tools.instructions];

  return {
    config,
    tools,
    presentation,
    skills,
    artifacts,
    instructions: `${instructionParts.filter(Boolean).join(" ")}${artifacts.instructions}${presentation.instructions}`,
  };
}

export function shouldAttachWidget(
  profile: PresentationProfile,
  kind: ToolWidgetKind,
): boolean {
  return profile.widgetKinds.includes(kind);
}

function classicSurface(inspection: "shell" | "dedicated"): ToolSurface {
  if (inspection === "shell") {
    return {
      kind: "classic",
      inspection,
      instructions: `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.`,
      shellDescription: `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. This is powerful execution and should only be exposed behind strong authentication.`,
    };
  }

  return {
    kind: "classic",
    inspection,
    instructions: `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.`,
    shellDescription: `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. This is powerful execution and should only be exposed behind strong authentication.`,
  };
}

function skillsCapability(enabled: boolean): SkillsCapability {
  const workspaceInstruction = enabled
    ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
    : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
  if (!enabled) {
    return {
      status: "disabled",
      instructions: "",
      readDescription: "",
      readPathDescription: "File path to read, relative to the workspace root.",
      workspaceInstruction,
    };
  }

  return {
    status: "enabled",
    instructions: `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories.`,
    readDescription:
      "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable.",
    readPathDescription:
      "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills.",
    workspaceInstruction,
  };
}

function artifactCapability(config: ResolvedConfig): ArtifactCapability {
  if (!config.artifactsEnabled) {
    return { status: "unavailable", reason: "disabled", instructions: "" };
  }
  if (!isArtifactDownloadSupportedPlatform()) {
    return { status: "unavailable", reason: "unsupported-platform", instructions: "" };
  }
  return {
    status: "available",
    maxFileBytes: config.artifactMaxFileBytes,
    instructions:
      " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs.",
  };
}

function agentsInstruction(): string {
  return `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it.`;
}
