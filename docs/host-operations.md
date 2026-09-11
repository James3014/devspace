# Host operations

Host operations are a dedicated, startup-authorized host executor. They are
separate from provider or model dispatch and do not grant repository mutation
authority.

The feature is disabled by default and is supported only on macOS, where the
OS sandbox profile is available. Enable it only with the startup environment
configuration below:

- `DEVSPACE_HOST_OPERATIONS=true`
- `DEVSPACE_HOST_OPERATION_OWNER_CLIENT_ID`
- `DEVSPACE_HOST_OPERATION_EXECUTABLE`
- `DEVSPACE_HOST_OPERATION_EXECUTABLE_SHA256`
- `DEVSPACE_HOST_OPERATION_ARGV` (JSON array of arguments; the executable is
  configured separately and is not repeated in this array)
- `DEVSPACE_HOST_OPERATION_CWD`
- `DEVSPACE_HOST_OPERATION_ALLOWED_PATHS`
- `DEVSPACE_HOST_OPERATION_READ_PATHS` (optional)
- `DEVSPACE_HOST_OPERATION_MAX_WALL_MS` and
  `DEVSPACE_HOST_OPERATION_MAX_IDLE_MS` (optional bounded overrides)
- `DEVSPACE_HOST_OPERATION_ALLOW_LONG_LIVED` (optional; defaults false)

The authenticated OAuth client must exactly equal the startup-selected owner
client. Requests must match the startup executable path and SHA-256, exact
argv, canonical cwd, and approved write/read paths. The executor does not
accept arbitrary shells, `sudo`, `launchctl`, provider credentials, network
access, process forking, service control, or an inferred repository scope.

The MCP surface exposes five operations: `host_operation_preflight`,
`host_operation_start`, `host_operation_status`, `host_operation_reconcile`,
and `host_operation_cancel`. Each operation is bound to one durable
`attemptKey`; replaying a completed operation returns its durable record.
A conflicting request that reuses the same attempt key fails closed, while a
new attempt key is permitted when it independently matches the startup policy.
Started or unknown operations require status/reconcile handling, and concurrent
replays share the existing in-flight operation. A shared registrar keeps exact
process ownership across MCP disconnects. After a server restart, an
unproven process is `outcome_unknown` and must be reconciled; a raw PID is
never sufficient for cancellation.

The executor enforces bounded wall and idle lifetimes. Long-lived processes
require explicit startup authorization and remain cancellable only through
their exact verified process identity. A successful preflight or test fixture
does not prove deployment, production readiness, or a live user's loaded MCP
surface.

For an inert local smoke fixture, `/usr/bin/true` with an empty argument list
is a suitable executable example when its startup SHA-256 and cwd/path policy
are bound explicitly. It performs no remote control and should not be used as
an authorization shortcut.
