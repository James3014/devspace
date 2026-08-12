import assert from "node:assert/strict";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import { buildCodexProcessLaunch } from "./local-agent-codex/command.js";

{
  const availability = checkLocalAgentProviderAvailability("codex", {
    ...process.env,
    CODEX_COMMAND: "/definitely/missing/devspace-codex",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const native = buildCodexProcessLaunch({
    executable: "C:\\Program Files\\Codex\\codex.exe",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    runtimeKey: "native",
  }, ["app-server"], "win32");
  assert.deepEqual(native, {
    executable: "C:\\Program Files\\Codex\\codex.exe",
    args: ["app-server"],
  });

  const shim = buildCodexProcessLaunch({
    executable: "C:\\Users\\me\\App Data\\npm\\codex.cmd",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    runtimeKey: "shim",
  }, ["app-server", "--help"], "win32");
  assert.deepEqual(shim, {
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '""C:\\Users\\me\\App Data\\npm\\codex.cmd" app-server --help"',
    ],
  });
  assert.throws(
    () => buildCodexProcessLaunch({
      executable: "C:\\Users\\me&bad\\codex.cmd",
      env: { ComSpec: "cmd.exe" },
      runtimeKey: "unsafe",
    }, ["app-server"], "win32"),
    /cannot be launched safely/,
  );
}

{
  const availability = checkLocalAgentProviderAvailability("pi", {
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getLocalAgentProviderAvailabilitySnapshot({
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
}

assert.equal(
  formatLocalAgentProviderAvailabilitySummary([
    { name: "codex", available: true },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex; unavailable: pi (pi executable not found)",
);
