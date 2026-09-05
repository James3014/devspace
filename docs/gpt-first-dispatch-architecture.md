# GPT-First Dispatch Architecture

Status: G0-G5 accepted; H1/H2 cutover hardening implemented and verified in source on 2026-09-05.

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

G5 subsequently accepted the live GPT_DIRECT path on `78157addb7a2041057542b2cdcce94600bf6e983`. H1/H2 were then added to harden cutover control after G5 exposed two real recovery defects.

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
- G5 live cutover / ChatGPT host rebind / real GPT_DIRECT acceptance: passed on live runtime `78157addb7a2041057542b2cdcce94600bf6e983` (`GPT_DIRECT_LIVE_DISPATCH_VERIFIED`).

## H1/H2 cutover hardening

### H1 — bootstrap-safe reconnect during drain

A cutover may no longer reject a fresh MCP `initialize` merely because the old server is in `drain`. New transports may initialize so the controlling GPT can continue to reach `cutover_status`, `cutover_drain`, restart, finish, and other non-consequential reconciliation tools. Consequential tools remain blocked by the durable `assertToolAllowed()` fence, so reconnectability does not grant mutation authority.

### H2 — typed replacement recovery for a missing drain receipt

If the old server disappears while the durable cutover is still `prepared`, an exact replacement server may use `cutover_recover_drain(cutoverId)`. The transition is accepted only when:

- the replacement `serverInstanceId` differs from the old server;
- source commit exactly matches the expected target;
- build ID exactly matches the expected target;
- capability manifest exactly matches the expected target;
- the caller supplies no session counts, paths, commands, or arbitrary state.

The server itself captures current bounded transport evidence and persists a typed `REPLACEMENT_RECOVER_DRAIN` event. `cutover_finish` accepts either normal `drained` evidence or this typed `recovered` evidence, and still requires the ordinary durable workspace/agent reconciliation witness.

Focused verification:

- `cutover-state.test.ts`: 6/6 passed.
- `mcp-cutover.test.ts`: 5/5 passed.
- `cutover-http.test.ts`: 2/2 passed.
- Full TypeScript typecheck: passed.
- Full build: passed.
- `git diff --check`: passed.
- `server.test.ts` could not execute assertions in this worktree because the local `better-sqlite3` native binding was absent; all 33 failures shared that environment error rather than a product assertion failure.
