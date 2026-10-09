# Dev M5 governed cutover tooling

Operator scripts for the governed DevSpace cutover on the Dev M5 host (issue #473).
Run them ON the host as the service user. They only perform the documented governed
steps (no poller, no unmanaged restart): the single restart is the bound
`launchd-self` actuator inside the sidecar.

| File | Role |
| --- | --- |
| `devspace-build-ready.sh <full-sha\|origin/main>` | Builds the exact commit on the host and shapes `~/.devspace/worktrees/devspace-build-ready-current` into a real (non-symlink) package root; writes evidence to `~/.devspace/build-ready/<sha>.json`. Never touches `current-release.json`, `releases/`, launchd or cutover state. |
| `m5-cutover.sh <full-sha\|origin/main> [--skip-build]` | Orchestrator; re-running resumes. |
| `m5-cutover-sidecar.mjs` | Owner sidecar run by the orchestrator (env: `PENDING_ID`, `CONTRACT_PATH`, `RECEIPT_PATH`, `ACTIVE_RELEASE_ROOT`). |
| `m5-cutover-lib.mjs` | Pure helpers (mode selection, refusal, identity compare) imported by the sidecar. |
| `m5-cutover.test.mjs` | `node --test scripts/ops/m5-cutover/m5-cutover.test.mjs` (no live host needed). |

## Procedure (what `m5-cutover.sh` does)

1. Resolve the target sha (`origin/main` via `git ls-remote`, or a 40-hex sha) and detect any active generation.
2. Build-ready evidence: `devspace-build-ready.sh` builds on the host (`npm ci`, `npm run build`) and writes the evidence JSON. `--skip-build` reuses matching evidence.
3. If the target is already live, stop.
4. Exact capability digest: serve the build-ready root on a temp port (7699) with a copy of `~/.devspace/config.json` and a scratch HOME/state, read `capabilityManifest.manifestSha256` from `/healthz`, stop it. Fails closed.
5. Write the operator contract JSON (`~/.devspace/worktrees/m5-cutover-<sha8>-contract.json`, mode 0600; `cutover_start` only, 40 min / 35 min expiries).
6. In-process carrier pairing request (`CarrierBindingStore.requestPairing`).
7. `carrier approve <pending> --contract <file> --confirm <pending>` (fresh) or `carrier recover` (resume).
8. Resumable sidecar: start (if full), drain, bind activation, single restart, wait for replacement, witness, `finishCutover`.
9. Verify: `/healthz` shows the target sha, `cutoverMode=normal`, `reconciliationRequired=false`; `cutover status` closed; public `/identity`; negative canary `POST /api/cutover/start` is 404.
10. Release the terminal effect lease (workaround, tracked as #472): `cutover release-terminal-lease ...` with the closed record's terminal hash. Without it the next `prepareEffect` fails with "overlapping resource scope is already leased".
11. `carrier revoke <carrier> --version N`.

## Prerequisites

- `~/.devspace/config.json` with the usual serve keys plus `mcpCutoverBuildReadyRoot` pointing at the build-ready root (`~/.devspace/worktrees/devspace-build-ready-current`); it is also read for `stateDir`.
- launchd label `com.james.devspace-serve`, service root `~/.local/share/devspace-service`, `current-release.json` pointing (`releasePath`) at `releases/release-<sha>-<digest16>`.
- node, npm, git, python3, curl, openssl on PATH; `origin` of the source repo is `James3014/devspace`.

### Environment overrides (defaults are the M5 values)

| Variable | Default | Used by |
| --- | --- | --- |
| `DEVSPACE_SERVICE_ROOT` | `$HOME/.local/share/devspace-service` | orchestrator, sidecar (legacy `SERVICE_ROOT` still read by the sidecar) |
| `DEVSPACE_STATE_DIR` | `$HOME/.local/share/devspace` (legacy `STATE_DIR` honoured) | orchestrator (contract `stateRoot`, lease DB, fallback when config has no `stateDir`) |
| `DEVSPACE_BUILD_READY_ROOT` | `$HOME/.devspace/worktrees/devspace-build-ready-current` | orchestrator |
| `DEVSPACE_LAUNCHD_LABEL` | `com.james.devspace-serve` (target is `gui/$(id -u)/<label>`) | orchestrator |
| `DEVSPACE_OPS_BIN` | directory of the script | orchestrator (where `devspace-build-ready.sh` and the sidecar live) |
| `DEVSPACE_BUILD_READY_SRC` / `DEVSPACE_BUILD_READY_HOME` | `$HOME/Workspace/devspace` / `$HOME` | build-ready / orchestrator source repo |
| `WITNESS_WORKSPACE_ID`, `WITNESS_AGENT_ID` | `ws_2a861da43e`, `agt_c58e7609` | orchestrator (finish witness pair) |
| `DRAIN_WAIT_MS` | `600000` (10 min) | sidecar drain wait |

## Resume semantics

The sidecar chooses its mode from persisted cutover state plus live identity (read-only, before anything is mutated):

- `full`: no active generation (or closed) -> start, drain, bind, restart, finish.
- `resume_drain`: prepared, never drained, old runtime live -> wait for zero in-flight (up to `DRAIN_WAIT_MS`), then continue.
- `resume_restart`: drained + activation bound, no restart requested, old live -> restart, then finish.
- `resume_finish`: drained + activation bound, replacement already live -> witness + `finishCutover`.
- anything else is refused (exit 2) with a recovery command: restart already requested but old still live (one-restart rule), drained without activation, foreign generation, unknown live identity.

Re-running never re-issues `cutover_start` for an existing generation. The orchestrator waits 6 minutes for the sidecar and exits 4 if it is still running; re-run to resume.

## Pitfall: `carrier recover`

```
carrier recover <pending> --carrier <cid> --version N --validity-version N --confirm <cid>
```

`--confirm` must repeat the CARRIER id, not the pending id (unlike `carrier approve`, where confirm is the pending id).
