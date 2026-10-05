import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceNexusWriterAdmission, repositoryRequiresNexusAdmission } from "./nexus-mutation-admission.js";

function withTempRepo(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "devspace-nexus-admission-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

withTempRepo((root) => {
  assert.equal(repositoryRequiresNexusAdmission(root), false);
  assert.equal(
    enforceNexusWriterAdmission({
      workspaceRoot: root,
      ownerContext: "owner",
      operation: "test",
    }),
    undefined,
  );
});

withTempRepo((root) => {
  mkdirSync(join(root, ".nexus-core"), { recursive: true });
  writeFileSync(join(root, ".nexus-core", "config.toml"), 'schema_version = 1\n');

  assert.equal(repositoryRequiresNexusAdmission(root), true);
  assert.throws(
    () => enforceNexusWriterAdmission({
      workspaceRoot: root,
      ownerContext: "owner",
      operation: "write",
    }),
    /NEXUS_ADMISSION_UNAVAILABLE/,
  );
  assert.throws(
    () => enforceNexusWriterAdmission({
      workspaceRoot: root,
      pointer: {
        workKey: "wk_00000000000000000000000000000000",
        leaseId: "lease",
        expectedLeaseVersion: 1,
        baseRevisionSha: "0".repeat(40),
      },
      ownerContext: "owner",
      operation: "write",
    }),
    /NEXUS_ADMISSION_UNAVAILABLE/,
  );
});

console.log("nexus mutation admission tests passed");
