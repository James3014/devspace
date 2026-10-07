#!/usr/bin/env node
/**
 * Wave 3 direct-contract canary runner.
 *
 * Default mode is --plan and has no network or filesystem side effects.
 * --inspect opens a workspace and runs read-only catalog/preflight calls.
 * A provider turn is possible only with --dispatch and the explicit
 * WAVE3_ALLOW_PROVIDER_TURN=ONE_DISPOSABLE_FILE_EFFECT acknowledgement.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = "wave3-329-direct-canary";
const EXPECTED_EFFECT = "WAVE2_329_EFFECT_OK\n";
const DIRECT_START_KEYS = new Set([
  "workspaceId", "profile", "provider", "model", "effort", "cliProviderId",
  "prompt", "attemptKey", "executionContract",
]);
const DIRECT_CONTRACT_KEYS = new Set([
  "expectedHead", "writePaths", "maxFiles", "toolchainId", "maxWallMs",
  "maxStartupMs", "maxExecutionMs", "idleTimeoutMode", "idleTimeoutMs",
]);
const LIVE_AGENT_START_KEYS = new Set([
  "workspaceId", "profile", "provider", "model", "effort", "cliProviderId",
  "prompt", "attemptKey", "executionContract",
]);
const LEGACY_CORE_BOUND_KEYS = new Set([
  "dispatchIntent", "authorizedToolCeiling", "toolProjectionManifest", "effectProjection",
  "authorityMode", "coreMutation", "capabilityDiscovery", "role", "parentEffectKey", "supersedes",
]);

function parseArgs(argv) {
  const args = { mode: "plan" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--plan") args.mode = "plan";
    else if (value === "--inspect") args.mode = "inspect";
    else if (value === "--dispatch") args.mode = "dispatch";
    else if (value === "--help" || value === "-h") args.mode = "help";
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new Error(`${label} contains fields outside the #422 direct contract: ${extra.join(", ")}`);
}

function assertOuterProjectionGeneration(outerProjectionGeneration, projectionEvidence) {
  if (!projectionEvidence.catalogGeneration || outerProjectionGeneration !== projectionEvidence.catalogGeneration) {
    throw new Error("Outer caller projection generation does not match the current live server catalog; stop before provider dispatch.");
  }
}

function schemaProperties(schema, label) {
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    throw new Error(`${label} is missing an inspectable live object schema; stop before provider dispatch.`);
  }
  return schema.properties;
}

function assertExactSchemaKeys(properties, expected, label) {
  const actual = Object.keys(properties).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} live schema keys differ from the #422 direct contract. actual=${actual.join(",")} expected=${wanted.join(",")}`);
  }
  const legacy = actual.filter((key) => LEGACY_CORE_BOUND_KEYS.has(key));
  if (legacy.length > 0) throw new Error(`${label} exposes retired Core-bound fields: ${legacy.join(", ")}`);
}

function validateDirectAgentStartSchema(tool) {
  const topProperties = schemaProperties(tool?.inputSchema, "agent_start");
  assertExactSchemaKeys(topProperties, LIVE_AGENT_START_KEYS, "agent_start");
  const required = new Set(tool.inputSchema.required ?? []);
  for (const key of ["workspaceId", "prompt", "attemptKey"]) {
    if (!required.has(key)) throw new Error(`agent_start live schema does not require ${key}; stop before provider dispatch.`);
  }
  const contractProperties = schemaProperties(topProperties.executionContract, "agent_start.executionContract");
  assertExactSchemaKeys(contractProperties, DIRECT_CONTRACT_KEYS, "agent_start.executionContract");
}

function git(root, ...argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function localState(root) {
  const top = realpathSync(git(root, "rev-parse", "--show-toplevel"));
  const realRoot = realpathSync(root);
  if (top !== realRoot) throw new Error("WAVE3_CANARY_ROOT must be the Git worktree root.");
  return {
    root: realRoot,
    head: git(realRoot, "rev-parse", "HEAD"),
    status: git(realRoot, "status", "--porcelain=v1", "--untracked-files=all"),
    effectExists: existsSync(join(realRoot, "effect.txt")),
  };
}

function config({ dispatch }) {
  const publicBaseUrl = required("DEVSPACE_PUBLIC_BASE_URL");
  const endpoint = new URL("/mcp", publicBaseUrl);
  if (!(["http:", "https:"].includes(endpoint.protocol))) {
    throw new Error("DEVSPACE_PUBLIC_BASE_URL must use HTTP or HTTPS.");
  }
  const workspaceRoot = realpathSync(required("WAVE3_CANARY_ROOT"));
  const expectedSourceCommit = required("WAVE3_EXPECTED_SOURCE_COMMIT").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedSourceCommit)) {
    throw new Error("WAVE3_EXPECTED_SOURCE_COMMIT must be a 40-character commit SHA.");
  }
  const profile = required("WAVE3_PROFILE");
  const toolchainId = required("WAVE3_TOOLCHAIN_ID");
  const attemptKey = dispatch ? required("WAVE3_ATTEMPT_KEY") : undefined;
  if (attemptKey && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(attemptKey)) {
    throw new Error("WAVE3_ATTEMPT_KEY does not match the DevSpace attemptKey schema.");
  }
  const expectedHead = dispatch ? required("WAVE3_EXPECTED_WORKSPACE_HEAD").toLowerCase() : undefined;
  if (expectedHead && !/^[0-9a-f]{40}$/.test(expectedHead)) {
    throw new Error("WAVE3_EXPECTED_WORKSPACE_HEAD must be a 40-character commit SHA.");
  }
  const outerProjectionGeneration = dispatch ? required("WAVE3_OUTER_PROJECTION_GENERATION").toLowerCase() : undefined;
  if (outerProjectionGeneration && !/^[0-9a-f]{64}$/.test(outerProjectionGeneration)) {
    throw new Error("WAVE3_OUTER_PROJECTION_GENERATION must be the 64-character CURRENT clientProjectionGeneration from the outer caller's #360 check.");
  }
  return {
    endpoint,
    packageRoot: required("DEVSPACE_PACKAGE_ROOT"),
    accessToken: required("DEVSPACE_REQUAL_ACCESS_TOKEN"),
    workspaceRoot,
    expectedSourceCommit,
    expectedHead,
    outerProjectionGeneration,
    profile,
    toolchainId,
    attemptKey,
  };
}

function directStartRequest(workspaceId, profile, attemptKey, expectedHead, toolchainId) {
  const request = {
    workspaceId,
    profile,
    prompt: [
      "Create exactly one file named effect.txt in the workspace root.",
      "Its complete contents must be the single line WAVE2_329_EFFECT_OK followed by one newline.",
      "Do not change, create, or delete any other path. Do not run commands, commit, or push.",
      "If effect.txt already exists or the requested write cannot be completed safely, stop without changing anything.",
      "Return only WAVE2_329_IMPLEMENT_DONE after the file write.",
    ].join(" "),
    attemptKey,
    executionContract: {
      expectedHead,
      writePaths: ["effect.txt"],
      maxFiles: 1,
      toolchainId,
      maxWallMs: 120_000,
      maxStartupMs: 30_000,
      maxExecutionMs: 120_000,
    },
  };
  assertOnlyKeys(request, DIRECT_START_KEYS, "agent_start request");
  assertOnlyKeys(request.executionContract, DIRECT_CONTRACT_KEYS, "executionContract");
  return request;
}

function parseResult(result, name) {
  if (result.isError) {
    const structured = result.structuredContent;
    const code = structured?.errorCode ?? structured?.code ?? "MCP_TOOL_ERROR";
    throw new Error(`${name} returned ${code}. Inspect the exact durable handle before any further action.`);
  }
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no structured result.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned unstructured text.`);
  }
}

async function connect(configValue) {
  if (/\s/.test(configValue.accessToken)) throw new Error("Access token must not contain whitespace.");
  const packageJson = join(configValue.packageRoot, "package.json");
  const require = createRequire(packageJson);
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: `${SCRIPT} evidence runner`, version: "1" });
  const transport = new StreamableHTTPClientTransport(configValue.endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${configValue.accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  return parseResult(await client.callTool({ name, arguments: args }), name);
}

async function inspectLiveProjection(client) {
  const listed = await client.listTools();
  const liveTools = listed.tools ?? [];
  const names = [...new Set(liveTools.map((tool) => tool.name).filter((name) => typeof name === "string"))].sort();
  if (names.length === 0) throw new Error("Live tools/list returned no tool names; stop before provider dispatch.");
  if (names.some((name) => name.startsWith("core_mutation_"))) {
    throw new Error("Live tools/list still exposes core_mutation_*; caller/runtime projection is not eligible for the #422 direct canary.");
  }
  for (const name of ["open_workspace", "agent_preflight", "agent_status", "agent_reconcile"]) {
    if (!names.includes(name)) throw new Error(`Live tools/list lacks required direct-canary tool ${name}.`);
  }
  const byName = new Map(liveTools.map((tool) => [tool.name, tool]));
  const startTool = byName.get("agent_start");
  if (!startTool) throw new Error("Live tools/list does not expose agent_start.");
  validateDirectAgentStartSchema(startTool);
  if (!byName.has("capability_convergence_status")) {
    throw new Error("Live tools/list lacks capability_convergence_status; #360 projection convergence cannot be proven.");
  }
  const convergence = await call(client, "capability_convergence_status", {
    clientProjectionToolNames: names,
    requestRefresh: false,
  });
  const projection = convergence.clientProjectionConvergence;
  const session = convergence.sessionConvergence;
  if (projection?.state !== "CURRENT" || projection?.converged !== true
    || session?.controllerDisposition !== "CURRENT" || session?.converged !== true
    || session?.activeDrift === true) {
    throw new Error("#360 live catalog/session projection is not proven CURRENT; reconnect/relist and rerun read-only checks before any canary.");
  }
  const catalogGeneration = session.serverGeneration?.catalogGeneration;
  if (!/^[0-9a-f]{64}$/.test(catalogGeneration ?? "")
    || projection.clientProjectionGeneration !== catalogGeneration) {
    throw new Error("#360 current projection generation does not match a valid live server catalog generation.");
  }
  return {
    toolNames: names,
    toolCount: names.length,
    catalogGeneration,
    clientProjectionGeneration: projection.clientProjectionGeneration ?? null,
    convergence: {
      state: projection.state,
      sessionDisposition: session.controllerDisposition,
      converged: session.converged,
    },
    agentStartSchema: {
      properties: Object.keys(startTool.inputSchema.properties).sort(),
      required: [...(startTool.inputSchema.required ?? [])].sort(),
      executionContractProperties: Object.keys(startTool.inputSchema.properties.executionContract.properties).sort(),
    },
  };
}

function requireCanaryReady(opened, preflight, expectedSourceCommit, toolchainId) {
  const sourceCommit = opened.devspaceBuild?.sourceCommit;
  if (sourceCommit?.toLowerCase() !== expectedSourceCommit) {
    throw new Error(`Runtime source ${sourceCommit ?? "missing"} does not match WAVE3_EXPECTED_SOURCE_COMMIT.`);
  }
  if (opened.mode !== "checkout" || opened.conversationSafety?.mutationAllowed !== true) {
    throw new Error("Canary workspace is not an allowed single-owner checkout; stop before provider dispatch.");
  }
  const readiness = preflight.readiness ?? {};
  if (preflight.worker?.profile === undefined || readiness.profileResolved !== true
    || readiness.providerConfigured !== true || readiness.runtimeReady !== true
    || readiness.capacityAvailable !== true || preflight.blockers?.length > 0) {
    throw new Error("Preflight has a local/profile/runtime blocker; stop before provider dispatch.");
  }
  if (preflight.toolchain?.id !== toolchainId || preflight.toolchain?.available !== true) {
    throw new Error("The requested verifier toolchain is not available; stop before provider dispatch.");
  }
  if (Object.keys(preflight.toolchain?.executables ?? {}).length === 0) {
    throw new Error("The requested toolchain exposes no verifier executables; stop before provider dispatch.");
  }
  // provider auth/reachability and quota are intentionally unknown in preflight.
  // UNKNOWN is preserved as evidence; it is not promoted to a quota pass.
  if (!["READY", "UNKNOWN"].includes(readiness.dispatchState)) {
    throw new Error(`Preflight dispatchState=${readiness.dispatchState ?? "missing"}; stop before provider dispatch.`);
  }
}

function summarizeStatus(status) {
  const verifierFields = ["effectKey", "planKey", "parentEffectKey", "parentRole", "toolchainId", "verifier", "effectState", "passed", "exitCode", "timedOut", "launchFailed"];
  const summarizeVerifier = (value) => Object.fromEntries(
    Object.entries(value ?? {}).filter(([key]) => verifierFields.includes(key)),
  );
  return {
    agentId: status.agentId,
    status: status.status,
    terminal: status.terminal,
    terminalReason: status.terminalReason,
    errorCode: status.errorCode,
    changedPaths: status.changedPaths,
    scopeState: status.scopeState,
    providerSessionId: status.providerSessionId,
    providerProcessState: status.providerProcessState,
    operationTimeline: status.operationTimeline,
    dispatchFailure: status.dispatchFailure,
    modelAttestation: status.modelAttestation,
    automatedVerifierResult: summarizeVerifier(status.automatedVerifierResult),
    automatedVerifierEffects: Object.fromEntries(
      Object.entries(status.automatedVerifierEffects ?? {}).map(([key, value]) => [key, summarizeVerifier(value)]),
    ),
    effectPolicyStatus: status.effectPolicyStatus,
  };
}

async function inspectClientState(client, configValue) {
  const projectionEvidence = await inspectLiveProjection(client);
  const opened = await call(client, "open_workspace", { path: configValue.workspaceRoot, mode: "checkout" });
  if (realpathSync(opened.root) !== configValue.workspaceRoot) {
    throw new Error("DevSpace opened a different workspace root.");
  }
  const selectedProfile = (opened.agentProfileStatuses ?? []).find((entry) => entry.name === configValue.profile);
  if (!selectedProfile || selectedProfile.write_mode === "read_only") {
    throw new Error("The selected profile is missing or read-only; stop before provider dispatch.");
  }
  const preflight = await call(client, "agent_preflight", {
    workspaceId: opened.workspaceId,
    profile: configValue.profile,
    toolchainId: configValue.toolchainId,
  });
  if (preflight.worker?.profile !== configValue.profile) {
    throw new Error("Preflight resolved a different profile than requested.");
  }
  requireCanaryReady(opened, preflight, configValue.expectedSourceCommit, configValue.toolchainId);
  let catalogEvidence;
  if (["opencode", "cline"].includes(preflight.worker?.provider) && preflight.worker?.model) {
    const catalog = await call(client, "agent_catalog", {
      workspaceId: opened.workspaceId,
      provider: preflight.worker.provider,
      model: preflight.worker.model,
      limit: 10,
    });
    const entry = (catalog.entries ?? []).find((candidate) =>
      candidate.fullName === preflight.worker.model || candidate.modelId === preflight.worker.model,
    );
    if (!entry || entry.enabled === false || entry.status === "deprecated") {
      throw new Error("Exact provider/model is absent, disabled, or deprecated in the current catalog.");
    }
    catalogEvidence = { snapshot: catalog.snapshot, entry };
  }
  return { opened, preflight, catalogEvidence, projectionEvidence };
}

function assertCleanCanary(state, expectedHead) {
  if (state.status !== "") throw new Error("Canary workspace must be clean before provider dispatch.");
  if (state.effectExists) throw new Error("effect.txt already exists; use a fresh disposable worktree.");
  if (expectedHead && state.head !== expectedHead) {
    throw new Error(`Workspace HEAD ${state.head} does not match WAVE3_EXPECTED_WORKSPACE_HEAD.`);
  }
}

async function runDispatch(client, configValue, opened, preflight, projectionEvidence) {
  if (process.env.WAVE3_ALLOW_PROVIDER_TURN !== "ONE_DISPOSABLE_FILE_EFFECT") {
    throw new Error("Dispatch is disabled without WAVE3_ALLOW_PROVIDER_TURN=ONE_DISPOSABLE_FILE_EFFECT.");
  }
  assertOuterProjectionGeneration(configValue.outerProjectionGeneration, projectionEvidence);
  const before = localState(configValue.workspaceRoot);
  assertCleanCanary(before, configValue.expectedHead);
  const startArgs = directStartRequest(
    opened.workspaceId,
    configValue.profile,
    configValue.attemptKey,
    before.head,
    configValue.toolchainId,
  );

  let started;
  try {
    started = await call(client, "agent_start", startArgs);
  } catch (error) {
    // The request may have reached the server. Never change attemptKey or start
    // a new operation here; recover only by replaying this exact request later.
    throw new Error(`agent_start outcome is uncertain for attemptKey ${configValue.attemptKey}; do not create a new key. ${error.message}`);
  }
  const agentId = started.agentId;
  if (typeof agentId !== "string" || !agentId) {
    throw new Error(`agent_start returned no agentId for attemptKey ${configValue.attemptKey}; do not create a new key.`);
  }

  let status = await call(client, "agent_status", { workspaceId: opened.workspaceId, agentId, waitMs: 0 });
  const activeAtReplay = status.terminal === false;
  const replay = await call(client, "agent_start", startArgs);
  if (replay.agentId !== agentId) {
    throw new Error("Exact attemptKey replay returned a different agentId; stop and reconcile the original handle.");
  }

  await client.close().catch(() => {});
  const reconnected = await connect(configValue);
  try {
    status = await call(reconnected, "agent_status", { workspaceId: opened.workspaceId, agentId, waitMs: 0 });
    if (status.agentId !== agentId) throw new Error("Reconnected status returned a different agentId.");
    const deadline = Date.now() + 120_000;
    while (status.terminal !== true && Date.now() < deadline) {
      status = await call(reconnected, "agent_status", { workspaceId: opened.workspaceId, agentId, waitMs: 5_000 });
    }
    const reconcile = await call(reconnected, "agent_reconcile", { workspaceId: opened.workspaceId, agentId });
    status = await call(reconnected, "agent_status", { workspaceId: opened.workspaceId, agentId, waitMs: 0 });
    if (status.agentId !== agentId || status.terminal !== true) {
      throw new Error("Post-reconcile status is not terminal on the original agent handle; preserve evidence and do not retry.");
    }
    const after = localState(configValue.workspaceRoot);
    let effectContent = null;
    let effectFileKind = "missing";
    const effectPath = join(after.root, "effect.txt");
    if (existsSync(effectPath)) {
      const stat = lstatSync(effectPath);
      effectFileKind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "regular_file" : "other";
      if (effectFileKind === "regular_file") {
        const fd = openSync(effectPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!fstatSync(fd).isFile()) throw new Error("effect.txt changed type during readback.");
          effectContent = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      }
    }
    const changedPaths = after.status.split("\n").filter(Boolean).map((line) => line.slice(3)).filter(Boolean).sort();
    const quotaClass = status.dispatchFailure?.failureClass ?? "UNKNOWN";
    const verifierEffects = Object.values(status.automatedVerifierEffects ?? {});
    const verifierNames = Object.keys(preflight.toolchain?.executables ?? {}).sort();
    const verifierByName = new Map(verifierEffects.map((effect) => [effect.verifier, effect]));
    const verifierSummary = verifierNames.map((verifier) => ({
      verifier,
      ...(verifierByName.has(verifier) ? summarizeStatus({ automatedVerifierResult: verifierByName.get(verifier) }).automatedVerifierResult : {}),
    }));
    const allExpectedVerifiersPassed = verifierSummary.length > 0 && verifierSummary.every((entry) =>
      entry.effectState === "COMPLETED" && entry.passed === true && entry.exitCode === 0
      && entry.timedOut !== true && entry.launchFailed !== true,
    );
    const result = {
      schema: "devspace.wave3_329_direct_canary.v1",
      collectedAt: new Date().toISOString(),
      expectedSourceCommit: configValue.expectedSourceCommit,
      runtimeSourceCommit: opened.devspaceBuild?.sourceCommit,
      runtimeBuildId: opened.devspaceBuild?.buildId,
      serverInstanceId: opened.devspaceBuild?.serverInstanceId,
      workspaceId: opened.workspaceId,
      workspaceRoot: opened.root,
      attemptKey: configValue.attemptKey,
      agentId,
      profile: configValue.profile,
      worker: preflight.worker,
      readiness: preflight.readiness,
      providerQuotaConclusion: quotaClass.startsWith("PROVIDER_QUOTA_EXHAUSTED") ? quotaClass : "UNKNOWN",
      replayDisposition: activeAtReplay ? "SAME_AGENT_WHILE_NONTERMINAL" : "SAME_AGENT_AFTER_TERMINAL_ONLY",
      activeReplayQualified: activeAtReplay,
      status: summarizeStatus(status),
      reconcile: {
        agentState: reconcile.agentState,
        providerState: reconcile.providerState,
        workspace: reconcile.workspace,
        candidate: reconcile.candidate,
      },
      physicalReadback: {
        headBefore: before.head,
        headAfter: after.head,
        dirtyAfter: after.status !== "",
        changedPaths,
        effectContent,
        effectFileKind,
        exactExpectedEffect: effectContent === EXPECTED_EFFECT,
        onlyExpectedPathChanged: changedPaths.length === 1 && changedPaths[0] === "effect.txt",
      },
      expectedVerifiers: verifierNames,
      verifierReadback: verifierSummary,
      allExpectedVerifiersPassed,
      physicalEffectQualified: effectContent === EXPECTED_EFFECT
        && effectFileKind === "regular_file"
        && changedPaths.length === 1 && changedPaths[0] === "effect.txt"
        && after.head === before.head,
      evidenceLimit: "Preflight provider capacity is UNKNOWN; no quota pass is inferred. Requested/resolved model metadata is not provider attestation.",
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await reconnected.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    process.stdout.write(
      `${SCRIPT} [--plan|--inspect|--dispatch]\n` +
      "Default --plan is local/static and does not connect. --inspect reads tools/list, projection convergence, open_workspace, and agent_preflight.\n" +
      "--dispatch also requires the outer-caller #360 projection gate, WAVE3_ALLOW_PROVIDER_TURN=ONE_DISPOSABLE_FILE_EFFECT, and exact runtime/workspace bindings.\n",
    );
    return;
  }
  if (args.mode === "plan") {
    process.stdout.write(`${JSON.stringify({
      mode: "plan",
      networkCalls: [],
      providerCalls: [],
      requiredLiveChecks: ["tools/list agent_start direct schema", "capability_convergence_status CURRENT", "runtime source/build", "profile and verifier toolchain"],
      directAgentStartKeys: [...DIRECT_START_KEYS],
      directExecutionContractKeys: [...DIRECT_CONTRACT_KEYS],
      plannedEffect: { path: "effect.txt", contents: EXPECTED_EFFECT, maxFiles: 1 },
      sequence: ["outer caller proves #360 projection CURRENT", "live tools/list and exact accepted agent_start schema", "capability_convergence_status CURRENT", "open_workspace", "agent_preflight", "agent_start once", "agent_status", "exact same-attempt replay", "reconnect", "agent_status", "agent_reconcile", "post-reconcile agent_status", "physical readback"],
    }, null, 2)}\n`);
    return;
  }
  const configValue = config({ dispatch: args.mode === "dispatch" });
  const before = localState(configValue.workspaceRoot);
  assertCleanCanary(before, configValue.expectedHead);
  const client = await connect(configValue);
  try {
    const { opened, preflight, catalogEvidence, projectionEvidence } = await inspectClientState(client, configValue);
    const summary = {
      mode: args.mode,
      runtimeSourceCommit: opened.devspaceBuild?.sourceCommit,
      runtimeBuildId: opened.devspaceBuild?.buildId,
      serverInstanceId: opened.devspaceBuild?.serverInstanceId,
      workspaceId: opened.workspaceId,
      workspaceRoot: opened.root,
      conversationSafety: opened.conversationSafety,
      projectionEvidence,
      profile: preflight.worker,
      catalogEvidence,
      readiness: preflight.readiness,
      toolchain: preflight.toolchain,
      blockers: preflight.blockers,
      unknowns: preflight.unknowns,
      quotaConclusion: "UNKNOWN",
      note: "agent_preflight is read-only. It does not establish provider quota, and UNKNOWN remains UNKNOWN.",
    };
    if (args.mode === "inspect") {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    await runDispatch(client, configValue, opened, preflight, projectionEvidence);
  } finally {
    await client.close().catch(() => {});
  }
}

export {
  assertCleanCanary,
  assertOuterProjectionGeneration,
  directStartRequest,
  inspectLiveProjection,
  requireCanaryReady,
  validateDirectAgentStartSchema,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${SCRIPT}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
