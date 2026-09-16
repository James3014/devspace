# macOS Chat Swarm: existing Chrome control (Issue #117 Wave 3 G1)

This is the connection configuration for the existing `MacWebDriver` / `CdpMacWebDriver` runtime. It preserves the [managed worker lifecycle](chat-swarm-macos-runtime.md): Chat Swarm storage owns worker, task, attempt, result, replay, and reconciliation state. A browser target or successful CDP command does not establish worker authority.

This source candidate is G1 only. No installed-build, Chrome authorization, authenticated ChatGPT, native host, or G2–G6 acceptance is claimed. The live claim remains `MACOS_ZERO_TOUCH_CHATGPT_WORKER_RUNTIME_NOT_YET_PROVEN`.

## Explicit existing-session configuration

The normal intended connection is to an already running, authenticated Chrome selected by the operator. Configuration names below describe server inputs; this change does not modify the machine's environment.

| Setting | Value |
| --- | --- |
| `DEVSPACE_CHAT_SWARM_RUNTIME` | `1` to enable managed runtime |
| `DEVSPACE_CHAT_SWARM_PROJECT_URL` | Exact `https://chatgpt.com/...` Project URL |
| `DEVSPACE_CHAT_SWARM_TRANSPORT` | `cdp` (default transport) |
| `DEVSPACE_CHAT_SWARM_CDP_MODE` | `existing-session` (must be explicit) |
| `DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR` | Explicit absolute existing Chrome **user-data-dir**, containing `DevToolsActivePort`; not a child `Default` or `Profile 1` directory |
| `DEVSPACE_CHAT_SWARM_APP_LABEL` | `dev` by default; override only for the intended installed app |

`DEVSPACE_CHAT_SWARM_BROWSER_BIN` and `DEVSPACE_CHAT_SWARM_CDP_ENDPOINT` must be unset in this mode. There is no default-profile discovery, port scan, fixed-port fallback, or automatic switch to another transport. When CDP mode is omitted, legacy managed CDP behavior is preserved; existing-session discovery is never inferred.

One-time setup requires Chrome 144+ with remote debugging explicitly enabled at `chrome://inspect/#remote-debugging`, followed by the user selecting **Allow** in Chrome's connection authorization dialog. Consent remains under Chrome/user control; DevSpace does not automate either step. See [Chrome's existing-session flow](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) and the [DevTools MCP endpoint discovery implementation](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/browser.ts).

The driver reads only `<explicit user-data-dir>/DevToolsActivePort`, a public endpoint artifact. It accepts a bounded regular file containing a decimal port in `1..65535` and `/devtools/browser/<id>`, then connects to `ws://127.0.0.1:<port><path>`. Missing, symlinked, oversized, or malformed metadata fails closed; artifact contents are not echoed in errors. It does not assume that the authorized browser WebSocket also serves `/json/list` or `/json/new`.

Each lifecycle operation resolves the artifact afresh and opens one bounded control connection. `Browser.getVersion`, `Target.getTargets`, `Target.createTarget`, `Target.attachToTarget` with flattened sessions, and `Runtime.evaluate` use that connection. The connection closes when the operation finishes or fails. Changed ports and browser endpoint IDs are not persisted. Chrome may request consent for a new connection; this G1 seam does not promise consent-free native operation.

Existing-session mode never launches, terminates, restarts, or changes the configuration of the user's Chrome. It never copies cookies, tokens, local storage, or profile state, and never clicks or bypasses browser authorization UI. Authorized worker lifecycle operations can open, inspect, send to, or close the exact worker tabs. Missing metadata or denied control is not permission to launch a replacement browser or retry by another mechanism.

## Legacy managed fallback and optional OpenCLI

The dedicated managed direct-CDP path remains available with `DEVSPACE_CHAT_SWARM_CDP_MODE=managed` or with CDP mode unset for backward compatibility. It uses `DEVSPACE_CHAT_SWARM_CDP_ENDPOINT` (default `http://127.0.0.1:9222`) and the existing dedicated `DEVSPACE_CHAT_SWARM_BROWSER_PROFILE_DIR` (default `~/.devspace/chat-swarm-browser`). `DEVSPACE_CHAT_SWARM_BROWSER_BIN`, if configured, permits the existing managed startup path with `--user-data-dir` when control is unavailable. Use a dedicated directory, never an authenticated user's regular profile. This remains the legacy fallback, not normal existing-session UX; existing-session must always be explicitly selected.

`DEVSPACE_CHAT_SWARM_TRANSPORT=opencli` remains an optional compatibility/diagnostic adapter. It is not canonical and is never selected automatically after a CDP failure. No per-worker browser profiles or processes are introduced.

## Exact conversations and failure boundaries

- Persisted conversation URL/fingerprint and authenticated peer binding remain distinct. `targetId` and CDP `sessionId` exist only inside a control operation and never become logical worker identity.
- Reuse requires an exact conversation URL match. If the target disappeared or navigated elsewhere, recovery opens only the persisted URL. It does not mint a worker, task, attempt, or result. A failed recovery leaves the existing durable reconciliation rules in force.
- Recovery verifies the observed URL; prompt delivery also checks the exact URL inside the DOM mutation before touching the composer. Other worker targets remain untouched. Cross-session CDP responses fail closed.
- `BROWSER_CONTROL_UNAVAILABLE:*` identifies missing/invalid metadata, unavailable authorization/connection, disconnects, or rejected control commands. A closed socket alone cannot distinguish a user's denial from a transport failure.
- `CHATGPT_SIGNED_OUT` identifies visible login UI or an auth route. Composer timeout remains a separate UI-readiness error; it does not imply signed-out status.
- `HOST_APP_BINDING_*`, `CHATGPT_CONVERSATION_IDENTITY_DRIFT`, authenticated peer checks, and durable reconciliation retain separate meanings. Control connectivity alone proves none of them.
- No automatic reconnect or command resend occurs within a failed operation. Failed prompt delivery retains the existing conservative `remoteMayContinue=true`, including when a target may have been reopened or a send acknowledgement was lost. Existing durable operation journals govern replay and reconciliation; an unknown outcome is not retry permission.

## Verification boundary

G1 uses temporary public-artifact fixtures and a fake CDP WebSocket, plus existing durable worker/task tests. Focused tests cover explicit configuration, metadata rejection, endpoint changes, exact target/session isolation, target loss, authorization/connection failure, and uncertain sends. Build/typecheck validate source integration only. Real Chrome consent, ChatGPT login/app binding, installed-host operation, and G2–G6 require separate authorized native witnesses.
