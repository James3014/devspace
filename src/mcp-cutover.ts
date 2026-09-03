import type {
  ClosableMcpTransport,
  McpSessionObservation,
  McpSessionRegistry,
} from "./mcp-sessions.js";

export interface ServerIdentityEvidence {
  serverInstanceId: string;
  sourceCommit: string;
  buildId: string;
}

export interface CutoverDrainResult {
  status: "drained" | "already_draining";

  transportsDrained: number;
  closeFailures: number;
  observation: McpSessionObservation;
  oldServer: ServerIdentityEvidence;
}

export interface McpCutoverCoordinator {
  isDraining(): boolean;
  beginDrain(): Promise<CutoverDrainResult>;
  finishDrain(): { observation: McpSessionObservation; servers: ServerIdentityEvidence };
}

export function createMcpCutoverCoordinator(input: {
  transports: McpSessionRegistry<ClosableMcpTransport>;
  server: ServerIdentityEvidence;
}): McpCutoverCoordinator {
 {
  let draining = false;
  return {
    isDraining() {

      return draining;
    },
    async beginDrain() {
      if (draining) {
        return {
          status: "already_draining" as const,
          transportsDrained:0,
          closeFailures:0,
          observation: input.transports.observe(),
          oldServer: input.server,
        };
      }
      draining = true;
      const results = await input.transports.closeAll();
      const closeFailures = results.filter((result) => result.error).length;
      return {
        status: "drained" as const,
        transportsDrained: results.length,
        closeFailures,
        observation: input.transports.observe(),
        oldServer: input.server,

      };
    },
    finishDrain() {
      draining = false;
      return {
        observation: input.transports.observe(),
        servers: input.server,
      };
    },
  };
 }
}

export function compareServerIdentity(input: {
  expected: ServerIdentityEvidence;
  actual: ServerIdentityEvidence;
}): { match: boolean; mismatches: string[] } {

{
  const mismatches: string[] = [];
  if (input.expected.serverInstanceId !== input.actual.serverInstanceId) {
    mismatches.push("serverInstanceId");
  }
  if (input.expected.sourceCommit !== input.actual.sourceCommit) {
    mismatches.push("sourceCommit");
  }
  if (input.expected.buildId !== input.actual.buildId) {
    mismatches.push("buildId");
  }
  return { match: mismatches.length === 0, mismatches };

 }
}