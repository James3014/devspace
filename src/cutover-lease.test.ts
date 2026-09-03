import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCutoverLease,
  readCutoverLease,
  releaseCutoverLease,
} from "./cutover-lease.js";

test("cutover lease: one winner, owner-only release, and TTL expiry allows replacement", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "devspace-cutover-lease-"));
  try {
    let now =1_000;
    const first = await acquireCutoverLease({
      stateRoot,
      serverInstanceId: "instance-a",
      now: () => now,
      ttlMs: 10_000,
    });
    assert.equal(first.acquired, true);
    assert.equal(first.reason, "acquired");

    const second = await acquireCutoverLease({
      stateRoot,
      serverInstanceId: "instance-b",
      now: () => now,
    });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, "held");
    assert.equal(second.existing?.holder, "instance-a");

    const wrongOwner = await releaseCutoverLease(stateRoot, "instance-b");
    assert.equal(wrongOwner.released, false);
    const held = await readCutoverLease(stateRoot);
    assert.equal(held?.holder, "instance-a");

    now =20_000;
    const replacement = await acquireCutoverLease({
      stateRoot,
      serverInstanceId: "instance-c",
      now: () => now,
    });
    assert.equal(replacement.acquired, true);
    assert.equal(replacement.reason, "replaced_expired");
    assert.equal(replacement.lease?.holder, "instance-c");

    const owned = await releaseCutoverLease(stateRoot, "instance-c");
    assert.equal(owned.released, true);
    const after = await readCutoverLease(stateRoot);
    assert.equal(after, undefined);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});