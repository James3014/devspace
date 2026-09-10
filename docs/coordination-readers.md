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
