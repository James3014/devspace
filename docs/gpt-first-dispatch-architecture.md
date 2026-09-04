# GPT-First Dispatch Architecture

Status: G0 architecture baseline for the Dev MCP source candidate.

## Decision

The MCP host (normally the primary GPT conversation) is the default orchestrator and worker selector. Nexus MCP and Dev MCP are peer capabilities beneath that host, not a mandatory upstream/downstream chain.

```text
Owner
  -> GPT host/orchestrator
       -> Nexus MCP (optional governance/planning/verification)
       -> Dev MCP   (local execution/dispatch/capability plane)
```

Dev MCP may reject an unsafe or unavailable execution, but it must not silently replace the worker, provider, model, or effort selected by the host.

## Dispatch modes

### GPT_DIRECT

The host selects an advertised DevSpace profile and dispatches directly through Dev MCP. Nexus planning, Workforce Admission, Task Cards, and Nexus execution grants are not prerequisites.

### GPT_NEXUS_ASSISTED

The host may ask Nexus MCP for advisory route/workforce evidence, but the host records its own final selection before direct Dev MCP execution. Advisory Nexus output is not execution authority.

### NEXUS_GOVERNED

The host explicitly enters the Nexus-governed lane. Nexus may then bind the selected worker and execution grant for that exact attempt. Changing that Nexus-selected execution identity requires fresh Nexus authority; this rule does not apply globally to unrelated GPT_DIRECT attempts.

## Selection and authority are separate

`executionContract.selection` records who selected the exact worker binding:

- `GPT`
- `OWNER_EXPLICIT`
- `NEXUS`

The selection binds profile/provider/model/effort. Dev MCP validates it against the resolved advertised profile and fails before worker launch if substitution would be required.

`executionContract.authorityMode` independently records why the local execution is authorized:

- `OWNER_DIRECT` (backwards-compatible default)
- `NEXUS_GOVERNED`

Direct execution cannot claim `selectedBy=NEXUS`. Explicit Nexus-governed selection requires `selectedBy=NEXUS` and a `decisionRef`.

## Reassignment control

Reassignment is a host decision, not a Dev MCP fallback policy. Status/reconciliation reports expose:

- `decisionOwner=HOST_GPT`
- `silentFallbackAllowed=false`
- `effectState`
- `retrySafe`
- `reconciliationRequired`
- `reasonCode`

A new attempt is safe only when physical evidence supports it. An active or ambiguous mutating attempt remains retry-unsafe. A reconciled terminal attempt with no workspace effect may become retry-safe. A terminal attempt with an observed candidate remains retry-unsafe until the host explicitly decides how to handle that candidate.

## Capability manifests

Dev MCP core runtime readiness and Nexus integration readiness are separate contracts.

The core capability manifest covers host-driven execution primitives, including explicit worker selection. It must remain healthy even if Nexus integration is absent.

The Nexus integration manifest separately fingerprints the `NEXUS_GOVERNED` / `nexusGrant` seam. Nexus integration may fail closed without globally disabling GPT_DIRECT dispatch.

## Authority boundaries

Dev MCP does not own semantic routing, Workforce Admission, independent acceptance, merge, release, or deployment authority. Nexus-specific policy remains in Nexus. Provider-specific behavior remains in runtime adapters.

## G0-G4 gate meanings

- **G0** — this GPT-first authority architecture is recorded and source contracts follow it.
- **G1** — source work is rebound to exact canonical `James3014/devspace/main` before mutation.
- **G2** — worker selection is explicit and independent from execution authority; substitution fails closed.
- **G3** — core capability readiness is independent from Nexus integration readiness.
- **G4** — physical effect/retry/reconciliation evidence is exposed for GPT-controlled reassignment; Dev MCP never auto-fallbacks.

Live cutover and real host dispatch are deliberately outside G0-G4 and belong to the later G5 acceptance gate.

## G0-G4 source candidate evidence (2026-09-05)

- Canonical source/base: `James3014/devspace main @ f0515fca0fe8d58dd5896e79d40e488010ef073c`.
- Base tree: `fbae09efa19c304c22b2c00389624de15f19a6cd`.
- The managed worktree was created from `james/main`; a fresh `git ls-remote james refs/heads/main` matched the exact base before implementation.
- G2 execution-protocol focused test: 8/8 passed.
- G2 lane-coherence witness: GPT direct selection accepted; Nexus selection in direct mode and GPT selection in governed mode rejected.
- G3 capability-manifest focused test: 3/3 passed.
- G3 negative witness: removing `nexusGrant` leaves core `missing=[]` while the independent Nexus integration manifest reports only `agent_start.executionContract.nexusGrant` missing.
- G2/G4 local-agent execution-contract suite: 90/90 passed, including explicit no-substitution and observed-candidate retry-unsafe tests.
- Production MCP server focused suite: 33/33 passed, including host-visible `selection` and `dispatchControl` schema checks.
- Core contract strict TypeScript check (`execution-protocol.ts`, `local-agent-contract.ts`, `capability-manifest.ts`): passed.
- Full `npm run typecheck`: passed.
- Full `npm run build`: passed; the existing Vite chunk-size warning remains non-blocking.
- `git diff --check`: passed.
- Verification reused the exact lockfile-compatible dependency tree from the source checkout through a temporary `node_modules` symlink; the symlink was removed afterward and no generated/tracked build residue remained.
- G5 live cutover / ChatGPT host rebind / real GPT_DIRECT acceptance remains deliberately out of scope.
