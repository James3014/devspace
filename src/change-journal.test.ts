import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceSessions } from "./db/schema.js";
import {
  createChangeJournalManager,
  MAX_JOURNAL_DIFF_BYTES,
  type ChangeJournalManager,
} from "./change-journal.js";

interface JournalFixture {
  root: string;
  stateDir: string;
  database: DatabaseHandle;
  journal: ChangeJournalManager;
  project: string;
}

async function fixture(t: TestContext): Promise<JournalFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-journal-test-"));
  const project = join(root, "project");
  const stateDir = join(root, "state");
  await mkdir(project, { recursive: true });
  const database = openDatabase(stateDir);
  const journal = createChangeJournalManager(database.db);
  await database.db.insert(workspaceSessions).values({
    id: "w1",
    root: project,
    status: "active",
    mode: "checkout",
    managed: "false",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, stateDir, database, journal, project };
}

async function write(project: string, path: string, content: string): Promise<void> {
  await writeFile(join(project, path), content);
}

test("creates a net diff across multiple touches of one file", async (t) => {
  const { journal, project } = await fixture(t);

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });
  await write(project, "notes.txt", "alpha\n");
  await write(project, "notes.txt", "alpha\nbeta\n");

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });

  assert.equal(review.result, "Changed 1 file (+2 -0).");
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]?.type, "new");
  assert.equal(review.files[0]?.additions, 2);
  assert.match(review.patch, /a\/notes.txt/);
});

test("the first touch captures the original, later edits diff against it", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "notes.txt", "alpha\n");

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });
  await write(project, "notes.txt", "alpha\nbeta\n");
  await write(project, "notes.txt", "alpha\nbeta\ngamma\n");

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });

  assert.equal(review.files[0]?.type, "change");
  assert.equal(review.summary.additions, 2);
  assert.doesNotMatch(review.patch, /\/dev\/null/);
  assert.match(review.patch, /\+beta/);
});

test("edits that revert to the original produce no changes and drop the row", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "notes.txt", "alpha\n");

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });
  await write(project, "notes.txt", "alpha\nbeta\n");

  assert.equal(
    (await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false })).files.length,
    1,
  );

  await write(project, "notes.txt", "alpha\n");
  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: true });

  assert.equal(review.result, "No changes since last shown changes.");
  assert.equal(review.files.length, 0);

  const again = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: true });
  assert.equal(again.files.length, 0);
});

test("a new file created then deleted is net zero", async (t) => {
  const { journal, project } = await fixture(t);

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "scratch.txt" });
  await write(project, "scratch.txt", "content\n");
  await rm(join(project, "scratch.txt"));

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: true });
  assert.equal(review.result, "No changes since last shown changes.");
  assert.equal(review.files.length, 0);
});

test("an existing file deleted after a touch reports a deletion", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "notes.txt", "alpha\n");

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });
  await write(project, "notes.txt", "alpha\nbeta\n");
  await rm(join(project, "notes.txt"));

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(review.files[0]?.type, "deleted");
  assert.equal(review.summary.removals, 1);
});

test("moves report the previous path and re-baseline clears it", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "old.txt", "alpha\nbeta\n");

  await journal.recordTouch({
    workspaceId: "w1",
    root: project,
    path: "new.txt",
    previousPath: "old.txt",
  });
  await write(project, "new.txt", "alpha\nbeta\n");
  await rm(join(project, "old.txt"));

  const first = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: true });
  assert.equal(first.files[0]?.type, "rename-pure");
  assert.equal(first.files[0]?.previousPath, "old.txt");
  assert.equal(first.summary.additions, 0);

  await write(project, "new.txt", "alpha\nbeta\ngamma\n");
  const second = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(second.files[0]?.type, "change");
  assert.equal(second.files[0]?.previousPath, undefined);
  assert.equal(second.summary.additions, 1);
});

test("binary filenames appear in the review without a text patch", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "logo.png", "PNG\x00\x01\x02");

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "logo.png" });
  await write(project, "logo.png", "PNG\x00\x03\x04");

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]?.path, "logo.png");
  assert.equal(review.patch, "");
});

test("content above the diff size cap degrades to a file list", async (t) => {
  const { journal, project } = await fixture(t);
  const big = "x".repeat(MAX_JOURNAL_DIFF_BYTES);

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "big.txt" });
  await write(project, "big.txt", `${big}\n`);

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(review.files.length, 1);
  assert.equal(review.patch, "");
  assert.equal(review.summary.additions, 0);
});

test("first-touch wins when the same path is touched repeatedly", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "notes.txt", "first\n");

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });
  await write(project, "notes.txt", "second\n");
  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.match(review.patch, /-first/);
});

test("the journal survives a database restart", async (t) => {
  const { database, stateDir, journal, project } = await fixture(t);

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "notes.txt" });
  await write(project, "notes.txt", "alpha\n");

  database.close();
  const reopened = openDatabase(stateDir);
  const restarted = createChangeJournalManager(reopened.db);
  t.after(() => reopened.close());

  const review = await restarted.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]?.type, "new");
});

test("a touched binary file deleted before review reports a deletion", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "logo.png", "PNG\x00\x01\x02");

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "logo.png" });
  await rm(join(project, "logo.png"));

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: true });
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]?.path, "logo.png");
  assert.equal(review.files[0]?.type, "deleted");

  const again = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(again.files.length, 0);
});

test("symlinks cannot smuggle content from outside the workspace into a review", async (t) => {
  const { root, journal, project } = await fixture(t);
  const outsideDir = join(root, "outside");
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, "secret.txt"), "external secrets\n");

  await symlink(join(outsideDir, "secret.txt"), join(project, "link.txt"));
  await assert.rejects(
    journal.recordTouch({ workspaceId: "w1", root: project, path: "link.txt" }),
    /outside workspace root/,
  );

  await write(project, "plain.txt", "alpha\n");
  await journal.recordTouch({ workspaceId: "w1", root: project, path: "plain.txt" });
  await rm(join(project, "plain.txt"));
  await symlink(join(outsideDir, "secret.txt"), join(project, "plain.txt"));
  await assert.rejects(
    journal.reviewChanges({ workspaceId: "w1", root: project }),
    /outside workspace root/,
  );
});

test("a symlink to a file inside the workspace is reviewable", async (t) => {
  const { journal, project } = await fixture(t);
  await write(project, "real.txt", "alpha\n");
  await symlink(join(project, "real.txt"), join(project, "alias.txt"));

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "alias.txt" });
  await write(project, "real.txt", "alpha\nbeta\n");
  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(review.files.length, 1);
  assert.equal(review.files[0]?.path, "alias.txt");
  assert.equal(review.summary.additions, 1);
});

test("the diff cap counts bytes, not UTF-16 code units", async (t) => {
  const { journal, project } = await fixture(t);
  const chunk = "é".repeat(Math.ceil(MAX_JOURNAL_DIFF_BYTES / 2));

  await journal.recordTouch({ workspaceId: "w1", root: project, path: "uni.txt" });
  await write(project, "uni.txt", `${chunk}\n`);

  const review = await journal.reviewChanges({ workspaceId: "w1", root: project, markReviewed: false });
  assert.equal(review.files.length, 1);
  assert.equal(review.patch, "");
  assert.equal(review.summary.additions, 0);
});

test("path containment is enforced", async (t) => {
  const { journal, project } = await fixture(t);

  await assert.rejects(
    journal.recordTouch({ workspaceId: "w1", root: project, path: "../escape.txt" }),
    /outside workspace root/,
  );
});