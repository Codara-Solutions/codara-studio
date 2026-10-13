import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HoverInfo, HoverProbeCall, OutlineRow } from "@shared/preview-point";
import { hoverInPage, outlineInPage, type RunInPage } from "./pageScripts";

// The element picker: a transparent layer over the browser tab's page that
// asks the page what is under the pointer and draws its box model the way
// DevTools does (margin, border, padding, content), with a tag label.
// Click picks and opens the composer; Shift-click adds to the selection and
// keeps picking; Up and Down walk to the parent and first child; Enter
// finishes; Esc cancels. The wheel scrolls the page under the layer. The
// outline lists the page as a tree for elements the mouse cannot reach.

export interface PickedElement {
  ref: string;
  label: string;
  info: HoverInfo;
}

interface Props {
  run: RunInPage;
  /** "pick" takes the pointer; "passive" only keeps the selection drawn behind the composer. */
  mode: "pick" | "passive";
  selection: PickedElement[];
  onSelectionChange: (next: PickedElement[]) => void;
  onFinish: (selection: PickedElement[]) => void;
  onCancel: () => void;
}

type HostBox = { left: number; top: number; width: number; height: number };

function hostBox(info: HoverInfo, inset: [number, number, number, number] = [0, 0, 0, 0], outset: [number, number, number, number] = [0, 0, 0, 0]): HostBox {
  const s = info.scale || 1;
  const left = info.rect.x - outset[3] + inset[3];
  const top = info.rect.y - outset[0] + inset[0];
  const width = info.rect.width + outset[1] + outset[3] - inset[1] - inset[3];
  const height = info.rect.height + outset[0] + outset[2] - inset[0] - inset[2];
  return { left: left / s, top: top / s, width: Math.max(0, width / s), height: Math.max(0, height / s) };
}

function sum(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

function BoxModel({ info }: { info: HoverInfo }) {
  const margin = hostBox(info, undefined, info.margin);
  const border = hostBox(info);
  const padding = hostBox(info, info.border);
  const content = hostBox(info, sum(info.border, info.padding));
  const style = (box: HostBox) => ({ left: box.left, top: box.top, width: box.width, height: box.height });
  return (
    <>
      <div className="cp-box cp-box--margin" style={style(margin)} />
      <div className="cp-box cp-box--border" style={style(border)} />
      <div className="cp-box cp-box--padding" style={style(padding)} />
      <div className="cp-box cp-box--content" style={style(content)} />
    </>
  );
}

function Tag({ info, hostHeight }: { info: HoverInfo; hostHeight: number }) {
  const box = hostBox(info);
  const above = box.top > 26;
  const top = above ? box.top - 24 : Math.min(box.top + box.height + 4, hostHeight - 24);
  return (
    <div className="cp-tag" style={{ left: Math.max(4, box.left), top: Math.max(4, top) }}>
      <span>{info.label}</span>
      <span className="cp-tag__size">{Math.round(info.rect.width)}×{Math.round(info.rect.height)}</span>
    </div>
  );
}

export default function PointPicker({ run, mode, selection, onSelectionChange, onFinish, onCancel }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hintEdge, setHintEdge] = useState<"top" | "bottom">("top");
  const hintRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<HoverProbeCall | null>(null);
  // What the drawn hover answers: the pointer at a point, a keyboard walk, or
  // an outline row. A click picks it only when it is about the click itself.
  const hoverOrigin = useRef<{ x: number; y: number } | "walk" | "outline" | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => setSize({ width: layer.clientWidth, height: layer.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mode === "pick") layerRef.current?.focus();
    else setHover(null);
  }, [mode]);

  // The hint covers part of the page. When the pointer rests on an element
  // the hint hides part of, the hint moves to the other edge. The delay lets
  // the pointer cross such an element on its way to the hint's buttons.
  useEffect(() => {
    const hint = hintRef.current;
    const layer = layerRef.current;
    if (mode !== "pick" || !hover || !hint || !layer) return;
    const box = hostBox(hover);
    const area = hint.getBoundingClientRect();
    const origin = layer.getBoundingClientRect();
    const left = area.left - origin.left;
    const top = area.top - origin.top;
    const covered = box.left < left + area.width && box.left + box.width > left && box.top < top + area.height && box.top + box.height > top;
    if (!covered || box.height > origin.height * 0.6) return;
    const timer = window.setTimeout(() => setHintEdge((edge) => (edge === "top" ? "bottom" : "top")), 250);
    return () => window.clearTimeout(timer);
  }, [hover, mode]);

  // After the page scrolls the picked elements moved; ask for their boxes again.
  const refreshSelection = useCallback(async () => {
    const width = layerRef.current?.clientWidth ?? 0;
    const current = selectionRef.current;
    if (!current.length) return;
    const next: PickedElement[] = [];
    for (const item of current) {
      const info = await hoverInPage(run, { op: "ref", ref: item.ref, hostWidth: width }).catch(() => null);
      next.push(info ? { ...item, info } : item);
    }
    onSelectionChange(next);
  }, [onSelectionChange, run]);

  // One page call in flight at a time; a move that arrives meanwhile
  // replaces the queued one, so a fast pointer never piles up calls.
  const ask = useCallback(
    (call: HoverProbeCall) => {
      pending.current = call;
      if (inFlight.current) return;
      const pump = async () => {
        inFlight.current = true;
        try {
          while (pending.current) {
            const next = pending.current;
            pending.current = null;
            const info = await hoverInPage(run, next).catch(() => null);
            if (!pending.current) {
              hoverOrigin.current = next.op === "at" || next.op === "scroll" ? { x: next.x, y: next.y } : "walk";
              setHover(info);
            }
            if (next.op === "scroll") await refreshSelection();
          }
        } finally {
          inFlight.current = false;
        }
      };
      void pump();
    },
    [refreshSelection, run],
  );

  const pointFor = (event: { clientX: number; clientY: number }) => {
    const rect = layerRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width } : null;
  };

  const toggle = (info: HoverInfo, keepPicking: boolean) => {
    const exists = selection.some((item) => item.ref === info.ref);
    const next = exists && keepPicking
      ? selection.filter((item) => item.ref !== info.ref)
      : exists ? selection : [...selection, { ref: info.ref, label: info.label, info }].slice(0, 12);
    onSelectionChange(next);
    if (!keepPicking) onFinish(next);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (mode !== "pick") return;
    const point = pointFor(event);
    if (point) ask({ op: "at", x: point.x, y: point.y, hostWidth: point.width });
  };

  const onPointerDown = async (event: React.PointerEvent) => {
    if (mode !== "pick" || event.button !== 0) return;
    event.preventDefault();
    const point = pointFor(event);
    if (!point) return;
    // A hover left by an outline row, or one still catching up with a fast
    // pointer, names another element than the one under the click.
    const origin = hoverOrigin.current;
    const current = hover && (origin === "walk" || (origin && typeof origin === "object" && Math.abs(origin.x - point.x) < 3 && Math.abs(origin.y - point.y) < 3));
    const info = current ? hover : await hoverInPage(run, { op: "at", x: point.x, y: point.y, hostWidth: point.width }).catch(() => null);
    if (info) toggle(info, event.shiftKey);
  };

  const onWheel = (event: React.WheelEvent) => {
    if (mode !== "pick") return;
    const point = pointFor(event);
    if (point) ask({ op: "scroll", x: point.x, y: point.y, dx: event.deltaX, dy: event.deltaY, hostWidth: point.width });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (mode !== "pick") return;
    const width = layerRef.current?.clientWidth ?? 0;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (outlineOpen) setOutlineOpen(false);
      else onCancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!selection.length && hover) toggle(hover, false);
      else if (selection.length) onFinish(selection);
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && hover) {
      event.preventDefault();
      ask({ op: event.key === "ArrowUp" ? "parent" : "child", ref: hover.ref, hostWidth: width });
    } else if (event.key === " " && hover) {
      event.preventDefault();
      toggle(hover, true);
    }
  };

  const count = selection.length;
  return (
    <div
      ref={layerRef}
      className="cp-layer"
      data-mode={mode}
      data-testid="point-picker"
      tabIndex={mode === "pick" ? 0 : -1}
      onPointerMove={onPointerMove}
      onPointerDown={(event) => void onPointerDown(event)}
      onPointerLeave={() => mode === "pick" && setHover(null)}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {mode === "pick" && hover ? (
        <>
          <BoxModel info={hover} />
          <Tag info={hover} hostHeight={size.height} />
        </>
      ) : null}
      {selection.map((item, index) => {
        const box = hostBox(item.info);
        return (
          <div key={item.ref}>
            <div className="cp-box cp-box--selected" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
            <div className="cp-badge" style={{ left: box.left, top: box.top }}>{index + 1}</div>
          </div>
        );
      })}
      {mode === "pick" ? (
        <div ref={hintRef} className="cp-panel cp-hint spark-glass--strong spark-overlay-surface" data-edge={hintEdge} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
          <span className="cp-hint__text">
            {count ? <span className="cp-hint__count">{count} picked · </span> : null}
            Click an element
            <span className="cp-kbd">⇧</span>click adds
            <span className="cp-kbd">↑</span><span className="cp-kbd">↓</span>parent, child
          </span>
          <button
            type="button"
            className={`spark-btn cp-btn${outlineOpen ? " is-active" : ""}`}
            aria-pressed={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
            title="Pick from the page's outline"
          >
            Outline
          </button>
          <button type="button" className="spark-btn cp-btn" onClick={onCancel} title="Stop picking (Esc)">
            Cancel
          </button>
          <button
            type="button"
            className="spark-btn is-primary cp-btn"
            disabled={!count}
            onClick={() => onFinish(selection)}
            title="Describe the picked elements (Enter)"
          >
            Done{count ? ` (${count})` : ""}
          </button>
        </div>
      ) : null}
      {mode === "pick" && outlineOpen ? (
        <OutlinePanel
          run={run}
          selectedRefs={new Set(selection.map((item) => item.ref))}
          hostWidth={size.width}
          onHover={(info) => {
            hoverOrigin.current = "outline";
            setHover(info);
          }}
          onToggle={(info) => toggle(info, true)}
          onClose={() => {
            setOutlineOpen(false);
            layerRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function OutlinePanel({
  run,
  selectedRefs,
  hostWidth,
  onHover,
  onToggle,
  onClose,
}: {
  run: RunInPage;
  selectedRefs: ReadonlySet<string>;
  hostWidth: number;
  onHover: (info: HoverInfo | null) => void;
  onToggle: (info: HoverInfo) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<OutlineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    let cancelled = false;
    outlineInPage(run)
      .then((result) => !cancelled && setRows(result.rows))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [run]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!rows || !needle) return rows ?? [];
    return rows.filter((row) => `${row.ref} ${row.label} ${row.role} ${row.name}`.toLowerCase().includes(needle));
  }, [filter, rows]);
  const locate = (row: OutlineRow) => hoverInPage(run, { op: "ref", ref: row.ref, hostWidth }).catch(() => null);
  return (
    <div
      className="cp-panel cp-outline spark-glass--strong spark-overlay-surface"
      data-testid="point-outline"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The layer reads arrows, Space and Enter as picking keys, so none of
        // the panel's keys reach it; Escape closes the panel here instead.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <input
        className="cp-note cp-note--line cp-outline__search"
        placeholder="Filter by text, tag or @ref"
        value={filter}
        autoFocus
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="cp-outline__list" role="listbox" aria-label="Page outline" aria-multiselectable>
        {error ? <div className="cp-status" data-tone="error" style={{ padding: 8 }}>{error}</div> : null}
        {!rows && !error ? <div className="cp-status" style={{ padding: 8 }}>Reading the page…</div> : null}
        {shown.map((row) => (
          <button
            key={row.ref}
            type="button"
            role="option"
            aria-selected={selectedRefs.has(row.ref)}
            className="cp-outline__row"
            style={{ paddingLeft: 6 + Math.min(row.depth, 12) * 10 }}
            onMouseEnter={() => void locate(row).then(onHover)}
            onMouseLeave={() => onHover(null)}
            onClick={() => void locate(row).then((info) => info && onToggle(info))}
          >
            <span>{row.label}</span>
            {row.name ? <span className="cp-outline__name">{row.name}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
