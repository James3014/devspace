# DevSpace development boundaries

This document defines dependency direction inside DevSpace. It is an engineering boundary, not a new runtime authority model.

The executable source of truth is `src/development-boundaries.ts`; `src/development-boundaries.test.ts` prevents declared control-substrate modules from acquiring direct dependencies on replaceable provider, carrier, or strategy code. The same fence runs in normal `npm test` and CI.

## Control substrate

The control substrate contains mechanics that must remain useful as models, providers, worker topologies, and conversation carriers change:

- filesystem/root containment;
- execution authority/effect/claim contracts;
- control-plane ownership, leases, reconciliation, and idempotency;
- bounded host-operation policy;
- platform process mechanics.

A control-substrate module may depend on Node/platform infrastructure and neutral control contracts. It must not import provider implementations, ChatGPT/browser carrier implementations, or optional ChatSwarm strategy.

## Replaceable edges

Provider adapters translate an already-admitted execution request into Codex, Claude, OpenCode, Pi, ACP, or another provider runtime. Provider/model availability is evidence for execution readiness; it is not execution authority.

Carrier adapters deliver or recover a bounded logical worker through a replaceable conversation/browser carrier. Carrier health, URL identity, or wake success does not mint task authority.

Cognitive/coordination strategy includes worker topology, ChatSwarm coordination, profile/toolchain selection, and similar orchestration choices. These may consume control-substrate contracts. They do not own completion, merge, release, or deployment truth.

## Composition roots

`server.ts` and `cli.ts` are composition roots. They are expected to wire control and replaceable layers together. An import from a composition root is therefore not evidence that the imported component belongs to the control substrate.

## Resolved second-wave debt

The second boundary slice removes the two explicit debts recorded by the first fence:

- shared sensitive-text redaction lives in neutral `sensitive-redaction.ts`; provider code re-exports it for compatibility while `host-operations.ts` consumes the neutral utility directly;
- ChatSwarm migration preparation/apply/reconcile lives in `chat-swarm-migration.ts`, which consumes the neutral durable-operation store. `durable-operations.ts` no longer imports ChatSwarm implementation modules.

`durable-operations.ts`, `host-operations.ts`, and `sensitive-redaction.ts` are therefore part of the declared control kernel. `server.ts` remains the composition root. `DEVELOPMENT_BOUNDARY_DEBT` is empty at this revision; future mixed modules must be recorded explicitly rather than silently promoted.

## Dependency rule

```text
control substrate
      ^
      |
provider adapters   carrier adapters   optional strategy
      \                 |                 /
       \                |                /
        +--------- composition root -----+
```

Allowed: replaceable edges consume stable control contracts.

Forbidden: control substrate imports replaceable edge implementations in order to obtain provider state, carrier state, worker topology, model selection, or strategy decisions.

The boundary is intentionally incremental: declare only modules that are actually clean, make migration debt visible, then move modules into the kernel only after their imports are neutralized and tests prove it.
