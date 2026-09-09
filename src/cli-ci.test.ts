import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureHome = mkdtempSync(join(tmpdir(), "devspace-cli-home-"));
const agyAppData = join(fixtureHome, ".gemini", "antigravity-cli");
mkdirSync(join(agyAppData, "conversations"), { recursive: true });
writeFileSync(join(agyAppData, "antigravity-oauth-token"), "TEST_AUTH_TOKEN\n", { mode: 0o600 });

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

try {
  await import("./cli.test.js");
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(fixtureHome, { recursive: true, force: true });
}
