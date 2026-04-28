import React, { useEffect, useRef } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ShellInfo } from "@shared/types";

interface Props {
  workerId: string;
  shell: ShellInfo;
  cwd: string;
  active: boolean;
  onPid: (pid: number) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
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

export default function TerminalView({
  workerId,
  shell,
  cwd,
  active,
  onPid,
  onExit,
  fontSize = 13,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string>(workerId);
  const disposeListenersRef = useRef<Array<() => void>>([]);
  const spawnedRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace',
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: true,
      theme: THEME,
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // Initial fit before spawn so we know cols/rows.
    let cols = 80;
    let rows = 24;
    try {
      fit.fit();
      cols = term.cols;
      rows = term.rows;
    } catch {
      /* DOM may not be ready; fall back to defaults */
    }

    const offData = window.spark.pty.onData(workerId, (data) => term.write(data));
    const offExit = window.spark.pty.onExit(workerId, (info) => {
      term.write(`\r\n\x1b[2;37m[process exited (${info.exitCode})]\x1b[0m\r\n`);
      onExit?.(info);
    });
    disposeListenersRef.current.push(offData, offExit);

    const dataDisposable = term.onData((data) => {
      void window.spark.pty.write(workerId, data);
    });

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

    // Resize observer to fit on container changes
    const ro = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
        const c = termRef.current.cols;
        const r = termRef.current.rows;
        if (spawnedRef.current) {
          void window.spark.pty.resize(workerId, c, r);
        }
      } catch {
        /* ignore */
      }
    });
    ro.observe(hostRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      dataDisposable.dispose();
      for (const d of disposeListenersRef.current) d();
      disposeListenersRef.current = [];
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      void window.spark.pty.dispose(ptyIdRef.current);
      termRef.current = null;
      fitRef.current = null;
    };
    // We intentionally only run this effect once per worker mount.
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
        // Defer to the next tick so xterm's own mousedown handler can run first
        // (it positions selection); then we make sure the textarea has focus.
        queueMicrotask(() => termRef.current?.focus());
      }}
    />
  );
}
