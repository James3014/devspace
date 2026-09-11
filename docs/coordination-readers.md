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

Embedding hosts may pass `completionBindings` to `createServer`: an array of
`{ repository, goal, subject, readers: { readContract, readEvidence } }` entries.
This evidence-only option preserves built-in pairing and cannot be combined with
custom `coordination` readers. Keys and callback references are captured at startup;
duplicate or malformed bindings fail startup. Each callback checks the current
carrier before and after reading, including expiry, revocation and authority
generation. Repository, goal and subject must match the host-selected binding.
The selected candidate is validated by the existing completion projector and need
not equal the carrier's base revision.

Hosts must independently establish the contract source, artifact integrity and
verification provenance before supplying these readers. The projector validates
records but does not authenticate a claimed artifact hash or reviewer identity.
There is no default file reader, automatic source selection, matrix fallback or implicit
grant. This embedding interface alone does not establish production acceptance.

For a CLI host, select an independently reviewed completion-only module explicitly:

```sh
devspace serve --completion-reader-module /absolute/path/completion.mjs --completion-reader-sha256 <64-hex-sha256>
```

The module exports `createCompletionBindings({ stateDir })`, returning the same
binding array described above. Its exact bytes use the existing verified module
loader and syntax restrictions. Only completion bindings are accepted; authority
hooks and extra fields are rejected. Do not combine these flags with coordination
reader flags. Missing flags, invalid bindings or a changed digest fail startup.
Pairing remains available. Selecting the module pins executable code, not evidence
truth: the reviewed reader must still validate its canonical sources, artifact
integrity and acceptance provenance. Synthetic fixtures cannot establish delivery.

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

The built-in contract supports a separately approved controller-only cutover as
described below. Existing custom reader integration remains separate. Pairing demonstrates possession of a carrier
credential, not native ChatGPT conversation attestation. HTTP SDK tests establish
the transport path; they do not establish deployment or native host acceptance.


### Reauthorize an expired carrier and resume safely

`devspace carrier show <carrier-id>` reads the immutable contract, revocation state, and validity version without disclosing credentials. The local operator can extend validity with `devspace carrier reauthorize <carrier-id> --validity-version <version> --until <ISO expiry>`. The future expiry must be within the existing 24-hour lease bound. This compare-and-swap update preserves the carrier ID, credential, scope, base and grant hash. Stale versions and revoked carriers are rejected. Children cannot exceed active parent validity; renewing a parent does not renew expired children.

The existing credential can then resume an authenticated MCP session. Renewal never clears a live operation pin or invents completion evidence. Reconcile interrupted operations using their persisted terminal witnesses; without a witness, the operation stays pinned. Changes to carrier or ancestor validity during execution fence completion even when the immutable grant is unchanged.

For an expired lease without a pinned effect, use `coordination_lease_read`, then explicitly release that exact version with `coordination_lease_release`. Prepare a distinct operation after reconciliation or release. Preparation never silently deletes or revives expired ownership. These commands use the existing ownership store.

Local approval proves local operating-system access and bounded credential possession. It does not attest a ChatGPT conversation, deploy the package, or prove native ChatGPT execution.

### Approve one exact cutover

A local cutover approval uses a root controller with `operations: ["cutover_start"]`
and `scope: [stateRoot]`. The state root must be the exact canonical configured
`stateDir`. This exception does not add the state directory to allowed workspace
roots and cannot be used by dependency contracts. Cutover authority cannot be
delegated or handed off. Existing custom host readers retain their own contract.

The additional strict `cutover` object contains:

- `stateRoot`, `attemptKey`, and an ISO `expiresAt` no later than initial carrier expiry;
- `currentIdentity`: exact original `serverInstanceId`, `sourceCommit`, `buildId`, and `capabilityManifestSha256`;
- `expectedIdentity`: exact replacement source, build and capability digest;
- `restart`: exact `buildReady` (`verifiedBy`, `verifiedAt`, nonempty `evidence`), `actuator: "launchd-self"`, `serviceLabel`, and `launchdTarget`;
- `finish`: exact `workspaceId` and `agentId` for the reconciliation witness.

The original source is the carrier's frozen `baseRevision` throughout recovery.
Unknown source identities cannot be approved. The operator must verify build-ready
evidence before approval; the live build probe is still required before scheduling.
No future replacement instance ID or generated cutover ID is invented at approval.
The durable request correlates that generated ID; finish requires a different
instance with the approved replacement identity and the approved witness selection.

After local `carrier approve` and credential resume, call
`coordination_prepare_cutover` with explicit `attemptKey`, `expectedSourceCommit`,
`expectedBuildId`, `expectedCapabilityManifestSha256`, and `expiresAt`, then pass
the same inputs to `cutover_start`. Preparation uses the actual server identity
and configured state root. Its request hash and operation ID must match approval;
changed inputs are rejected before the cutover write. Drain, restart and finish
continue through existing durable consumer checks and retain uncertain effects.

After the cutover deadline, preparation, a new start, drain and restart are denied.
Only exact persisted reconciliation/finish remains permitted under current carrier
authority **and an unexpired resource lease**. Carrier reauthorization does not
extend the cutover deadline or renew an expired resource lease. An expired pinned
resource lease remains rejected and pinned; its cutover recovery is an outstanding
integration requirement, not permission to restart or delete state.
