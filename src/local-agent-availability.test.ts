import assert from "node:assert/strict";
import {
  checkLocalAgentProviderAvailability,
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";

assert.equal(checkLocalAgentProviderAvailability("codex").available, true);

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
    ["codex", "claude", "opencode", "pi", "cursor", "copilot", "antigravity"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
}

{
  const availability = checkLocalAgentProviderAvailability("antigravity", {
    ...process.env,
    AGY_COMMAND: "/definitely/missing/devspace-agy",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

assert.equal(
  formatLocalAgentProviderAvailabilitySummary([
    { name: "codex", available: true },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex; unavailable: pi (pi executable not found)",
);
