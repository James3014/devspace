# Wave 3 direct-contract runtime requalification

This runbook requalifies the historical #329 one-file effect under the #422 direct `agent_start` contract. It does not use Nexus/Core mutation sessions, Core shadow state, or old Core-bound fields. The worker remains blind to Core. A run is at most one provider turn plus an exact replay of the same durable request.

## Current evidence boundary

At the 2026-10-08 04:15 UTC read, the public runtime reported source `9038cefd667142655d23e307fd952ff3c40242e8`, which includes #393, while #360's outer-caller projection still returned `Unknown tool` for projected M5 controls. #427 and #426 had not yet been deployed, and #1362 remained unmerged. This is a historical identity snapshot; read the live public identity again before any canary. The #328 physical witness and #329 Core-bound run remain historical baselines and do not qualify the #422 direct contract. #359 source-level taxonomy work also needs a current live witness. The earlier Agy 1.3.1 result contained only `init.model`, so observed-model attestation remains open.

One bounded successful turn can witness exact replay/same-handle behavior, one physical effect, terminal verifier readback, and any model identity the runtime actually attests. A successful turn cannot prove quota-failure classification. Do not induce a quota error to close that gate; if a naturally observed failure supplies a structured class, record it, otherwise quota/failure taxonomy remains open.

## Stop conditions

- Do not run a provider turn while #422/#393 source changes are unmerged or the expected source is not deployed. Set `WAVE3_EXPECTED_SOURCE_COMMIT` to the actual approved source SHA; do not guess it. The live `open_workspace.devspaceBuild.sourceCommit` must match it.
- Do not run while the active outer caller has the stale projection described by #360. A prior witness returned `STALE_RECONNECT_REQUIRED`; that witness is historical and cannot qualify a later session. Reconnect/relist first and capture the actual callable tool names and `agent_start` input schema from that caller. The direct dispatch surface intentionally does not expose `capability_convergence_status`, so the runner cannot call it or prove host projection freshness by itself.
- Do not dispatch if the live catalog or accepted `agent_start` schema differs from the #422 direct shape. Never send `core_mutation_*`, `dispatchIntent`, `authorizedToolCeiling`, `toolProjectionManifest`, `effectProjection`, `authorityMode`, `coreMutation`, `capabilityDiscovery`, `role`, `parentEffectKey`, or `supersedes` from this caller.
- Do not dispatch if workspace identity/head, profile, local capacity, verifier toolchain, or source/build identity is missing or mismatched. `WAVE3_TOOLCHAIN_ID` is a required operator-supplied value; the script fails closed when it is absent or unavailable.
- Do not retry with a new attempt key after a timeout, transport error, or uncertain `agent_start` result. Recover only with the exact original request/attempt key and the durable handle.
- Do not infer provider quota from `agent_preflight`. Its provider-capacity state is `UNKNOWN`; preserve that value unless a terminal dispatch result supplies a classified provider-quota outcome.

## Six waves

| Wave | Gate and evidence | State before the next wave |
| --- | --- | --- |
| 1. Caller projection (#360) | In the active outer caller, capture its actually callable DevSpace tool names and full `agent_start` input schema with a timestamp and caller identity. Attach that evidence to the canary record. Compute `WAVE3_OUTER_PROJECTION_GENERATION` as SHA-256 of JSON containing the sorted unique DevSpace tool names, and `WAVE3_OUTER_AGENT_START_SCHEMA_SHA256` as SHA-256 of the recursively key-sorted JSON schema. The runner independently reads the direct server `tools/list`, computes both values, and requires exact equality. | Missing outer-caller evidence, any missing/extra tool, absent schema, or either hash mismatch stops the canary. The runner's separate MCP session is not proof of the UI caller's projection; the known stale #360 witness means a fresh passing outer-caller capture is mandatory. |
| 2. Runtime and workspace | Read the live catalog, then `open_workspace` in checkout mode. Require the deployed source commit to equal `WAVE3_EXPECTED_SOURCE_COMMIT`; record build and instance identity. Verify exact selected profile, mutation permission, clean worktree, expected HEAD, absent `effect.txt`, and `agent_preflight` local/profile/runtime readiness. Require the supplied toolchain to be available and to expose verifier executables. | No provider quota conclusion is made here. Unknown provider reachability/capacity remains unknown. |
| 3. Duplicate dispatch and replay | Construct one request with a fresh, unique `attemptKey`, exact `workspaceId` and profile, bounded prompt, and `executionContract` containing `expectedHead`, `writePaths: ["effect.txt"]`, `maxFiles: 1`, the supplied `toolchainId`, and bounded times. Call `agent_start` once. Read `agent_status`, then replay the byte-for-byte same request and key. | Both responses must return the same durable `agentId`. Record whether replay occurred while the handle was nonterminal. If the turn completed before replay, this proves terminal same-handle replay but does not prove the active duplicate-dispatch case; do not start a second effect solely to force that race. A conflicting replay, a different handle, or an uncertain response stops; never mint another key. |
| 4. Quota and failure taxonomy | Preserve preflight's provider state as `UNKNOWN`. After the one turn, inspect the terminal status's structured `dispatchFailure.failureClass` and evidence. Classify only what the returned status proves; do not force quota exhaustion, classify from free-form text, or retry a provider error. | A missing/ambiguous class remains `UNKNOWN` and leaves the taxonomy gate open. The unsupported-model/auth misclassification is already tracked in #330/#421; add a new verified witness to the matching issue rather than duplicating it. For a different confirmed Dev MCP or nexus-core defect, search existing issues first, then attach the redacted request/handle, source/build, structured error, and minimal repro. |
| 5. First effect and terminal verifier | Reconnect, read the same handle until terminal, call `agent_reconcile`, then read status again. Inspect physical Git state and `effect.txt` with no-follow readback. Require exactly the expected one-line file, only that path changed, no duplicate effect, terminal state, and a complete successful automated-verifier result for every verifier in the configured toolchain. | Any extra/missing path, mismatch, nonterminal result, failed/missing verifier, or reconciliation disagreement leaves the gate open. Do not claim success from provider prose. |
| 6. Model attestation and closeout | Record requested selector, resolved profile/model, and `modelAttestation` independently. Accept model attestation only when a provider/runtime-produced observed identity is present and bound to this attempt; requested model or initialization metadata alone is not observed-model evidence. Summarize the six gates with artifact links and unresolved unknowns. | If observed identity is unavailable (as in the earlier Agy 1.3.1 witness, which exposed only `init.model`), report attestation as unavailable and leave that gate open. Do not inflate the claim. |

## #422 direct schema allowlist

Top-level `agent_start` properties:

```text
workspaceId, profile, provider, model, effort, cliProviderId, prompt, attemptKey, executionContract
```

Required properties include `workspaceId`, `prompt`, and `attemptKey`. The selected request uses `profile` and omits the direct provider/model selector.

`executionContract` properties:

```text
expectedHead, writePaths, maxFiles, toolchainId, maxWallMs, maxStartupMs,
maxExecutionMs, idleTimeoutMode, idleTimeoutMs
```

The script checks the live server `tools/list` schema and uses the same connected MCP session for its `agent_start` request. The direct dispatch surface hides `capability_convergence_status`; the runner computes the catalog generation from the live tool names and hashes the full `agent_start` input schema. The active outer caller must provide its own fresh names and schema as evidence. For dispatch, set `WAVE3_OUTER_PROJECTION_GENERATION` and `WAVE3_OUTER_AGENT_START_SCHEMA_SHA256` from that actual caller capture. Both must match the live server values. A supplied hash alone has no provenance, so retain the underlying caller capture; missing or stale evidence fails closed.

## Script modes

From the repository root:

```sh
node --check scripts/ops/wave3-329-direct-canary.mjs
node --check scripts/ops/wave3-329-direct-canary.test.mjs
node --test scripts/ops/wave3-329-direct-canary.test.mjs
node scripts/ops/wave3-329-direct-canary.mjs --plan
```

`--plan` is local and makes no network or provider calls. `--inspect` connects and reads the live direct catalog, workspace, and preflight without dispatching a provider. Before `--inspect` or `--dispatch`, supply `DEVSPACE_PUBLIC_BASE_URL`, `DEVSPACE_PACKAGE_ROOT`, `DEVSPACE_REQUAL_ACCESS_TOKEN`, `WAVE3_CANARY_ROOT`, `WAVE3_EXPECTED_SOURCE_COMMIT`, `WAVE3_PROFILE`, and `WAVE3_TOOLCHAIN_ID`. Dispatch additionally requires `WAVE3_ATTEMPT_KEY`, `WAVE3_EXPECTED_WORKSPACE_HEAD`, `WAVE3_OUTER_PROJECTION_GENERATION`, `WAVE3_OUTER_AGENT_START_SCHEMA_SHA256`, and the explicit `WAVE3_ALLOW_PROVIDER_TURN=ONE_DISPOSABLE_FILE_EFFECT` acknowledgement.

The provider-turn mode is intentionally not run as part of source preparation. The current run must remain stopped until the merge/deploy and all six live gates are independently ready.

## Preparation verification

The direct-canary schema/fail-closed tests, `node --check`, and `--plan` pass locally. The former local full-suite blocker in `workspaces.test.ts` is tracked by [#424](https://github.com/James3014/devspace/issues/424) and was fixed in merged [PR #426](https://github.com/James3014/devspace/pull/426). An earlier GitHub issue-check on this PR's historical base failed before verification because of the workflow ref bug [#438](https://github.com/James3014/devspace/issues/438). The exact-head #330 issue-check is rerunning on current main; do not claim that gate green until its terminal result is read. The separate typecheck/build/doctor verifier passed. No live MCP inspection, provider dispatch, or deployment was run, so this is preparation evidence only and not live acceptance.
