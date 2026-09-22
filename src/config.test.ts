import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readControlPlaneInventory } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.deepEqual(loadConfig(baseEnv).subagents, { enabled: false, providers: [] });
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig(baseEnv).agentMaxConcurrent, 4);
assert.equal(loadConfig(baseEnv).chatSwarmEnabled, false);
assert.equal(loadConfig(baseEnv).chatSwarmMaxWorkers, 16);
assert.equal(loadConfig(baseEnv).chatSwarmQueueLimit, 1000);
assert.equal(loadConfig(baseEnv).chatSwarmResultMaxChars, 256 * 1024);
assert.equal(loadConfig(baseEnv).chatSwarmInviteTtlSeconds, 15 * 60);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CHAT_SWARM: "1" }).chatSwarmEnabled, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CHAT_SWARM_MAX_WORKERS: "3" }).chatSwarmMaxWorkers, 3);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CHAT_SWARM_QUEUE_LIMIT: "17" }).chatSwarmQueueLimit, 17);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CHAT_SWARM_RESULT_MAX_CHARS: "4096" }).chatSwarmResultMaxChars, 4096);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CHAT_SWARM_INVITE_TTL_SECONDS: "60" }).chatSwarmInviteTtlSeconds, 60);
for (const [name, value] of [
  ["DEVSPACE_CHAT_SWARM_MAX_WORKERS", "0"],
  ["DEVSPACE_CHAT_SWARM_QUEUE_LIMIT", "0"],
  ["DEVSPACE_CHAT_SWARM_RESULT_MAX_CHARS", "0"],
  ["DEVSPACE_CHAT_SWARM_INVITE_TTL_SECONDS", "0"],
] as const) {
  assert.throws(() => loadConfig({ ...baseEnv, [name]: value }), new RegExp(`Invalid ${name}`));
}
assert.equal(loadConfig(baseEnv).codexGoalsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CODEX_GOALS: "1" }).codexGoalsEnabled, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CODEX_GOALS: "0" }).codexGoalsEnabled, false);
assert.equal(loadConfig(baseEnv).codexBin, undefined);
assert.equal(loadConfig(baseEnv).coreMutationRecoveryOwnerClientId, undefined);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_CORE_MUTATION_RECOVERY_OWNER_CLIENT_ID: " devspace-owner-recovery " }).coreMutationRecoveryOwnerClientId,
  "devspace-owner-recovery",
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_CORE_MUTATION_RECOVERY_OWNER_CLIENT_ID: "   " }).coreMutationRecoveryOwnerClientId,
  undefined,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_CODEX_BIN: "/custom/codex" }).codexBin, "/custom/codex");
assert.equal(loadConfig(baseEnv).repositoryIntelligenceRoot, undefined);
assert.equal(loadConfig(baseEnv).repositoryIntelligenceExpectedHead, undefined);
assert.equal(loadConfig(baseEnv).repositoryIntelligencePythonBin, undefined);
{
  const allowedRoot = mkdtempSync(join(tmpdir(), "devspace-ri-config-"));
  const riRoot = join(allowedRoot, "repository-intelligence-engine");
  const testHead = "a8b9a00a6f3ea3e9ade0c6ef494d0fa88a2d73b2";
  mkdirSync(riRoot, { recursive: true });
  try {
    const configured = loadConfig({
      ...baseEnv,
      DEVSPACE_ALLOWED_ROOTS: allowedRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD: testHead.toUpperCase(),
      DEVSPACE_REPOSITORY_INTELLIGENCE_PYTHON_BIN: "/opt/homebrew/bin/python3",
    });
    assert.equal(configured.repositoryIntelligenceRoot, riRoot);
    assert.equal(configured.repositoryIntelligenceExpectedHead, testHead);
    assert.equal(configured.repositoryIntelligencePythonBin, "/opt/homebrew/bin/python3");
    assert.throws(
      () => loadConfig({
        ...baseEnv,
        DEVSPACE_ALLOWED_ROOTS: allowedRoot,
        DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
      }),
      /DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD is required/,
    );
    for (const invalidHead of ["", "not-a-sha", "a8b9a00", testHead.slice(0, 39), "z".repeat(40)]) {
      assert.throws(
        () => loadConfig({
          ...baseEnv,
          DEVSPACE_ALLOWED_ROOTS: allowedRoot,
          DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: riRoot,
          DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD: invalidHead,
        }),
        /DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD/,
      );
    }
    assert.throws(
      () => loadConfig({
        ...baseEnv,
        DEVSPACE_ALLOWED_ROOTS: allowedRoot,
        DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT: join(tmpdir(), "outside-ri-root"),
        DEVSPACE_REPOSITORY_INTELLIGENCE_EXPECTED_HEAD: testHead,
      }),
      /DEVSPACE_REPOSITORY_INTELLIGENCE_ROOT must be inside DEVSPACE_ALLOWED_ROOTS/,
    );
  } finally {
    rmSync(allowedRoot, { recursive: true, force: true });
  }
}
assert.deepEqual(loadConfig(baseEnv).toolchains, []);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MAX_CONCURRENT_AGENTS: "2" }).agentMaxConcurrent, 2);
assert.equal(
  loadConfig({
    ...baseEnv,
    DEVSPACE_TOOLCHAINS: JSON.stringify([
      { id: "nexus-python", root: "/toolchain", verifiers: { pytest: ".venv/bin/pytest" } },
    ]),
  }).toolchains.length,
  1,
);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_TOOLCHAINS: "{not json" }), /not valid JSON/);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents, {
  enabled: true,
  providers: [],
});
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "0" }).logging.trustProxy, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY_HOPS: "1" }).logging.trustProxy, 1);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY_HOPS: "2" }).logging.trustProxy, 2);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }),
  /DEVSPACE_TRUST_PROXY_HOPS/,
);
for (const value of ["true", "yes", "on"]) {
  assert.throws(
    () => loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: value }),
    /DEVSPACE_TRUST_PROXY_HOPS/,
  );
}
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY_HOPS: "0" }),
  /Invalid DEVSPACE_TRUST_PROXY_HOPS/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY_HOPS: "" }),
  /Invalid DEVSPACE_TRUST_PROXY_HOPS/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
);

assert.equal(loadConfig(baseEnv).mcpSessionIdleTimeoutMs, 30 * 60 * 1000);
assert.equal(loadConfig(baseEnv).mcpSessionMaxSessions, 256);
assert.equal(loadConfig(baseEnv).mcpCutoverBuildReadyRoot, undefined);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS: "30000" }).mcpSessionIdleTimeoutMs,
  30000,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_MCP_SESSION_MAX_SESSIONS: "64" }).mcpSessionMaxSessions,
  64,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS: "0" }),
  /Invalid DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_MS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MCP_SESSION_MAX_SESSIONS: "0" }),
  /Invalid DEVSPACE_MCP_SESSION_MAX_SESSIONS: 0/,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_BUILD_READY_ROOT: process.cwd() }).mcpCutoverBuildReadyRoot,
  process.cwd(),
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_BUILD_READY_ROOT: join(tmpdir(), "outside-build-ready") }),
  /DEVSPACE_BUILD_READY_ROOT must be inside DEVSPACE_ALLOWED_ROOTS/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents.enabled, true);
assert.equal(fileConfig.subagents.providers.length, 10);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);

const topologyManifest = {
  schema: "devspace.control_plane_topology_manifest.v1",
  observedAt: new Date().toISOString(),
  maxAgeSeconds: 300,
  inventory: {
    services: [
      {
        role: "primary",
        roleKind: "AUTHORITATIVE_PRODUCTION",
        serviceIdentity: { serviceName: "primary", serverInstanceId: "server-primary" },
        endpoint: { url: "https://primary.invalid", port: 7677 },
        oauth: { clientIds: [] },
        stateDirectory: "/state/primary",
        allowedRoots: ["/workspace"],
        buildIdentity: { sourceCommit: "a".repeat(40), buildId: "build-primary" },
        capabilityManifest: { sha256: "b".repeat(64), catalogGeneration: "catalog-1", tools: [] },
        featureFlags: {},
        durableState: { workspaceSessions: 0, agentSessions: 0, durableOperations: 0, oauthClients: 0, activeSwarms: 0, workers: 0, tasks: 0, inFlightOperations: 0, unknownOperations: 0, reconcileRequired: 0 },
        runtimeOwner: { held: false },
        configuredMaxCapacity: 5,
      },
    ],
    canonicalRole: "primary",
    retirementCandidateRole: "primary",
  },
};
writeFileSync(join(configDir, "control-plane.json"), JSON.stringify(topologyManifest));
const topologyConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(topologyConfig.controlPlaneInventory?.canonicalRole, "primary");
assert.equal(topologyConfig.controlPlaneInventory?.manifestRequired, true);
assert.equal(topologyConfig.controlPlaneManifestPath, join(configDir, "control-plane.json"));
writeFileSync(join(configDir, "control-plane.json"), JSON.stringify({ ...topologyManifest, inventory: { ...topologyManifest.inventory, services: [{ ...topologyManifest.inventory.services[0], roleKind: undefined }] } }));
assert.throws(() => loadConfig({ DEVSPACE_CONFIG_DIR: configDir }), /roleKind/);
writeFileSync(join(configDir, "control-plane.json"), JSON.stringify({ ...topologyManifest, inventory: { ...topologyManifest.inventory, services: [{ ...topologyManifest.inventory.services[0], oauth: { secret: "must-not-load" } }] } }));
assert.throws(() => loadConfig({ DEVSPACE_CONFIG_DIR: configDir }), /secrets or tokens/);

{
  const reloadDir = mkdtempSync(join(tmpdir(), "devspace-control-plane-reload-"));
  const manifestPath = join(reloadDir, "control-plane.json");
  try {
    const firstManifest = {
      ...topologyManifest,
      observedAt: new Date().toISOString(),
      inventory: {
        ...topologyManifest.inventory,
        services: [{
          ...topologyManifest.inventory.services[0],
          capabilityManifest: { ...topologyManifest.inventory.services[0].capabilityManifest, catalogGeneration: "catalog-before" },
        }],
      },
    };
    writeFileSync(manifestPath, JSON.stringify(firstManifest));
    assert.equal(readControlPlaneInventory(manifestPath).services[0]?.capabilityManifest.catalogGeneration, "catalog-before");

    const secondManifest = {
      ...firstManifest,
      observedAt: new Date().toISOString(),
      inventory: {
        ...firstManifest.inventory,
        services: [{
          ...firstManifest.inventory.services[0],
          capabilityManifest: { ...firstManifest.inventory.services[0].capabilityManifest, catalogGeneration: "catalog-after" },
        }],
      },
    };
    writeFileSync(manifestPath, JSON.stringify(secondManifest));
    assert.equal(readControlPlaneInventory(manifestPath).services[0]?.capabilityManifest.catalogGeneration, "catalog-after");
  } finally {
    rmSync(reloadDir, { recursive: true, force: true });
  }
}

assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_HOST_OPERATION_ARGV: JSON.stringify(["fixture.mjs", "marker"]) }).hostOperationArgv, ["fixture.mjs", "marker"]);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_HOST_OPERATION_ARGV: "{bad" }), /Invalid DEVSPACE_HOST_OPERATION_ARGV/);
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_HOST_OPERATION_ARGV: JSON.stringify(["ok", "bad\0arg"]) }), /Invalid DEVSPACE_HOST_OPERATION_ARGV/);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_HOST_OPERATIONS: "1" }).hostOperationExecutable, undefined);
