# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Protected PR Integration Fallback

`git_merge_pull_request` is a narrow protected integration action, not a
generic git mutation capability. It is the bounded fallback for when the
primary GitHub connector is unavailable.

- Repository identity is derived from the workspace canonical origin remote and
  cross-verified against GitHub; the caller cannot select an arbitrary target
  repository, branch, refspec, or remote.
- Before merging, the action re-reads fresh state: PR open / not draft / base
  is the repository default branch / head matches the expected SHA / default
  branch SHA matches the expected base / PR mergeable / required status checks
  all terminal success. `ownerConfirmation` must be exactly `true`.
- The merge uses GitHub's native exact-head CAS (`sha`), and the base branch is
  re-read immediately before the merge. A drifted head or base fails closed
  (`EXPECTED_HEAD_MISMATCH` / `EXPECTED_BASE_MISMATCH`); the action never
  re-validates a changed head, never force-pushes, and never falls back to an
  unrestricted shell.
- The GitHub CLI runs through `execFile` with a fixed, typed argv (no shell, no
  caller-supplied suffix). If the transport is unavailable or required checks
  cannot be reliably determined, the action fails closed with a deterministic
  error code.

This action never bypasses branch protection, required checks, or admin merge
guards.

### Public canonical proxy surface

The public `canonical_gateway_proxy` surface (e.g. `mcp.snowskill.app`)
exposes the canonical Nexus Gateway manifest plus exactly two server-local
protected actions: `git_merge_pull_request` and `github_complete_pull_request`.
It never exposes raw DevSpace workspace, edit, write, or shell tools, and
`raw_devspace` remains loopback-only.

- The public merge action does not accept `workspaceId`, `cwd`, repository,
  remote, branch, refspec, or any shell input. Its filesystem root is the
  server-configured `NEXUS_CANONICAL_SOURCE_ROOT`; a missing root fails closed
  (`PUBLIC_MERGE_ROOT_UNCONFIGURED`) rather than guessing a workspace.
- Its trusted target is server-controlled and distinct from the raw surface:
  `origin -> James3014/Nexus-new -> main`. The raw surface keeps its own
  `nexus-new -> James3014/Nexus-new -> main` default; neither is
  caller-selectable.
- If the canonical Gateway manifest ever exposes either protected host action,
  the public surface fails closed at startup until an explicit migration
  decision is made; it never silently shadows, duplicates, or selects one
  implementation.
- `github_complete_pull_request` runs the Nexus
  `run_github_completion_loop()` caller through a JSON-lines host bridge. The
  Python caller cannot merge `main` directly: its CAS merge port is routed back
  into the existing `git_merge_pull_request` core. Integration generations are
  same-repository, non-force PR-branch updates and are capped at 3 generations
  and 2700 seconds. Any affected semantic/authority/test/transport dimension
  fails closed for fresh Candidate acceptance.

The protected merge behavior itself remains the same `git_merge_pull_request`
core used by the raw surface; the completion action reuses that core rather than
adding another protected merge implementation.

### Bound host generation activation

`nexus-devspace host-generation` is a CLI-only control for this host package. It
is not a public MCP action. Callers cannot select a service label, executable,
path, refspec, environment map, or shell command. `status` is read-only.
`activate` requires an exact `expected_old` generation and an exact desired
Candidate/build identity, packs from the CLI package's own git checkout, installs
that one artifact into the bound global package path, and kickstarts only
`com.nexus.mcp.devspace.direct`. A second successful invocation reconciles
without repeating mutation.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.
