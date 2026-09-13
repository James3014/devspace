# Host activation

Host activation is the typed, host-scoped production-effect mode built on top of the existing startup-authorized host operation executor. It exists for the narrow case where a validated Candidate must be installed into fixed local runtime surfaces outside an ordinary DevSpace workspace without falling back to an arbitrary shell command.

The first admitted activation kind is `OPENCLI_CHATGPT_ADAPTER_OVERLAY`. The caller does not choose target paths, transformations, or an executable at runtime. Those values are frozen by the startup host-operation policy and by one read-only activation manifest passed in the exact startup-authorized argv.

## Safety model

An activation manifest uses schema `devspace.host_activation_manifest.v1` and contains:

- one admitted activation `kind`;
- a host receipt directory;
- one or more target IDs and absolute target paths;
- exact expected preimage and postimage SHA-256 values;
- an exact `replace_exact_utf8` transformation for each target.

The manifest file itself must be inside the startup-approved read scope. Every target and the receipt directory must be inside the startup-approved write scope. Existing host-operation constraints still apply: authenticated Owner client, exact executable path and hash, exact argv, exact cwd, macOS sandboxing, no network, no shell class, no `sudo`, no `launchctl`, no process fork, and bounded lifetime.

The activation manifest SHA-256 is added to the durable request identity before the first possible target mutation. If the manifest changes after that bind, the activation fails closed.

## Transaction

For a new operation the executor performs this order:

1. bind the exact startup-authorized host operation;
2. bind and hash the activation manifest;
3. durably record the operation intent;
4. physically read every target and compare it with the expected preimage/postimage hashes;
5. reject drift before target mutation;
6. materialize every deterministic postimage and verify its declared hash;
7. write a complete rollback bundle before the first target write;
8. atomically replace targets one at a time;
9. physically read back every target;
10. write a terminal activation receipt.

If a target write fails, rollback is attempted for the complete target set and every restored target is re-read before the result is classified.

## Physical result classes

Host activation reports one of these effect states inside `HostOperationReceipt.observedPaths.activation`:

- `CONFIRMED_NO_EFFECT`
- `APPLIED`
- `PARTIAL_EFFECT`
- `ROLLED_BACK`
- `EFFECT_UNKNOWN`
- `BLOCKED_PREIMAGE_DRIFT`

A process exit code is not sufficient to produce `APPLIED`. A valid terminal activation receipt bound to the same operation and manifest plus exact postimage readback is required after uncertain execution. Unreceipted postimages after a restart remain `EFFECT_UNKNOWN`.

`PARTIAL_EFFECT` and `EFFECT_UNKNOWN` remain non-retryable. The same operation must be reconciled; a fresh attempt key is not a way to bypass unknown external-effect state.

## Existing MCP surface

Host activation intentionally reuses the existing host-operation surface rather than creating a second host executor:

- `host_operation_preflight`
- `host_operation_start`
- `host_operation_status`
- `host_operation_reconcile`
- `host_operation_cancel`

An activation request is recognized only when the exact startup-authorized argv contains one `--activation-manifest <absolute-path>` binding. `allowLongLivedProcess` is rejected for activation operations.

The activation executable is the packaged `dist/host-activation-cli.js` run by an exact startup-authorized Node executable. DevSpace injects the durable operation ID, manifest SHA, and already-approved read/write scopes into the child environment; callers do not supply those values.

## Example startup binding

The values below are illustrative. The operator must pin the actual packaged Node executable, its current SHA-256, exact installed DevSpace CLI path, exact manifest path, and exact host paths.

```text
DEVSPACE_HOST_OPERATIONS=true
DEVSPACE_HOST_OPERATION_EXECUTABLE=/absolute/path/to/node
DEVSPACE_HOST_OPERATION_EXECUTABLE_SHA256=<exact sha256>
DEVSPACE_HOST_OPERATION_ARGV=["/absolute/path/to/devspace/dist/host-activation-cli.js","--activation-manifest","/absolute/path/to/opencli-overlay-manifest.json"]
DEVSPACE_HOST_OPERATION_CWD=/absolute/approved/cwd
DEVSPACE_HOST_OPERATION_ALLOWED_PATHS=/fixed/activation/target/or/parent,/fixed/receipt/dir
DEVSPACE_HOST_OPERATION_READ_PATHS=/absolute/path/to/opencli-overlay-manifest.json
DEVSPACE_HOST_OPERATION_ALLOW_LONG_LIVED=false
```

The OpenCLI manifest should bind only the user adapter, packaged adapter, corresponding regression-test files, launcher pin, and the activation receipt directory required by the accepted overlay. It must not grant general `$HOME`, package-manager, shell, service-control, credential, or repository mutation authority.

## Authority boundary

This primitive is host execution mechanics only. `OWNER_DIRECT` remains the current activation authority lane. A future `NEXUS_GOVERNED` lane must fail closed until DevSpace can verify a canonical Nexus execution grant; it must not infer authority from Candidate existence, model output, Issue state, or this receipt.

`APPLIED` is only activation truth. It does not mean the runtime has passed production canary, semantic acceptance, release, or public-claim gates.
