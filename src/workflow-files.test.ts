import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflowArgFlags,
  persistWorkflowScript,
  readProjectWorkflowScriptFile,
  resolveNamedWorkflowScript,
  resolveWorkflowScriptFromPathOrName,
  WorkflowPathError,
} from "./workflow-files.js";
import { hashSource } from "./workflow-script.js";

{
  const { args, rest } = parseWorkflowArgFlags([
    "--arg",
    "n=1",
    "--arg",
    'files=["a.ts"]',
    "--follow",
    "extra",
  ]);
  assert.deepEqual(args, { n: 1, files: ["a.ts"] });
  assert.deepEqual(rest, ["--follow", "extra"]);
}

{
  const dir = await mkdtemp(join(tmpdir(), "wf-files-"));
  const path = await persistWorkflowScript({
    stateDir: dir,
    runId: "wfr_test",
    source: "export const meta = { name: 'x', description: 'd' }\nreturn 1\n",
    preferredName: "demo",
  });
  assert.match(path.replaceAll("\\", "/"), /workflow-scripts\/wfr_test\/demo\.js$/);

  const file = await resolveWorkflowScriptFromPathOrName({
    file: path,
    workspaceRoot: dir,
  });
  assert.equal(file.origin, "file");
  assert.equal(file.scriptHash, hashSource(file.source));

  await mkdir(join(dir, ".devspace", "workflows"), { recursive: true });
  await writeFile(
    join(dir, ".devspace", "workflows", "named.js"),
    "export const meta = { name: 'named', description: 'd' }\nreturn 2\n",
  );
  const named = await resolveNamedWorkflowScript({
    name: "named",
    workspaceRoot: dir,
  });
  assert.equal(named.origin, "named");
  assert.match(named.source, /named/);
  assert.equal(
    (
      await readProjectWorkflowScriptFile({
        scriptPath: join(dir, ".devspace", "workflows", "named.js"),
        workspaceRoot: dir,
      })
    ).nameHint,
    "named",
  );
  await assert.rejects(
    () =>
      readProjectWorkflowScriptFile({
        scriptPath: path,
        workspaceRoot: dir,
      }),
    /must be inside/,
  );

  if (process.platform !== "win32") {
    const outside = await mkdtemp(join(tmpdir(), "wf-files-outside-"));
    try {
      const outsideScript = join(outside, "escape.js");
      await writeFile(
        outsideScript,
        "export const meta = { name: 'escape', description: 'd' }\nreturn 4\n",
      );
      await symlink(
        outsideScript,
        join(dir, ".devspace", "workflows", "escape.js"),
      );
      await assert.rejects(
        () =>
          readProjectWorkflowScriptFile({
            scriptPath: "escape.js",
            workspaceRoot: dir,
          }),
        /resolves outside/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }

  await mkdir(join(dir, "workflows"), { recursive: true });
  await writeFile(
    join(dir, "workflows", "legacy.js"),
    "export const meta = { name: 'legacy', description: 'd' }\nreturn 3\n",
  );
  await assert.rejects(
    () => resolveNamedWorkflowScript({ name: "legacy", workspaceRoot: dir }),
    WorkflowPathError,
  );

  await assert.rejects(
    () => resolveNamedWorkflowScript({ name: "missing", workspaceRoot: dir }),
    WorkflowPathError,
  );

  await rm(dir, { recursive: true, force: true });
}

console.log("workflow-files.test.ts: ok");
