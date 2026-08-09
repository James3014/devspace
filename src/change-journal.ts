import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { unifiedFilePatch } from "./apply-patch.js";
import type { AppDatabase } from "./db/client.js";
import { changeJournal } from "./db/schema.js";
import { isPathInsideRoot } from "./roots.js";
import type { ReviewChangesResult, ReviewFile, ReviewSummary } from "./review-checkpoints.js";

export const MAX_JOURNAL_DIFF_BYTES = 512 * 1024;

export interface JournalTouchInput {
  workspaceId: string;
  root: string;
  path: string;
  previousPath?: string;
}

export interface JournalReviewInput {
  workspaceId: string;
  root: string;
  markReviewed?: boolean;
}

export interface ChangeJournalManager {
  recordTouch(input: JournalTouchInput): Promise<void>;
  reviewChanges(input: JournalReviewInput): Promise<ReviewChangesResult>;
}

interface JournalRow {
  path: string;
  previousPath?: string;
  originalContent: string | null;
  originalBinary: boolean;
  isNew: boolean;
  touchedAt: string;
}

interface JournalEntry {
  row: JournalRow;
  currentContent: string | null;
  currentBinary: boolean;
}

type NewJournalRow = {
  workspaceSessionId: string;
  path: string;
  previousPath?: string;
  originalContent: string | null;
  originalBinary: 0 | 1;
  isNew: 0 | 1;
  touchedAt: string;
};

export function createChangeJournalManager(database: AppDatabase): ChangeJournalManager {
  return {
    async recordTouch({ workspaceId, root, path, previousPath }) {
      assertJournalPath(root, path);
      if (previousPath) assertJournalPath(root, previousPath);

      const exists = await database
        .select({ path: changeJournal.path })
        .from(changeJournal)
        .where(and(
          eq(changeJournal.workspaceSessionId, workspaceId),
          eq(changeJournal.path, path),
        ))
        .limit(1);
      if (exists.length > 0) return;

      const original = previousPath
        ? await readFileIfPresent(join(root, previousPath))
        : await readFileIfPresent(join(root, path));
      const binary = original !== null && isBinary(original);
      const row: NewJournalRow = {
        workspaceSessionId: workspaceId,
        path,
        previousPath,
        originalContent: binary ? null : original?.toString("utf8") ?? null,
        originalBinary: binary ? 1 : 0,
        isNew: original === null ? 1 : 0,
        touchedAt: new Date().toISOString(),
      };
      await database.insert(changeJournal).values(row).onConflictDoNothing();
    },

    async reviewChanges({ workspaceId, root, markReviewed = true }) {
      const rows = await loadRows(database, workspaceId);
      const entries: JournalEntry[] = [];
      for (const row of rows) {
        assertJournalPath(root, row.path);
        const current = await readFileIfPresent(join(root, row.path));
        entries.push({
          row,
          currentContent: current === null ? null : current.toString("utf8"),
          currentBinary: current !== null && isBinary(current),
        });
      }

      const patchParts: string[] = [];
      const files: ReviewFile[] = [];
      let totalAdditions = 0;
      let totalRemovals = 0;

      for (const entry of entries) {
        const { row, currentContent, currentBinary } = entry;

        if (!row.previousPath) {
          if (currentContent === null && row.originalContent === null) continue;
          if (row.originalContent === currentContent) continue;
        }

        const originalBytes = row.originalBinary
          ? 0
          : Buffer.byteLength(row.originalContent ?? "");
        const oversized = originalBytes + (currentContent?.length ?? 0) > MAX_JOURNAL_DIFF_BYTES;
        const preview = !row.originalBinary && !currentBinary && !oversized;

        let fileAdditions = 0;
        let fileRemovals = 0;
        if (preview) {
          const filePatch = unifiedFilePatch(
            row.previousPath ?? row.path,
            row.path,
            row.originalContent,
            currentContent,
          );
          const stats = countPatchLineStats(filePatch);
          fileAdditions = stats.additions;
          fileRemovals = stats.removals;
          patchParts.push(filePatch);
        }

        totalAdditions += fileAdditions;
        totalRemovals += fileRemovals;
        files.push({
          path: row.path,
          previousPath: row.previousPath,
          type: fileType(
            row.path,
            row.previousPath,
            row.isNew,
            currentContent === null,
            fileAdditions,
            fileRemovals,
          ),
          additions: fileAdditions,
          removals: fileRemovals,
        });
      }

      if (markReviewed) {
        await rebaseline(database, workspaceId, entries);
      }

      const summary = summarizeFiles(files);
      return {
        result: summary.files === 0
          ? "No changes since last shown changes."
          : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
        summary,
        files,
        patch: patchParts.join("\n"),
      };
    },
  };
}

async function loadRows(database: AppDatabase, workspaceId: string): Promise<JournalRow[]> {
  const rows = await database
    .select()
    .from(changeJournal)
    .where(eq(changeJournal.workspaceSessionId, workspaceId))
    .orderBy(changeJournal.touchedAt);
  return rows.map((row) => ({
    path: row.path,
    previousPath: row.previousPath ?? undefined,
    originalContent: row.originalContent,
    originalBinary: row.originalBinary === 1,
    isNew: row.isNew === 1,
    touchedAt: row.touchedAt,
  }));
}

async function rebaseline(
  database: AppDatabase,
  workspaceId: string,
  entries: JournalEntry[],
): Promise<void> {
  for (const entry of entries) {
    const { row, currentContent, currentBinary } = entry;

    if (currentContent === null) {
      await database
        .delete(changeJournal)
        .where(and(
          eq(changeJournal.workspaceSessionId, workspaceId),
          eq(changeJournal.path, row.path),
        ));
      continue;
    }

    if (!row.previousPath && row.originalContent === currentContent) {
      await database
        .delete(changeJournal)
        .where(and(
          eq(changeJournal.workspaceSessionId, workspaceId),
          eq(changeJournal.path, row.path),
        ));
      continue;
    }

    await database
      .update(changeJournal)
      .set({
        originalContent: currentBinary ? null : currentContent,
        originalBinary: currentBinary ? 1 : 0,
        isNew: 0,
        previousPath: null,
        touchedAt: new Date().toISOString(),
      })
      .where(and(
        eq(changeJournal.workspaceSessionId, workspaceId),
        eq(changeJournal.path, row.path),
      ));
  }
}

async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

function assertJournalPath(root: string, path: string): void {
  if (!isPathInsideRoot(join(root, path), root)) {
    throw new Error(`Path is outside workspace root: ${path}`);
  }
}

function countPatchLineStats(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}

function fileType(
  path: string,
  previousPath: string | undefined,
  isNew: boolean,
  isDeleted: boolean,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (isNew && !isDeleted) return "new";
  if (isDeleted && additions === 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}