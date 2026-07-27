import assert from "node:assert/strict";
import { buildLocalAgentCatalog } from "./local-agent-catalog.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

const profiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    filePath: "/repo/.devspace/agents/reviewer.md",
    body: "Review carefully.",
    disabled: false,
  },
  {
    name: "claude-reviewer",
    description: "Review with Claude.",
    provider: "claude",
    filePath: "/repo/.devspace/agents/claude-reviewer.md",
    body: "Review carefully.",
    disabled: false,
  },
];

const catalog = buildLocalAgentCatalog(profiles, [
  { name: "codex", available: true },
  { name: "claude", available: false, reason: "missing" },
]);

assert.deepEqual(catalog.providers.map((provider) => provider.name), ["codex"]);
assert.deepEqual(catalog.profiles.map((profile) => profile.name), ["reviewer"]);
assert.equal(catalog.providers[0]?.effort.semantics, "reasoning_effort");

console.log("local-agent-catalog.test.ts: ok");
