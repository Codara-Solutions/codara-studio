// Cora's browser is Codara Studio's own Chromium <webview>. The model also
// has a shell, so this small pre-tool guard prevents it from bypassing that
// surface by launching Safari, Chrome, Edge, or the OS default browser.

export interface ToolBlockDecision {
  block: true;
  reason: string;
}

function shellCommand(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function launchesExternalBrowser(command: string): boolean {
  const normalized = command.replace(/\\\r?\n/g, " ");
  const segments = normalized.split(/(?:\r?\n|&&|\|\||[;|])/);
  for (const rawSegment of segments) {
    let segment = rawSegment
      .trim()
      .replace(/^[({]+\s*/, "")
      .replace(/^(?:(?:sudo|nohup|command|builtin)\s+)+/i, "");
    // `env FOO=bar open …` is a common wrapper. Peel only leading
    // assignments; the command itself remains available to the checks below.
    segment = segment.replace(
      /^env(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*\s+/i,
      "",
    );
    if (!segment) continue;
    if (/^(?:\S*\/)?open(?:\s|$)/i.test(segment)) return true;
    if (/^(?:\S*\/)?(?:xdg-open|sensible-browser|gnome-open|kde-open)(?:\s|$)/i.test(segment)) {
      return true;
    }
    if (/^(?:\S*\/)?gio\s+open(?:\s|$)/i.test(segment)) return true;
    if (/^(?:\S*\/)?osascript(?:\s|$)/i.test(segment)) return true;
    if (/^(?:cmd(?:\.exe)?\s+\/c\s+)?start\s+(?:"[^"]*"\s+)?(?:https?:|www\.)/i.test(segment)) {
      return true;
    }
    if (/\bStart-Process\b[^\r\n]*(?:https?:|www\.)/i.test(segment)) return true;
    if (/\b(?:python\d*|py)\s+-m\s+webbrowser\b/i.test(segment)) return true;
    if (/\bwebbrowser\.(?:open|open_new|open_new_tab)\s*\(/i.test(segment)) return true;
    if (
      /^(?:"[^"\r\n]*\/)?(?:google chrome|safari)(?:\.app\/Contents\/MacOS\/[^"\r\n]+)?"?(?:\s|$)/i.test(segment) ||
      /^(?:\S*\/)?(?:google-chrome(?:-stable)?|chromium(?:-browser)?|firefox|microsoft-edge|msedge)(?:\s|$)/i.test(segment)
    ) return true;
    if (/^(?:npx\s+)?(?:playwright|puppeteer|selenium|chromedriver|geckodriver)(?:\s|$)/i.test(segment)) {
      return true;
    }
  }
  return false;
}

export function studioBrowserOnlyDecision(
  toolName: unknown,
  input: unknown,
): ToolBlockDecision | undefined {
  const normalizedTool = String(toolName ?? "")
    .replace(/^mcp__codara-studio__/i, "")
    .toLowerCase();
  if (normalizedTool !== "bash") return undefined;
  const command = shellCommand(input);
  if (!command || !launchesExternalBrowser(command)) return undefined;
  return {
    block: true,
    reason:
      "Cora may drive only Codara Studio's built-in Browser. Use the codara_preview_* tools " +
      "to open, inspect, click, type, scroll, and capture the page; do not launch an external browser.",
  };
}
