import assert from "node:assert/strict";
import test from "node:test";
import { buildHostIdentityBinding, parseHostIdentityBinding } from "./host-identity.js";

test("host identity binds host, environment, Node major, state root, build, and source without exposing HOME/PATH", () => {
  const identity = buildHostIdentityBinding({
    environment: {
      HOME: "/Users/james",
      PATH: "/opt/homebrew/bin:/usr/bin",
      DEVSPACE_HOST_ID: "m5-pro",
    },
    stateRoot: "/Users/james/.local/share/devspace",
    devspaceBuildId: "devspace-1.0.7-abc",
    devspaceSourceCommit: "a".repeat(40),
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.8.1",
    hostname: "fallback.local",
  });
  assert.equal(identity.hostId, "m5-pro");
  assert.equal(identity.platform, "darwin");
  assert.equal(identity.arch, "arm64");
  assert.equal(identity.nodeMajor, 24);
  assert.equal(identity.devspaceBuildId, "devspace-1.0.7-abc");
  assert.equal(identity.devspaceSourceCommit, "a".repeat(40));
  const serialized = JSON.stringify(identity);
  assert.ok(!serialized.includes("/Users/james"));
  assert.ok(!serialized.includes("/opt/homebrew/bin"));
  assert.deepEqual(parseHostIdentityBinding(identity), identity);
});

test("host identity changes for host, HOME, PATH, Node major, or state-root drift", () => {
  const base = {
    environment: { HOME: "/Users/james", PATH: "/opt/homebrew/bin:/usr/bin", DEVSPACE_HOST_ID: "m5" },
    stateRoot: "/Users/james/.local/share/devspace",
    devspaceBuildId: "build-1",
    devspaceSourceCommit: "b".repeat(40),
    platform: "darwin" as NodeJS.Platform,
    arch: "arm64",
    nodeVersion: "24.8.0",
    hostname: "m5.local",
  };
  const original = buildHostIdentityBinding(base);
  const variants = [
    buildHostIdentityBinding({ ...base, environment: { ...base.environment, DEVSPACE_HOST_ID: "m4" } }),
    buildHostIdentityBinding({ ...base, environment: { ...base.environment, HOME: "/Users/jameschen" } }),
    buildHostIdentityBinding({ ...base, environment: { ...base.environment, PATH: "/usr/local/bin:/usr/bin" } }),
    buildHostIdentityBinding({ ...base, nodeVersion: "22.20.0" }),
    buildHostIdentityBinding({ ...base, stateRoot: "/Users/james/other-state" }),
  ];
  for (const variant of variants) assert.notEqual(variant.hostIdentityHash, original.hostIdentityHash);
});

test("host identity parser fails closed on hash tampering", () => {
  const identity = buildHostIdentityBinding({
    environment: { HOME: "/h", PATH: "/p", DEVSPACE_HOST_ID: "host-a" },
    stateRoot: "/state",
    devspaceBuildId: "build",
    devspaceSourceCommit: "c".repeat(40),
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.0.0",
  });
  assert.throws(() => parseHostIdentityBinding({ ...identity, hostId: "host-b" }), /hash mismatch/);
});
