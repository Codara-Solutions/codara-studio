import React, { useEffect, useRef } from "react";
import { TerminalPane, type TerminalPaneHandle } from "../components/Terminal/TerminalPane";
import type { ShellInfo } from "@shared/types";
import type { SparkOpenInput } from "../components/Terminal/useTerminalSession";
import type { Tab, TabId, TerminalTab } from "./types";

// TerminalStack hosts every terminal tab in the workspace. Tabs stay mounted
// across switches so the PTY scrollback, prompt state, and any running TUI
// (vim, htop, etc.) survive without redrawing.
//
// Detected URL events bubble up here unmodified — App.tsx subscribes via
// `onDetectedUrl` to optionally auto-spawn a preview tab.
//
// `onSparkOpen` carries `tp <file>` / `spark_open <file>` requests from
// inside the shell to the parent so the editor can open them.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  shell: ShellInfo | null;
  onDetectedUrl: (id: TabId, url: string) => void;
  onSparkOpen: (input: SparkOpenInput) => void;
  onExit: (id: TabId, info: { exitCode: number; signal?: number }) => void;
}

export default function TerminalStack({
  tabs,
  activeId,
  shell,
  onDetectedUrl,
  onSparkOpen,
  onExit,
}: Props) {
  const terminals = tabs.filter((t): t is TerminalTab => t.kind === "terminal");

  // Stable per-tab callback bundles — TerminalPane re-creates the xterm
  // instance whenever its prop identities change, so we must not hand it
  // fresh closures every render.
  const detectedRef = useRef(onDetectedUrl);
  const sparkOpenRef = useRef(onSparkOpen);
  const exitRef = useRef(onExit);
  useEffect(() => {
    detectedRef.current = onDetectedUrl;
  }, [onDetectedUrl]);
  useEffect(() => {
    sparkOpenRef.current = onSparkOpen;
  }, [onSparkOpen]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  type Bundle = {
    onDetectedUrl: (url: string) => void;
    onSparkOpen: (input: SparkOpenInput) => void;
    onExit: (info: { exitCode: number; signal?: number }) => void;
  };
  const bundles = useRef(new Map<TabId, Bundle>());
  const getBundle = (id: TabId): Bundle => {
    let b = bundles.current.get(id);
    if (!b) {
      b = {
        onDetectedUrl: (url: string) => detectedRef.current(id, url),
        onSparkOpen: (input: SparkOpenInput) => sparkOpenRef.current(input),
        onExit: (info) => exitRef.current(id, info),
      };
      bundles.current.set(id, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set(terminals.map((t) => t.id));
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [terminals]);

  if (terminals.length === 0) return null;
  if (!shell) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted)",
          fontSize: 12,
        }}
      >
        No shell detected.
      </div>
    );
  }

  // Hold a ref to the active TerminalPane handle so we could focus on tab
  // change in the future. Currently the pane focuses itself on first
  // mount; switching tabs doesn't auto-focus to avoid stealing focus from
  // a chat composer the user just typed in.
  const handlesRef = useRef<Map<TabId, TerminalPaneHandle | null>>(new Map());
  const setHandle = (id: TabId, h: TerminalPaneHandle | null) => {
    if (h) handlesRef.current.set(id, h);
    else handlesRef.current.delete(id);
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {terminals.map((t) => {
        const visible = t.id === activeId;
        const bundle = getBundle(t.id);
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: visible ? 2 : 1,
            }}
          >
            <TerminalPane
              ref={(h) => setHandle(t.id, h)}
              sessionId={t.id}
              shell={shell}
              initialCwd={t.cwd}
              visible={visible}
              onDetectedLocalUrl={bundle.onDetectedUrl}
              onSparkOpen={bundle.onSparkOpen}
              onExit={bundle.onExit}
            />
          </div>
        );
      })}
    </div>
  );
}
