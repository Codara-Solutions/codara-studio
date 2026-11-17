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

// Separators inside quotes belong to an argument (a commit message, an echo),
// so they must not start a new command segment that the anchored checks see.
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += char + command[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n" || char === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

// Headless test runs and browser installs are ordinary project work; only the
// subcommands that open a visible browser window bypass Studio's Browser.
const RUNNER_PREFIX = String.raw`(?:(?:npx|bunx|yarn|pnpm\s+(?:exec|dlx))\s+)?`;
const GUI_AUTOMATION_COMMAND = new RegExp(
  [
    `^${RUNNER_PREFIX}playwright\\s+(?:open|cr|ff|wk|codegen|show-report|show-trace)(?:\\s|$)`,
    `^${RUNNER_PREFIX}playwright\\s+test\\b[^\\n]*\\s--(?:headed|ui|debug)\\b`,
    `^${RUNNER_PREFIX}(?:\\S*\\/)?(?:chromedriver|geckodriver)(?:\\s|$)`,
  ].join("|"),
  "i",
);

export function launchesExternalBrowser(command: string): boolean {
  const normalized = command.replace(/\\\r?\n/g, " ");
  // Interpreter one-liners hide the launch inside a quoted argument, so these
  // unanchored checks run over the whole command, quotes included.
  if (/\bStart-Process\b[^\r\n]*(?:https?:|www\.)/i.test(normalized)) return true;
  if (/\b(?:python\d*|py)\s+-m\s+webbrowser\b/i.test(normalized)) return true;
  if (/\bwebbrowser\.(?:open|open_new|open_new_tab)\s*\(/i.test(normalized)) return true;
  for (const rawSegment of splitShellSegments(normalized)) {
    let segment = rawSegment
      .trim()
      .replace(/^[({]+\s*/, "")
      .replace(/^(?:(?:sudo|nohup|command|builtin)\s+)+/i, "");
    // `env FOO=bar open …` and `FOO=bar open …` are common wrappers. Peel only
    // leading assignments; the command itself remains available to the checks
    // below.
    segment = segment
      .replace(/^env(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*\s+/i, "")
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
    if (!segment) continue;
    // Quotes keep a commit message's "; open" out of the segment checks, but a
    // shell's -c script or an eval string is a command line of its own.
    const nested =
      /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(segment) ??
      /^eval\s+(["'])([\s\S]*)\1\s*$/.exec(segment);
    if (nested && launchesExternalBrowser(nested[2])) return true;
    if (/^(?:\S*\/)?open(?:\s|$)/i.test(segment)) return true;
    if (/^(?:\S*\/)?(?:xdg-open|sensible-browser|gnome-open|kde-open)(?:\s|$)/i.test(segment)) {
      return true;
    }
    if (/^(?:\S*\/)?gio\s+open(?:\s|$)/i.test(segment)) return true;
    if (/^(?:\S*\/)?osascript(?:\s|$)/i.test(segment)) return true;
    if (/^(?:cmd(?:\.exe)?\s+\/c\s+)?start\s+(?:"[^"]*"\s+)?(?:https?:|www\.)/i.test(segment)) {
      return true;
    }
    if (
      /^(?:"[^"\r\n]*\/)?(?:google chrome|safari)(?:\.app\/Contents\/MacOS\/[^"\r\n]+)?"?(?:\s|$)/i.test(segment) ||
      /^(?:\S*\/)?(?:google-chrome(?:-stable)?|chromium(?:-browser)?|firefox|microsoft-edge|msedge)(?:\s|$)/i.test(segment)
    ) return true;
    if (GUI_AUTOMATION_COMMAND.test(segment)) return true;
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
      "to open, inspect, click, type, scroll, and capture the page; do not launch an external browser. " +
      "Headless test runs such as `npx playwright test` stay allowed.",
  };
}
