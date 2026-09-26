import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { grepFilesTool, listDirectoryTool } from "./pi-tools.js";

function text(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");
}

test("native discovery propagates cancellation with an attributable error and no mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-pi-cancel-"));
  try {
    await writeFile(join(root, "fixture.txt"), "alpha|beta\n");
    const controller = new AbortController();
    controller.abort(new Error("fixture cancellation"));
    const response = await listDirectoryTool(
      { path: "." },
      { cwd: root, root, signal: controller.signal },
    );
    assert.equal(response.isError, true);
    assert.match(text(response), /DISCOVERY_CANCELLED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native discovery classifies an already-expired AbortSignal as a timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-pi-timeout-"));
  try {
    await writeFile(join(root, "fixture.txt"), "alpha|beta\n");
    const signal = AbortSignal.timeout(1);
    await delay(5);
    const response = await grepFilesTool(
      { pattern: "alpha|beta", path: ".", limit: 20 },
      { cwd: root, root, signal },
    );
    assert.equal(response.isError, true);
    assert.match(text(response), /DISCOVERY_TIMEOUT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
