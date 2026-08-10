import assert from "node:assert/strict";
import {
  getFileChangePathDisplay,
  getPatchDisplayParts,
  getRenderedFileChangeKind,
  getRenderedFileChangePathDisplay,
  parseReviewPatchFiles,
} from "./patch-display.js";

assert.deepEqual(getPatchDisplayParts({}), {
  title: "Applied patch",
  tone: "edit",
});

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "created.ts", operation: "add" }] }),
  {
    title: "Added 1 file",
    iconKind: "added",
    tone: "write",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "a.ts", operation: "add" },
      { path: "b.ts", operation: "add" },
    ],
  }),
  {
    title: "Added 2 files",
    iconKind: "added",
    tone: "write",
  },
);

assert.deepEqual(
  getFileChangePathDisplay({
    path: "src/new-name.ts",
    previousPath: "src/old-name.ts",
  }),
  {
    current: "new-name.ts",
    previous: "old-name.ts",
    title: "src/old-name.ts → src/new-name.ts",
  },
);

assert.deepEqual(
  getFileChangePathDisplay({
    path: "packages/new/file.ts",
    previousPath: "src/old/file.ts",
  }),
  {
    current: "packages/new/file.ts",
    previous: "src/old/file.ts",
    title: "src/old/file.ts → packages/new/file.ts",
  },
);

assert.deepEqual(
  getRenderedFileChangePathDisplay(
    [{ path: "src/new-name.ts", previousPath: "src/old-name.ts", operation: "move" }],
    { path: "src/new-name.ts" },
    0,
  ),
  {
    current: "new-name.ts",
    previous: "old-name.ts",
    title: "src/old-name.ts → src/new-name.ts",
  },
);

assert.deepEqual(
  getRenderedFileChangePathDisplay(
    [
      { path: "shared.ts", previousPath: "first.ts", operation: "move" },
      { path: "shared.ts", previousPath: "second.ts", operation: "move" },
    ],
    { path: "shared.ts" },
    1,
  ),
  {
    current: "shared.ts",
    previous: "second.ts",
    title: "second.ts → shared.ts",
  },
);

assert.equal(
  getRenderedFileChangeKind(
    [
      { path: "same.tmp", operation: "add" },
      { path: "same.tmp", operation: "delete" },
    ],
    { path: "same.tmp", type: "new" },
    0,
  ),
  "added",
);

assert.equal(
  getRenderedFileChangeKind(
    [
      { path: "same.tmp", operation: "add" },
      { path: "same.tmp", operation: "delete" },
    ],
    { path: "same.tmp", type: "deleted" },
    1,
  ),
  "deleted",
);

assert.equal(
  getRenderedFileChangeKind(
    [{ path: "report.md", operation: "add" }],
    { path: "report.md", type: "change" },
    0,
  ),
  "edited",
);

assert.equal(
  getRenderedFileChangeKind(
    [{ path: "renamed.md", previousPath: "old.md", operation: "move" }],
    { path: "renamed.md", type: "change" },
    0,
  ),
  "renamed",
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "created.ts", type: "new" }] }),
  {
    title: "Added 1 file",
    iconKind: "added",
    tone: "write",
  },
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "renamed.ts", type: "rename-changed" }] }),
  {
    title: "Renamed and edited 1 file",
    iconKind: "renamed-edited",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "removed.ts", type: "deleted" }] }),
  {
    title: "Deleted 1 file",
    iconKind: "deleted",
    tone: "delete",
  },
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "unknown.ts" }] }),
  {
    title: "Changed 1 file",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "created.ts", operation: "add" },
      { path: "edited.ts", operation: "update" },
    ],
  }),
  {
    title: "Changed 2 files",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "same.ts", operation: "add" },
      { path: "same.ts", operation: "update" },
    ],
  }),
  {
    title: "Changed 1 file",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "edited.ts", operation: "update" },
      { path: "moved.ts", previousPath: "old.ts", operation: "move" },
      { path: "removed.ts", operation: "delete" },
    ],
  }),
  {
    title: "Changed 3 files",
    tone: "edit",
  },
);

const reviewPatch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
`;

const parsedReview = parseReviewPatchFiles(reviewPatch);
assert.equal(parsedReview.ok, true);
assert.equal(parsedReview.files.length, 1);
assert.equal(parsedReview.files[0]?.name, "src/a.ts");
assert.equal(parsedReview.files[0]?.hunks.length, 1);
assert.equal(parsedReview.files[0]?.hunks[0]?.additionLines, 1);
assert.equal(parsedReview.files[0]?.hunks[0]?.deletionLines, 1);

assert.deepEqual(parseReviewPatchFiles(undefined), { files: [], binaryFiles: new Set(), ok: true });
{
  const whitespaceOnly = parseReviewPatchFiles("   \n  ");
  assert.deepEqual(whitespaceOnly.files, []);
  assert.equal(whitespaceOnly.ok, true);
}
assert.equal(parseReviewPatchFiles("garbage that is not a patch").ok, true);

const crlfReviewPatch = reviewPatch.replace(/\n/g, "\r\n");
assert.equal(parseReviewPatchFiles(crlfReviewPatch).ok, true);
assert.equal(parseReviewPatchFiles(crlfReviewPatch).files.length, 1);

const binaryPatch = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
{
  const parsed = parseReviewPatchFiles(binaryPatch);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.hunks.length, 0);
  assert.deepEqual([...parsed.binaryFiles], ["logo.png"]);
}

const renamePatch = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;
{
  const parsed = parseReviewPatchFiles(renamePatch);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files[0]?.type, "rename-pure");
  assert.deepEqual([...parsed.binaryFiles], []);
}

const modePatch = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;
{
  const parsed = parseReviewPatchFiles(modePatch);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files[0]?.hunks.length, 0);
  assert.equal(parsed.files[0]?.prevMode, "100644");
  assert.equal(parsed.files[0]?.mode, "100755");
  assert.deepEqual([...parsed.binaryFiles], []);
}

const trailingSpacePatch = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
+new 
`;
{
  const parsed = parseReviewPatchFiles(trailingSpacePatch);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files[0]?.additionLines[0], "new ");
}

const binarySpacePathPatch = `diff --git a/logo mark.png b/logo mark.png
index 1111111..2222222 100644
Binary files a/logo mark.png and b/logo mark.png differ
`;
{
  const parsed = parseReviewPatchFiles(binarySpacePathPatch);
  assert.equal(parsed.ok, true);
  assert.deepEqual([...parsed.binaryFiles], ["logo mark.png"]);
}

const quotedBinaryPatch = `diff --git a/"logo mark.png" b/"logo mark.png"
index 1111111..2222222 100644
Binary files a/"logo mark.png" and b/"logo mark.png" differ
`;
{
  const parsed = parseReviewPatchFiles(quotedBinaryPatch);
  assert.equal(parsed.ok, true);
  assert.deepEqual([...parsed.binaryFiles], ["logo mark.png"]);
}
