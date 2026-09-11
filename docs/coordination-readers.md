# CLI coordination readers

An operator can connect the existing host reader interface when starting DevSpace:

```sh
devspace serve --coordination-reader-module /absolute/path/readers.mjs --coordination-reader-sha256 <64-hex-sha256>
```

Both flags are required together. The `.mjs` artifact must be a self-contained ESM bundle exporting `createCoordinationReaders({ stateDir })`. The context is frozen and contains no credentials. The factory may be asynchronous and returns the existing `ControlPlaneConsumerOptions` interface. `resolveOwnerContext`, `verifyGrantEvidence`, and `resolveEffectBinding` are required functions; supplied optional interface hooks must also be functions.

DevSpace reads the artifact once, verifies its SHA-256, parses its syntax, and imports those same bytes through a data URL. Static imports and re-exports may reference only `node:` builtins. Dynamic imports, including nested and computed imports, are rejected. Relative imports and npm package imports are unsupported: bundle dependencies into the reviewed artifact.

This is operator-supplied executable code with host privileges, not a sandbox. Loading further executable dependencies through builtins, filesystem reads, eval, or similar mechanisms violates the supported artifact contract; the loader does not claim to prevent those mechanisms. The digest identifies the selected artifact, not its transitive effects or the legitimacy of any authority source. Operators must review that boundary before selecting an artifact.

Readers must consult the existing canonical authority and evidence sources. OAuth authentication, a caller-supplied owner name, this module's presence, and its digest are not grants. Resource leases remain subordinate to canonical work ownership. A reader adapter must not issue authority or turn reported completion into accepted evidence.

Configured bootstrap failure stops startup before listening and reports a bounded error without module contents or factory exception details. Omitting both flags preserves ordinary startup; guarded operations still deny when trusted readers are unavailable. No module discovery, registry, fallback issuer, or implicit standing grant is provided.

## Built-in carrier pairing

Without a custom reader module, the server now exposes a local pairing path for
bounded dependency operations. Unpaired sessions have no coordination authority.
An explicitly configured custom reader retains exclusive control; the built-in
pairing tools are not enabled alongside it.

1. The MCP client calls `coordination_pair` and keeps its private credential.
   The pending ID identifies the pairing request; it does not grant authority.
2. The local operator inspects the pending ID with
   `devspace carrier inspect <pending-id>` and approves a bounded JSON contract:
   `devspace carrier approve <pending-id> --contract <file> --confirm <pending-id>`.
   The contract contains `repository`, `goal`, `role`, `scope`, `baseRevision`,
   `operations: ["dependency_sync"]`, and an ISO `expiresAt`. Scope must be within
   configured roots. Local approval represents the local OS user's authority;
   it is not proof of human presence and is not a sandbox against local shell access.
3. The client calls `coordination_resume` with its credential. The server associates
   the verified carrier with that authenticated MCP session. Another session using
   the same OAuth client must prove possession separately. Conversation metadata
   cannot substitute for this proof. Credentials are stored only as hashes and
   must not be copied into ordinary receipts, logs, or another carrier's conversation.
4. A controller can approve a worker's pending pairing using
   `coordination_delegate`. Repository, goal and base must match; scope, operations
   and expiry may only narrow. Workers cannot delegate or create controllers.
5. Before `dependency_sync`, use `coordination_prepare_dependencies` with the same
   workspace, recipe and attempt key. It calculates the real request and acquires
   the existing ownership lease. Execution calculates the request again, rejecting
   input drift. The actual recipe still runs through the durable consumer fence.

`coordination_revoke_worker` revokes an exact child version. The local operator can
revoke any carrier using `devspace carrier revoke <carrier-id> --version <version>`.
Every protected operation rereads revocation and expiry, including parent records.
A server restart forgets session associations; credentials can resume their still
valid persisted authority.

Existing `coordination_handoff` transfers the same lease and operation to another
verified carrier. The recipient must have compatible current authority; a worker
cannot use handoff to promote itself. The effect retains its original request hash.
Revocation cannot undo an already launched process. A confirmed command exit and
frozen-input/base readback are persisted as an immutable terminal witness, allowing
`operation_reconcile` to close that same pinned effect under current authority.
Without a recorded terminal witness, uncertainty stays pinned and is not retried.

This built-in contract currently rejects cutover operations. Existing custom reader
cutover integration remains separate. Pairing demonstrates possession of a carrier
credential, not native ChatGPT conversation attestation. HTTP SDK tests establish
the transport path; they do not establish deployment or native host acceptance.
