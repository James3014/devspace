import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { withInstalledNexusCertifyOnPath } from "./local-agent-path.js";

function tempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "devspace-path-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

tempHome((home) => {
  const original = "/usr/bin:/bin";
  const unchanged = withInstalledNexusCertifyOnPath({ HOME: home, PATH: original });
  assert.equal(unchanged.PATH, original);

  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, process.platform === "win32" ? "nexus-certify.exe" : "nexus-certify"), "");

  const injected = withInstalledNexusCertifyOnPath({ HOME: home, PATH: original });
  assert.equal(injected.PATH?.split(delimiter)[0], bin);

  const repeated = withInstalledNexusCertifyOnPath({ HOME: home, PATH: injected.PATH });
  assert.equal(repeated.PATH?.split(delimiter).filter((entry) => entry === bin).length, 1);
});

console.log("local agent PATH tests passed");
