import React, { useEffect, useMemo, useRef, useState } from "react";
import { LoomIcon, WORKER_TONE } from "./FlowNodes";
import type { PaletteChoice } from "./model";
import { STEP_META, STEP_TONE, STEP_TYPES } from "./step-meta";

// The add-node palette — n8n's "what happens next?" panel, at Codara size.
// A search box on top (focused on open, so you can just type "python" or
// "slack"), then every node grouped by what it is FOR: AI, Run, Flow, Output.
// Arrow keys move, Enter picks, Escape closes; the mouse works too. Opened
// from a node's '+' handle (anchored) or the toolbar (centered). Picking an
// entry inserts the node already wired.

interface Entry {
  key: string;
  choice: PaletteChoice;
  title: string;
  blurb: string;
  group: "AI" | "Run" | "Flow" | "Output";
  tone: string;
  keywords: string[];
  icon: React.ReactNode;
}

function entries(): Entry[] {
  const out: Entry[] = [
    {
      key: "worker",
      choice: { kind: "worker" },
      title: "Worker",
      blurb: "An AI agent runs a prompt in your workspace.",
      group: "AI",
      tone: WORKER_TONE,
      keywords: ["agent", "ai", "model", "prompt", "claude", "gpt", "cora"],
      icon: <LoomIcon kind="worker" tone={WORKER_TONE} size={15} />,
    },
  ];
  for (const type of STEP_TYPES) {
    const m = STEP_META[type];
    out.push({
      key: `step:${type}`,
      choice: { kind: "step", stepType: type },
      title: m.title,
      blurb: m.blurb,
      group: type === "notify" || type === "writeFile" ? "Output" : "Run",
      tone: STEP_TONE,
      keywords: m.keywords,
      icon: <LoomIcon kind="step" stepType={type} tone={STEP_TONE} size={15} />,
    });
  }
  out.push(
    {
      key: "guard",
      choice: { kind: "guard" },
      title: "Guard",
      blurb: "Branch on a condition — pass or fail.",
      group: "Flow",
      tone: "var(--ok)",
      keywords: ["if", "condition", "branch", "tests", "check", "route"],
      icon: <LoomIcon kind="guard" tone="var(--ok)" size={15} />,
    },
    {
      key: "merge",
      choice: { kind: "merge" },
      title: "Merge",
      blurb: "Join parallel branches back together.",
      group: "Flow",
      tone: "var(--info)",
      keywords: ["join", "wait", "combine", "fan-in", "all", "any"],
      icon: <LoomIcon kind="merge" tone="var(--info)" size={15} />,
    },
  );
  return out;
}

const GROUP_ORDER: Entry["group"][] = ["AI", "Run", "Flow", "Output"];

function matches(e: Entry, q: string): boolean {
  if (!q) return true;
  const hay = `${e.title} ${e.blurb} ${e.group} ${e.keywords.join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export interface PaletteState {
  /** screen coords (relative to the canvas container) to anchor the popover. */
  x: number;
  y: number;
  /** the node + handle we're adding FROM, or null for a free (toolbar) add. */
  from: { nodeId: string; branch?: "pass" | "fail" } | null;
}

export default function AddNodePalette({
  state,
  onPick,
  onClose,
}: {
  state: PaletteState;
  onPick: (choice: PaletteChoice) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const all = useMemo(entries, []);
  const visible = useMemo(() => all.filter((e) => matches(e, query.trim())), [all, query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Defer so the opening click doesn't immediately close it.
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    const f = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.clearTimeout(t);
      window.cancelAnimationFrame(f);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onClose]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (visible.length === 0 ? 0 : (c + 1) % visible.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (visible.length === 0 ? 0 : (c - 1 + visible.length) % visible.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = visible[cursor];
      if (pick) onPick(pick.choice);
    }
  };

  // Clamp the popover inside the canvas: it's taller than the old one.
  const width = 300;

  let index = -1;
  return (
    <div
      ref={ref}
      className="loom-palette spark-fade-in"
      role="dialog"
      aria-label="Add node"
      onKeyDown={onKey}
      style={{ position: "absolute", left: state.x, top: state.y, width, zIndex: 20 }}
    >
      <div className="loom-palette__head">
        <span className="spark-eyebrow" style={{ color: "var(--muted-2)" }}>
          {state.from
            ? `Add after ${state.from.branch ? `${state.from.branch} branch` : "this node"}`
            : "Add a node"}
        </span>
        <input
          ref={inputRef}
          className="spark-input loom-palette__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes… (python, webhook, if)"
          aria-label="Search nodes"
        />
      </div>
      <div className="loom-palette__list" role="listbox" aria-label="Node kinds">
        {visible.length === 0 && (
          <div className="loom-palette__empty">Nothing matches “{query.trim()}”.</div>
        )}
        {GROUP_ORDER.map((group) => {
          const rows = visible.filter((e) => e.group === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="loom-palette__group">
              <div className="loom-palette__group-label spark-eyebrow">{group}</div>
              {rows.map((e) => {
                index += 1;
                const i = index;
                const active = i === cursor;
                return (
                  <button
                    key={e.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-index={i}
                    data-palette-key={e.key}
                    className={`loom-palette__item${active ? " is-active" : ""}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => onPick(e.choice)}
                  >
                    <span
                      aria-hidden
                      className="loom-palette__icon"
                      style={{ "--pal-tone": e.tone } as React.CSSProperties}
                    >
                      {e.icon}
                    </span>
                    <span className="loom-palette__text">
                      <span className="loom-palette__title">{e.title}</span>
                      <span className="loom-palette__blurb">{e.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="loom-palette__foot spark-mono">
        <span>↑↓ move</span>
        <span>↵ add</span>
        <span>esc close</span>
      </div>
    </div>
  );
}
