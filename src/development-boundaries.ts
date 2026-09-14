export type DevelopmentBoundaryRole =
  | "CONTROL_SUBSTRATE"
  | "PROVIDER_ADAPTER"
  | "CARRIER_ADAPTER"
  | "COGNITIVE_STRATEGY"
  | "COMPOSITION_ROOT"
  | "MIXED_DEBT";

/**
 * Modules whose implementation must remain independent from replaceable
 * provider, carrier, and orchestration strategy code.
 *
 * Keep this list deliberately small and truthful. A module is promoted here
 * only after its imports satisfy the dependency fence in
 * development-boundaries.test.ts.
 */
export const CONTROL_SUBSTRATE_KERNEL_MODULES = [
  "roots.ts",
  "execution-protocol.ts",
  "control-plane-ownership.ts",
  "host-operation-policy.ts",
  "process-platform.ts",
] as const;

/** Legitimate application wiring points. Composition is not authority transfer. */
export const COMPOSITION_ROOT_MODULES = ["server.ts", "cli.ts"] as const;

/**
 * Relative-import prefixes owned by replaceable edges or optional strategy.
 * A clean control-substrate module must never import one of these directly.
 */
export const REPLACEABLE_EDGE_SPECIFIER_PREFIXES = [
  "./local-agent-",
  "./chat-swarm-",
  "./carrier-binding",
  "./codex-runtime",
  "./provider-scratch",
] as const;

export const DEVELOPMENT_BOUNDARY_DEBT = [
  {
    module: "durable-operations.ts",
    role: "MIXED_DEBT" as const,
    reason:
      "The durable operation ledger also owns ChatSwarm migration preparation/apply/reconcile helpers. Split strategy-specific migration wiring before promoting the module into the control kernel.",
  },
  {
    module: "host-operations.ts",
    role: "MIXED_DEBT" as const,
    reason:
      "Host-operation execution currently imports local-agent error redaction and the mixed durable-operations module. Move shared redaction and durable ledger contracts behind neutral control modules first.",
  },
] as const;

export const DEVELOPMENT_BOUNDARY_RULES = Object.freeze({
  controlSubstrateMayImportReplaceableEdges: false,
  replaceableEdgesMayConsumeControlContracts: true,
  compositionRootsMayWireAllRoles: true,
  carrierStateMayMintTaskAuthority: false,
  providerAvailabilityMayMintExecutionAuthority: false,
  strategySelectionMayMintCompletionAuthority: false,
});
