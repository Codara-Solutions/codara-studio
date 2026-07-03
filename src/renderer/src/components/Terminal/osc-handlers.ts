import type { IMarker, Terminal } from "@xterm/xterm";

// OSC handlers for the bottom-strip terminal panes.
//
// OSC 7 — `file://<host>/<path>` — shell reports current working directory.
// OSC 133;A — prompt start; we drop a non-disposing xterm marker so callers
//   can later highlight per-prompt blocks inline (the marker survives the
//   buffer trim threshold xterm enforces by default).
// OSC 8888;file=<path> — Codara-private "open file in editor" extension. The
//   shell-integration scripts emit it via the `spark_open` / `tp` command;
//   the renderer dispatches `spark:terax-open` so any registered editor
//   subscriber can pop the file open.
//
// All handlers return `true` from the registerOscHandler callback so xterm
// treats the sequence as fully consumed and never tries to render it.

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export interface PromptTracker {
  getMarker: () => IMarker | null;
  dispose: () => void;
}

export function registerPromptTracker(term: Terminal): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    if (data.startsWith("A")) {
      marker?.dispose();
      marker = term.registerMarker(0);
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

export interface SparkOpenInput {
  file: string;
}

export function registerSparkOpenHandler(
  term: Terminal,
  onOpen: (input: SparkOpenInput) => void,
): () => void {
  const d = term.parser.registerOscHandler(8888, (data) => {
    const input = parseSparkOpen(data);
    if (input) onOpen(input);
    return true;
  });
  return () => d.dispose();
}

function parseOsc7(data: string): string | null {
  // Format: `file://[host]/path`. Host is irrelevant for local terminals — we
  // strip whatever the shell put there and decode the percent-escaped path.
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed UTF-8 — keep raw path */
  }
  // Windows shells emit `/C:/Users/foo`; strip the leading slash so we get a
  // valid drive-rooted path. Linux/macOS paths are already absolute (`/home/…`).
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

function parseSparkOpen(data: string): SparkOpenInput | null {
  const fileMatch = data.match(/file=([^;]+)/);
  if (!fileMatch) return null;
  try {
    return { file: decodeURIComponent(fileMatch[1]) };
  } catch {
    return { file: fileMatch[1] };
  }
}
