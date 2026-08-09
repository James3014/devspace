import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";
import {
  fileChangeKindLabel,
  getFileChangeKind,
  getFileChangePathDisplay,
  getRenderedFileChangeKind,
  getRenderedFileChangePathDisplay,
  parseReviewPatchFiles,
  type FileChangeKind,
} from "./patch-display.js";
import { pierrePrettyScrollbarCss } from "./scrollbar.js";

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
  const reviewParse = useMemo(() => parseReviewPatchFiles(patch), [patch]);
  const files = reviewParse.files;
  const visibleFiles = typeof visibleFileCount === "number"
    ? files.slice(0, visibleFileCount)
    : files;
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

  if (errorMessage) return <StatusLine message={errorMessage} tone="error" />;
  if (card.error) return <StatusLine message={card.error} tone="error" />;
  if (!patch) return <StatusLine message="Diff payload is not available." />;
  if (!reviewParse.ok) return <FallbackReviewList card={card} />;
  if (files.length === 0) return <StatusLine message="No diff hunks to review." />;

  const options = diffOptions(themeType);

  if (files.length === 1) {
    const fileDiff = files[0];
    if (fileDiff.hunks.length === 0) {
      return <BinaryFileList files={[fileDiff]} card={card} />;
    }
    return (
      <div className="review-single-file">
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          className="pierre-diff pretty-scrollbar"
        />
      </div>
    );
  }

  return (
    <div className="review-diff pretty-scrollbar">
      <div className="review-diff-files">
        {visibleFiles.map((fileDiff, index) => {
          const key = fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
          const stats = diffStats(fileDiff);
          const isOpen = openFiles.has(key);
          const changeKind = getRenderedFileChangeKind(
            card.files ?? [],
            {
              path: fileDiff.name,
              previousPath: fileDiff.prevName,
              type: fileDiff.type,
            },
            index,
          );
          const pathDisplay = getRenderedFileChangePathDisplay(
            card.files ?? [],
            {
              path: fileDiff.name,
              previousPath: fileDiff.prevName,
            },
            index,
          );

          return (
            <div className="review-diff-file" key={key}>
              {fileDiff.hunks.length === 0 ? (
                <FileSummaryRow
                  kind={changeKind}
                  pathDisplay={pathDisplay}
                  name={fileDiff.name}
                  additions={stats.additions}
                  removals={stats.removals}
                  note="Binary file — diff preview hidden"
                />
              ) : (
                <>
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
                    <FileSummaryLabel kind={changeKind} pathDisplay={pathDisplay} name={fileDiff.name} />
                    <span className="review-diff-file-stats">
                      <span className="add">+{stats.additions}</span>
                      <span className="remove">-{stats.removals}</span>
                    </span>
                  </button>
                  {isOpen ? (
                    <FileDiff
                      fileDiff={fileDiff}
                      options={options}
                      className="pierre-diff pretty-scrollbar"
                    />
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FallbackReviewList({ card }: { card: ToolResultCard }) {
  const files = card.files ?? [];
  if (files.length === 0) {
    return <StatusLine message="The diff could not be previewed." />;
  }

  return (
    <div className="review-diff pretty-scrollbar">
      <div className="review-summary-note">
        Diff preview is unavailable — showing the changed files instead.
      </div>
      <div className="review-diff-files">
        {files.map((file, index) => {
          const kind = getFileChangeKind(file);
          const pathDisplay = getFileChangePathDisplay(file);
          return (
            <div className="review-diff-file" key={file.path ?? `file-${index}`}>
              <div className="review-diff-file-header static" aria-disabled="true">
                <FileSummaryLabel
                  kind={kind}
                  pathDisplay={pathDisplay}
                  name={file.path ?? file.previousPath ?? "Unknown file"}
                />
                <span className="review-diff-file-stats">
                  <span className="add">+{file.additions ?? 0}</span>
                  <span className="remove">-{file.removals ?? 0}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BinaryFileList({
  files,
  card,
}: {
  files: FileDiffMetadata[];
  card: ToolResultCard;
}) {
  return (
    <div className="review-diff pretty-scrollbar">
      <div className="review-diff-files">
        {files.map((fileDiff, index) => {
          const changeKind = getRenderedFileChangeKind(
            card.files ?? [],
            { path: fileDiff.name, previousPath: fileDiff.prevName, type: fileDiff.type },
            index,
          );
          const pathDisplay = getRenderedFileChangePathDisplay(
            card.files ?? [],
            { path: fileDiff.name, previousPath: fileDiff.prevName },
            index,
          );
          return (
            <div className="review-diff-file" key={fileDiff.cacheKey ?? fileDiff.name}>
              <FileSummaryRow
                kind={changeKind}
                pathDisplay={pathDisplay}
                name={fileDiff.name}
                additions={0}
                removals={0}
                note="Binary file — diff preview hidden"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileSummaryRow({
  kind,
  pathDisplay,
  name,
  additions,
  removals,
  note,
}: {
  kind: FileChangeKind;
  pathDisplay: ReturnType<typeof getRenderedFileChangePathDisplay>;
  name: string;
  additions: number;
  removals: number;
  note: string;
}) {
  return (
    <div className="review-diff-file-group">
      <div className="review-diff-file-header static" aria-disabled="true">
        <FileSummaryLabel kind={kind} pathDisplay={pathDisplay} name={name} />
        <span className="review-diff-file-stats">
          <span className="add">+{additions}</span>
          <span className="remove">-{removals}</span>
        </span>
      </div>
      <div className="review-binary-note">{note}</div>
    </div>
  );
}

function FileSummaryLabel({
  kind,
  pathDisplay,
  name,
}: {
  kind: FileChangeKind;
  pathDisplay: ReturnType<typeof getRenderedFileChangePathDisplay>;
  name: string;
}) {
  return (
    <>
      <span
        className={`review-file-kind ${kind}`}
        role="img"
        title={fileChangeKindLabel(kind)}
        aria-label={fileChangeKindLabel(kind)}
      >
        {fileChangeSymbol(kind)}
      </span>
      {pathDisplay?.previous ? (
        <span
          className="review-diff-file-name renamed"
          title={pathDisplay.title}
        >
          <span className="review-diff-file-path previous">
            {pathDisplay.previous}
          </span>
          <span className="review-diff-file-arrow">→</span>
          <span className="review-diff-file-path current">
            {pathDisplay.current}
          </span>
        </span>
      ) : (
        <span className="review-diff-file-name" title={pathDisplay?.title ?? name}>
          {pathDisplay?.current ?? name}
        </span>
      )}
    </>
  );
}

function fileChangeSymbol(kind: FileChangeKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "edited":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
    case "renamed-edited":
      return "R";
    case "unknown":
      return "•";
  }
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
    unsafeCSS: pierrePrettyScrollbarCss,
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
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
