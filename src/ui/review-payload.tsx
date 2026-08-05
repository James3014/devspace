import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";
import { PIERRE_SCROLLBAR_STYLES } from "./scrollbar-styles.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
  errorMessage?: string | null;
  visibleFileCount?: number;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({
  card,
  hostContext,
  errorMessage = null,
  visibleFileCount,
}: PayloadRendererOptions) {
  const patch = card.payload?.patch;
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const files = useMemo(() => parseFiles(patch), [patch]);
  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;
  const isSingleFile = files.length === 1;
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => {
    const onlyFile = files.length === 1 ? files[0] : undefined;
    return onlyFile ? new Set([reviewFileKey(onlyFile)]) : new Set();
  });

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);

  return (
    <div className="review-diff pretty-scrollbar">
      <div className="review-diff-files">
        {visibleFiles.map((fileDiff) => {
          const key = reviewFileKey(fileDiff);
          const stats = diffStats(fileDiff);
          const isOpen = openFiles.has(key);
          const metadata = findReviewFile(card.files, fileDiff);
          const operation = reviewOperation(metadata);
          const previousPath = metadata?.previousPath ?? fileDiff.prevName;

          return (
            <div className={`review-diff-file operation-${operation}`} key={key}>
              {!isSingleFile ? (
                <button
                  type="button"
                  className="review-diff-file-header"
                  aria-expanded={isOpen}
                  onClick={() => {
                    const next = new Set(openFiles);
                    if (next.has(key)) {
                      next.delete(key);
                    } else {
                      next.add(key);
                    }
                    setOpenFiles(next);
                  }}
                >
                  <span className="review-diff-file-main">
                    <span
                      className={`review-diff-file-operation ${operation}`}
                      aria-label={reviewOperationLabel(operation)}
                      title={reviewOperationLabel(operation)}
                    >
                      {reviewOperationSymbol(operation)}
                    </span>
                    <span className="review-diff-file-name">
                      {fileDiff.name}
                      {previousPath && previousPath !== fileDiff.name ? (
                        <span className="review-diff-file-previous"> ← {previousPath}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="review-diff-file-stats">
                    <span className="add">+{stats.additions}</span>
                    <span className="remove">-{stats.removals}</span>
                    <span className="review-diff-file-chevron" aria-hidden="true">›</span>
                  </span>
                </button>
              ) : null}
              {isOpen ? (
                <FileDiff
                  fileDiff={fileDiff}
                  options={options}
                  className="pierre-diff pretty-scrollbar"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function parseFiles(patch: string | undefined): FileDiffMetadata[] {
  if (!patch) return [];
  return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
}

function reviewFileKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}`;
}

function diffStats(fileDiff: FileDiffMetadata): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

type ReviewOperation = "add" | "update" | "delete" | "move";

function findReviewFile(
  files: ToolResultCard["files"],
  fileDiff: FileDiffMetadata,
): NonNullable<ToolResultCard["files"]>[number] | undefined {
  const name = fileDiff.name;
  const previousName = fileDiff.prevName;
  return files?.find((file) => {
    if (file.path === name || file.previousPath === name) return true;
    if (!previousName) return false;
    return file.path === previousName || file.previousPath === previousName;
  });
}

function reviewOperation(file: NonNullable<ToolResultCard["files"]>[number] | undefined): ReviewOperation {
  if (file?.operation === "add" || file?.type === "new") return "add";
  if (file?.operation === "delete" || file?.type === "deleted") return "delete";
  if (
    file?.operation === "move" ||
    file?.type === "rename-pure" ||
    file?.type === "rename-changed"
  ) {
    return "move";
  }
  return "update";
}

function reviewOperationSymbol(operation: ReviewOperation): string {
  if (operation === "add") return "+";
  if (operation === "delete") return "−";
  if (operation === "move") return "↗";
  return "~";
}

function reviewOperationLabel(operation: ReviewOperation): string {
  if (operation === "add") return "Added file";
  if (operation === "delete") return "Deleted file";
  if (operation === "move") return "Moved file";
  return "Changed file";
}

function diffOptions(themeType: ThemeType): FileDiffOptions<undefined> {
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    themeType,
    diffStyle: "unified",
    diffIndicators: "bars",
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
    unsafeCSS: PIERRE_SCROLLBAR_STYLES,
  };
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}
