import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ChatSwarmError } from "./chat-swarm-contract.js";
import { registerChatSwarmRuntimeTools } from "./chat-swarm-runtime-tools.js";

const statusTools = [
  "chat_swarm_runtime_status",
  "chat_swarm_runtime_ensure",
  "chat_swarm_runtime_scale",
  "chat_swarm_runtime_recover",
  "chat_swarm_runtime_stop",
] as const;
const runtimeTools = [
  ["chat_swarm_runtime_status", { swarmId: "swarm-1" }],
  ["chat_swarm_runtime_ensure", { swarmId: "swarm-1" }],
  ["chat_swarm_runtime_scale", { swarmId: "swarm-1", desiredWorkers: 1 }],
  ["chat_swarm_runtime_recover", { swarmId: "swarm-1", workerId: "worker-1" }],
  ["chat_swarm_runtime_stop", { swarmId: "swarm-1", workerId: "worker-1" }],
  ["chat_swarm_runtime_bootstrap", { operationId: "operation-1" }],
] as const;

test("runtime tool errors use MCP metadata without violating success output schemas", async () => {
  const server = new McpServer({ name: "runtime-tools-output-schema", version: "1" });
  const expectedError = new ChatSwarmError("INVALID_STATE", "runtime is unavailable", {
    layer: "coordinator",
    stage: "admission_denied",
  });
  assert.equal(
    registerChatSwarmRuntimeTools(
      server,
      () => { throw new Error("manager factory must not run after admission denial"); },
      { chatSwarmMaxWorkers: 5 },
      () => { throw expectedError; },
    ),
    runtimeTools.length,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "runtime-tools-output-schema-client", version: "1" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const listed = await client.listTools();
    const listedTools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const registered = (server as any)._registeredTools as Record<string, { outputSchema: { safeParse: (value: unknown) => { success: boolean } } }>;

    const statusOutputSchemas = statusTools.map((name) => listedTools.get(name)?.outputSchema);
    assert.ok(statusOutputSchemas.every(Boolean));
    for (const schema of statusOutputSchemas.slice(1)) assert.deepEqual(schema, statusOutputSchemas[0]);
    assert.deepEqual((statusOutputSchemas[0] as any).required, [
      "swarmId", "state", "enabled", "desiredDefault", "maxWorkers", "adapter", "slots",
    ]);
    assert.deepEqual((listedTools.get("chat_swarm_runtime_bootstrap")?.outputSchema as any).required, ["slot", "worker"]);

    const validStatus = {
      swarmId: "swarm-1",
      state: "READY",
      enabled: true,
      desiredDefault: 1,
      maxWorkers: 5,
      adapter: {
        kind: "mac_web_chatgpt",
        controlMechanism: "CDP",
        projectConfigured: true,
        appBinding: "READY",
      },
      slots: [],
    };
    assert.equal(registered.chat_swarm_runtime_status.outputSchema.safeParse(validStatus).success, true);
    assert.equal(registered.chat_swarm_runtime_status.outputSchema.safeParse({ ...validStatus, slots: "invalid" }).success, false);

    for (const [name, arguments_] of runtimeTools) {
      const listedTool = listedTools.get(name);
      assert.ok(listedTool?.outputSchema, `${name} must advertise its original success output schema`);

      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, true, `${name} must remain a tool error`);
      assert.equal("structuredContent" in result, false, `${name} must not send schema-incompatible structured content`);

      const details = {
        code: expectedError.code,
        layer: expectedError.layer,
        stage: expectedError.stage,
        operation: name.replace("chat_swarm_", ""),
        message: expectedError.message,
      };
      const protocolResult = CallToolResultSchema.parse(result);
      assert.deepEqual(protocolResult._meta?.["devspace/error"], details);
      assert.deepEqual((result._meta as any)?.["devspace/error"], details);
      assert.equal((result.content as Array<{ type: string; text?: string }>)[0]?.text, `[${details.code}] ${details.message}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
