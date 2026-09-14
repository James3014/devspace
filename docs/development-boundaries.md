# DevSpace development boundaries

This document defines dependency direction inside DevSpace. It is an engineering boundary, not a new runtime authority model.

The executable source of truth for the first boundary slice is `src/development-boundaries.ts`; `src/development-boundaries.test.ts` prevents declared control-substrate modules from acquiring direct dependencies on replaceable provider, carrier, or strategy code.

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

## Current migration debt

The first fence intentionally does not pretend the repository is already fully separated.

`durable-operations.ts` mixes the generic durable operation ledger with ChatSwarm migration preparation/apply/reconcile behavior. The generic ledger remains strategically important, but the ChatSwarm migration adapter is replaceable strategy-specific wiring. Split those concerns before promoting the module into the clean control kernel.

`host-operations.ts` currently imports redaction from `local-agent-errors.ts` and consumes the mixed `durable-operations.ts` surface. Shared redaction should move to a neutral utility, and host operations should consume a neutral durable-operation contract/store surface before this module is promoted into the kernel.

These entries are explicit debt, not permanent exceptions. New control code must not use them as precedent for additional provider/carrier/strategy coupling.

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
