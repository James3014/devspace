import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NexusGatewayProxyError,
  createNexusGatewayProxyServer,
  createPublicDirectMergeLaneGuard,
  createPublicNexusIntegrationTargetResolver,
  fetchNexusGatewayToolManifest,
  forwardNexusGatewayTool,
  nexusGatewayManifestIdentity,
  nexusGatewayToolManifestSha256,
} from "./nexus-gateway-proxy.js";
import type { ServerConfig } from "./config.js";
import { createMcpTransportBoundary, MODERN_MCP_PROTOCOL_VERSION } from "./mcp-transport.js";
import {
  MergePullRequestError,
  PR_MERGE_ERROR_CODES,
  type GitHubPullRequestTransport,
  type RepositoryView,
  type PullRequestView,
  type BranchRefView,
  type BranchProtectionView,
  type EffectiveRulesView,
  type RequiredCheckRequirement,
  type CommitStatusEvidence,
  type CheckRunView,
  type MergeResultView,
  type MergeEffectGuard,
  type MergeMethod,
} from "./git-pr-merge.js";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const NEW_MAIN = "5".repeat(40);

const config = {
  gatewayProxyUrl: "http://127.0.0.1:8766",
  gatewayProxyToken: "gateway-token-that-is-long-enough",
} as ServerConfig;

const originalFetch = globalThis.fetch;
let request: { url: string; init?: RequestInit } | undefined;
let manifestFetches = 0;
globalThis.fetch = (async (input, init) => {
  const body = JSON.parse(String(init?.body));
  request = { url: String(input), init };
  if (body.method === "tools/list") {
    manifestFetches += 1;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        manifest_revision: "gateway-revision-7",
        tools: [
          {
            name: "nexus_gateway_status",
            description: "Read the canonical gateway status.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "nexus_candidate_approve",
            description: "Approve an exact candidate.",
            inputSchema: {
              type: "object",
              required: ["task_id", "approval"],
              properties: {
                task_id: { type: "string" },
                approval: {
                  type: "object",
                  required: ["schema"],
                  properties: { schema: { const: "nexus.approval.v2" } },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result: { content: [{ type: "text", text: "ok" }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  const manifest = await fetchNexusGatewayToolManifest(config);
  assert.deepEqual(manifest.map((tool) => tool.name), ["nexus_candidate_approve", "nexus_gateway_status"]);
  assert.equal(manifest.revision, "gateway-revision-7");
  assert.equal(manifest.sha256, nexusGatewayToolManifestSha256(manifest));
  assert.deepEqual(nexusGatewayManifestIdentity(manifest), {
    count: 2,
    revision: `sha256:${manifest.sha256}`,
    sha256: manifest.sha256,
  });
  assert.equal(
    manifest.find((tool) => tool.name === "nexus_candidate_approve")?.inputSchema.properties?.approval?.properties?.schema?.const,
    "nexus.approval.v2",
  );

  const proxyServer = await createNexusGatewayProxyServer(config, manifest);
  assert.equal(manifestFetches, 1, "prepared startup manifest must be reused by every request factory");
  const registeredTools = (proxyServer as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  assert.deepEqual(
    Object.keys(registeredTools ?? {}).sort(),
    ["git_merge_pull_request", "github_complete_pull_request", "nexus_candidate_approve", "nexus_gateway_status"],
  );

  const publicBoundary = createMcpTransportBoundary(
    () => createNexusGatewayProxyServer(config, manifest),
    "dual",
  );
  const toolsResponse = await publicBoundary.fetch(new Request("http://test.local/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": MODERN_MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "proxy-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  }));
  assert.equal(toolsResponse.status, 200);
  assert.equal(toolsResponse.headers.has("mcp-session-id"), false);
  const publicPayload = JSON.parse(await toolsResponse.text());
  assert.deepEqual(
    publicPayload.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ["git_merge_pull_request", "github_complete_pull_request", "nexus_candidate_approve", "nexus_gateway_status"],
  );
  const publicNames = new Set(publicPayload.result.tools.map((tool: { name: string }) => tool.name));
  for (const rawName of ["open_workspace", "bash", "write", "edit"]) {
    assert.equal(publicNames.has(rawName), false, `hybrid public surface must not expose raw ${rawName}`);
  }
  assert.equal(publicPayload.result.resultType, "complete");
  await publicBoundary.close();

  const result = await forwardNexusGatewayTool(config, "nexus_gateway_status", { detail: true }, {
    requestId: "request-1",
    traceparent: "trace-parent",
    tracestate: "trace-state",
    baggage: "tenant=nexus",
    clientId: "client-1",
    principal: "owner",
    protocolVersion: "2026-07-28",
    taskId: "task-1",
    attemptId: "attempt-1",
  });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok" }] });
  assert.equal(request?.url, "http://127.0.0.1:8766/mcp");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${config.gatewayProxyToken}`);
  assert.equal(new Headers(request?.init?.headers).get("x-request-id"), "request-1");
  assert.equal(new Headers(request?.init?.headers).get("traceparent"), "trace-parent");
  assert.equal(new Headers(request?.init?.headers).get("tracestate"), "trace-state");
  assert.equal(new Headers(request?.init?.headers).get("baggage"), "tenant=nexus");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-mcp-client-id"), "client-1");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-mcp-principal"), "owner");
  assert.equal(new Headers(request?.init?.headers).get("mcp-protocol-version"), "2026-07-28");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-task-id"), "task-1");
  assert.equal(new Headers(request?.init?.headers).get("x-nexus-attempt-id"), "attempt-1");
  assert.deepEqual(JSON.parse(String(request?.init?.body)).params, {
    name: "nexus_gateway_status",
    arguments: { detail: true },
  });

  const acceptedByKey = new Map<string, { task_id: string; attempt_id: string }>();
  let mutationApplications = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const params = body.params as { name: string; arguments: Record<string, unknown> };
    if (params.name === "nexus_submit_task") {
      const key = String(params.arguments.idempotency_key);
      let identity = acceptedByKey.get(key);
      if (!identity) {
        mutationApplications += 1;
        identity = { task_id: "task-long-1", attempt_id: "attempt-long-1" };
        acceptedByKey.set(key, identity);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: identity }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const identity = acceptedByKey.get(String(params.arguments.idempotency_key));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: identity }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const mutationArguments = { idempotency_key: "mutation-key-1", objective: "bounded long task" };
  const submitted = await forwardNexusGatewayTool(config, "nexus_submit_task", mutationArguments);
  const duplicate = await forwardNexusGatewayTool(config, "nexus_submit_task", mutationArguments);
  const recovered = await forwardNexusGatewayTool(config, "nexus_get_task", { idempotency_key: "mutation-key-1" });
  assert.deepEqual(submitted, { task_id: "task-long-1", attempt_id: "attempt-long-1" });
  assert.deepEqual(duplicate, submitted);
  assert.deepEqual(recovered, submitted);
  assert.equal(mutationApplications, 1, "existing downstream idempotency contract must apply once");

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [{ name: "write", inputSchema: { type: "object" } }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await assert.rejects(
    () => fetchNexusGatewayToolManifest(config),
    (error: unknown) => error instanceof NexusGatewayProxyError && /raw DevSpace tool write/.test(error.message),
  );

  globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as typeof fetch;
  await assert.rejects(
    () => forwardNexusGatewayTool(config, "nexus_gateway_status", {}),
    (error: unknown) => error instanceof NexusGatewayProxyError && /non-JSON HTTP 502/.test(error.message),
  );

  // ============================================================
  // B-light hybrid public surface regression coverage
  // ============================================================
  class FakeGitHubTransport implements GitHubPullRequestTransport {
    repository: RepositoryView = { default_branch: "main", full_name: "James3014/Nexus-new" };
    pr: PullRequestView = {
      number: 42,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      baseRefOid: BASE,
      headRefName: "feature/x",
      headRefOid: HEAD,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      merged: false,
      mergedAt: null,
      mergeCommitOid: null,
      title: "Fix widget",
      url: "https://github.com/James3014/Nexus-new/pull/42",
    };
    branchProtection: BranchProtectionView = { determined: true, requirements: [] };
    effectiveRules: EffectiveRulesView = { determined: true, requirements: [] };
    checkRuns: CheckRunView[] = [];
    commitStatuses: CommitStatusEvidence[] = [];
    mergeCalls: Array<{ repo: string; prNumber: number; method: MergeMethod; expectedHeadSha: string }> = [];
    mergedPr: PullRequestView = {
      ...this.pr,
      state: "MERGED",
      merged: true,
      mergedAt: "2026-08-16T12:00:00Z",
      mergeCommitOid: NEW_MAIN,
    };

    async getRepository(repo: string): Promise<RepositoryView> {
      return this.repository;
    }
    async getPullRequest(repo: string, prNumber: number): Promise<PullRequestView> {
      return this.mergeCalls.length > 0 ? this.mergedPr : this.pr;
    }
    async getBranchRef(repo: string, branch: string): Promise<BranchRefView> {
      return { sha: this.mergeCalls.length > 0 ? NEW_MAIN : BASE };
    }
    async getBranchProtection(repo: string, branch: string): Promise<BranchProtectionView> {
      return this.branchProtection;
    }
    async getEffectiveRules(repo: string, branch: string): Promise<EffectiveRulesView> {
      return this.effectiveRules;
    }
    async getCheckRuns(repo: string, headSha: string): Promise<CheckRunView[]> {
      return this.checkRuns;
    }
    async getCommitStatus(repo: string, headSha: string): Promise<CommitStatusEvidence[]> {
      return this.commitStatuses;
    }
    async mergePullRequest(
      repo: string,
      prNumber: number,
      method: MergeMethod,
      expectedHeadSha: string,
    ): Promise<MergeResultView> {
      this.mergeCalls.push({ repo, prNumber, method, expectedHeadSha });
      return { merged: true, sha: NEW_MAIN, message: null };
    }
  }

  function makeCanonicalFixture(): { base: string; dir: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), "nexus-proxy-canonical-"));
    const bare = join(base, "canonical.git");
    const work = join(base, "work");
    execSync(`git init --bare -b main ${JSON.stringify(bare)}`, { stdio: "pipe" });
    execSync(`git clone -q ${JSON.stringify(bare)} ${JSON.stringify(work)}`, { stdio: "pipe" });
    execSync(`git -C ${JSON.stringify(work)} config user.name test`, { stdio: "pipe" });
    execSync(`git -C ${JSON.stringify(work)} config user.email test@test.com`, { stdio: "pipe" });
    writeFileSync(join(work, "README.md"), "# nexus-new\n");
    execSync(`git -C ${JSON.stringify(work)} add -A`, { stdio: "pipe" });
    execSync(`git -C ${JSON.stringify(work)} commit -m init`, { stdio: "pipe" });
    execSync(`git -C ${JSON.stringify(work)} push -q origin main`, { stdio: "pipe" });
    execSync(
      `git -C ${JSON.stringify(work)} remote set-url origin https://github.com/James3014/Nexus-new.git`,
      { stdio: "pipe" },
    );
    return {
      base,
      dir: work,
      cleanup: () => rmSync(base, { recursive: true, force: true }),
    };
  }

  type RegisteredMergeTool = {
    executor?: (args: Record<string, unknown>) => Promise<{ content?: Array<{ type: string; text: string }>; isError?: boolean }>;
    inputSchema?: { def?: { shape?: Record<string, unknown> } };
  };

  async function buildPublicProxy(
    manifestToRegister: typeof manifest,
    root: string | undefined,
    transport: FakeGitHubTransport,
    directGuard?: MergeEffectGuard,
  ): Promise<{ executor: NonNullable<RegisteredMergeTool["executor"]>; registered: Record<string, RegisteredMergeTool> }> {
    const proxyConfig = {
      ...config,
      ...(root ? { nexusCanonicalSourceRoot: root } : {}),
    } as ServerConfig;
    const proxy = await createNexusGatewayProxyServer(proxyConfig, manifestToRegister, {
      gitMergeTransportFactory: () => transport,
      directMergeLaneGuardFactory: () => directGuard ?? (async () => undefined),
    });
    const registered = (proxy as unknown as { _registeredTools?: Record<string, RegisteredMergeTool> })._registeredTools ?? {};
    assert.ok(registered["git_merge_pull_request"]?.executor, "git_merge_pull_request must be registered on the proxy");
    return { executor: registered["git_merge_pull_request"].executor!, registered };
  }

  const proxyMergeArgs: (overrides?: Record<string, unknown>) => Record<string, unknown> = (overrides = {}) => ({
    prNumber: 42,
    expectedBaseSha: BASE,
    expectedHeadSha: HEAD,
    mergeMethod: "merge",
    ownerConfirmation: true,
    ...overrides,
  });

  // B. Public merge schema: task-oriented only, no workspace/path/repo/remote controls.
  {
    const schemaBoundary = createMcpTransportBoundary(
      () => createNexusGatewayProxyServer(config, manifest),
      "dual",
    );
    const schemaResponse = await schemaBoundary.fetch(new Request("http://test.local/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": MODERN_MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "schema-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }));
    const schemaPayload = JSON.parse(await schemaResponse.text());
    const mergeTool = schemaPayload.result.tools.find((tool: { name: string }) => tool.name === "git_merge_pull_request");
    assert.ok(mergeTool, "git_merge_pull_request must be advertised");
    const properties = Object.keys(mergeTool.inputSchema.properties ?? {});
    for (const requiredKey of ["prNumber", "expectedBaseSha", "expectedHeadSha", "mergeMethod", "ownerConfirmation"]) {
      assert.ok(properties.includes(requiredKey), `public schema must contain ${requiredKey}`);
    }
    for (const forbiddenKey of ["workspaceId", "cwd", "repo", "repository", "remote", "branch", "execution_lane", "executionLane", "internal", "completion"]) {
      assert.ok(!properties.includes(forbiddenKey), `public schema must NOT contain ${forbiddenKey}`);
    }
    await schemaBoundary.close();
  }

  // G. Collision gate: either local protected action becoming Gateway-owned fails closed.
  for (const protectedName of ["git_merge_pull_request", "github_complete_pull_request"]) {
    const collisionManifest = [
      ...manifest,
      { name: protectedName, inputSchema: { type: "object", properties: {} } },
    ] as typeof manifest;
    await assert.rejects(
      () => createNexusGatewayProxyServer(config, collisionManifest),
      (error: unknown) =>
        error instanceof NexusGatewayProxyError
        && error.message.includes(`collision: canonical gateway manifest now exposes ${protectedName}`)
        && /migration decision is required/.test(error.message),
    );
  }

  // Completion action is present but fails closed until both host runtime bindings are configured.
  {
    const proxy = await createNexusGatewayProxyServer(config, manifest);
    const registered = (proxy as unknown as { _registeredTools?: Record<string, RegisteredMergeTool> })._registeredTools ?? {};
    const completion = registered["github_complete_pull_request"];
    assert.ok(completion?.executor, "github_complete_pull_request must be registered on the proxy");
    const result = await completion.executor!({
      initialEvidence: {},
      standingGrantRequest: {},
      mergeMethod: "merge",
      ownerConfirmation: true,
    });
    assert.equal(result.isError, true);
    const data = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(data.code, "PUBLIC_COMPLETION_RUNTIME_UNCONFIGURED");
  }

  // C + F. Server-bound root + exact-head wiring through the existing merge core.
  {
    const fixture = makeCanonicalFixture();
    try {
      const transport = new FakeGitHubTransport();
      const { executor } = await buildPublicProxy(manifest, fixture.dir, transport);
      const result = await executor({
        ...proxyMergeArgs({ mergeMethod: "squash" }),
        // Caller-supplied workspace/path/remote controls must be structurally
        // ignored; the handler binds cwd to the configured canonical root.
        workspaceId: "ws_ignored",
        cwd: "/does/not/exist",
        repository: "evil/repo",
        remote: "evil",
        branch: "release",
      });
      assert.ok(!result.isError, `expected success receipt, got ${JSON.stringify(result)}`);
      const receipt = JSON.parse(result.content?.[0]?.text ?? "{}");
      assert.equal(receipt.merged, true);
      assert.equal(receipt.repository, "James3014/Nexus-new");
      assert.equal(receipt.remote_name, "origin");
      assert.equal(receipt.pr_number, 42);
      assert.equal(receipt.merge_method, "squash");
      assert.equal(receipt.observed_head_sha_before_merge, HEAD);
      assert.equal(receipt.merge_commit_sha, NEW_MAIN);
      assert.equal(transport.mergeCalls.length, 1, "merge API must be called exactly once");
      assert.deepEqual(transport.mergeCalls[0], {
        repo: "James3014/Nexus-new",
        prNumber: 42,
        method: "squash",
        expectedHeadSha: HEAD,
      });
    } finally {
      fixture.cleanup();
    }
  }

  // C2. The public direct action cannot reach the physical merge effect when
  // the host-selected lane guard rejects the exact PR as GOVERNED.
  {
    const fixture = makeCanonicalFixture();
    try {
      const transport = new FakeGitHubTransport();
      const { executor } = await buildPublicProxy(
        manifest,
        fixture.dir,
        transport,
        async () => {
          throw new MergePullRequestError(
            PR_MERGE_ERROR_CODES.MERGE_LANE_NOT_AUTHORIZED,
            "GOVERNED must use github_complete_pull_request",
          );
        },
      );
      const result = await executor(proxyMergeArgs());
      assert.equal(result.isError, true);
      const data = JSON.parse(result.content?.[0]?.text ?? "{}");
      assert.equal(data.code, PR_MERGE_ERROR_CODES.MERGE_LANE_NOT_AUTHORIZED);
      assert.equal(transport.mergeCalls.length, 0, "GOVERNED direct call must stop before GitHub merge effect");
    } finally {
      fixture.cleanup();
    }
  }

  // C3. The production lane adapter accepts only trusted DIRECT results and
  // rejects GOVERNED before the physical merge core. The canonical Nexus
  // validator itself is covered in Nexus-new; this fixture verifies the host
  // subprocess/result/identity boundary without duplicating its policy.
  {
    const root = mkdtempSync(join(tmpdir(), "nexus-public-lane-guard-"));
    try {
      const ops = join(root, "scripts", "ops");
      mkdirSync(ops, { recursive: true });
      writeFileSync(
        join(ops, "trusted_merge_lane_gate.py"),
        [
          "import json, sys",
          "p = sys.argv[sys.argv.index('--event-json') + 1]",
          "event = json.load(open(p, encoding='utf-8'))",
          "pr = event['pull_request']",
          "lane = 'GOVERNED' if 'GOVERNED' in pr.get('body', '') else 'DIRECT_CANONICAL'",
          "print(json.dumps({'schema':'nexus.trusted_merge_lane_gate_result.v1','status':'PASS','pull_request_number':pr['number'],'head_sha':pr['head']['sha'],'execution_lane':lane}))",
        ].join("\n"),
        "utf8",
      );

      const guard = createPublicDirectMergeLaneGuard({
        ...config,
        nexusCanonicalSourceRoot: root,
        nexusPythonBin: "python3",
      } as ServerConfig);
      const baseContext = {
        gitRoot: root,
        repository: "James3014/Nexus-new",
        defaultBranch: "main",
        expectedBaseSha: BASE,
        expectedHeadSha: HEAD,
      };
      await guard({
        ...baseContext,
        pullRequest: {
          number: 1128,
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          baseRefOid: BASE,
          headRefName: "direct/test",
          headRefOid: HEAD,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          merged: false,
          mergedAt: null,
          mergeCommitOid: null,
          title: "direct",
          url: "https://github.com/James3014/Nexus-new/pull/1128",
          body: "DIRECT",
        },
      });
      await assert.rejects(
        guard({
          ...baseContext,
          pullRequest: {
            number: 1129,
            state: "OPEN",
            isDraft: false,
            baseRefName: "main",
            baseRefOid: BASE,
            headRefName: "governed/test",
            headRefOid: HEAD,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            merged: false,
            mergedAt: null,
            mergeCommitOid: null,
            title: "governed",
            url: "https://github.com/James3014/Nexus-new/pull/1129",
            body: "GOVERNED",
          },
        }),
        (error: unknown) =>
          error instanceof MergePullRequestError
          && error.code === PR_MERGE_ERROR_CODES.MERGE_LANE_NOT_AUTHORIZED,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // D. Public trusted target: origin -> James3014/Nexus-new succeeds; wrong or missing remote fails closed.
  {
    const fixture = makeCanonicalFixture();
    try {
      const transport = new FakeGitHubTransport();
      const { executor } = await buildPublicProxy(manifest, fixture.dir, transport);
      const result = await executor(proxyMergeArgs());
      assert.ok(!result.isError, `expected success via server-side origin target, got ${JSON.stringify(result)}`);
      assert.equal(transport.mergeCalls.length, 1);
      assert.equal(transport.mergeCalls[0].repo, "James3014/Nexus-new");
    } finally {
      fixture.cleanup();
    }
  }
  {
    const fixture = makeCanonicalFixture();
    try {
      execSync(
        `git -C ${JSON.stringify(fixture.dir)} remote set-url origin git@github.com:evil/widget.git`,
        { stdio: "pipe" },
      );
      const transport = new FakeGitHubTransport();
      const { executor } = await buildPublicProxy(manifest, fixture.dir, transport);
      const result = await executor(proxyMergeArgs());
      assert.ok(result.isError, "wrong origin remote must fail closed");
      const data = JSON.parse(result.content?.[0]?.text ?? "{}");
      assert.equal(data.code, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED);
      assert.equal(transport.mergeCalls.length, 0);
    } finally {
      fixture.cleanup();
    }
  }
  {
    const fixture = makeCanonicalFixture();
    try {
      execSync(`git -C ${JSON.stringify(fixture.dir)} remote remove origin`, { stdio: "pipe" });
      const transport = new FakeGitHubTransport();
      const { executor } = await buildPublicProxy(manifest, fixture.dir, transport);
      const result = await executor(proxyMergeArgs());
      assert.ok(result.isError, "missing origin remote must fail closed");
      const data = JSON.parse(result.content?.[0]?.text ?? "{}");
      assert.equal(data.code, PR_MERGE_ERROR_CODES.INTEGRATION_TARGET_UNRESOLVED);
      assert.equal(transport.mergeCalls.length, 0);
    } finally {
      fixture.cleanup();
    }
  }

  // E. ownerConfirmation=false is rejected before any GitHub mutation.
  {
    const fixture = makeCanonicalFixture();
    try {
      const transport = new FakeGitHubTransport();
      const { executor } = await buildPublicProxy(manifest, fixture.dir, transport);
      const result = await executor(proxyMergeArgs({ ownerConfirmation: false }));
      assert.ok(result.isError, "ownerConfirmation false must error");
      const data = JSON.parse(result.content?.[0]?.text ?? "{}");
      assert.equal(data.code, PR_MERGE_ERROR_CODES.OWNER_CONFIRMATION_REQUIRED);
      assert.equal(transport.mergeCalls.length, 0, "no merge call without owner confirmation");
    } finally {
      fixture.cleanup();
    }
  }

  // Server-bound root missing: the public action fails closed, not silently no-op.
  {
    const transport = new FakeGitHubTransport();
    const { executor } = await buildPublicProxy(manifest, undefined, transport);
    const result = await executor(proxyMergeArgs());
    assert.ok(result.isError, "missing canonical source root must fail closed");
    const data = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(data.code, "PUBLIC_MERGE_ROOT_UNCONFIGURED");
    assert.equal(transport.mergeCalls.length, 0);
  }

  // Proxy trusted resolver binds origin -> James3014/Nexus-new (server-side).
  {
    const resolver = createPublicNexusIntegrationTargetResolver();
    const fixture = makeCanonicalFixture();
    try {
      const target = await resolver.resolve(fixture.dir);
      assert.equal(target.remoteName, "origin");
      assert.equal(target.repository, "James3014/Nexus-new");
      assert.equal(target.defaultBranch, "main");
    } finally {
      fixture.cleanup();
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
