import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  DurableOperationError,
  DurableOperationManager,
  DurableOperationStore,
  NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
  NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE,
  NEXUS_GATEWAY_RECOVERY_PREFLIGHT_BRIDGE_CODE,
  NEXUS_STANDING_GRANT_CAS_BRIDGE_CODE,
  buildNexusGatewayRecoveryBridgeCode,
  NEXUS_GATEWAY_RECOVERY_SCHEMA,
  canonicalAutonomyHash,
  type CommandRunner,
  type NexusGatewayRecoveryRequest,
  type StandingGrantContext,
  type StandingGrantReceipt,
} from "./durable-operations.js";
const execFileAsync = promisify(execFile);

function canonicalHash(value: unknown): string {
  const sort = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(sort);
    if (child && typeof child === "object") {
      return Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sort(item)]),
      );
    }
    return child;
  };
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

function makeStandingGrant(overrides: Partial<StandingGrantContext> = {}): StandingGrantReceipt {
  const contextBase = {
    schema: "nexus.standing_grant_context.v1" as const,
    owner_id: "owner-james",
    coordinator_id: "coordinator-codex",
    repository: {
      repository_id: "James3014/Nexus-new",
      canonical_remote: "https://github.com/James3014/Nexus-new.git",
    },
    thread_id: "thread-test-1",
    goal_id: "goal-test-1",
    allowed_actions: ["GITHUB_MERGE"],
    issued_at: new Date(Date.now() - 3600_000).toISOString(),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  };
  const context: StandingGrantContext = {
    ...contextBase,
    context_hash: overrides.context_hash ?? canonicalAutonomyHash(contextBase as unknown as Record<string, unknown>),
  };
  const receiptBase = {
    schema: "nexus.standing_grant_receipt.v1" as const,
    grant_id: "grant-test-1",
    context,
    supersedes_grant_hash: null,
  };
  return {
    ...receiptBase,
    receipt_hash: canonicalHash(receiptBase),
  };
}

function recoveryRequest(overrides: Partial<NexusGatewayRecoveryRequest> = {}): NexusGatewayRecoveryRequest {
  const request = {
    request_id: "request-1",
    idempotency_fence: "fence-1",
    operation: "gateway-recover" as const,
    effect_class: "GATEWAY_DURABLE_RECOVERY" as const,
    recovery_authority_id: "authority-1",
    recovery_authority_hash: "a".repeat(64),
    desired_manifest_id: `r1-${"b".repeat(40)}`,
    desired_manifest_hash: "c".repeat(64),
    predecessor_manifest_id: `r1-${"d".repeat(40)}`,
    predecessor_manifest_hash: "e".repeat(64),
    request_hash: "",
    schema: NEXUS_GATEWAY_RECOVERY_SCHEMA,
    ...overrides,
  };
  request.request_hash = canonicalHash({
    request_id: request.request_id,
    idempotency_fence: request.idempotency_fence,
    operation: request.operation,
    effect_class: request.effect_class,
    recovery_authority_id: request.recovery_authority_id,
    recovery_authority_hash: request.recovery_authority_hash,
    desired_manifest_id: request.desired_manifest_id,
    desired_manifest_hash: request.desired_manifest_hash,
    predecessor_manifest_id: request.predecessor_manifest_id,
    predecessor_manifest_hash: request.predecessor_manifest_hash,
  });
  return request;
}

async function runRecoveryBridge(
  home: string,
  request: NexusGatewayRecoveryRequest,
  bridgeCode = NEXUS_GATEWAY_RECOVERY_BRIDGE_CODE,
) {
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/python3", ["-I", "-B", "-c", bridgeCode], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

async function runPythonBridge(home: string, bridgeCode: string, payload: unknown) {
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/python3", ["-I", "-B", "-c", bridgeCode], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "devspace-durable-ops-"));
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

test("workspace_clone clones a local repository inside allowed roots and exact replay does not duplicate", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "source");
    const destination = join(f.root, "clone");
    await mkdir(source);
    await git(source, "init");
    await git(source, "config", "user.email", "devspace@example.com");
    await git(source, "config", "user.name", "DevSpace Test");
    await writeFile(join(source, "README.md"), "hello\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "initial");

    const manager = new DurableOperationManager(f.config);
    try {
      const first = await manager.workspaceClone({
        attemptKey: "clone-local-1",
        remote: source,
        destination,
      });
      assert.equal(first.status, "succeeded");
      assert.equal(first.receipt?.openable, true);
      assert.equal(await readFile(join(destination, "README.md"), "utf8"), "hello\n");

      const replay = await manager.workspaceClone({
        attemptKey: "clone-local-1",
        remote: source,
        destination,
      });
      assert.equal(replay.operationId, first.operationId);
      assert.equal(replay.updatedAt, first.updatedAt);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("workspace_clone rejects destinations outside allowed roots and conflicting replay", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "devspace-clone-outside-"));
  try {
    const source = join(f.root, "source");
    await mkdir(source);
    await git(source, "init");
    const manager = new DurableOperationManager(f.config);
    try {
      await assert.rejects(
        manager.workspaceClone({
          attemptKey: "outside-1",
          remote: source,
          destination: join(outside, "clone"),
        }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "DESTINATION_OUTSIDE_ALLOWED_ROOT",
      );

      const destination = join(f.root, "clone-a");
      await manager.workspaceClone({ attemptKey: "conflict-1", remote: source, destination });
      await assert.rejects(
        manager.workspaceClone({
          attemptKey: "conflict-1",
          remote: source,
          destination: join(f.root, "clone-b"),
        }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "OPERATION_REPLAY_CONFLICT",
      );
    } finally {
      manager.close();
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("dependency_sync frozen recipe succeeds without changing manifest or lock inputs", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
    await writeFile(join(project, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
    const beforeManifest = await readFile(join(project, "package.json"), "utf8");
    const beforeLock = await readFile(join(project, "package-lock.json"), "utf8");
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const manager = new DurableOperationManager(f.config, runner);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-frozen-1",
        workspaceId: "ws_fixture",
        workspaceRoot: project,
        recipe: "npm_ci",
      });
      assert.equal(result.status, "succeeded");
      assert.equal(await readFile(join(project, "package.json"), "utf8"), beforeManifest);
      assert.equal(await readFile(join(project, "package-lock.json"), "utf8"), beforeLock);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("dependency_sync detects frozen input mutation even when the command exits zero", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), "{\"name\":\"fixture\"}\n");
    await writeFile(join(project, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    const runner: CommandRunner = async (_command, _args, cwd) => {
      await writeFile(join(cwd, "package-lock.json"), "{\"lockfileVersion\":3,\"mutated\":true}\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new DurableOperationManager(f.config, runner);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-mutation-1",
        workspaceId: "ws_fixture",
        workspaceRoot: project,
        recipe: "npm_ci",
      });
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "FROZEN_INPUT_CHANGED");
      assert.equal(result.retrySafe, false);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("restart fences a nonterminal mutating operation as outcome_unknown and requires reconciliation", async () => {
  const f = await fixture();
  try {
    const destination = join(f.root, "interrupted-clone");
    const store = new DurableOperationStore(f.config.stateDir);
    const created = store.createOrReplay({
      operationId: "op_interrupted",
      attemptKey: "interrupted-1",
      requestHash: "hash-1",
      kind: "workspace_clone",
      authorityMode: "OWNER_DIRECT",
      scopeRoot: f.root,
      request: { destination, remote: join(f.root, "missing-source") },
    }).record;
    assert.equal(created.status, "started");
    store.close();

    let runnerCalls = 0;
    const restarted = new DurableOperationManager(f.config, async () => {
      runnerCalls += 1;
      throw new Error("reconciliation must not re-execute mutation");
    });
    try {
      const afterRestart = restarted.store.getByOperationId("op_interrupted");
      assert.equal(afterRestart?.status, "outcome_unknown");
      assert.equal(afterRestart?.retrySafe, false);
      assert.equal(runnerCalls, 0, "restart fencing must not execute the original mutation");
      const reconciled = await restarted.reconcile("op_interrupted");
      assert.equal(reconciled.status, "outcome_unknown");
      assert.equal(reconciled.errorCode, "RECONCILIATION_REQUIRED");
      assert.equal(runnerCalls, 0, "reconciliation must inspect physical state without re-executing mutation");
    } finally {
      restarted.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("NEXUS_GOVERNED mutating operations fail closed before G9 validation wiring", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(f.config, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    try {
      await assert.rejects(
        manager.workspaceClone({
          attemptKey: "nexus-not-wired-1",
          remote: join(f.root, "source"),
          destination: join(f.root, "destination"),
          authorityMode: "NEXUS_GOVERNED",
        }),
        /G9 must provide validated Nexus authority evidence/,
      );
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recover exact replay is durable and never invokes the bridge twice", async () => {
  const f = await fixture();
  try {
    const calls: NexusGatewayRecoveryRequest[] = [];
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout: JSON.stringify({ result: "VERIFIED", evidence_hash: "f".repeat(64) }), stderr: "" };
      },
    );
    try {
      const request = recoveryRequest();
      const first = await manager.nexusGatewayRecover({ attemptKey: "gateway-recover-1", request });
      assert.equal(first.kind, "nexus_gateway_recover");
      assert.equal(first.authorityMode, "NEXUS_GOVERNED");
      assert.equal(first.status, "succeeded");
      assert.equal(calls.length, 1);

      const replay = await manager.nexusGatewayRecover({ attemptKey: "gateway-recover-1", request });
      assert.equal(replay.operationId, first.operationId);
      assert.equal(replay.updatedAt, first.updatedAt);
      assert.equal(calls.length, 1, "exact terminal replay must not invoke the fixed bridge twice");

      const conflicting = recoveryRequest({ desired_manifest_hash: "1".repeat(64) });
      await assert.rejects(
        manager.nexusGatewayRecover({ attemptKey: "gateway-recover-1", request: conflicting }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "OPERATION_REPLAY_CONFLICT",
      );
      assert.equal(calls.length, 1);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recover rejects malformed request before bridge execution", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ result: "VERIFIED" }), stderr: "" };
      },
    );
    try {
      const malformed = { ...recoveryRequest(), operation: "launchctl" } as unknown as NexusGatewayRecoveryRequest;
      await assert.rejects(
        manager.nexusGatewayRecover({ attemptKey: "gateway-invalid-1", request: malformed }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "NEXUS_GATEWAY_REQUEST_INVALID",
      );
      assert.equal(calls, 0);

      const badHash = { ...recoveryRequest(), request_hash: "0".repeat(64) };
      await assert.rejects(
        manager.nexusGatewayRecover({ attemptKey: "gateway-invalid-2", request: badHash }),
        (error: unknown) => error instanceof DurableOperationError && error.code === "NEXUS_GATEWAY_REQUEST_INVALID",
      );
      assert.equal(calls, 0);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recover bridge failure is persisted as uncertain instead of remaining started", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("fixed interpreter unavailable"); },
    );
    try {
      const result = await manager.nexusGatewayRecover({
        attemptKey: "gateway-bridge-error-1",
        request: recoveryRequest(),
      });
      assert.equal(result.status, "outcome_unknown");
      assert.equal(result.errorCode, "NEXUS_GATEWAY_RECOVERY_UNCERTAIN");
      assert.notEqual(manager.store.getByOperationId(result.operationId)?.status, "started");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recover reconciliation re-enters only the same stored request", async () => {
  const f = await fixture();
  try {
    const calls: NexusGatewayRecoveryRequest[] = [];
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async (request) => {
        calls.push(structuredClone(request));
        return calls.length === 1
          ? { exitCode: 0, stdout: JSON.stringify({ result: "UNCERTAIN_EFFECT", evidence_hash: "1".repeat(64) }), stderr: "" }
          : { exitCode: 0, stdout: JSON.stringify({ result: "VERIFIED", evidence_hash: "2".repeat(64) }), stderr: "" };
      },
    );
    try {
      const request = recoveryRequest();
      const uncertain = await manager.nexusGatewayRecover({ attemptKey: "gateway-reconcile-1", request });
      assert.equal(uncertain.status, "outcome_unknown");
      const reconciled = await manager.reconcile(uncertain.operationId);
      assert.equal(reconciled.status, "succeeded");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1], calls[0], "reconcile must use the original persisted Nexus request and fence");
      assert.equal((reconciled.receipt as Record<string, unknown>).reconciled, true);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recover malformed manager output fails closed as uncertain", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
    );
    try {
      const result = await manager.nexusGatewayRecover({ attemptKey: "gateway-json-1", request: recoveryRequest() });
      assert.equal(result.status, "outcome_unknown");
      assert.equal(result.errorCode, "NEXUS_GATEWAY_RECOVERY_UNCERTAIN");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("fixed Nexus bridge rejects manager hash mismatch before importing manager code", { skip: process.platform !== "darwin" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "devspace-nexus-bridge-hash-"));
  try {
    const state = join(home, "Library", "Application Support", "Nexus", "gateway-direct");
    await mkdir(state, { recursive: true });
    const marker = join(home, "manager-imported");
    const managerPath = join(state, "manager.py");
    await writeFile(managerPath, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("IMPORTED")\n`);
    await chmod(managerPath, 0o600);
    const request = recoveryRequest();
    const authorityPath = join(state, "recovery-authority.json");
    await writeFile(authorityPath, JSON.stringify({
      schema: "nexus.gateway.durable_recovery_authority.v2",
      revocation_state: "NOT_REVOKED",
      final_manager_sha256: NEXUS_GATEWAY_ACCEPTED_MANAGER_SHA256,
    }));
    await chmod(authorityPath, 0o600);
    const result = await runRecoveryBridge(home, request);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /manager artifact hash mismatch/);
    assert.equal(await pathExists(marker), false, "tampered manager must be rejected before Python import executes it");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fixed Nexus bridge rejects a deployment with a substituted authority contract before manager import", { skip: process.platform !== "darwin" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "devspace-nexus-bridge-contract-"));
  try {
    const state = join(home, "Library", "Application Support", "Nexus", "gateway-direct");
    const deployments = join(state, "deployments");
    await mkdir(deployments, { recursive: true });
    const marker = join(home, "manager-imported");
    const managerPath = join(state, "manager.py");
    await writeFile(managerPath, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("IMPORTED")\n`);
    await chmod(managerPath, 0o600);
    const managerHash = createHash("sha256").update(await readFile(managerPath)).digest("hex");
    const request = recoveryRequest();
    const desiredRoot = join(deployments, request.desired_manifest_id);
    await mkdir(join(desiredRoot, "nexus", "contracts"), { recursive: true });
    await git(desiredRoot, "init");
    await git(desiredRoot, "config", "user.email", "devspace@example.com");
    await git(desiredRoot, "config", "user.name", "DevSpace Test");
    await git(desiredRoot, "remote", "add", "origin", "https://github.com/James3014/Nexus-new.git");
    await writeFile(join(desiredRoot, "nexus", "contracts", "gateway_deployment.py"), "# substituted authority contract\n");
    await git(desiredRoot, "add", ".");
    await git(desiredRoot, "commit", "-m", "fixture");
    const desiredCommit = await git(desiredRoot, "rev-parse", "HEAD");
    const desiredTree = await git(desiredRoot, "rev-parse", "HEAD^{tree}");
    const authorityPath = join(state, "recovery-authority.json");
    await writeFile(authorityPath, JSON.stringify({
      schema: "nexus.gateway.durable_recovery_authority.v2",
      revocation_state: "NOT_REVOKED",
      final_manager_sha256: managerHash,
      request_id: request.request_id,
      idempotency_fence: request.idempotency_fence,
      receipt_id: request.recovery_authority_id,
      receipt_hash: request.recovery_authority_hash,
      desired_manifest_id: request.desired_manifest_id,
      desired_manifest_sha256: request.desired_manifest_hash,
      predecessor_manifest_id: request.predecessor_manifest_id,
      predecessor_manifest_sha256: request.predecessor_manifest_hash,
      desired_manifest: {
        deployment_id: request.desired_manifest_id,
        commit: desiredCommit,
        tree: desiredTree,
      },
    }));
    await chmod(authorityPath, 0o600);
    const bridgeCode = buildNexusGatewayRecoveryBridgeCode(managerHash, "9".repeat(64));
    const result = await runRecoveryBridge(home, request, bridgeCode);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /authority contract hash mismatch/);
    assert.equal(await pathExists(marker), false, "substituted authority contract must be rejected before manager import");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fixed Nexus bridge rejects a symlinked desired deployment root before importing manager code", { skip: process.platform !== "darwin" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "devspace-nexus-bridge-root-"));
  const outside = await mkdtemp(join(tmpdir(), "devspace-nexus-bridge-outside-"));
  try {
    const state = join(home, "Library", "Application Support", "Nexus", "gateway-direct");
    const deployments = join(state, "deployments");
    await mkdir(deployments, { recursive: true });
    const marker = join(home, "manager-imported");
    const managerPath = join(state, "manager.py");
    await writeFile(managerPath, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("IMPORTED")\n`);
    await chmod(managerPath, 0o600);
    const managerHash = createHash("sha256").update(await readFile(managerPath)).digest("hex");
    const request = recoveryRequest();
    await symlink(outside, join(deployments, request.desired_manifest_id));
    const authorityPath = join(state, "recovery-authority.json");
    await writeFile(authorityPath, JSON.stringify({
      schema: "nexus.gateway.durable_recovery_authority.v2",
      revocation_state: "NOT_REVOKED",
      final_manager_sha256: managerHash,
      request_id: request.request_id,
      idempotency_fence: request.idempotency_fence,
      receipt_id: request.recovery_authority_id,
      receipt_hash: request.recovery_authority_hash,
      desired_manifest_id: request.desired_manifest_id,
      desired_manifest_sha256: request.desired_manifest_hash,
      predecessor_manifest_id: request.predecessor_manifest_id,
      predecessor_manifest_sha256: request.predecessor_manifest_hash,
      desired_manifest: {
        deployment_id: request.desired_manifest_id,
        commit: "1".repeat(40),
        tree: "2".repeat(40),
      },
    }));
    await chmod(authorityPath, 0o600);
    const bridgeCode = buildNexusGatewayRecoveryBridgeCode(managerHash, "8".repeat(64));
    const result = await runRecoveryBridge(home, request, bridgeCode);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /must not be a symlink/);
    assert.equal(await pathExists(marker), false, "escaped deployment root must be rejected before manager import");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("nexus_gateway_recovery_preflight passes with effect_started=false and readiness=[TARGET_READY,ROLLBACK_READY]", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("recovery bridge must not be called during preflight"); },
      async (request) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          result: "BLOCKED",
          effect_started: false,
          evidence_hash: "1".repeat(64),
          physical_observation: { readiness: ["TARGET_READY", "ROLLBACK_READY"] },
        }),
        stderr: "",
      }),
    );
    try {
      const result = await manager.nexusGatewayRecoveryPreflight({
        attemptKey: "preflight-pass-1",
        request: recoveryRequest(),
      });
      assert.equal(result.status, "passed");
      assert.equal(result.effectStarted, false);
      assert.deepEqual(result.readiness, ["TARGET_READY", "ROLLBACK_READY"]);
      assert.ok(result.outcome, "outcome must be present on pass");
      assert.equal(result.outcome!.result, "BLOCKED");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recovery_preflight rejects authority schema mismatch", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("recovery bridge must not be called"); },
      async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "recovery authority schema mismatch",
      }),
    );
    try {
      const result = await manager.nexusGatewayRecoveryPreflight({
        attemptKey: "preflight-tamper-1",
        request: recoveryRequest(),
      });
      assert.equal(result.status, "error");
      assert.equal(result.effectStarted, false);
      assert.match(result.errorMessage ?? "", /schema mismatch|exit/i);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recovery_preflight rejects wrong request hash", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("recovery bridge must not be called"); },
      async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "request/authority binding mismatch",
      }),
    );
    try {
      const badRequest = recoveryRequest({ request_hash: "0".repeat(64) });
      const result = await manager.nexusGatewayRecoveryPreflight({
        attemptKey: "preflight-tamper-2",
        request: badRequest,
      });
      assert.equal(result.status, "error");
      assert.equal(result.effectStarted, false);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recovery_preflight rejects wrong manager hash", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("recovery bridge must not be called"); },
      async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "manager artifact hash mismatch",
      }),
    );
    try {
      const result = await manager.nexusGatewayRecoveryPreflight({
        attemptKey: "preflight-tamper-3",
        request: recoveryRequest(),
      });
      assert.equal(result.status, "error");
      assert.equal(result.effectStarted, false);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_gateway_recovery_preflight rejects effect_started=true as error", async () => {
  const f = await fixture();
  try {
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("recovery bridge must not be called"); },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          result: "BLOCKED",
          effect_started: true,
          evidence_hash: "1".repeat(64),
          physical_observation: { readiness: ["TARGET_READY", "ROLLBACK_READY"] },
        }),
        stderr: "",
      }),
    );
    try {
      const result = await manager.nexusGatewayRecoveryPreflight({
        attemptKey: "preflight-effect-leak-1",
        request: recoveryRequest(),
      });
      assert.equal(result.status, "error");
      assert.equal(result.effectStarted, true);
      assert.match(result.errorMessage ?? "", /effect/i);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("fixed Nexus standing-grant CAS bridge rejects malformed input before any host effect", async () => {
  const home = await mkdtemp(join(tmpdir(), "devspace-standing-grant-bridge-"));
  try {
    const result = await runPythonBridge(home, NEXUS_STANDING_GRANT_CAS_BRIDGE_CODE, {});
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /standing-grant CAS request schema mismatch/);
    assert.equal(result.stdout, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("nexus_task_card_authority_switch switches exact GITHUB_MERGE receipt to fixed Task Card actions", async () => {
  const f = await fixture();
  try {
    const grantPath = join(f.root, "standing_grant.json");
    const backupPath = join(f.root, "standing_grant.backup.json");
    const initialGrant = makeStandingGrant();
    await writeFile(grantPath, JSON.stringify(initialGrant), { mode: 0o600 });

    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("gateway recovery runner unused"); },
      async () => { throw new Error("preflight runner unused"); },
      grantPath,
      backupPath,
    );
    try {
      const input = {
        attemptKey: "switch-1",
        expectedCurrentReceiptHash: initialGrant.receipt_hash,
        expectedCurrentGoalId: initialGrant.context.goal_id,
        successorGoalId: "goal-task-card-bootstrap",
        successorThreadId: "thread-task-card-bootstrap",
        ttlMinutes: 20,
        ownerConfirmation: true,
      } as const;
      const result = await manager.nexusTaskCardAuthoritySwitch(input);
      assert.equal(result.kind, "nexus_task_card_authority_switch");
      assert.equal(result.status, "succeeded");
      assert.equal(result.authorityMode, "OWNER_DIRECT");

      const updatedGrant = JSON.parse(await readFile(grantPath, "utf8")) as StandingGrantReceipt;
      assert.deepEqual(updatedGrant.context.allowed_actions, ["TASK_CARD_COMMIT", "TASK_CARD_CREATE"]);
      assert.equal(updatedGrant.context.owner_id, initialGrant.context.owner_id);
      assert.equal(updatedGrant.context.goal_id, input.successorGoalId);
      assert.equal(updatedGrant.context.thread_id, input.successorThreadId);
      assert.equal(updatedGrant.supersedes_grant_hash, initialGrant.receipt_hash);
      const { receipt_hash: updatedHash, ...updatedPayload } = updatedGrant;
      assert.equal(updatedHash, canonicalHash(updatedPayload));

      const backupGrant = JSON.parse(await readFile(backupPath, "utf8")) as StandingGrantReceipt;
      assert.deepEqual(backupGrant, initialGrant);

      const replayed = await manager.nexusTaskCardAuthoritySwitch(input);
      assert.equal(replayed.operationId, result.operationId);
      assert.equal(replayed.status, "succeeded");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_task_card_authority_switch emits Nexus-canonical six-digit UTC timestamps", async () => {
  const f = await fixture();
  try {
    const grantPath = join(f.root, "standing_grant.json");
    const backupPath = join(f.root, "standing_grant.backup.json");
    const fixedNow = Date.parse("2026-09-05T08:40:07.910Z");
    const initialGrant = makeStandingGrant({
      owner_id: "James3014",
      coordinator_id: "primary-codex-coordinator",
      issued_at: "2026-09-05T07:40:07.910000Z",
      expires_at: "2026-09-05T09:40:07.910000Z",
    });
    await writeFile(grantPath, JSON.stringify(initialGrant), { mode: 0o600 });

    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("gateway recovery runner unused"); },
      async () => { throw new Error("preflight runner unused"); },
      grantPath,
      backupPath,
      () => fixedNow,
    );
    try {
      const result = await manager.nexusTaskCardAuthoritySwitch({
        attemptKey: "switch-python-canonical-timestamp-1",
        expectedCurrentReceiptHash: initialGrant.receipt_hash,
        expectedCurrentGoalId: initialGrant.context.goal_id,
        successorGoalId: "H4-LIVE-TASK-CARD-AUTHORITY-ACCEPTANCE-20260905",
        successorThreadId: "H4-LIVE-TASK-CARD-AUTHORITY-ACCEPTANCE-20260905",
        ttlMinutes: 1,
        ownerConfirmation: true,
      });
      assert.equal(result.status, "succeeded");

      const updatedGrant = JSON.parse(await readFile(grantPath, "utf8")) as StandingGrantReceipt;
      assert.equal(updatedGrant.context.issued_at, "2026-09-05T08:40:07.910000Z");
      assert.equal(updatedGrant.context.expires_at, "2026-09-05T08:41:07.910000Z");
      assert.equal(updatedGrant.context.context_hash, "d83148444f0d30c3bf1706e36ca6de34b46fe586ffd237a2cd08ec5b78f6c9fe");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_task_card_authority_switch rejects missing Owner authority, CAS/Goal drift, wide TTL, and wrong predecessor action", async () => {
  const f = await fixture();
  try {
    const grantPath = join(f.root, "standing_grant.json");
    const backupPath = join(f.root, "standing_grant.backup.json");
    const initialGrant = makeStandingGrant();
    await writeFile(grantPath, JSON.stringify(initialGrant), { mode: 0o600 });
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("unused"); },
      async () => { throw new Error("unused"); },
      grantPath,
      backupPath,
    );
    const base = {
      expectedCurrentReceiptHash: initialGrant.receipt_hash,
      expectedCurrentGoalId: initialGrant.context.goal_id,
      successorGoalId: "goal-task-card-bootstrap",
      successorThreadId: "thread-task-card-bootstrap",
      ttlMinutes: 20,
      ownerConfirmation: true,
    } as const;
    try {
      await assert.rejects(
        manager.nexusTaskCardAuthoritySwitch({ ...base, attemptKey: "switch-err-1", ownerConfirmation: false }),
        (err: DurableOperationError) => err.code === "NEXUS_AUTHORITY_SWITCH_INVALID",
      );
      await assert.rejects(
        manager.nexusTaskCardAuthoritySwitch({ ...base, attemptKey: "switch-err-2", expectedCurrentReceiptHash: "0".repeat(64) }),
        (err: DurableOperationError) => err.code === "NEXUS_AUTHORITY_SWITCH_INVALID",
      );
      await assert.rejects(
        manager.nexusTaskCardAuthoritySwitch({ ...base, attemptKey: "switch-err-3", expectedCurrentGoalId: "wrong-goal-id" }),
        (err: DurableOperationError) => err.code === "NEXUS_AUTHORITY_SWITCH_INVALID",
      );
      await assert.rejects(
        manager.nexusTaskCardAuthoritySwitch({ ...base, attemptKey: "switch-err-4", ttlMinutes: 45 }),
        (err: DurableOperationError) => err.code === "NEXUS_AUTHORITY_SWITCH_INVALID",
      );

      const nonMergeGrant = makeStandingGrant({ allowed_actions: ["TASK_CARD_CREATE"] });
      await writeFile(grantPath, JSON.stringify(nonMergeGrant), { mode: 0o600 });
      await assert.rejects(
        manager.nexusTaskCardAuthoritySwitch({
          ...base,
          attemptKey: "switch-err-5",
          expectedCurrentReceiptHash: nonMergeGrant.receipt_hash,
          expectedCurrentGoalId: nonMergeGrant.context.goal_id,
        }),
        (err: DurableOperationError) => err.code === "NEXUS_AUTHORITY_SWITCH_INVALID",
      );
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_task_card_authority_restore restores the exact predecessor context as a new CAS successor", async () => {
  const f = await fixture();
  try {
    const grantPath = join(f.root, "standing_grant.json");
    const backupPath = join(f.root, "standing_grant.backup.json");
    const initialGrant = makeStandingGrant();
    await writeFile(grantPath, JSON.stringify(initialGrant), { mode: 0o600 });
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("unused"); },
      async () => { throw new Error("unused"); },
      grantPath,
      backupPath,
    );
    try {
      const switchResult = await manager.nexusTaskCardAuthoritySwitch({
        attemptKey: "switch-to-restore-1",
        expectedCurrentReceiptHash: initialGrant.receipt_hash,
        expectedCurrentGoalId: initialGrant.context.goal_id,
        successorGoalId: "goal-task-card-bootstrap",
        successorThreadId: "thread-task-card-bootstrap",
        ttlMinutes: 15,
        ownerConfirmation: true,
      });
      assert.equal(switchResult.status, "succeeded");
      const temporaryReceiptHash = String((switchResult.receipt as Record<string, unknown>).temporaryReceiptHash);

      const restoreInput = {
        attemptKey: "restore-1",
        switchOperationId: switchResult.operationId,
        expectedTemporaryReceiptHash: temporaryReceiptHash,
        ownerConfirmation: true,
      } as const;
      const restoreResult = await manager.nexusTaskCardAuthorityRestore(restoreInput);
      assert.equal(restoreResult.kind, "nexus_task_card_authority_restore");
      assert.equal(restoreResult.status, "succeeded");
      assert.equal(restoreResult.authorityMode, "OWNER_DIRECT");

      const restoredGrant = JSON.parse(await readFile(grantPath, "utf8")) as StandingGrantReceipt;
      assert.deepEqual(restoredGrant.context, initialGrant.context);
      assert.equal(restoredGrant.supersedes_grant_hash, temporaryReceiptHash);
      assert.notEqual(restoredGrant.receipt_hash, initialGrant.receipt_hash);
      const { receipt_hash: restoredHash, ...restoredPayload } = restoredGrant;
      assert.equal(restoredHash, canonicalHash(restoredPayload));

      const replayed = await manager.nexusTaskCardAuthorityRestore(restoreInput);
      assert.equal(replayed.operationId, restoreResult.operationId);
      assert.equal(replayed.status, "succeeded");

      await assert.rejects(
        manager.nexusTaskCardAuthorityRestore({ ...restoreInput, expectedTemporaryReceiptHash: "1".repeat(64) }),
        (err: DurableOperationError) => err.code === "OPERATION_REPLAY_CONFLICT",
      );
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("nexus_task_card_authority reconcile leaves successful switch stable", async () => {
  const f = await fixture();
  try {
    const grantPath = join(f.root, "standing_grant.json");
    const backupPath = join(f.root, "standing_grant.backup.json");
    const initialGrant = makeStandingGrant();
    await writeFile(grantPath, JSON.stringify(initialGrant), { mode: 0o600 });
    const manager = new DurableOperationManager(
      f.config,
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      async () => { throw new Error("unused"); },
      async () => { throw new Error("unused"); },
      grantPath,
      backupPath,
    );
    try {
      const switchResult = await manager.nexusTaskCardAuthoritySwitch({
        attemptKey: "reconcile-switch-1",
        expectedCurrentReceiptHash: initialGrant.receipt_hash,
        expectedCurrentGoalId: initialGrant.context.goal_id,
        successorGoalId: "goal-task-card-bootstrap",
        successorThreadId: "thread-task-card-bootstrap",
        ttlMinutes: 20,
        ownerConfirmation: true,
      });
      const reconciled = await manager.reconcile(switchResult.operationId);
      assert.equal(reconciled.status, "succeeded");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});
