export type HarnessConfig =
  | {
      kind: "claude-code";
      inspection: "shell" | "dedicated";
    }
  | {
      kind: "codex";
    };

export type LegacyToolMode = "minimal" | "full" | "codex";

export function harnessFromLegacyToolMode(mode: LegacyToolMode): HarnessConfig {
  switch (mode) {
    case "minimal":
      return { kind: "claude-code", inspection: "shell" };
    case "full":
      return { kind: "claude-code", inspection: "dedicated" };
    case "codex":
      return { kind: "codex" };
  }
}

export function usesDedicatedInspection(harness: HarnessConfig): boolean {
  return harness.kind === "claude-code" && harness.inspection === "dedicated";
}
