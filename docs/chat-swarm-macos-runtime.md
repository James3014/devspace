# macOS managed ChatGPT worker runtime

This document describes the source contract introduced for DevSpace Issue #117. It is a macOS-only, opt-in runtime for managed ChatGPT Web worker carriers. Chat Swarm durable storage remains the authority for worker, task, attempt, result, replay, and reconciliation state.

## Claim boundary

Source support does not prove the live product path. Until the native G0 and G2-G6 witnesses pass on an exact installed build, the maximum claim remains:

`MACOS_ZERO_TOUCH_CHATGPT_WORKER_RUNTIME_NOT_YET_PROVEN`

A browser tab, conversation URL, or successful source test is not worker/task authority.

## One-time environment setup

The surrounding ChatGPT/browser environment may require one-time login and app consent. Normal `ensure`, `scale`, `recover`, targeted wake, and result delivery must not require the Owner to manually create worker chats, copy invite credentials, relay IDs/results, or wake workers.

The runtime is disabled unless explicitly enabled.

Required for managed provisioning:

- `DEVSPACE_CHAT_SWARM_RUNTIME=1`
- `DEVSPACE_CHAT_SWARM_PROJECT_URL=https://chatgpt.com/...`

Optional configuration:

- `DEVSPACE_CHAT_SWARM_CDP_ENDPOINT` — bounded CDP endpoint; default `http://127.0.0.1:9222`
- `DEVSPACE_CHAT_SWARM_BROWSER_BIN` — browser executable used only when DevSpace must start the managed browser runtime
- `DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR` — dedicated managed profile directory
- `DEVSPACE_CHAT_SWARM_APP_LABEL` — configured ChatGPT app label; default `dev-c`
- `DEVSPACE_CHAT_SWARM_POOL_DEFAULT` — normal desired pool size; bounded by the existing Chat Swarm max-worker limit
- `DEVSPACE_CHAT_SWARM_RUNTIME_TIMEOUT_MS` — bounded external carrier operation deadline
- `DEVSPACE_CHAT_SWARM_BOOTSTRAP_WAIT_MS` — bounded wait for the exact managed conversation to bind itself

No runtime configuration authorizes repository mutation, provider-agent execution, merge, release, deployment, or any other authority outside the existing Chat Swarm contracts.

## MCP surface

When Chat Swarm is enabled in the normal server configuration, DevSpace exposes:

- `chat_swarm_runtime_status`
- `chat_swarm_runtime_ensure`
- `chat_swarm_runtime_scale`
- `chat_swarm_runtime_recover`
- `chat_swarm_runtime_stop`
- `chat_swarm_runtime_bootstrap`

These six managed-runtime tools extend the 15 existing Chat Swarm tools, so the enabled production surface contains 21 `chat_swarm_*` tools in total.

`runtime_status` is read-only. The remaining tools are consequential lifecycle operations and preserve durable operation/reconciliation semantics.

## Managed provisioning contract

Normal capacity creation is:

```text
Main owner
-> runtime_ensure(swarmId, desiredWorkers=N)
-> persist exact missing slot + generation intent
-> one CAS winner may create the browser conversation
-> persist exact observed conversation fingerprint
-> one CAS winner may deliver bootstrap
-> the exact ChatGPT conversation calls runtime_bootstrap(operationId)
-> request metadata fingerprint must equal the observed conversation fingerprint
-> existing Chat Swarm admission creates/binds the logical worker
-> slot becomes PARKED
```

Knowledge of `swarmId`, runtime slot, label, operation ID, or conversation URL alone is insufficient to bind a worker. The authenticated caller identity must match the exact managed carrier fingerprint.

If a browser create/bootstrap acknowledgement is lost after an external effect may have happened, the operation enters reconciliation-required state. DevSpace does not create a second conversation or resend blindly.

## Targeted delivery

Canonical task dispatch happens before any browser wake:

```text
canonical durable dispatch/claim
-> durable WAKE carrier operation
-> exact managed conversation wake
-> worker calls chat_swarm_next(workerId=...)
-> canonical task execution
-> chat_swarm_submit
```

Wake is only a delivery hint. Wake failure cannot roll back or duplicate canonical task truth. Identical wake replay reuses the same durable carrier operation.

## Recovery and cold ensure

An existing durable slot does not prove that its browser carrier is alive. `runtime_ensure` first reconciles exact existing managed carriers through the durable `ENSURE_EXISTING` carrier journal.

The health-check generation is stable within one DevSpace process, so repeated `ensure` calls in the same boot are idempotent. A new DevSpace process uses a new generation, forcing a fresh physical carrier check after restart before the pool can be treated as healthy.

`runtime_recover` reopens the exact persisted conversation and never creates a new task attempt. If exact-conversation recovery cannot establish a safe state, it fails closed. Replacement with a fresh conversation must use the #51/#120 continuation contract rather than silently minting a new logical worker.

## Scaling down / stop

Scale-down and stop are fenced before the browser effect:

- worker must be idle and available;
- no current task;
- no targeted queued task;
- no unresolved carrier operation;
- no unresolved continuation;
- worker is fenced from authority before browser close;
- lost close acknowledgement becomes reconciliation-required;
- the close is not blindly repeated.

## Security boundaries

The runtime must not:

- persist or emit OAuth/access tokens, cookies, local-storage secrets, or private ChatGPT session material;
- use hidden/private OpenAI APIs;
- bypass CAPTCHA, challenge, rate limits, quotas, or account controls;
- rotate accounts to evade limits;
- treat browser/session state as task authority;
- infer task completion from model prose;
- retry an outcome-unknown external effect under a new task/attempt.

## Native acceptance still required

Source integration is only G1. Issue #117 stays open until exact installed macOS evidence proves:

1. **G0** — real browser/CDP/Project/conversation/app-binding mechanism on the target Mac;
2. **G2** — Main-only `runtime_ensure(3)` creates/restores exactly three healthy workers and repeated `ensure(3)` creates none;
3. **G3** — three targeted tasks wake the exact carriers, execute, submit, and collect with zero manual worker interaction;
4. **G4** — losing one managed browser carrier and recovering the exact logical worker leaves the others untouched;
5. **G5** — `3 -> 5 -> 2` scaling protects busy/targeted/reconcile-required workers;
6. **G6** — after DevSpace/browser restart, one `runtime_ensure` reconstructs/revalidates the desired pool from durable secret-free state.

Required post-setup interaction budget for those live gates:

```text
manual worker window creation      0
manual worker dev-c selection      0
manual join/invite transfer        0
manual workerId/taskId transfer    0
manual worker wake                 0
manual worker result relay         0
```
