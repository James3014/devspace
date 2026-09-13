# Physical Host Registry (G1)

Status: **experimental, read-only, opt-in**.

This feature implements the first bounded gate from #123: represent a physical DevSpace host as an explicit owner-configured identity and verify that host's existing `/identity` endpoint before exposing its capability manifest.

It does **not** provide remote shell, remote MCP tool forwarding, remote workspace mutation, worker placement, failover, retry authority, or task authority.

## Authority model

The identities remain distinct:

```text
host_id
!= workspace_id
!= worker_id
!= carrier_id
!= operation_id / attemptKey
```

A reachable host is not automatically admitted. Host health and capability visibility are evidence only.

```text
owner-pinned host_id
  -> exact /identity URL
  -> HTTPS fetch (HTTP only for loopback)
  -> product=devspace
  -> sourceDirty=false
  -> sourceCommit exact match
  -> buildId exact match
  -> capability schema = devspace.capability_manifest.v1
  -> capability manifest SHA-256 exact match
  -> MATCH
```

Only `MATCH` exposes the remote capability manifest through `host_capabilities`.

## Configuration

The registry is disabled unless `DEVSPACE_PHYSICAL_HOST_REGISTRY` points to an owner-controlled JSON file.

The path must be absolute (or start with `~/`), must be outside every `DEVSPACE_ALLOWED_ROOTS` path, and must be a regular non-symlink file. On POSIX systems it must have no group/other permissions and must have a single hard link (`chmod 600` is the intended mode).

Example:

```json
{
  "hosts": [
    {
      "hostId": "mac-studio",
      "identityUrl": "https://mac-studio.example.test/identity",
      "expected": {
        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
        "buildId": "devspace-build-id",
        "capabilityManifestSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    }
  ]
}
```

A maximum of 16 explicit hosts is accepted. The tool surface never accepts an arbitrary URL from a model or caller; callers select an exact preconfigured `hostId`.

## MCP tools

When the registry is configured, DevSpace exposes three read-only tools:

- `host_registry_list` — returns configured host IDs and pinned expected identity. It performs no network request.
- `host_registry_status` — performs one bounded read of the configured `/identity` endpoint and classifies the result as `MATCH`, `IDENTITY_MISMATCH`, `UNREACHABLE`, or `INVALID_RESPONSE`.
- `host_capabilities` — returns the capability manifest only when identity state is `MATCH`.

The network read has a fixed 3-second timeout, rejects redirects, rejects responses larger than 128 KiB, and sends no DevSpace credentials or owner secrets.

## Explicit non-goals

G1 intentionally rejects the donor project's generic device-forwarding model. There is no equivalent of:

```text
call_device_tool(host, arbitraryTool, arbitraryArguments)
```

There is also no automatic discovery, SSH credential storage, broad OS execution, cross-host retry, or host-driven task scheduling.

In particular:

```text
host A unreachable
!= no effect occurred
!= safe to send an effect to host B
```

Any later remote mutation gate must compose an admitted `host_id` with the existing DevSpace workspace and durable-operation authorities instead of inventing a parallel execution path.

## Verification boundary

Source/unit/CI verification can prove registry parsing, identity admission, mismatch failure, schema failure, and normal DevSpace regression behavior.

It does **not** prove physical two-Mac operation. That remains the next live gate:

```text
controller host
-> exact remote host
-> exact remote DevSpace identity
-> remote open_workspace/read-only canary
```

No claim of distributed execution should be made until that physical canary is run.
