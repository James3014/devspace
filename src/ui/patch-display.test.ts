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

assert.deepEqual(parseReviewPatchFiles(undefined), { files: [], ok: true });
assert.deepEqual(parseReviewPatchFiles("   \n  "), { files: [], ok: true });
assert.deepEqual(parseReviewPatchFiles("garbage that is not a patch"), { files: [], ok: true });

const crlfReviewPatch = reviewPatch.replace(/\n/g, "\r\n");
assert.equal(parseReviewPatchFiles(crlfReviewPatch).ok, true);
assert.equal(parseReviewPatchFiles(crlfReviewPatch).files.length, 1);
