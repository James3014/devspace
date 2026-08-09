import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { ToolResultCard } from "./card-types.js";

export interface ReviewPatchParse {
  files: FileDiffMetadata[];
  binaryFiles: Set<string>;
  ok: boolean;
}

export type FileChangeKind =
  | "added"
  | "edited"
  | "deleted"
  | "renamed"
  | "renamed-edited"
  | "unknown";

type ToolResultFile = NonNullable<ToolResultCard["files"]>[number];

export interface PatchDisplayParts {
  title: string;
  iconKind?: FileChangeKind;
  tone: "edit" | "write" | "delete";
}

export interface FileChangePathDisplay {
  current: string;
  previous?: string;
  title: string;
}

const fileChangeLabels: Record<Exclude<FileChangeKind, "unknown">, string> = {
  added: "Added",
  edited: "Edited",
  deleted: "Deleted",
  renamed: "Renamed",
  "renamed-edited": "Renamed and edited",
};

export function getPatchDisplayParts(
  card: Pick<ToolResultCard, "files">,
  options: { emptyTitle?: string } = {},
): PatchDisplayParts {
  const files = card.files ?? [];
  const fileCount = countChangedFiles(files);

  if (fileCount === 0) {
    return { title: options.emptyTitle ?? "Applied patch", tone: "edit" };
  }

  const kinds = new Set(files.map(getFileChangeKind));
  const singleKind = kinds.size === 1 ? [...kinds][0] : undefined;
  const display: PatchDisplayParts = {
    title: changeTitle(singleKind, fileCount),
    tone: changeTone(singleKind),
  };

  if (singleKind && singleKind !== "unknown") display.iconKind = singleKind;
  return display;
}

export function getFileChangeKind(file: ToolResultFile): FileChangeKind {
  switch (file.operation) {
    case "add":
      return "added";
    case "update":
      return "edited";
    case "delete":
      return "deleted";
    case "move":
      return "renamed";
  }

  switch (file.type) {
    case "new":
      return "added";
    case "change":
      return "edited";
    case "deleted":
      return "deleted";
    case "rename-pure":
      return "renamed";
    case "rename-changed":
      return "renamed-edited";
    default:
      return "unknown";
  }
}

export function getRenderedFileChangeKind(
  files: NonNullable<ToolResultCard["files"]>,
  parsedFile: Pick<ToolResultFile, "path" | "previousPath" | "type">,
  index: number,
): FileChangeKind {
  const parsedKind = getFileChangeKind(parsedFile);

  // The diff parser is authoritative for additions, deletions, and native Git
  // rename metadata. This also keeps repeated operations on the same path from
  // reusing the first matching card entry.
  if (parsedKind !== "edited" && parsedKind !== "unknown") return parsedKind;

  // apply_patch emits one card file per generated diff in the same order. Its
  // move patch currently lacks Git rename metadata, so preserve the explicit
  // move operation when the destination lines up with the parsed diff.
  const indexedFile = files[index];
  if (
    indexedFile?.operation === "move" &&
    (!parsedFile.path || indexedFile.path === parsedFile.path)
  ) {
    return "renamed";
  }

  const movedFile = files.find((file) => (
    file.operation === "move" &&
    file.path === parsedFile.path &&
    (!parsedFile.previousPath || file.previousPath === parsedFile.previousPath)
  ));
  if (movedFile) return "renamed";

  // A parsed content change is more accurate than an "add" directive that
  // overwrote an existing file.
  if (parsedKind === "edited") return "edited";

  return indexedFile ? getFileChangeKind(indexedFile) : "unknown";
}

export function getFileChangePathDisplay(
  file: Pick<ToolResultFile, "path" | "previousPath">,
): FileChangePathDisplay | undefined {
  const current = file.path ?? file.previousPath;
  if (!current) return undefined;

  const previous = file.previousPath;
  if (!previous || previous === current) {
    return { current, title: current };
  }

  const sameDirectory = pathDirectory(previous) === pathDirectory(current);
  return {
    current: sameDirectory ? pathBasename(current) : current,
    previous: sameDirectory ? pathBasename(previous) : previous,
    title: `${previous} → ${current}`,
  };
}

export function getRenderedFileChangePathDisplay(
  files: NonNullable<ToolResultCard["files"]>,
  parsedFile: Pick<ToolResultFile, "path" | "previousPath">,
  index: number,
): FileChangePathDisplay | undefined {
  const indexedFile = files[index];
  const matchedFile = indexedFile?.path === parsedFile.path
    ? indexedFile
    : files.find((file) => (
      file.path === parsedFile.path &&
      (!parsedFile.previousPath || !file.previousPath || file.previousPath === parsedFile.previousPath)
    ));
  const cardFile = matchedFile ?? indexedFile;

  return getFileChangePathDisplay({
    path: parsedFile.path ?? cardFile?.path,
    previousPath: parsedFile.previousPath ?? cardFile?.previousPath,
  });
}

export function fileChangeKindLabel(kind: FileChangeKind): string {
  return kind === "unknown" ? "Changed" : fileChangeLabels[kind];
}

/**
 * Parse a review patch without ever throwing, so a malformed or unexpected
 * patch cannot take down the whole card render. A parse failure surfaces as
 * `ok: false` so the caller can fall back to a file-summary-only card.
 *
 * Diffs without hunks are normal for renames, mode changes, and binary
 * files. Binary files are detected from their explicit git markers
 * ("Binary files ... differ" or "GIT binary patch") so hunkless renames and
 * mode changes are not mistaken for binary content.
 */
export function parseReviewPatchFiles(patch: string | undefined): ReviewPatchParse {
  if (!patch) return { files: [], binaryFiles: new Set(), ok: true };
  const normalized = patch.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  if (/^\s*$/.test(normalized)) return { files: [], binaryFiles: new Set(), ok: true };

  try {
    const files = parsePatchFiles(normalized, "review", true).flatMap(
      (parsedPatch) => parsedPatch.files,
    );
    const binaryFiles = new Set<string>();
    for (const section of patch.split(/^diff --git /m)) {
      if (!section || !/Binary files|GIT binary patch/.test(section)) continue;
      const firstLine = section.split("\n")[0] ?? "";
      const binaryPath = firstLine.match(/ b\/(.+?)\s*$/)?.[1]?.replace(/^"|"$/g, "")
        ?? firstLine.split(" ")[1]?.slice(2);
      if (binaryPath) binaryFiles.add(binaryPath);
    }
    return { files, binaryFiles, ok: true };
  } catch {
    return { files: [], binaryFiles: new Set(), ok: false };
  }
}

function countChangedFiles(files: NonNullable<ToolResultCard["files"]>): number {
  const paths = new Set<string>();
  let unnamedFiles = 0;

  for (const file of files) {
    const path = file.path ?? file.previousPath;
    if (path) {
      paths.add(path);
    } else {
      unnamedFiles += 1;
    }
  }

  return paths.size + unnamedFiles;
}

function changeTitle(kind: FileChangeKind | undefined, fileCount: number): string {
  if (kind && kind !== "unknown") {
    return `${fileChangeLabels[kind]} ${fileCount} ${fileNoun(fileCount)}`;
  }

  return `Changed ${fileCount} ${fileNoun(fileCount)}`;
}

function changeTone(kind: FileChangeKind | undefined): PatchDisplayParts["tone"] {
  if (kind === "added") return "write";
  if (kind === "deleted") return "delete";
  return "edit";
}

function fileNoun(fileCount: number): "file" | "files" {
  return fileCount === 1 ? "file" : "files";
}

function pathDirectory(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
}

function pathBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}
