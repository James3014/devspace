import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatSwarmStore } from "./chat-swarm-store.js";
import { ChatSwarmMigrationCoordinator, chatSwarmMigrationOperationId } from "./chat-swarm-migration.js";
import { promisify } from "node:util";
import type { ControlPlaneOwnershipStore } from "./control-plane-ownership.js";
import type { ControlPlaneConsumerOptions } from "./control-plane-consumer.js";
import { loadConfig } from "./config.js";
import { CutoverStateStore } from "./cutover-state.js";
import { openDatabase } from "./db/client.js";
import { initializeControlPlaneOwnershipDatabase } from "./control-plane-ownership.js";
import { canonicalizePath } from "./roots.js";
import {
  DurableOperationError,
  DurableOperationManager,
  DurableOperationStore,
  cutoverTerminalRecordHash,
  planCutoverStart,
  hashJson,
  type CommandRunner,
} from "./durable-operations.js";

const execFileAsync = promisify(execFile);

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

test("git_push preserves one durable attempt across lost acknowledgement and delayed remote settlement", async () => {
  const f = await fixture();
  try {
    const remote = join(f.root, "push-remote.git");
    const project = join(f.root, "push-project");
    await mkdir(remote);
    await mkdir(project);
    await git(remote, "init", "--bare", "--initial-branch=main");
    await git(project, "init", "--initial-branch=main");
    await git(project, "config", "user.email", "devspace@example.com");
    await git(project, "config", "user.name", "DevSpace Test");
    await writeFile(join(project, "candidate.txt"), "candidate\n");
    await git(project, "add", "candidate.txt");
    await git(project, "commit", "-m", "candidate");
    await git(project, "remote", "add", "origin", remote);
    const head = await git(project, "rev-parse", "HEAD");

    let pushCalls = 0;
    let firstReadback = true;
    const gitRunner = async (args: string[], cwd: string) => {
      if (args[0] === "push") {
        pushCalls += 1;
        await execFileAsync("git", args, { cwd });
        throw new Error("injected lost acknowledgement after remote accepted push");
      }
      if (args[0] === "ls-remote" && firstReadback) {
        firstReadback = false;
        return { stdout: "", stderr: "" };
      }
      const result = await execFileAsync("git", args, { cwd });
      return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    };

    const manager = new DurableOperationManager(f.config);
    try {
      const uncertain = await manager.gitPush({
        attemptKey: "git-push-lost-ack-1",
        workspaceId: "ws_git_push",
        workspaceRoot: project,
        expectedHead: head,
        remote: "origin",
        branch: "candidate",
        gitRunner,
      });
      assert.equal(uncertain.kind, "git_push");
      assert.equal(uncertain.status, "outcome_unknown");
      assert.equal(uncertain.retrySafe, false);
      assert.equal(uncertain.receipt?.effectState, "EFFECT_UNKNOWN");
      assert.equal(pushCalls, 1);
      assert.equal(await git(remote, "rev-parse", "refs/heads/candidate"), head);

      await assert.rejects(
        manager.gitPush({
          attemptKey: "git-push-lost-ack-1",
          workspaceId: "ws_git_push",
          workspaceRoot: project,
          expectedHead: head,
          remote: "origin",
          branch: "candidate",
          gitRunner,
        }),
        (error: unknown) =>
          error instanceof DurableOperationError &&
          error.code === "OPERATION_OUTCOME_UNKNOWN" &&
          error.operation?.operationId === uncertain.operationId,
      );
      assert.equal(pushCalls, 1, "same-attempt replay must not issue a second push");

      const reconciled = await manager.reconcile(uncertain.operationId);
      assert.equal(reconciled.operationId, uncertain.operationId);
      assert.equal(reconciled.status, "succeeded");
      assert.equal(reconciled.retrySafe, false);
      assert.equal(reconciled.receipt?.effectState, "CONFIRMED_REMOTE_PUSH");
      assert.equal(reconciled.receipt?.pushedSha, head);
      assert.equal(pushCalls, 1, "reconciliation must inspect remote truth without re-pushing");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("git_push treats pre-effect validation failure as retry-safe only for a new attempt identity", async () => {
  const f = await fixture();
  try {
    const remote = join(f.root, "push-validation-remote.git");
    const project = join(f.root, "push-validation-project");
    await mkdir(remote);
    await mkdir(project);
    await git(remote, "init", "--bare", "--initial-branch=main");
    await git(project, "init", "--initial-branch=main");
    await git(project, "config", "user.email", "devspace@example.com");
    await git(project, "config", "user.name", "DevSpace Test");
    await writeFile(join(project, "candidate.txt"), "candidate\n");
    await git(project, "add", "candidate.txt");
    await git(project, "commit", "-m", "candidate");
    await git(project, "remote", "add", "origin", remote);
    const head = await git(project, "rev-parse", "HEAD");

    const manager = new DurableOperationManager(f.config);
    try {
      const rejected = await manager.gitPush({
        attemptKey: "git-push-pre-effect-1",
        workspaceId: "ws_git_push_validation",
        workspaceRoot: project,
        expectedHead: head,
        remote: "origin",
        branch: "main",
      });
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.retrySafe, true);
      assert.equal(rejected.receipt?.effectState, "CONFIRMED_NO_EFFECT");
      assert.equal(await git(project, "ls-remote", "--heads", "origin", "refs/heads/main"), "");

      const succeeded = await manager.gitPush({
        attemptKey: "git-push-pre-effect-2",
        workspaceId: "ws_git_push_validation",
        workspaceRoot: project,
        expectedHead: head,
        remote: "origin",
        branch: "candidate",
      });
      assert.equal(succeeded.status, "succeeded");
      assert.equal(succeeded.receipt?.pushedSha, head);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("chat swarm migration executor is readback-bound, idempotent, and refuses unknown replay", async () => {
  const f = await fixture();
  const destinationRoot = await mkdtemp(join(tmpdir(), "devspace-migration-destination-"));
  const source = new ChatSwarmStore(f.config.stateDir);
  const destination = new ChatSwarmStore(destinationRoot);
  const binding = (role: string, stateDirectory: string) => ({
    serverInstanceId: `${role}-server`,
    sourceCommit: "a".repeat(40),
    buildId: `${role}-build`,
    capabilityManifestSha256: "b".repeat(64),
    catalogGeneration: "catalog-1",
    stateDirectory,
  });
  try {
    const swarm = source.createSwarm({ ownerIdentity: "owner", workerLimit: 2 });
    const worker = source.createWorker({ swarmId: swarm.id, label: "peer", runtimeKind: "mcp_peer" });
    const task = source.createTask({ swarmId: swarm.id, taskKey: "executor", prompt: "preserve" }).task;
    source.claimTask(task.id, worker.id);
    source.recoverAfterRestart();
    const sourceBinding = binding("source", f.config.stateDir);
    const destinationBinding = binding("destination", destinationRoot);
    const attemptKey = "migration-executor-1";
    // The destination binding is known before export; the operation identity is
    // derived from that canonical destination root and the attempt key.
    const operationId = chatSwarmMigrationOperationId(destinationRoot, attemptKey);
    assert.notEqual(operationId, chatSwarmMigrationOperationId(f.config.stateDir, attemptKey));
    const bundle = source.exportMigrationBundle({ operationId, sourceBinding, destinationBinding });
    assert.equal(bundle.operationId, operationId);
    const canonicalConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(destinationRoot, ".config"),
      DEVSPACE_ALLOWED_ROOTS: destinationRoot,
      DEVSPACE_WORKTREE_ROOT: join(destinationRoot, ".worktrees"),
      DEVSPACE_STATE_DIR: destinationRoot,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const manager = new DurableOperationManager(canonicalConfig);
    const migration = new ChatSwarmMigrationCoordinator(manager.store, destinationRoot);
    try {
      const preparation = migration.prepareChatSwarmMigration({ attemptKey, bundle, destinationBinding });
      const first = migration.applyChatSwarmMigration(preparation, destination);
      assert.equal(first.status, "succeeded");
      assert.equal(first.retrySafe, false);
      assert.equal(destination.getTask(task.id)?.lifecycleState, "RECONCILE_REQUIRED");
      assert.equal(source.listSwarms().some((item) => item.id === swarm.id), true);
      assert.equal(source.listWorkers(swarm.id).some((item) => item.id === worker.id), true);
      assert.equal(source.getTask(task.id)?.lifecycleState, "RECONCILE_REQUIRED");
      const replay = migration.applyChatSwarmMigration(preparation, destination);
      assert.deepEqual(replay, first);
      assert.equal(destination.readMigrationReadback(bundle).contentHash, bundle.contentHash);

      const unknownAttempt = "migration-executor-unknown";
      const unknownOperationId = chatSwarmMigrationOperationId(destinationRoot, unknownAttempt);
      const unknownBundle = source.exportMigrationBundle({ operationId: unknownOperationId, sourceBinding, destinationBinding });
      const unknownPreparation = migration.prepareChatSwarmMigration({ attemptKey: unknownAttempt, bundle: unknownBundle, destinationBinding });
      manager.store.finish(unknownPreparation.operationId, { status: "outcome_unknown", retrySafe: false, errorCode: "RECONCILIATION_REQUIRED" });
      assert.throws(() => migration.applyChatSwarmMigration(unknownPreparation, destination), (error: unknown) => error instanceof DurableOperationError && error.code === "OPERATION_OUTCOME_UNKNOWN");
    } finally {
      manager.close();
    }
  } finally {
    source.close();
    destination.close();
    await rm(destinationRoot, { recursive: true, force: true });
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

async function dependencyFixtureManager(config: ReturnType<typeof loadConfig>, runner: CommandRunner, path: string) {
  const root=canonicalizePath(path);
  await git(root,"init");
  await git(root,"-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-m","fixture");
  const base=await git(root,"rev-parse","HEAD");
  const sha=(value: string|Buffer)=>createHash("sha256").update(value).digest("hex");
  const requestHash=sha(JSON.stringify({baseRevision:base,frozenInputs:{"package-lock.json":sha(await readFile(join(root,"package-lock.json"))),"package.json":sha(await readFile(join(root,"package.json")))},recipe:"npm_ci",version:"devspace.execution.v1",workspaceId:"ws_fixture",workspaceRoot:root}));
  const context=Object.freeze({});
  const grant={repository:"owner/repo",goal:"fixture",coordinatorThread:"controller",evidenceHash:"fixture-proof"};
  let ownership:ControlPlaneOwnershipStore;
  let leaseId="";
  const options:ControlPlaneConsumerOptions={
    resolveOwnerContext:c=>c===context?{ownerThread:"fixture"}:undefined,
    verifyGrantEvidence:g=>JSON.stringify(g)===JSON.stringify(grant),
    resolveEffectBinding:(c,subject)=>c===context && subject.requestHash===requestHash ? {leaseId,leaseVersion:ownership.get(leaseId)!.version,requestHash,role:"worker"}:undefined,
  };
  const manager=new DurableOperationManager(config,runner,options);
  ownership=manager.store.createOwnershipStore(options);
  ownership.putGrantEvidence(context,grant,0);
  leaseId=ownership.acquire(context,{repositoryKey:grant.repository,resourceKind:"workspace",resourceId:root,resource:root,scope:[root],operation:"dependency_sync",baseRevision:base,expiresAt:new Date(Date.now()+60000).toISOString(),idempotencyKey:"fixture",grant}).leaseId;
  return {manager,context,ownership,leaseId};
}

test("workspace_clone passes literal native Git paths containing spaces and shell metacharacters", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "source dir;$(touch SHOULD_NOT_EXIST)");
    const destination = join(f.root, "clone dir [literal]");
    await mkdir(source);
    await git(source, "init");
    await git(source, "config", "user.email", "devspace@example.com");
    await git(source, "config", "user.name", "DevSpace Test");
    await writeFile(join(source, "README.md"), "native argv\n");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "native argv");

    const manager = new DurableOperationManager(f.config);
    try {
      const result = await manager.workspaceClone({ attemptKey: "clone-native-argv-1", remote: source, destination });
      assert.equal(result.status, "succeeded");
      assert.equal(await readFile(join(destination, "README.md"), "utf8"), "native argv\n");
      assert.equal(await pathExists(join(f.root, "SHOULD_NOT_EXIST")), false);
    } finally {
      manager.close();
    }
  } finally {
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
    const {manager,context} = await dependencyFixtureManager(f.config,runner,project);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-frozen-1",
        workspaceId: "ws_fixture",
        workspaceRoot: project,
        recipe: "npm_ci",
      },context);
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

test("C4: new direct cutover persists exact durable correlation without Carrier governance", async () => {
  const f = await fixture();
  const manager = new DurableOperationManager(f.config);
  try {
    const input = {
      attemptKey: "c4-direct-cutover-1",
      currentIdentity: {
        serverInstanceId: "old-server",
        sourceCommit: "a".repeat(40),
        buildId: "old-build",
        capabilityManifestSha256: "c".repeat(64),
      },
      expectedIdentity: {
        sourceCommit: "b".repeat(40),
        buildId: "new-build",
        capabilityManifestSha256: "c".repeat(64),
      },
    };
    const first = manager.startDirectCutover(input);
    assert.equal(first.status, "succeeded");
    assert.equal(first.retrySafe, false);
    const cutover = new CutoverStateStore(f.config.stateDir).get();
    assert.equal(cutover?.phase, "prepared");
    assert.equal(cutover?.coordinationBinding, undefined);
    assert.deepEqual(cutover?.directOperation, {
      operationId: first.operationId,
      requestHash: first.requestHash,
    });
    assert.equal(first.receipt?.cutoverId, cutover?.cutoverId);
    assert.deepEqual(manager.startDirectCutover(input), first);
    assert.deepEqual(await manager.reconcile(first.operationId), first);
    assert.throws(() => manager.startDirectCutover({
      ...input,
      expectedIdentity: { ...input.expectedIdentity, buildId: "wrong-target" },
    }), /OPERATION_REPLAY_CONFLICT|materially different/);
    assert.equal(new CutoverStateStore(f.config.stateDir).get()?.cutoverId, cutover?.cutoverId);
  } finally {
    manager.close();
    await f.cleanup();
  }
});

test("C4 refuses to downgrade a persisted Carrier-bound cutover into new OWNER_DIRECT authority", async () => {
  const f = await fixture();
  const manager = new DurableOperationManager(f.config);
  try {
    const input = {
      attemptKey: "c4-must-not-downgrade",
      currentIdentity: { serverInstanceId: "legacy-old", sourceCommit: "a".repeat(40), buildId: "old" },
      expectedIdentity: { sourceCommit: "b".repeat(40), buildId: "new" },
    };
    const coordinationBinding = {
      leaseId: "lease-old",
      pinnedLeaseVersion: 2,
      operationHandle: "op_" + "e".repeat(16),
      requestHash: "f".repeat(64),
      ownerThread: "legacy-controller",
    };
    const bound = new CutoverStateStore(f.config.stateDir).begin({
      oldServerIdentity: input.currentIdentity,
      expectedNewIdentity: input.expectedIdentity,
      coordinationBinding,
    });
    const operationId = planCutoverStart(f.config.stateDir, input).operationId;
    assert.throws(() => manager.startDirectCutover(input), /Unresolved cutover.*fence/i);
    assert.equal(manager.store.getByOperationId(operationId), undefined, "no intent may be persisted for a known active legacy fence");
    assert.deepEqual(new CutoverStateStore(f.config.stateDir).get()?.coordinationBinding, coordinationBinding);
    assert.equal(new CutoverStateStore(f.config.stateDir).get()?.directOperation, undefined);
    assert.equal(new CutoverStateStore(f.config.stateDir).get()?.cutoverId, bound.cutoverId);
  } finally {
    manager.close();
    await f.cleanup();
  }
});

test("C4 occupied native cutover fence denies pre-intent and permits same attemptKey after genuine closure", async () => {
  const f = await fixture();
  const manager = new DurableOperationManager(f.config);
  try {
    const state = new CutoverStateStore(f.config.stateDir);
    const first = state.begin({
      oldServerIdentity: {serverInstanceId: "old-active", sourceCommit: "a".repeat(40), buildId: "build-a"},
      expectedNewIdentity: {sourceCommit: "b".repeat(40), buildId: "build-b"},
    });
    const input = {
      attemptKey: "c4-known-fence-retry",
      currentIdentity: {serverInstanceId: "new-active", sourceCommit: "b".repeat(40), buildId: "build-b"},
      expectedIdentity: {sourceCommit: "c".repeat(40), buildId: "build-c"},
    };
    const operationId = planCutoverStart(f.config.stateDir, input).operationId;
    assert.throws(() => manager.startDirectCutover(input), /Unresolved cutover.*fence/i);
    assert.equal(manager.store.getByOperationId(operationId), undefined, "pre-intent collision must leave the attempt key reusable");
    assert.equal(state.get()?.cutoverId, first.cutoverId);
    state.close(first.cutoverId, {
      closedByServerInstanceId: "closed-active",
      workspaceQueryable: true,
      agentQueryable: true,
      agentReconciled: true,
      reconciledAt: new Date().toISOString(),
    });
    const started = manager.startDirectCutover(input);
    assert.equal(started.status, "succeeded");
    assert.equal(started.operationId, operationId);
    assert.deepEqual(manager.startDirectCutover(input), started, "same-effect replay may not be rejected by its own active fence");
    assert.equal(state.get()?.directOperation?.operationId, operationId);
    assert.notEqual(state.get()?.cutoverId, first.cutoverId);
  } finally {
    manager.close();
    await f.cleanup();
  }
});

test("C4 cannot archive a closed Carrier generation while its durable lease terminalization is incomplete", async () => {
  const f = await fixture();
  const manager = new DurableOperationManager(f.config);
  try {
    const old = {
      attemptKey: "legacy-closed-awaiting-ack",
      currentIdentity: {serverInstanceId: "bound-owner", sourceCommit: "a".repeat(40), buildId: "old"},
      expectedIdentity: {sourceCommit: "b".repeat(40), buildId: "old-target"},
    };
    const plan = planCutoverStart(f.config.stateDir, old);
    const coordinationBinding = {
      leaseId: "lease-legacy-closed",
      pinnedLeaseVersion: 3,
      operationHandle: plan.operationId,
      requestHash: plan.requestHash,
      ownerThread: "legacy-controller",
    };
    const bound = manager.store.createOrReplay({
      operationId: plan.operationId, attemptKey: old.attemptKey,
      requestHash: plan.requestHash, kind: "cutover_start",
      scopeRoot: plan.stateRoot, request: {...plan.request, coordinationBinding},
    });
    assert.equal(bound.record.status, "started");
    const state = new CutoverStateStore(f.config.stateDir);
    const existing = state.begin({
      oldServerIdentity: old.currentIdentity,
      expectedNewIdentity: old.expectedIdentity,
      coordinationBinding,
    });
    state.close(existing.cutoverId, {
      closedByServerInstanceId: "replacement-bound", workspaceQueryable: true,
      agentQueryable: true, agentReconciled: true, reconciledAt: new Date().toISOString(),
    });
    assert.equal(state.get()?.phase, "closed");
    const next = {
      attemptKey: "c4-new-after-terminal",
      currentIdentity: {serverInstanceId: "replacement-bound", sourceCommit: "b".repeat(40), buildId: "old-target"},
      expectedIdentity: {sourceCommit: "c".repeat(40), buildId: "new-target"},
    };
    assert.throws(() => manager.startDirectCutover(next), /bound.*terminal|legacy.*terminal|lifecycle.*terminal/i);
    assert.equal(state.get()?.cutoverId, existing.cutoverId, "legacy recovery must remain physically addressable");
    const nextId = planCutoverStart(f.config.stateDir, next).operationId;
    assert.equal(manager.store.getByOperationId(nextId), undefined, "no new intent may be poisoned before legacy terminalization");
    manager.store.finish(plan.operationId, {
      status: "succeeded", retrySafe: false,
      receipt: {cutoverId: existing.cutoverId, lifecycleTerminal: true, terminalRecordHash: "0".repeat(64)},
    });
    assert.throws(() => manager.startDirectCutover(next), /bound.*terminal|legacy.*terminal|digest|hash/i);
    assert.equal(state.get()?.cutoverId, existing.cutoverId);
    manager.store.finish(plan.operationId, {
      status: "succeeded", retrySafe: false,
      receipt: {cutoverId: existing.cutoverId, lifecycleTerminal: true, terminalRecordHash: cutoverTerminalRecordHash(state.get()!)},
    });
    assert.throws(() => manager.startDirectCutover(next), /legacy.*lease.*terminal|terminal.*lease/i,
      "a matching operation receipt cannot waive the original Carrier lease release");
    assert.equal(state.get()?.cutoverId, existing.cutoverId);

    const db = openDatabase(f.config.stateDir);
    try {
      initializeControlPlaneOwnershipDatabase(db.sqlite);
      const now = new Date().toISOString();
      db.sqlite.prepare(`insert into control_plane_resource_leases (
        lease_id,repository_key,resource_kind,resource_id,resource,operation,scope_json,base_revision,
        idempotency_key,owner_thread,grant_json,grant_version,version,terminal_state,expires_at,
        created_at,updated_at,active_operation_handle,operation_state
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        coordinationBinding.leaseId, "james3014/devspace", "filesystem", plan.stateRoot, plan.stateRoot,
        "cutover_start", JSON.stringify([plan.stateRoot]), old.currentIdentity.sourceCommit,
        old.attemptKey, coordinationBinding.ownerThread,
        JSON.stringify({
          repository: "james3014/devspace", goal: "legacy-closure-fixture",
          coordinatorThread: coordinationBinding.ownerThread, evidenceHash: "fixture",
        }),
        1, 3, null, "2100-01-01T00:00:00.000Z", now, now, null, "finished",
      );
      assert.throws(() => manager.startDirectCutover(next), /legacy.*lease.*terminal|terminal.*lease/i,
        "a finished operation with an unreleased state-root lease must remain recoverable");
      db.sqlite.prepare("update control_plane_resource_leases set terminal_state='released', version=version+1 where lease_id=?")
        .run(coordinationBinding.leaseId);
      db.sqlite.prepare("update control_plane_resource_leases set owner_thread='wrong-owner' where lease_id=?")
        .run(coordinationBinding.leaseId);
      assert.throws(() => manager.startDirectCutover(next), /legacy.*lease.*terminal|terminal.*lease/i,
        "released lease owned by another historical principal cannot authorize archival");
      db.sqlite.prepare("update control_plane_resource_leases set owner_thread=? where lease_id=?")
        .run(coordinationBinding.ownerThread, coordinationBinding.leaseId);
      db.sqlite.prepare("update control_plane_resource_leases set resource='/wrong-resource' where lease_id=?")
        .run(coordinationBinding.leaseId);
      assert.throws(() => manager.startDirectCutover(next), /legacy.*lease.*terminal|terminal.*lease/i,
        "released lease for another resource cannot authorize archival");
      db.sqlite.prepare("update control_plane_resource_leases set resource=? where lease_id=?")
        .run(plan.stateRoot, coordinationBinding.leaseId);
    } finally {
      db.close();
    }
    const after = manager.startDirectCutover(next);
    assert.equal(after.status, "succeeded");
    assert.equal(state.get()?.directOperation?.operationId, after.operationId);
    assert.notEqual(state.get()?.cutoverId, existing.cutoverId);
  } finally {
    manager.close();
    await f.cleanup();
  }
});

test("C4 direct cutover lost-ACK reconciles exact intent, never recreates absent or mismatched physical effects", async () => {
  const f = await fixture();
  const manager = new DurableOperationManager(f.config);
  try {
    const input = {
      attemptKey: "c4-unknown-cutover",
      currentIdentity: { serverInstanceId: "old-1", sourceCommit: "a".repeat(40), buildId: "old-build" },
      expectedIdentity: { sourceCommit: "b".repeat(40), buildId: "new-build" },
    };
    const planned = planCutoverStart(f.config.stateDir, input);
    const request = { ...planned.request, ownerDirect: true };
    const requestHash = hashJson(request);
    const intent = manager.store.createOrReplay({
      operationId: planned.operationId,
      attemptKey: input.attemptKey,
      requestHash,
      kind: "cutover_start",
      scopeRoot: planned.stateRoot,
      request,
    });
    assert.equal(intent.record.status, "started");
    assert.throws(() => manager.reconcileDirectCutoverStart(planned.operationId), /no retry is authorized/);
    assert.throws(() => manager.startDirectCutover(input), /no retry is authorized/);
    assert.equal(new CutoverStateStore(f.config.stateDir).get(), undefined);
    assert.equal(manager.store.getByOperationId(planned.operationId)?.status, "started");
    const observed = new CutoverStateStore(f.config.stateDir).begin({
      oldServerIdentity: input.currentIdentity,
      expectedNewIdentity: input.expectedIdentity,
      directOperation: { operationId: planned.operationId, requestHash },
    });
    const reconciled = manager.reconcileDirectCutoverStart(planned.operationId);
    assert.equal(reconciled.status, "succeeded");
    assert.equal(reconciled.receipt?.cutoverId, observed.cutoverId);
    assert.deepEqual(manager.startDirectCutover(input), reconciled);
  } finally {
    manager.close();
    await f.cleanup();
  }
});

test("C4 startup Carrier compatibility inventory excludes direct records but detects bound history", async () => {
  const f = await fixture();
  const manager = new DurableOperationManager(f.config);
  try {
    assert.equal(manager.store.hasLegacyBoundOperations(), false);
    manager.startDirectCutover({
      attemptKey: "c4-new-only",
      currentIdentity: { serverInstanceId: "old", sourceCommit: "a".repeat(40), buildId: "old" },
      expectedIdentity: { sourceCommit: "b".repeat(40), buildId: "new" },
    });
    assert.equal(manager.store.hasLegacyBoundOperations(), false);
    const boundSync = manager.store.createOrReplay({
      operationId: "op_1111111111111111",
      attemptKey: "historical-bound-sync",
      requestHash: "c".repeat(64),
      kind: "dependency_sync",
      scopeRoot: f.config.stateDir,
      request: { version: "historical", workspaceRoot: f.config.stateDir },
    });
    assert.equal(manager.store.hasLegacyBoundOperations(), true);
    manager.store.finish(boundSync.record.operationId, { status: "succeeded", retrySafe: false });
    assert.equal(manager.store.hasLegacyBoundOperations(), false, "terminal dependency sync must not keep Carrier resident");

    const boundCutover = manager.store.createOrReplay({
      operationId: "op_2222222222222222",
      attemptKey: "historical-bound-cutover",
      requestHash: "d".repeat(64),
      kind: "cutover_start",
      scopeRoot: f.config.stateDir,
      request: { version: "historical", coordinationBinding: {
        leaseId: "lease-legacy", operationHandle: "op_2222222222222222",
        requestHash: "d".repeat(64), ownerThread: "legacy-controller", pinnedLeaseVersion: 1,
      } },
    });
    assert.equal(manager.store.hasLegacyBoundOperations(), true);
    manager.store.finish(boundCutover.record.operationId, {
      status: "succeeded", retrySafe: false, receipt: { lifecycleTerminal: true },
    });
    assert.equal(manager.store.hasLegacyBoundOperations(), false, "terminal cutover must not keep Carrier resident");
  } finally {
    manager.close();
    await f.cleanup();
  }
});

test("dependency_sync OWNER_DIRECT isolated mode does not require carrier authority", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
    await writeFile(join(project, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
    await git(project, "init");
    await git(project, "config", "user.email", "devspace@example.com");
    await git(project, "config", "user.name", "DevSpace Test");
    await git(project, "add", ".");
    await git(project, "commit", "-m", "fixture");
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const manager = new DurableOperationManager(f.config, runner);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-owner-direct-isolated-1",
        workspaceId: "ws_isolated",
        workspaceRoot: project,
        recipe: "npm_ci",
        ownerDirectIsolated: true,
      });
      assert.equal(result.status, "succeeded");
      assert.equal(calls, 1);
      const witness = manager.store.readDependencyTerminal(result.operationId);
      assert.equal(witness?.leaseId, "OWNER_DIRECT_ISOLATED");
      assert.equal(witness?.requestHash, result.requestHash);
      assert.equal(witness?.frozenInputsUnchanged, true);
      assert.equal((result.request as Record<string, unknown>).ownerDirectIsolated, true);
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("C4 checkout reconciliation rejects a forged isolated witness after lost process acknowledgement", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "checkout");
    await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
    await writeFile(join(project, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
    await git(project, "init");
    await git(project, "config", "user.email", "devspace@example.com");
    await git(project, "config", "user.name", "DevSpace Test");
    await git(project, "add", ".");
    await git(project, "commit", "-m", "fixture");
    const manager = new DurableOperationManager(f.config, async () => {
      throw new Error("lost checkout process acknowledgement");
    });
    try {
      const unknown = await manager.dependencySync({
        attemptKey: "c4-checkout-no-witness",
        workspaceId: "ws_single_checkout",
        workspaceRoot: project,
        recipe: "npm_ci",
        ownerDirectExecution: true,
      });
      assert.equal(unknown.status, "outcome_unknown");
      assert.equal(unknown.retrySafe, false);
      assert.equal(unknown.request.ownerDirectExecution, true);
      manager.store.recordDependencyTerminal(unknown.operationId, unknown.requestHash, "OWNER_DIRECT_ISOLATED", 0, true);
      assert.throws(() => manager.reconcileOwnerDirectDependencySync(unknown.operationId), /No exact terminal witness exists/);
      assert.equal(manager.store.getByOperationId(unknown.operationId)?.status, "outcome_unknown");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("dependency_sync OWNER_DIRECT isolated reconciliation requires its exact terminal witness", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
    await writeFile(join(project, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }) + "\n");
    await git(project, "init");
    await git(project, "config", "user.email", "devspace@example.com");
    await git(project, "config", "user.name", "DevSpace Test");
    await git(project, "add", ".");
    await git(project, "commit", "-m", "fixture");
    const manager = new DurableOperationManager(f.config, async () => {
      throw new Error("simulated unacknowledged dependency process");
    });
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-owner-direct-isolated-unknown",
        workspaceId: "ws_isolated",
        workspaceRoot: project,
        recipe: "npm_ci",
        ownerDirectIsolated: true,
      });
      assert.equal(result.status, "outcome_unknown");
      assert.throws(
        () => manager.reconcileOwnerDirectDependencySync(result.operationId),
        /No exact terminal witness exists/,
      );
      assert.equal(manager.store.getByOperationId(result.operationId)?.status, "outcome_unknown");
    } finally {
      manager.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("dependency_sync rejects a changed request before creating an operation or pin", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "project");
    await mkdir(project);
    await writeFile(join(project, "package.json"), '{"name":"fixture"}\n');
    await writeFile(join(project, "package-lock.json"), '{"lockfileVersion":3}\n');
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const { manager, context, ownership, leaseId } = await dependencyFixtureManager(f.config, runner, project);
    try {
      const before = ownership.get(leaseId);
      const attemptKey = "deps-wrong-request";
      await assert.rejects(manager.dependencySync({
        attemptKey,
        workspaceId: "wrong-workspace",
        workspaceRoot: project,
        recipe: "npm_ci",
      }, context), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "AUTHORITY_REQUIRED");
      assert.equal(calls, 0);
      assert.equal(manager.store.getByAttempt(canonicalizePath(project), attemptKey), undefined);
      assert.deepEqual(ownership.get(leaseId), before);
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
    const {manager,context} = await dependencyFixtureManager(f.config,runner,project);
    try {
      const result = await manager.dependencySync({
        attemptKey: "deps-mutation-1",
        workspaceId: "ws_fixture",
        workspaceRoot: project,
        recipe: "npm_ci",
      },context);
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
