#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CarrierBindingStore, type CarrierContract } from "./carrier-binding.js";
import { canonicalizePath, isPathInsideRoot } from "./roots.js";
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import type { Result as BetterResult } from "better-result";

import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { loadCoordinationReaders, parseCoordinationReaderArgs, type CoordinationReaderSelection } from "./coordination-reader-loader.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import { resolveSubagentsConfig } from "./local-agent-config.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
} from "./local-agent-catalog.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
} from "./local-agent-targets.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { AgentTargetError, toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import {
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  formatAgentTargetCatalog,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import {
  type OnboardingDestination,
  SUBAGENT_SKILL_INSTALL_COMMAND,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
  usesChatGpt,
  usesCodingAgents,
} from "./onboarding.js";
import { AgentSessionError, LocalAgentSessionManager } from "./local-agent-sessions.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import {
  getActiveOpencodeCatalogSnapshot,
  refreshOpencodeCatalog,
} from "./local-agent-opencode-catalog.js";
import {
  cutoverSeamStatus,
  performCutoverRecovery,
  performNativeCrossDomainBindingRepair,
  NativeObservedReplacementCommittedError,
  NativeBindingRepairOutcomeUnknownError,
  performNativeObservedReplacementRecovery,
  readRunningBuildIdentity,
  resolveSeamStateDir,
  runningPackageRoot,
} from "./cutover-recovery.js";
import { CutoverStateStore } from "./cutover-state.js";
import {
  CutoverCapabilityManifestDomainMismatchError,
  probeBuildReady,
  probeTargetPackage,
} from "./cutover-build-ready.js";
import type { ExpectedCutoverIdentity } from "./cutover-state.js";

type Command = "serve" | "init" | "doctor" | "config" | "agents" | "models" | "cutover" | "carrier" | "help" | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve": {
      const selection = parseCoordinationReaderArgs(args);
      await ensureConfigured();
      await serve(selection);
      return;
    }
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "models":
      await runModelsCommand(args);
      return;
    case "carrier":
      runCarrierCommand(args);
      return;
    case "cutover":
      await runCutoverCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config" || command === "agents" || command === "models" || command === "cutover" || command === "carrier") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const destinationAnswer = await prompts.multiselect({
      message: "Where will you use DevSpace?",
      options: [
        {
          value: "chatgpt",
          label: "ChatGPT",
          hint: "Connect ChatGPT to projects on this computer.",
        },
        {
          value: "coding-agents",
          label: "Coding Agents",
          hint: "Use DevSpace from Codex, Claude Code, OpenCode, Pi, and similar tools.",
        },
      ],
      initialValues: files.config.publicBaseUrl ? ["chatgpt"] : ["coding-agents"],
      required: true,
    });
    if (prompts.isCancel(destinationAnswer)) throw new SetupCancelledError();
    const usage = resolveOnboardingUsage(destinationAnswer as OnboardingDestination[]);
    const useChatGpt = usesChatGpt(usage);
    const useCodingAgents = usesCodingAgents(usage);

    let allowedRoots: string[] | undefined;
    if (useChatGpt) {
      const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
      const rootsAnswer = await textPrompt({
        message: `Which project folders can DevSpace access? Press Enter to use ${defaultRoots}`,
        placeholder: defaultRoots,
        defaultValue: defaultRoots,
        validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
      });
      allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);
    }

    const port = isValidPort(files.config.port) ? files.config.port : 7676;

    let publicBaseUrl: string | null = null;
    if (useChatGpt) {
      prompts.note(
        [
          `Point your HTTPS tunnel or reverse proxy to http://127.0.0.1:${port}.`,
          "Paste its public URL below.",
          "",
          "Example: https://your-tunnel-host.example.com",
        ].join("\n"),
        "Connect ChatGPT",
      );
      publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
        message: files.config.publicBaseUrl
          ? `What public URL will ChatGPT connect to? Press Enter to keep ${files.config.publicBaseUrl}`
          : "What public URL will ChatGPT connect to?",
        placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }));
    }

    const currentSubagents = resolveSubagentsConfig(files.config.subagents, {});
    const availability = getLocalAgentProviderAvailabilitySnapshot();
    const configuredProviders = currentSubagents.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.id);
    const initialValues = configuredProviders.length > 0
      ? configuredProviders
      : availability
          .filter((provider) => provider.available)
          .map((provider) => provider.name);
    const providerAnswer = await prompts.multiselect({
      message: "Which Coding Agents should be available?",
      options: availability.map((provider) => ({
        value: provider.name,
        label: provider.name,
        hint: provider.available
          ? provider.note ?? "available"
          : `unavailable: ${provider.reason ?? "provider preflight failed"}`,
      })),
      initialValues,
      required: true,
    });
    if (prompts.isCancel(providerAnswer)) throw new SetupCancelledError();
    const selectedProviders = providerAnswer as LocalAgentProvider[];
    const subagents = updateOnboardingSubagentsConfig(
      currentSubagents,
      selectedProviders,
    );

    const config: DevspaceUserConfig = {
      ...files.config,
      host: files.config.host ?? "127.0.0.1",
      port,
      ...(allowedRoots ? { allowedRoots } : {}),
      publicBaseUrl,
      subagents,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    writeDevspaceConfig(config);
    writeDevspaceAuth(auth);

    const lines = [
      ...(allowedRoots ? [`Project folders: ${allowedRoots.join(", ")}`] : []),
      `Coding Agents: ${selectedProviders.join(", ")}`,
      ...(publicBaseUrl ? [`ChatGPT connection URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace is ready");
    if (useChatGpt) {
      prompts.note(
        [
          `Owner password: ${auth.ownerToken}`,
          "Use this when ChatGPT asks you to approve DevSpace access.",
        ].join("\n"),
        "Owner password",
      );
    }
    if (useCodingAgents) {
      prompts.note(
        [
          SUBAGENT_SKILL_INSTALL_COMMAND,
          "",
          "The Skills CLI will let you choose which Coding Agents receive it.",
        ].join("\n"),
        "Install the Subagents skill",
      );
    }
    const nextSteps = [
      useChatGpt ? "Run `devspace serve`, then connect ChatGPT." : undefined,
      useCodingAgents ? "Run the skill command above before delegating from your Coding Agents." : undefined,
    ].filter(Boolean).join(" ");
    prompts.outro(nextSteps);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(selection?: CoordinationReaderSelection): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const coordination = await loadCoordinationReaders(selection, config.stateDir);
  const { app, close, localAgentProviders } = createServer(config, coordination ? { coordination } : {});
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(),
    );
    console.log(`Subagents: ${config.subagents.enabled ? "enabled" : "disabled"}`);
    console.log(`Subagent providers: ${formatLocalAgentProviderStatusSummary(providers)}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace models          List available models in catalog",
      "  devspace models refresh  Refresh current provider model catalog and bump generation",
      "  devspace carrier inspect <pending-id>",
      "  devspace carrier show <carrier-id>",
      "  devspace carrier reauthorize <carrier-id> --validity-version <version> --until <ISO expiry>",
      "  devspace carrier approve <pending-id> --contract <file> --confirm <pending-id>",
      "  devspace carrier revoke <carrier-id> --version <version>",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents show <id>",
      "  devspace agents cancel <id> [--json]",
      "  devspace agents daemon <status|stop|logs>",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

async function runModelsCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  if (subcommand === "refresh") {
    const refreshed = await refreshOpencodeCatalog();
    console.log(`Refreshed OpenCode catalog: ${refreshed.entries.length} models (generation: ${refreshed.generation}, source: ${refreshed.source})`);
    return;
  }
  const current = getActiveOpencodeCatalogSnapshot();
  console.log(`OpenCode Catalog (generation: ${current.generation}, source: ${current.source}, fetchedAt: ${current.fetchedAt}):`);
  for (const entry of current.entries) {
    console.log(`  ${entry.fullName} (variants: ${entry.variants.join(", ")}) [${entry.status}]`);
  }
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList(commandArgs, json);
      return;
    case "run":
      await runAgentsRun(commandArgs, json);
      return;
    case "continue":
      await runAgentsContinue(commandArgs, json);
      return;
    case "show":
      await runAgentsShow(commandArgs, json);
      return;
    case "cancel":
      await runAgentsCancel(commandArgs, json);
      return;
    case "targets":
      await runAgentsTargets(commandArgs, json);
      return;
    case "daemon":
      await runAgentsDaemon(commandArgs, json);
      return;
    case "__worker":
      await runAgentsWorker(commandArgs);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsTargets(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents targets [--json]");
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const providers = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const catalog = buildLocalAgentCatalog(config.subagents, profiles, providers);
  const output = presentAgentTargetCatalog(catalog);
  if (json) printJson(output);
  else console.log(formatAgentTargetCatalog(output));
}

async function runAgentsList(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents ls [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const result = await client.list(resolveCliWorkspaceContext(config.allowedRoots));
  const agents = presentAgentResult(result, json);
  if (!agents) return;

  const summaries = agents.map(presentAgentSummary);
  if (json) {
    printJson(summaries);
    return;
  }


  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const summary of summaries) {
    console.log(formatAgentSummary(summary));
  }
}

async function runAgentsRun(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const client = createLocalAgentClient(config);
  const result = await client.start({
    target: parsed.target,
    prompt: parsed.prompt,
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    model: parsed.model,
    effort: parsed.effort,
  });
  const record = presentAgentResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  console.log(formatAgentReceipt(receipt));

}

async function runAgentsContinue(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentContinueArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const result = await client.continue(parsed.agentId, parsed.prompt, {
    model: parsed.model,
    effort: parsed.effort,
  }, scope);
  const record = presentAgentResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  console.log(formatAgentReceipt(receipt));
}

async function runAgentsShow(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: devspace agents show <id> [--json]");

  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const initial = await client.get(id, scope);
  let record = presentAgentResult(initial, json);
  if (!record) return;


  const deadline = Date.now() + 15_000;
  while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
    await sleep(500);
    const refreshed = presentAgentResult(await client.get(id, scope), json);
    if (!refreshed) return;
    record = refreshed;

  }

  const observation = presentAgentObservation(record);
  if (json) printJson(observation);
  else console.log(formatAgentObservation(observation));
}

async function runAgentsDaemon(args: string[], json: boolean): Promise<void> {
  const [subcommand, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: devspace agents daemon <status|stop|logs> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  switch (subcommand) {
    case "status": {
      const status = presentAgentResult(await client.status(), json);
      if (!status) return;
      printJson(status);
      return;
    }
    case "stop": {
      const status = presentAgentResult(await client.stop(), json);
      if (!status) return;
      if (json) printJson(status);
      else console.log("Local agent daemon stop requested.");
      return;
    }
    case "logs": {
      const logs = presentAgentResult(await client.logs(), json);
      if (logs === undefined) return;
      if (json) printJson({ logs });
      else console.log(logs || "No local agent daemon logs found.");
      return;
    }
    default:
      throw new Error("Usage: devspace agents daemon <status|stop|logs>");
  }
}

function extractJsonOption(args: string[]): { args: string[]; json: boolean } {
  const commandArgs: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      commandArgs.push(argument);
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      json = true;
      continue;
    }
    commandArgs.push(argument);
  }
  return { args: commandArgs, json };
}

function presentAgentResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  if (json) {
    printJson({ error: toAgentErrorPayload(result.error) });
    process.exitCode = 1;
    return undefined;
  }
  throw new Error(result.error.message);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function runAgentsCancel(args: string[], json: boolean): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace agents cancel <id>");

  const config = loadConfig();
  const manager = new LocalAgentSessionManager(config);
  let record: LocalAgentRecord | undefined;
  try {
    record = manager.getRecordByPrefixOrId(id);
    if (!record) throw new AgentTargetError({
      code: "AGENT_NOT_FOUND",
      target: id,
      operation: "cancel",
      retryable: false,
      message: `Unknown subagent id: ${id}`,
    });
    const output = await manager.cancelAgent({
      workspaceId: record.workspaceId ?? "cli",
      workspaceRoot: record.workspaceRoot,
      agentId: record.id,
    });
    if (json) printJson(output);
    else console.log(`${output.agentId} ${output.status} ${output.profileName} ${output.provider}`);
  } catch (error) {
    if (!json) throw error;
    if (error instanceof AgentSessionError) {
      printJson({ error: {
        code: error.code,
        message: error.message,
        retryable: error.code === "WORKER_TERMINATION_FAILED",
        operation: "cancel",
        target: id,
        ...(record ? { agentId: record.id, provider: record.provider, workspaceId: record.workspaceId } : {}),
      } });
    } else if (error instanceof AgentTargetError) {
      printJson({ error: toAgentErrorPayload(error) });
    } else {
      printJson({ error: { code: "TARGET_RESOLUTION_FAILED", message: error instanceof Error ? error.message : String(error), retryable: false, target: id } });
    }
    process.exitCode = 1;
  } finally {
    manager.close();
  }
}

async function runAgentsWorker(args: string[]): Promise<void> {
  const [id, promptFileFlag, promptFile, workerTokenFlag, workerToken] = args;
  if (
    !id ||
    promptFileFlag !== "--prompt-file" ||
    !promptFile ||
    workerTokenFlag !== "--worker-token" ||
    !workerToken
  ) {
    throw new Error("Usage: devspace agents __worker <id> --prompt-file <path> --worker-token <token>");
  }

  const config = loadConfig();
  const manager = new LocalAgentSessionManager(config);
  try {
    await manager.runWorkerTurnFromFile(id, promptFile, workerToken);
  } finally {
    manager.close();
  }
}

function resolveCurrentWorkspaceRoot(): string {
  return resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
}

function resolveCurrentWorkspaceScope(): { workspaceId?: string; workspaceRoot: string } {
  return {
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot: resolveCurrentWorkspaceRoot(),
  };
}

function formatAgentLine(agent: Pick<
  LocalAgentRecord,
  "id" | "status" | "profileName" | "provider" | "model" | "effort"
>): string {
  const model = agent.model ? ` ${agent.model}` : "";
  const effort = agent.effort ? ` effort=${agent.effort}` : "";
  return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${effort}`;

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls [--json]",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents cancel <id> [--json]",
      "  devspace agents targets [--json]",
      "  devspace agents daemon <status|stop|logs> [--json]",
    ].join("\n"),
  );
}

interface CutoverRecoverCliOptions {
  cutoverId: string;
  sourceCommit: string;
  buildId: string;
  capabilityManifestSha256?: string;
  activeSessions: number;
  oldestAgeMs: number;
  expiresAt?: string;
  buildReadyVerifiedBy?: string;
  buildReadyEvidence?: string;
  json: boolean;
}

async function runCutoverCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  if (subcommand === "status" || subcommand === "ls") {
    const json = args.includes("--json");
    const status = cutoverSeamStatus(resolveSeamStateDir());
    if (json) printJson(status);
    else {
      const active = status.active as {
        cutoverId?: string;
        phase?: string;
        expectedNewIdentity?: { capabilityManifestSha256?: string };
        bindingRepair?: { correctCapabilityManifestSha256?: string; reason?: string };
      } | undefined;
      const superseded = status.superseded as { cutoverId?: string; phase?: string } | undefined;
      const lines = [
        `Active cutover: ${active ? `${active.cutoverId} (${active.phase})` : "none"}`,
        `Terminally superseded: ${superseded ? superseded.cutoverId : "none"}`,
      ];
      if (active?.bindingRepair) {
        lines.push(
          `Repaired binding: original capability=${active.expectedNewIdentity?.capabilityManifestSha256}; effective capability=${active.bindingRepair.correctCapabilityManifestSha256}; reason=${active.bindingRepair.reason}`,
        );
      }
      console.log(lines.join("\n"));
    }
    return;
  }
  if (subcommand === "recover") {
    await runCutoverRecover(args.slice(1));
    return;
  }
  if (subcommand === "observe") {
    await runCutoverObserve(args.slice(1));
    return;
  }
  if (subcommand === "repair" || subcommand === "repair-binding") {
    await runCutoverRepair(args.slice(1));
    return;
  }
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h" || subcommand === undefined) {
    printCutoverHelp();
    return;
  }
  throw new Error("Usage: devspace cutover <status|recover|observe|repair>");
}

function printCutoverHelp(): void {
  console.log(
    [
      "DevSpace cutover recovery (out-of-process control seam)",
      "",
      "Usage:",
      "  devspace cutover status [--json]",
      "  devspace cutover recover --cutover-id <id> --commit <sha> --build-id <id> [--capability-sha <sha>] [--package-root <path>] [--json]",
      "  devspace cutover observe --cutover-id <id> --workspace-id <id> --agent-id <id> [--json]",
      "  devspace cutover repair --cutover-id <id> --workspace-id <id> --agent-id <id> [--server-url <url>] [--package-root <path>] [--state-dir <path>] [--json]",
      "",
      "The repair subcommand repairs a successor cutover blocked by CROSS_DOMAIN_DIGEST_MISBINDING",
      "where the target build-manifest digest was mistakenly bound as the capability manifest digest.",
      "It verifies cryptographic attribution against the physical target package, records a durable",
      "repair receipt, requires exact positive workspace/agent reconciliation, and terminally closes",
      "the cutover without replaying the restart.",
    ].join("\n"),
  );
}

async function runCutoverObserve(args: string[]): Promise<void> {
  let cutoverId: string | undefined;
  let workspaceId: string | undefined;
  let agentId: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = (): string => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value.`);
      return next;
    };
    if (argument === "--json") json = true;
    else if (argument === "--cutover-id") cutoverId = value();
    else if (argument === "--workspace-id") workspaceId = value();
    else if (argument === "--agent-id") agentId = value();
    else throw new Error(`Unknown cutover observe flag: ${argument}`);
  }
  if (!cutoverId || !workspaceId || !agentId) {
    throw new Error("Usage: devspace cutover observe --cutover-id <id> --workspace-id <id> --agent-id <id> [--json]");
  }
  const config = loadConfig();
  const requesterIdentity = readRunningBuildIdentity(runningPackageRoot());
  if (!requesterIdentity) {
    throw new Error("Unable to read the executing accepted build identity; refusing native observed recovery.");
  }
  const endpoint = new URL(`http://${config.host}:${config.port}/mcp`);
  const result = await performNativeObservedReplacementRecovery({
    serverUrl: endpoint,
    publicBaseUrl: new URL(config.publicBaseUrl),
    stateDir: config.stateDir,
    cutoverId,
    workspaceId,
    agentId,
    ownerToken: config.oauth.ownerToken,
    requesterIdentity,
  });
  if (json) {
    printJson(result);
    return;
  }
  console.log(`Observed replacement ${result.cutover.cutoverId}: phase=${result.cutover.phase}; server=${result.serverInstanceId}; newlyRecovered=${String(result.newlyRecovered)}`);
}

async function runCutoverRepair(args: string[]): Promise<void> {
  let cutoverId: string | undefined;
  let workspaceId: string | undefined;
  let agentId: string | undefined;
  let packageRoot: string | undefined;
  let serverUrl: string | undefined;
  let stateDir: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = (): string => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value.`);
      return next;
    };
    if (argument === "--json") json = true;
    else if (argument === "--cutover-id") cutoverId = value();
    else if (argument === "--workspace-id") workspaceId = value();
    else if (argument === "--agent-id") agentId = value();
    else if (argument === "--package-root") packageRoot = value();
    else if (argument === "--server-url") serverUrl = value();
    else if (argument === "--state-dir") stateDir = value();
    else throw new Error(`Unknown cutover repair flag: ${argument}`);
  }
  if (!cutoverId || !workspaceId || !agentId) {
    throw new Error("Usage: devspace cutover repair --cutover-id <id> --workspace-id <id> --agent-id <id> [--server-url <url>] [--package-root <path>] [--state-dir <path>] [--json]");
  }
  const config = loadConfig();
  const requesterIdentity = readRunningBuildIdentity(runningPackageRoot());
  if (!requesterIdentity) {
    throw new Error("Unable to read the executing accepted build identity; refusing cross-domain binding repair.");
  }
  const endpoint = serverUrl ? new URL(serverUrl) : new URL(`http://${config.host}:${config.port}/mcp`);
  const effectivePackageRoot = packageRoot ?? config.mcpCutoverBuildReadyRoot ?? process.env.DEVSPACE_PACKAGE_ROOT ?? runningPackageRoot();
  let result: Awaited<ReturnType<typeof performNativeCrossDomainBindingRepair>>;
  try {
    result = await performNativeCrossDomainBindingRepair({
      serverUrl: endpoint,
      publicBaseUrl: new URL(config.publicBaseUrl),
      stateDir: stateDir ?? config.stateDir,
      cutoverId,
      workspaceId,
      agentId,
      ownerToken: config.oauth.ownerToken,
      requesterIdentity,
      packageRoot: effectivePackageRoot,
    });
  } catch (error) {
    if (error instanceof NativeBindingRepairOutcomeUnknownError && json) {
      printJson({
        outcome: "OUTCOME_UNKNOWN",
        committed: null,
        cutoverId: error.cutoverId,
        error: error.message,
        retryAllowed: false,
      });
      process.exitCode = 1;
      return;
    }
    if (error instanceof NativeObservedReplacementCommittedError && json) {
      printJson({
        outcome: "RECONCILE_REQUIRED",
        committed: true,
        committedRecord: error.committedRecord,
        error: error.message,
        retryAllowed: false,
      });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (json) {
    printJson(result);
    return;
  }
  console.log(
    `Repaired binding ${result.cutover.cutoverId}: phase=${result.cutover.phase}; server=${result.serverInstanceId}; newlyRecovered=${String(result.newlyRecovered)}`,
  );
}

function parseCutoverRecoverArgs(args: string[]): CutoverRecoverCliOptions {
  const options: Partial<CutoverRecoverCliOptions> = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`Flag ${argument} requires a value.`);
      index += 1;
      return next;
    };
    switch (argument) {
      case "--json":
        options.json = true;
        break;
      case "--cutover-id":
        options.cutoverId = value();
        break;
      case "--expected-source-commit":
        options.sourceCommit = value();
        break;
      case "--expected-build-id":
        options.buildId = value();
        break;
      case "--expected-capability-manifest-sha256":
        options.capabilityManifestSha256 = value();
        break;
      case "--active-sessions":
        options.activeSessions = parseNonNegativeIntOrThrow(value(), "--active-sessions");
        break;
      case "--oldest-age-ms":
        options.oldestAgeMs = parseNonNegativeIntOrThrow(value(), "--oldest-age-ms");
        break;
      case "--expires-at":
        options.expiresAt = value();
        break;
      case "--build-ready-verified-by":
        options.buildReadyVerifiedBy = value();
        break;
      case "--build-ready-evidence":
        options.buildReadyEvidence = value();
        break;
      default:
        throw new Error(`Unknown cutover recover flag: ${argument}`);
    }
  }
  if (!options.cutoverId || !options.sourceCommit || !options.buildId) {
    throw new Error(
      "Usage: devspace cutover recover --cutover-id <id> --expected-source-commit <40hex> --expected-build-id <id> ...",
    );
  }
  if (options.activeSessions === undefined || options.oldestAgeMs === undefined) {
    throw new Error(
      "devspace cutover recover requires --active-sessions <n> and --oldest-age-ms <n> so drain evidence is never fabricated.",
    );
  }
  if (options.buildReadyVerifiedBy?.trim() === "") {
    throw new Error("--build-ready-verified-by must be a non-empty identity string.");
  }
  return options as CutoverRecoverCliOptions;
}

function parseNonNegativeIntOrThrow(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer; got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

async function runCutoverRecover(args: string[]): Promise<void> {
  const options = parseCutoverRecoverArgs(args);
  if (!/^[0-9a-f]{40}$/.test(options.sourceCommit)) {
    throw new Error("--expected-source-commit must be a 40-character hex commit.");
  }
  if (
    options.capabilityManifestSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(options.capabilityManifestSha256)
  ) {
    throw new Error("--expected-capability-manifest-sha256 must be a 64-character hex hash.");
  }
  if (options.capabilityManifestSha256 !== undefined) {
    const targetRoot = runningPackageRoot();
    try {
      const targetPackage = probeTargetPackage(targetRoot);
      if (
        targetPackage.buildManifestSha256 !== undefined &&
        options.capabilityManifestSha256 === targetPackage.buildManifestSha256
      ) {
        throw new CutoverCapabilityManifestDomainMismatchError();
      }
    } catch (err) {
      if (err instanceof CutoverCapabilityManifestDomainMismatchError) throw err;
    }
  }
  if (options.expiresAt !== undefined && !Number.isFinite(Date.parse(options.expiresAt))) {
    throw new Error("--expires-at must be an ISO-8601 timestamp.");
  }
  const config = loadConfig();
  const requesterIdentity = readRunningBuildIdentity(runningPackageRoot());
  if (!requesterIdentity) {
    throw new Error(
      "Unable to read the running build identity; run the recovery seam from an accepted DevSpace build.",
    );
  }
  const buildReadyProbe = config.mcpCutoverBuildReadyRoot
    ? (expected: ExpectedCutoverIdentity) =>
        probeBuildReady({ packageRoot: runningPackageRoot(), expected })
    : undefined;
  const buildReadyAttestation = options.buildReadyVerifiedBy
    ? { verifiedBy: options.buildReadyVerifiedBy, ...(options.buildReadyEvidence ? { evidence: options.buildReadyEvidence } : {}) }
    : undefined;
  if (!buildReadyProbe && !buildReadyAttestation) {
    throw new Error(
      "Cutover recovery requires a configured DEVSPACE_BUILD_READY_ROOT or --build-ready-verified-by.",
    );
  }
  const result = performCutoverRecovery({
    store: new CutoverStateStore(config.stateDir),
    requesterIdentity,
    cutoverId: options.cutoverId,
    expectedNewIdentity: {
      sourceCommit: options.sourceCommit,
      buildId: options.buildId,
      ...(options.capabilityManifestSha256 ? { capabilityManifestSha256: options.capabilityManifestSha256 } : {}),
    },
    drainEvidence: { activeSessions: options.activeSessions, oldestAgeMs: options.oldestAgeMs },
    ...(buildReadyProbe ? { buildReadyProbe } : {}),
    ...(buildReadyAttestation ? { buildReadyAttestation } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(
    [
      `Superseded stale cutover ${result.terminal.cutoverId} (phase ${result.terminal.phase})`,
      `  old expected target: ${result.terminal.supersession?.oldExpectedIdentity.sourceCommit} / ${result.terminal.supersession?.oldExpectedIdentity.buildId}`,
      `Established successor ${result.successor.cutoverId} (supersedes ${result.successor.supersedesCutoverId})`,
      `  new expected target: ${result.successor.expectedNewIdentity.sourceCommit} / ${result.successor.expectedNewIdentity.buildId}`,
      `Successor drain recorded: activeSessions=${result.drainRecord.drainEvidence?.activeSessions ?? "unknown"}`,
      `Restart requested: ${String(result.restartRequested)}; restart scheduled (durable marker): ${String(result.restartScheduled)}`,
      `The service is NOT restarted; after verifying the restart-scheduled marker, run the single launchctl kickstart.`,
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read DevSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function runCarrierCommand(args: string[]): void {
  const [action,id,...flags]=args;
  if(!id) throw new Error("Carrier command requires an exact ID.");
  const config=loadConfig();
  const bindings=new CarrierBindingStore(config.stateDir);
  try {
    let result:unknown;
    if(action==="inspect" && flags.length===0) result=bindings.pending(id);
    else if(action==="show" && flags.length===0) result=bindings.inspectLocal(id);
    else if(action==="reauthorize" && flags.length===4 && flags[0]==="--validity-version" && flags[2]==="--until") {
      const record=bindings.inspectLocal(id);
      const roots=[...config.allowedRoots,config.worktreeRoot].map(canonicalizePath);
      if(record.contract.scope.some(path=>!roots.some(root=>isPathInsideRoot(canonicalizePath(path),root)))) throw new Error("Carrier scope exceeds current configured roots.");
      result=bindings.reauthorizeLocal(id,Number(flags[1]),flags[3]!);
    }
    else if(action==="approve" && flags.length===4 && flags[0]==="--contract" && flags[2]==="--confirm" && flags[3]===id) {
      const contract=JSON.parse(readFileSync(resolve(flags[1]!),"utf8")) as CarrierContract;
      const roots=[...config.allowedRoots,config.worktreeRoot].map(canonicalizePath);
      if(!Array.isArray(contract.scope) || contract.scope.some(path=>!roots.some(root=>isPathInsideRoot(canonicalizePath(path),root)))) throw new Error("Carrier scope exceeds configured roots.");
      result=bindings.approveLocal(id,contract);
    } else if(action==="revoke" && flags.length===2 && flags[0]==="--version") result=bindings.revokeLocal(id,Number(flags[1]));
    else throw new Error("Invalid carrier arguments. Inspect the exact pending pairing before approving its bounded contract.");
    console.log(JSON.stringify(result,null,2));
  } finally { bindings.close(); }
}
