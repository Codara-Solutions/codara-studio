import React, { useEffect, useRef } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ShellInfo } from "@shared/types";
import { ShellIntegration } from "../terminal/shell-integration";

interface Props {
  workerId: string;
  shell: ShellInfo;
  cwd: string;
  active: boolean;
  onPid: (pid: number) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  onShellIntegration?: (integration: ShellIntegration | null) => void;
  fontSize?: number;
}

const THEME: ITheme = {
  background: "#1a1a1a",
  foreground: "#e6e6e6",
  cursor: "#F0C419",
  cursorAccent: "#1a1a1a",
  selectionBackground: "rgba(240, 196, 25, 0.35)",
  black: "#222222",
  red: "#ff6e6e",
  green: "#7ad48f",
  yellow: "#F0C419",
  blue: "#7fb3ff",
  magenta: "#c99bff",
  cyan: "#5dd6d6",
  white: "#e6e6e6",
  brightBlack: "#5a5a5a",
  brightRed: "#ff8a8a",
  brightGreen: "#9be0ad",
  brightYellow: "#ffd54f",
  brightBlue: "#a3c8ff",
  brightMagenta: "#dabaff",
  brightCyan: "#84e1e1",
  brightWhite: "#ffffff",
};

const RESIZE_DEBOUNCE_MS = 120;

function detectWindowsPty():
  | { backend: "conpty" | "winpty"; buildNumber: number }
  | undefined {
  if (typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent;
  if (!/Windows/i.test(ua)) return undefined;
  // ConPTY is reliable on Windows 10 1809+ (build 17763) and on Windows 11.
  // We can't reliably read the OS build from the renderer, so fall back to a
  // safe modern build number — xterm.js uses this for wrap-line heuristics.
  return { backend: "conpty", buildNumber: 22000 };
}

export default function TerminalView({
  workerId,
  shell,
  cwd,
  active,
  onPid,
  onExit,
  onShellIntegration,
  fontSize = 13,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string>(workerId);
  const disposeListenersRef = useRef<Array<() => void>>([]);
  const spawnedRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const integrationRef = useRef<ShellIntegration | null>(null);
  const onShellIntegrationRef = useRef(onShellIntegration);
  onShellIntegrationRef.current = onShellIntegration;

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace',
      fontSize,
      lineHeight: 1.2,
      // TUIs (Claude/Codex) constantly reposition the cursor while drawing
      // spinners and frames. A bright blinking block cursor visibly jumps
      // around, which looks broken. A thin non-blinking bar that hides when
      // the pane isn't focused matches a normal terminal's behavior.
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      allowTransparency: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 5000,
      convertEol: false,
      windowsPty: detectWindowsPty(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // Block-strip parser. Attached for every pane — orchestration workers
    // are now plain pwsh sessions too, so the OSC 133/633 markers from the
    // user's spark.ps1 shell-integration land here just like a manual term.
    {
      const integration = new ShellIntegration(term);
      integrationRef.current = integration;
      onShellIntegrationRef.current?.(integration);
    }

    let cols = 80;
    let rows = 24;
    try {
      fit.fit();
      cols = term.cols;
      rows = term.rows;
    } catch {
      /* DOM may not be ready; fall back to defaults */
    }
    lastSentSizeRef.current = { cols, rows };

    const offData = window.spark.pty.onData(workerId, (data) => {
      // Main process now ships Uint8Array. xterm.js's parser preserves byte
      // boundaries across writes, which is what TUIs (claude/codex/Ink) need
      // to render ANSI cursor sequences without smearing.
      term.write(data as Uint8Array);
    });
    const offExit = window.spark.pty.onExit(workerId, (info) => {
      term.write(`\r\n\x1b[2;37m[process exited (${info.exitCode})]\x1b[0m\r\n`);
      onExit?.(info);
    });
    disposeListenersRef.current.push(offData, offExit);

    const dataDisposable = term.onData((data) => {
      void window.spark.pty.write(workerId, data);
    });

    // Standard copy/paste. Ctrl+Shift+C / Ctrl+Shift+V always copy/paste.
    // Ctrl+C also copies when there's a selection (Windows convention) — only
    // sends ^C to the PTY when nothing is selected. Returning false from the
    // custom-key handler tells xterm to skip its default key processing.
    const writeClipboardToTerm = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) await window.spark.pty.write(workerId, text);
      } catch {
        /* clipboard may be empty or blocked */
      }
    };
    const copySelection = () => {
      const sel = term.getSelection();
      if (!sel) return false;
      void navigator.clipboard.writeText(sel);
      term.clearSelection();
      return true;
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "c") {
        copySelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "v") {
        void writeClipboardToTerm();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && key === "c" && term.hasSelection()) {
        copySelection();
        return false;
      }
      return true;
    });

    // Right-click paste, matching Windows Terminal / Wave default.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
      } else {
        void writeClipboardToTerm();
      }
    };
    hostRef.current.addEventListener("contextmenu", onContextMenu);

    let cancelled = false;
    (async () => {
      try {
        const res = await window.spark.pty.spawn({ id: workerId, shell, cwd, cols, rows });
        if (cancelled) return;
        spawnedRef.current = true;
        onPid(res.pid);
        term.focus();
      } catch (err) {
        term.write(`\r\n\x1b[31mfailed to spawn: ${(err as Error).message}\x1b[0m\r\n`);
      }
    })();

    // Debounced resize. ConPTY emits a fresh redraw on every resize; without
    // debouncing, drag-resize floods scrollback with duplicate frames and the
    // terminal looks broken. Always xterm-resize first, then pty-resize.
    const scheduleResize = () => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        if (!fitRef.current || !termRef.current) return;
        try {
          fitRef.current.fit();
        } catch {
          return;
        }
        const c = termRef.current.cols;
        const r = termRef.current.rows;
        const last = lastSentSizeRef.current;
        if (last && last.cols === c && last.rows === r) return;
        lastSentSizeRef.current = { cols: c, rows: r };
        if (spawnedRef.current) {
          void window.spark.pty.resize(workerId, c, r);
        }
      }, RESIZE_DEBOUNCE_MS);
    };

    const ro = new ResizeObserver(scheduleResize);
    ro.observe(hostRef.current);

    return () => {
      cancelled = true;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      ro.disconnect();
      hostRef.current?.removeEventListener("contextmenu", onContextMenu);
      dataDisposable.dispose();
      for (const d of disposeListenersRef.current) d();
      disposeListenersRef.current = [];
      if (integrationRef.current) {
        integrationRef.current.dispose();
        integrationRef.current = null;
        onShellIntegrationRef.current?.(null);
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      void window.spark.pty.dispose(ptyIdRef.current);
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    }
  }, [fontSize]);

  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
    }
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="xterm-host"
      tabIndex={-1}
      onMouseDown={() => {
        queueMicrotask(() => termRef.current?.focus());
      }}
    />
  );
}
