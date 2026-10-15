import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampQuote, type ReviewNote } from "@shared/review-notes";
import { useOptionalSelectionRouting } from "../../routing/SelectionRoutingContext";
import { NoteComposer } from "./ReviewNoteCards";
import { addReviewNote, reviewNotesError, useReviewNotes } from "./review-notes-store";
import "./review.css";

// Review notes on a rendered Markdown file, such as a plan: select text, press
// "Add note", write it. The note keeps the selected text and the source lines
// it came from (MarkdownPreview marks each rendered element with data-line and
// data-line-end), and joins the workspace's other review notes. Blocks with a
// note are marked, and a bar on top counts them and opens the review tab.

interface Props {
  containerRef: React.RefObject<HTMLElement>;
  /** The Markdown file's absolute path. */
  basePath: string;
  /** Re-marks the noted blocks when the rendered text changes. */
  text: string;
}

interface TextPick {
  startLine: number;
  endLine: number;
  quote: string;
  rect: { left: number; top: number; bottom: number; right: number };
}

/** Where a noted block keeps a title of its own while the notes' title shows. */
const OWN_TITLE = "data-review-own-title";

const BLOCK_TAGS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "TR", "TD", "TH", "HR", "DIV", "DETAILS", "SUMMARY", "DT", "DD", "TABLE"]);

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return /^[A-Za-z]:\//.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function lineRange(element: Element): [number, number] | null {
  const start = Number(element.getAttribute("data-line"));
  const end = Number(element.getAttribute("data-line-end") ?? start);
  return Number.isInteger(start) && start > 0 ? [start, Number.isInteger(end) && end >= start ? end : start] : null;
}

/** The source line of a point in the rendered text; inside a code block, the exact line. */
function lineAt(container: HTMLElement, node: Node, offset: number, edge: "start" | "end"): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const marked = element?.closest("[data-line]");
  if (!marked || !container.contains(marked)) return null;
  const range = lineRange(marked);
  if (!range) return null;
  const pre = marked.tagName === "PRE" ? marked : marked.tagName === "CODE" && marked.parentElement?.tagName === "PRE" ? marked.parentElement : null;
  if (pre) {
    const outer = lineRange(pre) ?? range;
    const before = document.createRange();
    before.setStart(pre, 0);
    try {
      before.setEnd(node, offset);
    } catch {
      return edge === "start" ? outer[0] : outer[1];
    }
    const newlines = (before.toString().match(/\n/g) ?? []).length;
    // The fence takes the block's first source line.
    return Math.min(outer[1], outer[0] + 1 + newlines);
  }
  return edge === "start" ? range[0] : range[1];
}

function readSelection(container: HTMLElement): TextPick | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = selection.toString().trim();
  if (!quote) return null;
  const start = lineAt(container, range.startContainer, range.startOffset, "start");
  const end = lineAt(container, range.endContainer, range.endOffset, "end");
  if (start === null || end === null) return null;
  const rects = range.getClientRects();
  const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  const box = range.getBoundingClientRect();
  return {
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
    quote: clampQuote(quote),
    rect: { left: box.left, top: box.top, bottom: last.bottom, right: last.right },
  };
}

function where(pick: TextPick): string {
  return pick.startLine === pick.endLine ? `line ${pick.startLine}` : `lines ${pick.startLine}-${pick.endLine}`;
}

export default function MarkdownReviewLayer({ containerRef, basePath, text }: Props): React.ReactElement | null {
  const routing = useOptionalSelectionRouting();
  const workspaceId = routing?.workspaceId ?? null;
  const { notes } = useReviewNotes(workspaceId);
  const mine = useMemo(
    () => notes.filter((note) => note.source === "markdown" && samePath(note.filePath, basePath)),
    [basePath, notes],
  );
  const [pick, setPick] = useState<TextPick | null>(null);
  const [composing, setComposing] = useState<TextPick | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Follow the selection while no note is being written.
  useEffect(() => {
    if (!workspaceId || composing) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A short timer rather than a frame: a selection made while the window
    // is in the background still gets its button.
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const container = containerRef.current;
        setPick(container ? readSelection(container) : null);
      }, 40);
    };
    document.addEventListener("selectionchange", update);
    const container = containerRef.current;
    container?.addEventListener("scroll", update, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", update);
      container?.removeEventListener("scroll", update);
    };
  }, [composing, containerRef, workspaceId]);

  // Mark the blocks that carry a note: the innermost ones, so a note on one
  // list item marks that item and not the whole list.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const marked = container.querySelectorAll("[data-review-noted]");
    for (const element of marked) {
      element.removeAttribute("data-review-noted");
      // A title the document gave the block comes back.
      const own = element.getAttribute(OWN_TITLE);
      if (own !== null) element.setAttribute("title", own);
      else element.removeAttribute("title");
      element.removeAttribute(OWN_TITLE);
    }
    if (!mine.length) return;
    const blocks = [...container.querySelectorAll<HTMLElement>("[data-line]")].filter((element) => BLOCK_TAGS.has(element.tagName));
    const hits = new Map<HTMLElement, ReviewNote[]>();
    for (const note of mine) {
      const whole = note.startLine === 0 && note.endLine === 0;
      if (whole) continue;
      const touching = blocks.filter((element) => {
        const range = lineRange(element);
        return range !== null && range[0] <= note.endLine && range[1] >= note.startLine;
      });
      for (const element of touching) {
        if (touching.some((other) => other !== element && element.contains(other))) continue;
        hits.set(element, [...(hits.get(element) ?? []), note]);
      }
    }
    for (const [element, list] of hits) {
      const own = element.getAttribute("title");
      if (own !== null) element.setAttribute(OWN_TITLE, own);
      element.setAttribute("data-review-noted", "");
      element.setAttribute("title", list.map((note) => `Review note: ${note.body}`).join("\n\n"));
    }
  }, [containerRef, mine, text]);

  const close = useCallback(() => {
    setComposing(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!composing) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [close, composing]);

  const save = useCallback(
    async (body: string) => {
      if (!workspaceId || !composing) return;
      const note = await addReviewNote(workspaceId, {
        source: "markdown",
        filePath: basePath,
        side: "new",
        startLine: composing.startLine,
        endLine: composing.endLine,
        quote: composing.quote,
        body,
      });
      if (!note) {
        const why = reviewNotesError(workspaceId);
        setError(why ? `The note was not saved. ${why}` : "The note was not saved. There may be too many notes already.");
        return;
      }
      window.getSelection()?.removeAllRanges();
      setPick(null);
      close();
    },
    [basePath, close, composing, workspaceId],
  );

  if (!workspaceId) return null;

  const place = (rect: TextPick["rect"], width: number, height: number, edge: "start" | "end") => {
    const left = Math.min(Math.max(8, edge === "start" ? rect.left : rect.right - width), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    return { left, top };
  };

  const containerRect = containerRef.current?.getBoundingClientRect();
  const pickVisible =
    pick && containerRect && pick.rect.bottom >= containerRect.top && pick.rect.top <= containerRect.bottom ? pick : null;

  return (
    <>
      {mine.length ? (
        <div className="rv-md-bar" data-testid="markdown-review-bar">
          <span>
            {mine.length === 1 ? "1 review note" : `${mine.length} review notes`} on this file
          </span>
          <button type="button" className="rv-textbtn" onClick={() => window.dispatchEvent(new CustomEvent("spark:open-review"))}>
            Open review
          </button>
        </div>
      ) : null}
      {pickVisible && !composing
        ? createPortal(
            <button
              ref={buttonRef}
              type="button"
              className="spark-menu spark-glass rv-md-add rv-textbtn"
              data-testid="markdown-add-note"
              style={{ ...place(pickVisible.rect, 92, 28, "end"), minWidth: 0, padding: "4px 10px" }}
              // Keeps the selection: a click would otherwise collapse it first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setComposing(pickVisible)}
            >
              Add note
            </button>,
            document.body,
          )
        : null}
      {composing
        ? createPortal(
            <div
              ref={popoverRef}
              className="spark-menu spark-glass rv-md-popover"
              role="dialog"
              aria-label={`Review note on ${where(composing)}`}
              data-testid="markdown-note-popover"
              style={place(composing.rect, 320, 230, "start")}
            >
              <div className="rv-note__meta" style={{ marginBottom: 6 }}>
                <span className="rv-note__where">Note on {where(composing)}</span>
              </div>
              <div className="rv-md-popover__quote">{composing.quote}</div>
              <NoteComposer
                label={`Note on ${where(composing)}`}
                saveLabel="Add note"
                onSave={save}
                onCancel={close}
                draftKey={`md:${workspaceId}:${basePath}:${composing.startLine}-${composing.endLine}`}
              />
              {error ? <div className="rv-status" data-tone="error" style={{ padding: "6px 0 0" }}>{error}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
