import React, { useMemo, useState } from "react";
import type { GitConflictSide, GitDiff, GitDiffLine, GitDiffLineKind } from "@shared/types";
import { BackIcon, IconButton, OpenFileIcon, Spinner, splitPath } from "./git-ui";

interface Props {
  path: string;
  staged: boolean;
  diff: GitDiff | null;
  loading: boolean;
  onBack: () => void;
  onOpenFile: () => void;
  // Threaded for the diff/staging agent (A5): the repo cwd, whether this is an
  // untracked file, and a callback to refresh the panel after a partial stage /
  // unstage / discard or a conflict resolution. We build hunk-level staging here
  // using window.spark.git.applyPatch / git.resolveConflict and call onChanged()
  // on success — GitPanel re-fetches the open diff on a version bump.
  cwd: string;
  untracked: boolean;
  onChanged: () => void;
}

// Per-line treatment. Adds / deletes get a faint tinted band the full width of
// the (horizontally scrollable) row; hunks and metadata stay quiet.
const LINE_STYLE: Record<GitDiffLineKind, React.CSSProperties> = {
  add: {
    background: "color-mix(in oklch, var(--ok) 13%, transparent)",
    color: "color-mix(in oklch, var(--ok) 64%, var(--ink))",
  },
  del: {
    background: "color-mix(in oklch, var(--danger) 13%, transparent)",
    color: "color-mix(in oklch, var(--danger) 70%, var(--ink))",
  },
  hunk: {
    background: "color-mix(in oklch, var(--info) 9%, transparent)",
    color: "var(--info)",
  },
  meta: { color: "var(--muted-2)" },
  context: { color: "var(--ink-dim)" },
};

// ── Diff structure parsing ────────────────────────────────────────────────────
// The backend's GitDiff is a flat list of {kind,text} lines (text = the exact
// diff line, leading +/-/space intact). To stage / discard a single hunk we need
// to peel that apart into the file-header block (the meta run before the first
// hunk) and one record per hunk, then re-emit a valid unified-diff patch.

interface Hunk {
  /** The literal `@@ -a,b +c,d @@ …` line. */
  header: string;
  /** Old-file start line and new-file start line, from the @@ header. */
  oldStart: number;
  newStart: number;
  /** Body lines (add / del / context, plus any `\ No newline…` markers). */
  body: GitDiffLine[];
  /** Index of this hunk's `@@` line in diff.lines (for stable React keys). */
  index: number;
  added: number;
  removed: number;
}

interface DiffStructure {
  /** Meta lines before the first hunk: `diff --git`, `index`, `---`, `+++`. */
  fileHeader: string[];
  hunks: Hunk[];
  /** True if any line carries a merge-conflict marker. */
  conflicted: boolean;
}

// Match `@@ -oldStart[,oldCount] +newStart[,newCount] @@`. Counts default to 1
// when omitted (a single-line hunk), per the unified-diff spec.
const HUNK_RE = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isConflictMarker(text: string): boolean {
  return (
    text.startsWith("<<<<<<<") ||
    text.startsWith("=======") ||
    text.startsWith(">>>>>>>") ||
    text.startsWith("|||||||")
  );
}

function parseDiffStructure(diff: GitDiff): DiffStructure {
  const fileHeader: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let seenHunk = false;
  let conflicted = false;

  for (let i = 0; i < diff.lines.length; i++) {
    const line = diff.lines[i];
    if (isConflictMarker(line.text)) conflicted = true;

    if (line.kind === "hunk") {
      const m = line.text.match(HUNK_RE);
      current = {
        header: line.text,
        oldStart: m ? Number(m[1]) : 0,
        newStart: m ? Number(m[2]) : 0,
        body: [],
        index: i,
        added: 0,
        removed: 0,
      };
      hunks.push(current);
      seenHunk = true;
      continue;
    }

    if (!seenHunk) {
      // Everything before the first @@ is the file header (we only keep meta —
      // a well-formed diff has nothing else here).
      if (line.kind === "meta") fileHeader.push(line.text);
      continue;
    }

    if (!current) continue;
    if (line.kind === "meta" && !line.text.startsWith("\\")) {
      // A non-"\ No newline" meta line after a hunk would start a new file
      // section. getGitDiff is always single-file, so this shouldn't happen;
      // stop appending to the current hunk if it ever does.
      current = null;
      continue;
    }
    // add / del / context, or a `\ No newline at end of file` marker.
    current.body.push(line);
    if (line.kind === "add") current.added++;
    else if (line.kind === "del") current.removed++;
  }

  return { fileHeader, hunks, conflicted };
}

// Reconstruct a one-hunk unified-diff patch: the file header + this hunk's @@
// line + its body lines, each verbatim. `git apply --recount` recomputes the @@
// counts, so a header copied straight from `git diff` always lines up.
// Validated against `git apply --cached` / `--reverse` in a throwaway repo.
function buildHunkPatch(structure: DiffStructure, hunk: Hunk): string {
  const parts = [...structure.fileHeader, hunk.header, ...hunk.body.map((l) => l.text)];
  return `${parts.join("\n")}\n`;
}

// ── Old / new line-number gutters ─────────────────────────────────────────────
// Walk the hunk bodies to assign each rendered line its old-file and/or new-file
// number, so the view reads like a real side-gutter diff. Context advances both;
// del advances only old; add advances only new; the @@ row and meta rows blank.
interface RenderLine {
  line: GitDiffLine;
  /** Global index into diff.lines (React key + hunk lookup). */
  index: number;
  oldNo: number | null;
  newNo: number | null;
}

function computeRenderLines(diff: GitDiff, structure: DiffStructure): RenderLine[] {
  const out: RenderLine[] = [];
  let hi = 0;
  let oldNo = 0;
  let newNo = 0;
  for (let i = 0; i < diff.lines.length; i++) {
    const line = diff.lines[i];
    if (line.kind === "hunk") {
      const h = structure.hunks[hi];
      hi++;
      oldNo = h ? h.oldStart : 0;
      newNo = h ? h.newStart : 0;
      out.push({ line, index: i, oldNo: null, newNo: null });
      continue;
    }
    if (line.kind === "meta") {
      out.push({ line, index: i, oldNo: null, newNo: null });
      continue;
    }
    if (line.kind === "context") {
      out.push({ line, index: i, oldNo, newNo });
      oldNo++;
      newNo++;
    } else if (line.kind === "del") {
      out.push({ line, index: i, oldNo, newNo: null });
      oldNo++;
    } else {
      // add
      out.push({ line, index: i, oldNo: null, newNo });
      newNo++;
    }
  }
  return out;
}

type ApplyKind = "stageHunk" | "unstageHunk" | "discardHunk";

export default function DiffView({
  path,
  staged,
  diff,
  loading,
  onBack,
  onOpenFile,
  cwd,
  untracked,
  onChanged,
}: Props): React.ReactElement {
  const { dir, name } = splitPath(path);
  // The in-flight op id (e.g. `hunk:3:stageHunk`) — disables every action and
  // marks the active one as busy. Cleared on completion.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which hunk's discard is armed (two-step confirm). Only one at a time.
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);

  const structure = useMemo(
    () => (diff && !diff.binary ? parseDiffStructure(diff) : null),
    [diff],
  );
  const renderLines = useMemo(
    () => (diff && structure && !diff.binary ? computeRenderLines(diff, structure) : []),
    [diff, structure],
  );

  const conflicted = structure?.conflicted ?? false;
  const hunkCount = structure?.hunks.length ?? 0;
  // Untracked files have a synthetic all-added diff that isn't a real patch
  // (no file header) — stage/unstage the whole file via the change list, not
  // per hunk. Conflicted files route through resolveConflict instead.
  const canPartialStage = Boolean(structure) && !untracked && !conflicted && hunkCount > 0;

  const gutterWidth = useMemo(() => {
    let max = 0;
    for (const r of renderLines) {
      if (r.oldNo && r.oldNo > max) max = r.oldNo;
      if (r.newNo && r.newNo > max) max = r.newNo;
    }
    // 1 digit minimum; clamp so a 4000-line cap can't blow the gutter out.
    return Math.max(2, String(max).length);
  }, [renderLines]);

  async function runApply(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const result = await fn();
      if (result.ok) {
        // GitPanel reloads the diff on the version bump; reset transient UI.
        setConfirmDiscard(null);
        onChanged();
      } else {
        setError(result.error ?? "Operation failed.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function applyHunk(hunk: Hunk, kind: ApplyKind): void {
    if (!structure) return;
    const patch = buildHunkPatch(structure, hunk);
    const id = `hunk:${hunk.index}:${kind}`;
    if (kind === "stageHunk") {
      void runApply(id, () => window.spark.git.applyPatch(cwd, patch, { cached: true, reverse: false }));
    } else if (kind === "unstageHunk") {
      void runApply(id, () => window.spark.git.applyPatch(cwd, patch, { cached: true, reverse: true }));
    } else {
      // Discard: reverse-apply to the working tree.
      void runApply(id, () => window.spark.git.applyPatch(cwd, patch, { cached: false, reverse: true }));
    }
  }

  function applyAll(kind: ApplyKind): void {
    if (!structure || structure.hunks.length === 0) return;
    // Stage / unstage / discard the whole file by chaining each hunk's patch.
    // (A single combined patch would also work, but per-hunk keeps one bad hunk
    // from voiding the rest under --recount, and reuses the validated builder.)
    const hunks = structure.hunks;
    const id = `all:${kind}`;
    void runApply(id, async () => {
      for (const hunk of hunks) {
        const patch = buildHunkPatch(structure, hunk);
        const opts =
          kind === "stageHunk"
            ? { cached: true, reverse: false }
            : kind === "unstageHunk"
              ? { cached: true, reverse: true }
              : { cached: false, reverse: true };
        const r = await window.spark.git.applyPatch(cwd, patch, opts);
        if (!r.ok) return r;
      }
      return { ok: true } as const;
    });
  }

  function resolve(side: GitConflictSide): void {
    void runApply(`conflict:${side}`, () => window.spark.git.resolveConflict(cwd, path, side));
  }

  const headerBusy = busy === "all:stageHunk" || busy === "all:unstageHunk" || busy === "all:discardHunk";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          flex: "0 0 auto",
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px 0 4px",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <IconButton title="Back to changes" onClick={onBack} size={22}>
          <BackIcon />
        </IconButton>
        <span
          title={path}
          style={{
            minWidth: 0,
            flex: 1,
            display: "flex",
            alignItems: "baseline",
            gap: 5,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {dir}
          </span>
        </span>
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            letterSpacing: "0.1em",
            fontWeight: 700,
            textTransform: "uppercase",
            color: conflicted ? "var(--danger)" : staged ? "var(--ok)" : "var(--muted)",
          }}
        >
          {conflicted ? "Conflict" : staged ? "Staged" : "Working"}
        </span>
        <IconButton title="Open file in editor" onClick={onOpenFile} size={22}>
          <OpenFileIcon />
        </IconButton>
      </div>

      {/* Conflict banner — resolve by keeping one side wholesale. */}
      {conflicted && (
        <ConflictBar
          busy={busy}
          onOurs={() => resolve("ours")}
          onTheirs={() => resolve("theirs")}
        />
      )}

      {/* Per-file action bar: stage / unstage / discard every hunk at once. */}
      {canPartialStage && (
        <FileActionBar
          staged={staged}
          hunkCount={hunkCount}
          busy={headerBusy}
          disabled={busy !== null}
          confirmDiscardAll={confirmDiscard === -1}
          onStageAll={() => applyAll("stageHunk")}
          onUnstageAll={() => applyAll("unstageHunk")}
          onDiscardAll={() => {
            if (confirmDiscard === -1) applyAll("discardHunk");
            else setConfirmDiscard(-1);
          }}
        />
      )}

      {error && <ApplyError text={error} onDismiss={() => setError(null)} />}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {loading ? (
          <DiffHint>
            <Spinner /> <span style={{ marginLeft: 8 }}>Loading diff…</span>
          </DiffHint>
        ) : !diff || diff.error ? (
          <DiffHint danger>{diff?.error ?? "Could not load this diff."}</DiffHint>
        ) : diff.binary ? (
          <DiffHint>Binary file — no inline preview.</DiffHint>
        ) : diff.lines.length === 0 ? (
          <DiffHint>No textual changes to show.</DiffHint>
        ) : (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {renderLines.map((r) =>
              r.line.kind === "hunk" ? (
                <HunkRow
                  key={r.index}
                  hunk={structure!.hunks.find((h) => h.index === r.index)!}
                  staged={staged}
                  showActions={canPartialStage}
                  gutterWidth={gutterWidth}
                  busy={busy}
                  anyBusy={busy !== null}
                  confirmDiscard={confirmDiscard}
                  onStage={(h) => applyHunk(h, "stageHunk")}
                  onUnstage={(h) => applyHunk(h, "unstageHunk")}
                  onDiscard={(h) => {
                    if (confirmDiscard === h.index) applyHunk(h, "discardHunk");
                    else setConfirmDiscard(h.index);
                  }}
                  onCancelConfirm={() => setConfirmDiscard(null)}
                />
              ) : (
                <DiffLineRow key={r.index} render={r} gutterWidth={gutterWidth} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── A single non-hunk diff line, with old/new gutters ─────────────────────────

const GUTTER_DIGIT = 7; // px per mono digit at 11px — keeps the gutter snug.

function DiffLineRow({
  render,
  gutterWidth,
}: {
  render: RenderLine;
  gutterWidth: number;
}): React.ReactElement {
  const { line, oldNo, newNo } = render;
  const gw = gutterWidth * GUTTER_DIGIT + 8;
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : null;
  return (
    <div
      style={{
        ...LINE_STYLE[line.kind],
        display: "flex",
        width: "max-content",
        minWidth: "100%",
        minHeight: 16,
        lineHeight: "16px",
      }}
    >
      <Gutter value={oldNo} width={gw} />
      <Gutter value={newNo} width={gw} />
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 12,
          textAlign: "center",
          color: "inherit",
          opacity: sign ? 0.7 : 0.25,
          userSelect: "none",
        }}
      >
        {sign ?? ""}
      </span>
      <span style={{ flex: "1 1 auto", whiteSpace: "pre", paddingRight: 10 }}>
        {/* text keeps its own leading +/-/space; strip the duplicate sign we
            render in the dedicated column above so it isn't shown twice. */}
        {renderBody(line)}
      </span>
    </div>
  );
}

// Drop the leading +/-/space from a content line (we show the sign separately);
// meta lines and `\ No newline` markers print verbatim.
function renderBody(line: GitDiffLine): string {
  if (line.kind === "add" || line.kind === "del" || line.kind === "context") {
    const body = line.text.slice(1);
    return body === "" ? " " : body;
  }
  return line.text === "" ? " " : line.text;
}

function Gutter({ value, width }: { value: number | null; width: number }): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        flex: `0 0 ${width}px`,
        textAlign: "right",
        paddingRight: 6,
        color: "var(--muted-2)",
        opacity: value == null ? 0 : 0.75,
        userSelect: "none",
        whiteSpace: "pre",
      }}
    >
      {value ?? ""}
    </span>
  );
}

// ── Hunk header row, with hover-revealed stage / unstage / discard ────────────

function HunkRow({
  hunk,
  staged,
  showActions,
  gutterWidth,
  busy,
  anyBusy,
  confirmDiscard,
  onStage,
  onUnstage,
  onDiscard,
  onCancelConfirm,
}: {
  hunk: Hunk;
  staged: boolean;
  showActions: boolean;
  gutterWidth: number;
  busy: string | null;
  anyBusy: boolean;
  confirmDiscard: number | null;
  onStage: (h: Hunk) => void;
  onUnstage: (h: Hunk) => void;
  onDiscard: (h: Hunk) => void;
  onCancelConfirm: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const gw = gutterWidth * GUTTER_DIGIT + 8;
  const armed = confirmDiscard === hunk.index;
  const stageBusy = busy === `hunk:${hunk.index}:stageHunk`;
  const unstageBusy = busy === `hunk:${hunk.index}:unstageHunk`;
  const discardBusy = busy === `hunk:${hunk.index}:discardHunk`;
  // The actions slot reserves its width so revealing it never reflows the row.
  const slotWidth = staged ? 26 : 50;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        if (armed) onCancelConfirm();
      }}
      style={{
        ...LINE_STYLE.hunk,
        display: "flex",
        alignItems: "center",
        width: "max-content",
        minWidth: "100%",
        minHeight: 20,
        lineHeight: "20px",
        borderTop: "1px solid color-mix(in oklch, var(--info) 18%, transparent)",
        borderBottom: "1px solid color-mix(in oklch, var(--info) 14%, transparent)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: `0 0 ${gw * 2 + 12}px`,
          textAlign: "right",
          paddingRight: 6,
          fontSize: 9.5,
          letterSpacing: "0.06em",
          color: "color-mix(in oklch, var(--info) 60%, var(--muted))",
          userSelect: "none",
        }}
      >
        {hunk.added > 0 ? `+${hunk.added}` : ""}
        {hunk.added > 0 && hunk.removed > 0 ? " " : ""}
        {hunk.removed > 0 ? `−${hunk.removed}` : ""}
      </span>
      <span style={{ flex: "1 1 auto", whiteSpace: "pre", paddingRight: 10, fontSize: 10.5 }}>
        {hunk.header}
      </span>
      {showActions && (
        <span
          style={{
            flex: `0 0 ${slotWidth}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 2,
            paddingRight: 4,
          }}
        >
          {hover &&
            (staged ? (
              <IconButton
                title="Unstage this hunk"
                onClick={() => onUnstage(hunk)}
                disabled={anyBusy}
                size={18}
              >
                {unstageBusy ? <Spinner size={11} /> : <MinusGlyph />}
              </IconButton>
            ) : (
              <>
                <IconButton
                  title={armed ? "Click again to discard this hunk" : "Discard this hunk"}
                  danger
                  active={armed}
                  disabled={anyBusy}
                  onClick={() => onDiscard(hunk)}
                  size={18}
                >
                  {discardBusy ? <Spinner size={11} /> : <UndoIcon />}
                </IconButton>
                <IconButton
                  title="Stage this hunk"
                  onClick={() => onStage(hunk)}
                  disabled={anyBusy}
                  size={18}
                >
                  {stageBusy ? <Spinner size={11} /> : <PlusGlyph />}
                </IconButton>
              </>
            ))}
        </span>
      )}
    </div>
  );
}

// ── Per-file action bar ───────────────────────────────────────────────────────

function FileActionBar({
  staged,
  hunkCount,
  busy,
  disabled,
  confirmDiscardAll,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
}: {
  staged: boolean;
  hunkCount: number;
  busy: boolean;
  disabled: boolean;
  confirmDiscardAll: boolean;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
}): React.ReactElement {
  const label = `${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 8px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "color-mix(in oklch, var(--ink) 2.5%, transparent)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          color: "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {busy ? <Spinner size={11} /> : null}
        {label}
      </span>
      {staged ? (
        <TextAction label="Unstage all" onClick={onUnstageAll} disabled={disabled} />
      ) : (
        <>
          <TextAction
            label={confirmDiscardAll ? "Confirm discard" : "Discard all"}
            danger
            active={confirmDiscardAll}
            onClick={onDiscardAll}
            disabled={disabled}
          />
          <TextAction label="Stage all" onClick={onStageAll} disabled={disabled} />
        </>
      )}
    </div>
  );
}

// A compact text button matching the panel's quiet, cursor-default language.
function TextAction({
  label,
  onClick,
  disabled = false,
  danger = false,
  active = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const lit = (hover || active) && !disabled;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        flex: "0 0 auto",
        padding: "3px 8px",
        borderRadius: 5,
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 700,
        whiteSpace: "nowrap",
        border: lit
          ? danger
            ? "1px solid color-mix(in oklch, var(--danger) 45%, var(--rule-soft))"
            : "1px solid var(--accent-edge)"
          : "1px solid var(--rule-strong)",
        background: lit ? (danger ? "var(--danger-soft)" : "var(--accent-soft)") : "transparent",
        color: disabled
          ? "var(--muted-2)"
          : danger
            ? "var(--danger)"
            : lit
              ? "var(--ink)"
              : "var(--ink-dim)",
        opacity: disabled ? 0.5 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

// ── Conflict resolution bar ───────────────────────────────────────────────────

function ConflictBar({
  busy,
  onOurs,
  onTheirs,
}: {
  busy: string | null;
  onOurs: () => void;
  onTheirs: () => void;
}): React.ReactElement {
  const oursBusy = busy === "conflict:ours";
  const theirsBusy = busy === "conflict:theirs";
  const disabled = busy !== null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 9px",
        margin: "8px 8px 0",
        borderRadius: 7,
        border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
        background: "var(--danger-soft)",
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          display: "inline-flex",
          color: "var(--danger)",
        }}
      >
        <ConflictIcon />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          lineHeight: 1.4,
          color: "color-mix(in oklch, var(--danger) 80%, var(--ink))",
        }}
      >
        Merge conflict — keep one side, then commit.
      </span>
      <TextAction
        label={oursBusy ? "Keeping…" : "Accept Current"}
        onClick={onOurs}
        disabled={disabled}
      />
      <TextAction
        label={theirsBusy ? "Keeping…" : "Accept Incoming"}
        onClick={onTheirs}
        disabled={disabled}
      />
    </div>
  );
}

// ── Inline error strip (mirrors GitPanel's ErrorStrip, scoped to the diff) ─────

function ApplyError({ text, onDismiss }: { text: string; onDismiss: () => void }): React.ReactElement {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        margin: "8px 8px 0",
        padding: "7px 9px",
        borderRadius: 7,
        border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
        background: "var(--danger-soft)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: 1.5,
          color: "color-mix(in oklch, var(--danger) 80%, var(--ink))",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 96,
          overflow: "auto",
        }}
      >
        {text}
      </span>
      <button
        type="button"
        title="Dismiss"
        onClick={onDismiss}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          border: "none",
          background: "transparent",
          color: "var(--danger)",
          cursor: "default",
          fontSize: 13,
          lineHeight: 1,
          padding: 2,
        }}
      >
        ✕
      </button>
    </div>
  );
}

function DiffHint({
  children,
  danger = false,
}: {
  children: React.ReactNode;
  danger?: boolean;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "14px 14px",
        fontSize: 11,
        color: danger ? "var(--danger)" : "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

// ── Local icons (defined here — git-ui.tsx is owned by another agent) ──────────
// 14×14, 1.2px stroke, currentColor — same language as git-ui's icon set.

function PlusGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3.2v7.6M3.2 7h7.6" />
    </svg>
  );
}

function MinusGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.2 7h7.6" />
    </svg>
  );
}

function UndoIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6.5h6.2A2.8 2.8 0 0 1 9.2 12H6" />
      <path d="M5.4 4 3 6.5 5.4 9" />
    </svg>
  );
}

function ConflictIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 1.8 12.6 11.6H1.4L7 1.8Z" />
      <path d="M7 5.6v2.8" />
      <circle cx="7" cy="10.1" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}
