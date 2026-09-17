import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import {
  assertCapabilityDiscoveryBinding,
  CoreMutationSessionError,
  CoreMutationSessionStore,
  parseRepositoryMutationBinding,
  type CoreMutationAdmission,
  type CoreMutationCandidateProvenance,
  type CoreMutationPhysicalSnapshot,
  type CoreMutationManagedWriterDomain,
} from "./core-mutation-session.js";
import {
  parseCapabilityDiscoveryReceipt,
  verifyCapabilityDiscoveryReceipt,
} from "./capability-discovery.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { WorkspaceRegistry } from "./workspaces.js";

export const CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS = Symbol(
  "CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS",
);

export interface CoreMutationToolExtra {
  _meta?: unknown;
  authInfo?: { clientId?: string };
  sessionId?: string;
}

export interface CoreMutationGuard {
  require(input: {
    workspaceId: string;
    extra: CoreMutationToolExtra;
    pointer?: { sessionId?: string; bindingHash?: string; required?: boolean };
  }): { id: string; bindingHash: string };
  admit(input: {
    workspaceId: string;
    extra: CoreMutationToolExtra;
    pointer?: { sessionId?: string; bindingHash?: string; required?: boolean };
    paths?: readonly string[];
    deletedPaths?: readonly string[];
    pathContainment: "STRUCTURED_SINK_ENFORCED" | "NOT_PROVEN";
    writerDomain?: CoreMutationManagedWriterDomain;
    synchronousPostEffectCheck?: true;
  }): Promise<CoreMutationAdmission>;
  active(workspaceId: string): { id: string; bindingHash: string } | undefined;
  candidate(candidateHead: string): CoreMutationCandidateProvenance | undefined;
  snapshot(input: {
    workspaceId: string;
    extra: CoreMutationToolExtra;
    pointer?: { sessionId?: string; bindingHash?: string; required?: boolean };
  }): Promise<CoreMutationPhysicalSnapshot>;
  recordCandidate(input: {
    workspaceId: string;
    extra: CoreMutationToolExtra;
    candidateHead: string;
    candidateTree: string;
  }): Promise<CoreMutationCandidateProvenance>;
  reconcileSynchronousEffect(input: {
    workspaceId: string;
    extra: CoreMutationToolExtra;
    pointer: { sessionId: string; bindingHash: string };
  }): Promise<CoreMutationPhysicalSnapshot>;
  assertDiscovery(workspaceId: string, receipt: ReturnType<typeof parseCapabilityDiscoveryReceipt>): void;
}

function actorKey(extra: CoreMutationToolExtra): string | undefined {
  const conversationScope = openAiConversationScopeId(extra._meta);
  if (conversationScope) {
    return `openai:${createHash("sha256").update(conversationScope).digest("hex")}`;
  }
  const clientId = extra.authInfo?.clientId;
  if (clientId) {
    return `mcp:${createHash("sha256").update(clientId).digest("hex")}`;
  }
  return undefined;
}

function actorKeyRequired(extra: CoreMutationToolExtra): string {
  const value = actorKey(extra);
  if (!value) {
    throw new Error(
      "[ACTOR_IDENTITY_REQUIRED] Core-bound mutation sessions require ChatGPT conversation or authenticated MCP client identity.",
    );
  }
  return value;
}

function toolError(error: unknown): Error {
  if (error instanceof CoreMutationSessionError) {
    return new Error(`[${error.code}] ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function coreMutationAdmissionOutput(admission: CoreMutationAdmission): Record<string, unknown> {
  return {
    bound: admission.bound,
    claim: admission.claim,
    pathContainment: admission.pathContainment,
    pathContainmentEvidence: admission.pathContainment === "NOT_PROVEN"
      ? "PATH_LEVEL_PREWRITE_CONTAINMENT_NOT_PROVEN"
      : admission.pathContainment,
    trustedEngineeringCompletion: false,
    ...(admission.sessionId ? { sessionId: admission.sessionId } : {}),
    ...(admission.bindingHash ? { bindingHash: admission.bindingHash } : {}),
    ...(admission.acceptanceContractHash ? { acceptanceContractHash: admission.acceptanceContractHash } : {}),
  };
}

export function coreMutationCandidateOutput(provenance: CoreMutationCandidateProvenance): Record<string, unknown> {
  return {
    bound: true,
    claim: "CORE_BOUND_CANDIDATE",
    sessionId: provenance.sessionId,
    bindingHash: provenance.bindingHash,
    acceptanceContractHash: provenance.acceptanceContractHash,
    candidateHead: provenance.candidateHead,
    candidateTree: provenance.candidateTree,
    sourceHead: provenance.sourceHead,
    sourceTree: provenance.sourceTree,
    changedPaths: provenance.changedPaths,
    deletedPaths: provenance.deletedPaths,
    diffHash: provenance.diffHash,
    changeSetId: provenance.changeSetId,
    changeSetHash: provenance.changeSetHash,
    changeManifestHash: provenance.changeManifestHash,
  };
}

export function createCoreMutationGuard(
  workspaces: WorkspaceRegistry,
  store: CoreMutationSessionStore | undefined,
  testOnlyBypass?: typeof CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS,
): CoreMutationGuard | undefined {
  if (!store) {
    if (testOnlyBypass === CORE_MUTATION_TEST_ONLY_UNTRUSTED_BYPASS) return undefined;
    const missing = (): never => {
      throw new Error(
        "[CORE_MUTATION_STORE_REQUIRED] Write-capable MCP construction requires the durable Core mutation store; only the explicitly untrusted test constructor path may omit it.",
      );
    };
    return {
      require: missing,
      admit: async () => missing(),
      active: () => undefined,
      candidate: () => undefined,
      snapshot: async () => missing(),
      recordCandidate: async () => missing(),
      reconcileSynchronousEffect: async () => missing(),
      assertDiscovery: missing,
    };
  }
  return {
    require: (input) => {
      try {
        const session = store.requireActive({
          workspaceSessionId: input.workspaceId,
          actorKey: actorKey(input.extra) ?? "",
          pointer: input.pointer,
        });
        return { id: session.id, bindingHash: session.bindingHash };
      } catch (error) {
        throw toolError(error);
      }
    },
    active: (workspaceId) => {
      const session = store.getActive(workspaceId);
      return session ? { id: session.id, bindingHash: session.bindingHash } : undefined;
    },
    candidate: (candidateHead) => store.getCandidate(candidateHead),
    snapshot: async (input) => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      try {
        const session = store.requireActive({
          workspaceSessionId: input.workspaceId,
          actorKey: actorKeyRequired(input.extra),
          pointer: input.pointer,
        });
        return await store.snapshot({
          sessionId: session.id,
          workspaceSessionId: input.workspaceId,
          workspaceRoot: workspace.root,
          actorKey: actorKeyRequired(input.extra),
        });
      } catch (error) {
        throw toolError(error);
      }
    },
    recordCandidate: async (input) => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      const session = store.getActive(input.workspaceId);
      if (!session) {
        throw new Error("[CORE_BOUND_SESSION_REQUIRED] Candidate provenance requires an active Core mutation session.");
      }
      try {
        return await store.recordCandidate({
          sessionId: session.id,
          workspaceSessionId: input.workspaceId,
          workspaceRoot: workspace.root,
          actorKey: actorKeyRequired(input.extra),
          candidateHead: input.candidateHead,
          candidateTree: input.candidateTree,
        });
      } catch (error) {
        throw toolError(error);
      }
    },
    reconcileSynchronousEffect: async (input) => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      try {
        const reconciled = await store.reconcileSynchronousEffect({
          sessionId: input.pointer.sessionId,
          workspaceSessionId: input.workspaceId,
          workspaceRoot: workspace.root,
          actorKey: actorKeyRequired(input.extra),
          bindingHash: input.pointer.bindingHash,
        });
        return reconciled.snapshot;
      } catch (error) {
        throw toolError(error);
      }
    },
    assertDiscovery: (workspaceId, receipt) => {
      const session = store.getActive(workspaceId);
      if (!session) {
        throw new Error("[CORE_BOUND_SESSION_REQUIRED] No active Core mutation session exists for this workspace.");
      }
      try {
        assertCapabilityDiscoveryBinding(session.binding, receipt);
      } catch (error) {
        throw toolError(error);
      }
    },
    admit: async (input) => {
      const workspace = workspaces.getWorkspace(input.workspaceId);
      try {
        return await store.admitEffect({
          workspaceSessionId: input.workspaceId,
          workspaceRoot: workspace.root,
          workspaceMode: workspace.mode,
          managed: workspace.worktree?.managed === true,
          actorKey: actorKey(input.extra) ?? "",
          pointer: input.pointer,
          paths: input.paths,
          deletedPaths: input.deletedPaths,
          pathContainment: input.pathContainment,
          writerDomain: input.writerDomain,
          synchronousPostEffectCheck: input.synchronousPostEffectCheck,
        });
      } catch (error) {
        throw toolError(error);
      }
    },
  };
}

export function registerCoreMutationSessionTools(
  server: McpServer,
  workspaces: WorkspaceRegistry,
  store: CoreMutationSessionStore | undefined,
  inspectWriterDomain?: (
    session: NonNullable<ReturnType<CoreMutationSessionStore["getById"]>>,
    domain: CoreMutationManagedWriterDomain,
  ) => Promise<"CLEAR" | "ACTIVE" | "UNKNOWN"> | "CLEAR" | "ACTIVE" | "UNKNOWN",
): void {
  if (!store) return;

  const outputSchema = z.object({
    id: z.string(),
    workspaceSessionId: z.string(),
    bindingId: z.string(),
    operationId: z.string(),
    attemptId: z.string(),
    bindingHash: z.string(),
    sourceHead: z.string(),
    sourceTree: z.string(),
    status: z.enum(["ACTIVE", "COMPLETED", "ABANDONED"]),
    freshnessState: z.enum(["FRESH", "EXPIRED"]),
    rebindState: z.enum(["BOUND_CURRENT", "REBIND_REQUIRED"]),
    writerReconciliationState: z.enum(["CLEAR", "OUTCOME_UNKNOWN"]),
    writerDomains: z.array(z.enum(["PROCESS", "AGENT", "SYNCHRONOUS_GIT"])),
    firstEffectAt: z.string().optional(),
    lastEffectAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    closedAt: z.string().optional(),
    binding: z.record(z.string(), z.unknown()),
  });
  const publicSession = (session: ReturnType<CoreMutationSessionStore["getById"]>) => {
    if (!session) throw new Error("Core mutation session unexpectedly disappeared.");
    const { actorKey: _actorKey, ...rest } = session;
    return rest as unknown as Record<string, unknown>;
  };

  registerAppTool(
    server,
    "core_mutation_session_open",
    {
      title: "Open Core-bound mutation session",
      description:
        "Bind one exact clean workspace/base to a frozen Nexus Core AcceptanceContract before trusted repository mutation. Reuses existing capability-discovery evidence; DevSpace validates provenance but gains no route, approval, verification, or completion authority.",
      inputSchema: {
        workspaceId: z.string(),
        binding: z.unknown(),
        capabilityDiscoveryReceipt: z.unknown(),
      },
      outputSchema,
      _meta: {},
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspaceId, binding, capabilityDiscoveryReceipt }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const receipt = parseCapabilityDiscoveryReceipt(capabilityDiscoveryReceipt);
        const verified = await verifyCapabilityDiscoveryReceipt(receipt);
        const parsedBinding = parseRepositoryMutationBinding(binding);
        assertCapabilityDiscoveryBinding(parsedBinding, verified.receipt);
        const session = await store.open({
          workspaceSessionId: workspaceId,
          workspaceRoot: workspace.root,
          workspaceMode: workspace.mode,
          managed: workspace.worktree?.managed === true,
          actorKey: actorKeyRequired(extra),
          binding: parsedBinding,
        });
        return {
          content: [{ type: "text" as const, text: `Core mutation session ${session.id} is ACTIVE and bound to ${session.sourceHead}.` }],
          structuredContent: publicSession(session),
        };
      } catch (error) {
        throw toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "core_mutation_session_status",
    {
      title: "Core mutation session status",
      description: "Read one durable Core-bound mutation session for this exact workspace and caller identity.",
      inputSchema: { workspaceId: z.string(), sessionId: z.string().optional() },
      outputSchema,
      _meta: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, sessionId }, extra) => {
      workspaces.getWorkspace(workspaceId);
      const key = actorKeyRequired(extra);
      const session = sessionId ? store.getById(sessionId) : store.getActive(workspaceId);
      if (!session || session.workspaceSessionId !== workspaceId) {
        throw new Error("[CORE_MUTATION_SESSION_NOT_FOUND] No matching Core mutation session exists for this workspace.");
      }
      if (session.actorKey !== key) {
        throw new Error("[CORE_MUTATION_ACTOR_MISMATCH] Core mutation session belongs to a different caller identity.");
      }
      return {
        content: [{ type: "text" as const, text: `Core mutation session ${session.id}: ${session.status}.` }],
        structuredContent: publicSession(session),
      };
    },
  );

  registerAppTool(
    server,
    "core_mutation_session_reconcile_synchronous",
    {
      title: "Reconcile Core synchronous Git effect",
      description:
        "Inspect the exact physical workspace after an unresolved synchronous Git effect and clear only the SYNCHRONOUS_GIT writer pin when scope and deletion checks remain valid. This never retries Git, clears other writer domains, or grants completion authority.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        bindingHash: z.string(),
      },
      outputSchema: z.object({
        session: outputSchema,
        snapshot: z.record(z.string(), z.unknown()),
      }),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, sessionId, bindingHash }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const reconciled = await store.reconcileSynchronousEffect({
          sessionId,
          workspaceSessionId: workspaceId,
          workspaceRoot: workspace.root,
          actorKey: actorKeyRequired(extra),
          bindingHash,
        });
        return {
          content: [{
            type: "text" as const,
            text: `Core synchronous Git effect reconciled for ${sessionId}; no Git effect was replayed.`,
          }],
          structuredContent: {
            session: publicSession(reconciled.session),
            snapshot: reconciled.snapshot as unknown as Record<string, unknown>,
          },
        };
      } catch (error) {
        throw toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "core_mutation_session_snapshot",
    {
      title: "Materialize Core ChangeSet snapshot",
      description:
        "Materialize the current worktree as a deterministic Git tree using an isolated temporary index and return Core-compatible physical ChangeSet inputs without changing caller index, HEAD, or working files.",
      inputSchema: { workspaceId: z.string(), sessionId: z.string() },
      outputSchema: z.record(z.string(), z.unknown()),
      _meta: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, sessionId }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const snapshot = await store.snapshot({
          sessionId,
          workspaceSessionId: workspaceId,
          workspaceRoot: workspace.root,
          actorKey: actorKeyRequired(extra),
        });
        return {
          content: [{
            type: "text" as const,
            text: `Core snapshot ${sessionId}: ${snapshot.changedPaths.length} changed path(s), scopeEscapes=${snapshot.scopeEscapePaths.length}, deletionViolation=${snapshot.deletionViolation}.`,
          }],
          structuredContent: snapshot as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "core_mutation_session_close",
    {
      title: "Close Core-bound mutation session",
      description:
        "Close one exact Core mutation session. COMPLETE requires the clean current HEAD to have durable physical Candidate/ChangeSet provenance from this exact binding; COMPLETED records execution/Candidate closure only and never grants Core verification, certification, acceptance, or trusted engineering completion. ABANDON remains terminal without creating retry or completion authority.",
      inputSchema: {
        workspaceId: z.string(),
        sessionId: z.string(),
        mode: z.enum(["COMPLETE", "ABANDON"]),
      },
      outputSchema,
      _meta: {},
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId, sessionId, mode }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      try {
        const session = await store.closeSession({
          sessionId,
          workspaceSessionId: workspaceId,
          workspaceRoot: workspace.root,
          actorKey: actorKeyRequired(extra),
          mode,
          inspectWriterDomain,
        });
        const meaning = session.status === "COMPLETED"
          ? "physical Candidate/ChangeSet recorded; Core verification, certification, acceptance, and trusted completion remain external"
          : "abandoned without retry or completion authority";
        return {
          content: [{ type: "text" as const, text: `Core mutation session ${session.id} closed as ${session.status} (${meaning}).` }],
          structuredContent: publicSession(session),
        };
      } catch (error) {
        throw toolError(error);
      }
    },
  );
}
