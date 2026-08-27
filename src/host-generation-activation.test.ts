import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOUND_SERVICE_LABEL,
  parseActivationRequest,
  runHostGeneration,
  sourceHasNonGeneratedDirt,
  type ActivationAdapters,
  type DesiredGeneration,
  type GenerationIdentity,
  type InstalledIdentity,
  type RuntimeReadiness,
  type ServiceStatus,
  HostActivationError,
} from "./host-generation-activation.js";

const OLD: GenerationIdentity = {
  package_version: "1.0.1-nexus.5",
  source_commit: "a".repeat(40),
  build_id: "nexus-1.0.1-nexus.5-aaaaaaaa",
};
const DESIRED: DesiredGeneration = {
  package_version: "1.0.1-nexus.7",
  source_commit: "b".repeat(40),
  source_tree: "c".repeat(40),
  build_id: "nexus-1.0.1-nexus.7-bbbbbbbb",
  artifact_sha256: "d".repeat(64),
};

function installedFrom(identity: GenerationIdentity): InstalledIdentity {
  return { package_name: "@nexus-local/devspace", ...identity };
}

function runtimeFrom(identity: GenerationIdentity, tools = ["git_merge_pull_request", "github_complete_pull_request"]): RuntimeReadiness {
  return {
    reachable: true,
    ok: true,
    source_commit: identity.source_commit,
    build_id: identity.build_id,
    package_version: identity.package_version,
    local_protected_tools: tools,
  };
}

function activateRequest(overrides: Record<string, unknown> = {}) {
  return parseActivationRequest({
    schema: "nexus.devspace.host_generation_activation.v1",
    operation: "activate",
    expected_old: OLD,
    desired: DESIRED,
    ...overrides,
  });
}

function makeAdapters(overrides: Partial<{
  installed: InstalledIdentity | null;
  runtime: RuntimeReadiness;
  service: ServiceStatus;
  source: { commit: string; tree: string; dirtyNonGenerated: boolean };
  built: ReturnType<ActivationAdapters["readSourceBuiltIdentity"]>;
  packSha: string;
  actions: string[];
  postRestartRuntime: RuntimeReadiness;
  postRestartPid: number;
  restart: () => { newPid: number };
}>): ActivationAdapters & { packs: number; installs: number; restarts: number } {
  let installed = overrides.installed === undefined ? installedFrom(OLD) : overrides.installed;
  let runtime = overrides.runtime ?? runtimeFrom(OLD, ["git_merge_pull_request"]);
  let service = overrides.service ?? { label: BOUND_SERVICE_LABEL, pid: 11, running: true };
  let actions = overrides.actions ?? ["git_merge_pull_request"];
  const stats = { packs: 0, installs: 0, restarts: 0 };
  const adapters: ActivationAdapters & { packs: number; installs: number; restarts: number } = {
    get packs() { return stats.packs; },
    get installs() { return stats.installs; },
    get restarts() { return stats.restarts; },
    readInstalledIdentity() { return installed; },
    readServiceStatus() { return service; },
    readSourceHead() {
      return overrides.source ?? {
        commit: DESIRED.source_commit,
        tree: DESIRED.source_tree,
        dirtyNonGenerated: false,
      };
    },
    readSourceBuiltIdentity() {
      return overrides.built === undefined
        ? {
            package_name: "@nexus-local/devspace",
            package_version: DESIRED.package_version,
            source_commit: DESIRED.source_commit,
            source_dirty: false,
            build_id: DESIRED.build_id,
            build_manifest_sha256: "e".repeat(64),
          }
        : overrides.built;
    },
    pack() {
      stats.packs += 1;
      return {
        tarballPath: "/tmp/nexus-devspace-host-activation/pkg.tgz",
        sha256: overrides.packSha ?? DESIRED.artifact_sha256!,
      };
    },
    install() {
      stats.installs += 1;
      installed = installedFrom(DESIRED);
      actions = ["git_merge_pull_request", "github_complete_pull_request"];
    },
    restartBoundService(_oldPid) {
      stats.restarts += 1;
      if (overrides.restart) return overrides.restart();
      service = { label: BOUND_SERVICE_LABEL, pid: overrides.postRestartPid ?? 99, running: true };
      runtime = overrides.postRestartRuntime ?? runtimeFrom(DESIRED);
      return { newPid: service.pid! };
    },
    readRuntime() { return runtime; },
    readInstalledActions() { return actions; },
    async sleep() {
      // no-op in unit tests
    },
  };
  return adapters;
}

describe("parseActivationRequest", () => {
  it("rejects arbitrary path, service, env, and command fields", () => {
    const cases: Array<Record<string, unknown>> = [
      { path: "/etc/passwd" },
      { source_root: "/tmp/evil" },
      { service_label: "com.apple.other" },
      { env: { FOO: "1" } },
      { command: "launchctl kill" },
      { executable: "/bin/zsh" },
    ];
    for (const extra of cases) {
      assert.throws(
        () => parseActivationRequest({
          schema: "nexus.devspace.host_generation_activation.v1",
          operation: "activate",
          expected_old: OLD,
          desired: DESIRED,
          ...extra,
        }),
        HostActivationError,
      );
    }
  });

  it("rejects a wrong schema or digest", () => {
    assert.throws(
      () => parseActivationRequest({
        schema: "evil.v1",
        operation: "activate",
        expected_old: OLD,
        desired: DESIRED,
      }),
      /schema/,
    );
    assert.throws(
      () => parseActivationRequest({
        schema: "nexus.devspace.host_generation_activation.v1",
        operation: "activate",
        expected_old: OLD,
        desired: { ...DESIRED, artifact_sha256: "zz" },
      }),
      /artifact_sha256/,
    );
  });
});

describe("runHostGeneration", () => {
  it("status is read-only", async () => {
    const adapters = makeAdapters({});
    const result = await runHostGeneration({
      schema: "nexus.devspace.host_generation_activation.v1",
      operation: "status",
    }, adapters);
    assert.equal(result.outcome, "RECONCILED");
    assert.equal(result.mutated, false);
    assert.equal(adapters.packs, 0);
    assert.equal(adapters.installs, 0);
    assert.equal(adapters.restarts, 0);
  });

  it("wrong expected old generation blocks", async () => {
    const adapters = makeAdapters({ installed: installedFrom({
      package_version: "1.0.1-nexus.4",
      source_commit: "1".repeat(40),
      build_id: "nexus-1.0.1-nexus.4-11111111",
    }) });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "EXPECTED_OLD_MISMATCH");
    assert.equal(result.mutated, false);
    assert.equal(adapters.installs, 0);
  });

  it("wrong packed digest blocks", async () => {
    const adapters = makeAdapters({ packSha: "f".repeat(64) });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "ARTIFACT_DIGEST_MISMATCH");
    assert.equal(adapters.installs, 0);
  });

  it("allows generated-only porcelain dirtiness", () => {
    assert.equal(sourceHasNonGeneratedDirt(" M generated/build-identity.json"), false);
    assert.equal(sourceHasNonGeneratedDirt(" M src/cli.ts"), true);
  });

  it("dirty source blocks", async () => {
    const adapters = makeAdapters({
      source: { commit: DESIRED.source_commit, tree: DESIRED.source_tree, dirtyNonGenerated: true },
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "SOURCE_DIRTY");
  });

  it("wrong source Candidate blocks", async () => {
    const adapters = makeAdapters({
      source: { commit: "9".repeat(40), tree: DESIRED.source_tree, dirtyNonGenerated: false },
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "SOURCE_IDENTITY_MISMATCH");
  });

  it("wrong built identity blocks", async () => {
    const adapters = makeAdapters({
      built: {
        package_name: "@nexus-local/devspace",
        package_version: DESIRED.package_version,
        source_commit: "8".repeat(40),
        source_dirty: false,
        build_id: DESIRED.build_id,
        build_manifest_sha256: "e".repeat(64),
      },
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "BUILD_IDENTITY_MISMATCH");
  });

  it("missing action surface after install blocks", async () => {
    const adapters = makeAdapters({});
    const originalInstall = adapters.install.bind(adapters);
    adapters.install = (artifact) => {
      originalInstall(artifact);
      adapters.readInstalledActions = () => ["git_merge_pull_request"];
    };
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "ACTION_SURFACE_MISSING");
    assert.equal(result.mutated, true);
  });

  it("wrong live build identity blocks", async () => {
    const adapters = makeAdapters({
      postRestartRuntime: runtimeFrom({
        package_version: DESIRED.package_version,
        source_commit: "7".repeat(40),
        build_id: DESIRED.build_id,
      }),
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "RUNTIME_IDENTITY_MISMATCH");
  });

  it("service alive without readiness is NOT_READY", async () => {
    const adapters = makeAdapters({
      postRestartRuntime: {
        reachable: true,
        ok: false,
        source_commit: null,
        build_id: null,
        package_version: null,
        local_protected_tools: null,
      },
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "NOT_READY");
    assert.equal(result.code, "READINESS_UNPROVEN");
  });

  it("second invocation after success reconciles without mutation", async () => {
    const adapters = makeAdapters({
      installed: installedFrom(DESIRED),
      runtime: runtimeFrom(DESIRED),
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "RECONCILED");
    assert.equal(result.code, "ALREADY_ACTIVE");
    assert.equal(result.mutated, false);
    assert.equal(adapters.installs, 0);
    assert.equal(adapters.restarts, 0);
  });

  it("adapter cannot retarget another service", async () => {
    const adapters = makeAdapters({
      service: { label: "com.nexus.mcp.gateway.direct", pid: 1, running: true },
    });
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "BLOCK");
    assert.equal(result.code, "SERVICE_IDENTITY_MISMATCH");
  });

  it("activates the desired generation", async () => {
    const adapters = makeAdapters({});
    const result = await runHostGeneration(activateRequest(), adapters);
    assert.equal(result.outcome, "PASS");
    assert.equal(result.code, "ACTIVATED");
    assert.equal(result.mutated, true);
    assert.equal(adapters.packs, 1);
    assert.equal(adapters.installs, 1);
    assert.equal(adapters.restarts, 1);
    assert.equal(result.installed?.source_commit, DESIRED.source_commit);
    assert.ok(result.runtime?.local_protected_tools?.includes("github_complete_pull_request"));
  });
});
