import type { RuntimeState } from "./types";

// Agent-CLI detection tables shared by the renderer (useTerminalSession's
// live state poller / chip detection) and the main process (the terminal
// agent notifier's stream watcher). One source of truth: a pattern tuned
// for one side automatically benefits the other, and the two sides can
// never drift apart on what "Claude is working" looks like.
//
// Everything in this module is pure data + pure string functions — no DOM,
// no Electron, no Node imports — so it is safe to import from any process.

// Internal-only union of every agent CLI we can detect from terminal output.
// Spark's public surface (App.tsx, TerminalStack.tsx, run-store, etc.) still
// only models the three first-party runtimes — anything outside that set is
// coerced to `null` at the onAgentState boundary so the UI accent / tab-type
// machinery doesn't need to grow new cases for each new banner we recognise.
// Detection is still useful even when coerced: the running=true edge fires,
// which is enough to keep the activity indicator in sync.
export type AgentRuntime =
  | "claude"
  | "codex"
  | "cursor"
  | "aider"
  | "droid"
  | "amp"
  | "opencode"
  | "grok"
  | "hermes"
  | "pi"
  | "antigravity"
  | "kimi"
  | "kiro"
  | "copilot"
  | "cline";

// Public runtime tag emitted through onAgentState. Mirrors the three runtimes
// the rest of the app already knows how to render. The boundary in
// useTerminalSession coerces every other AgentRuntime down to `null`.
export type PublicAgentRuntime = "claude" | "codex" | "cursor";

export const KNOWN_PUBLIC_RUNTIMES: ReadonlySet<AgentRuntime> = new Set([
  "claude",
  "codex",
  "cursor",
]);

export function coercePublicRuntime(runtime: AgentRuntime): PublicAgentRuntime | null {
  return KNOWN_PUBLIC_RUNTIMES.has(runtime) ? (runtime as PublicAgentRuntime) : null;
}

// Banner / first-prompt boilerplate patterns. Order is significant: more
// specific patterns sit before broader ones so a vendor that includes a
// generic keyword (e.g. "Grok") in their banner can't be mis-tagged by a
// looser regex below. Patterns must match launch banner text only — they
// should NOT fire on ordinary shell output (file listings, help text,
// README content, log tails). See research/HERDR_LEARNINGS.md §2 for the
// upstream catalogue these came from.
//
// Caveats per herdr:
//   - pi:     `Pi v` is generic; false positives are plausible in noisy
//             shell output. Documented here rather than dropped because
//             first-mover detection is still useful when we have it.
//   - cline:  detection is unreliable upstream; we keep the banner regex
//             for the running=true edge but expect misses.
//   - copilot: structural-only per herdr (e.g. `esc to cancel` for the
//              working signal). We rely on the banner alone for now.
//
// Whitespace caveat (verified against a live Claude Code v2.1.170 capture,
// 2026-06-10): Ink frequently encodes the gaps BETWEEN words as cursor-forward
// moves (`ESC[1C`) rather than literal spaces — the banner arrives as
// `Claude<ESC[1C>Code<ESC[1C>v2.1.170`, which strips to "ClaudeCodev2.1.170".
// Every inter-word gap in these patterns is therefore `\s*` (zero or more),
// never a literal space or `\s+`.
export const RUNTIME_BANNERS: ReadonlyArray<{ runtime: AgentRuntime; pattern: RegExp }> = [
  // First-party runtimes — keep these at the top so they take precedence.
  { runtime: "codex",      pattern: /OpenAI\s*Codex\s*\(?v?\d/ },
  { runtime: "claude",     pattern: /Claude\s*Code\s*v?\d/ },
  { runtime: "cursor",     pattern: /Cursor\s*(?:Agent|CLI)/i },
  // Third-party CLIs (alphabetical within tier). Each pattern is anchored
  // on banner-style text (product name + version, or a vendor-specific
  // header) so README mentions and stray log lines don't trigger them.
  { runtime: "aider",      pattern: /\baider\s*v\d|\baider\s*chat\b/i },
  { runtime: "amp",        pattern: /\bSourcegraph\s*Amp\b|\bAmp\s*CLI\b/i },
  { runtime: "antigravity",pattern: /\bAntigravity\b|\bagy\s*v?\d/i },
  { runtime: "cline",      pattern: /\bCline\s*v\d|\bcline-cli\b/i },
  { runtime: "copilot",    pattern: /\bGitHub\s*Copilot\s*CLI\b|\bcopilot\s*v\d/i },
  { runtime: "droid",      pattern: /\bDroid\s*CLI\b|\bfactory\.ai\b/i },
  { runtime: "grok",       pattern: /\bGrok\s*v\d|\bxAI\s*Grok\b/i },
  { runtime: "hermes",     pattern: /\bHermes\s*v\d|\bhermes-agent\b/i },
  { runtime: "kimi",       pattern: /\bKimi\s*v\d|\bkimi-code\b/i },
  { runtime: "kiro",       pattern: /\bKiro\s*v\d|\bkiro-cli\b/i },
  { runtime: "opencode",   pattern: /\bOpenCode\s*v\d|\bopencode\b/i },
  // `Pi v` is generic enough that it can plausibly fire on unrelated
  // shell output. Keep it last in the iteration order so any more specific
  // pattern above wins first.
  { runtime: "pi",         pattern: /\bPi\s*v\d/ },
];

// CSI / OSC stripper. Ink (Claude / Codex / Cursor) often positions individual
// characters with cursor moves, so a banner like "Claude Code v2.1.139"
// arrives in the raw byte stream as `C\x1b[H l\x1b[H a…` and a literal
// regex against the unstripped text would never match. Stripping the
// escapes coalesces the characters back into a normal line.
export const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(OSC_RE, "");
}

// Identify which agent CLI is running by scanning a short rolling buffer of
// recent visible text against the RUNTIME_BANNERS table above. Patterns are
// specific enough to live launch banners / first-prompt boilerplate that
// ordinary shell output (file listings, commit messages, README content,
// `claude --help`) does NOT trigger them. Examples:
//   - Codex:  `OpenAI Codex (v0.130.0)`
//   - Claude: `Claude Code v2.1.139`
//   - Cursor: `Cursor Agent (composer-2.5-fast)` / `Cursor CLI v…`
//   - Aider:  `aider v0.65.0`
//   - Droid:  `Droid CLI` / `factory.ai`
// Returns null when nothing matched so the caller leaves the pane alone.
// Iteration order mirrors the table: first-party runtimes first, then
// third-party CLIs ordered most-specific to least-specific.
export function sniffRuntime(text: string): AgentRuntime | null {
  const stripped = stripAnsi(text);
  for (const entry of RUNTIME_BANNERS) {
    if (entry.pattern.test(stripped)) return entry.runtime;
  }
  return null;
}

export function sniffOsc633CommandRuntime(text: string): AgentRuntime | null {
  const re = /\x1b\]633;E;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let runtime: AgentRuntime | null = null;
  while ((match = re.exec(text))) {
    runtime = runtimeFromCommandLine(unescapeOsc633(match[1]));
  }
  return runtime;
}

export function runtimeFromCommandLine(cmdLine: string): AgentRuntime | null {
  const exe = cmdLine
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  if (!exe) return null;
  if (exe === "claude" || exe.endsWith("/claude") || exe.endsWith("\\claude")) return "claude";
  if (exe === "codex" || exe.endsWith("/codex") || exe.endsWith("\\codex")) return "codex";
  if (exe === "agent" || exe.endsWith("/agent") || exe.endsWith("\\agent")) return "cursor";
  return null;
}

// Per-runtime "what is the agent doing right now" pattern tables. Each entry
// owns three sets of regexes that run against the same plain-text tail of the
// xterm buffer (renderer) or the stripped recent byte stream (main).
//
//   `working`: the agent is generating / streaming. Match anything the live
//              status line prints while thinking — most CLIs paint a spinner
//              with text like "esc to interrupt" or "(thinking)".
//   `blocked`: the agent is waiting on the user for permission or
//              confirmation. These prompts are the whole point of the
//              detection — Spark surfaces them as the "needs you" signal.
//   `done`   : the agent has actively printed a completion line (vs simply
//              going quiet, which is `idle`). Today we mostly fall back to
//              the OSC 633;A "prompt is back" boundary (handled elsewhere),
//              but a positive completion match lets us cut over without
//              waiting for the debounce window.
//
// Patterns were lifted from herdr's hand-tuned table (research/HERDR_LEARNINGS
// quick-win B), trimmed to the three runtimes Spark spawns today. The patterns
// match against the CSI/OSC-stripped tail string so Ink's per-character cursor
// moves do not interleave bytes inside the literal we're looking for.
export interface RuntimePatterns {
  working: RegExp[];
  blocked: RegExp[];
  done: RegExp[];
}

export const RUNTIME_PATTERNS: Record<"claude" | "codex" | "cursor", RuntimePatterns> = {
  // Claude Code (Anthropic). VERIFIED against a live v2.1.170 pty capture
  // (2026-06-10): the footer while a turn runs is a whimsical spinner verb
  // plus a stats group — `✽ Pouncing… (3s · ↓ 1 tokens)` — repainted at
  // least once per second (often as tiny partial frames that only rewrite
  // the verb and the seconds digit). "esc to interrupt" is GONE from this
  // version's footer; the patterns keep it for older installs only. The
  // stats group is the reliable signal: `(<n>s ·` and `↓/↑ <n> tokens`.
  // Inter-word gaps are `\s*` because Ink emits them as cursor moves.
  claude: {
    working: [
      // v2.1.17x footer stats: "(3s · ↓ 1 tokens)", "(12s · ↑ 4.2k tokens)",
      // and the hook-runner variant "running sp hooks… 0/2 · 3s · ↓1 tokens)".
      /\(\d+\s*s\s*·/,
      /[↓↑]\s*[\d.,]+\s*k?\s*tokens/i,
      // Verb-only spinner frames — "✻ Pouncing…" — painted for the first
      // ~1s of a turn BEFORE the stats group appears (live capture). Without
      // this the measured working span of a fast turn starts too late and
      // the MIN_WORK gate can swallow the completion alert. Spinner glyph +
      // capitalized whimsical gerund + ellipsis keeps prose from matching.
      /[✻✽✶✢✳∗✺❋]\s*[A-Z][a-z]+ing…/,
      // Older footers (≤ v2.1.1x) and other TUI states.
      /esc\s*to\s*interrupt/i,
      /\(?\s*esc\s*to\s*cancel\s*\)?/i,
      /thinking[…\.]/i,
      /\bworking[…\.]/i,
      /\bcompacting[…\.]/i,
    ],
    blocked: [
      /Do\s*you\s*want\s*to\s*(?:proceed|continue|allow)/i,
      /Allow\s*.*\s*to\s*(?:edit|run|read)/i,
      /\bWaiting\s*for\s*your\s*input\b/i,
      /Press\s*(?:y|n|enter|esc)\s*to/i,
      /Enter\s*your\s*(?:response|answer|choice):/i,
      /Do\s*you\s*trust\s*the\s*files/i,
      // AskUserQuestion-style selector (live-observed v2.1.170): a question
      // with numbered options and the footer "Enter to select · ↑/↓ to
      // navigate · Esc to cancel". The caret+numbered-option shape also
      // covers permission menus repainted without their question line.
      /Enter\s*to\s*select/i,
      /[❯›]\s*\d+\.\s/,
    ],
    done: [
      /Session\s*ended\./i,
      /\bGoodbye\b!?/i,
    ],
  },
  // OpenAI Codex CLI. Lower-case "thinking" / "working" footer lines, and a
  // "shell command" approval prompt that mirrors Claude's permission flow.
  codex: {
    working: [
      /esc\s*to\s*interrupt/i,
      /\(\s*\d+\s*s\s*[·•]\s*esc/i,
      /\(thinking\)/i,
      /\(working\)/i,
      /\bWorking\s*\(\d+\s*s/i,
      /Generating/i,
      /Streaming/i,
    ],
    blocked: [
      /Approve\s*shell\s*command/i,
      /Approve\s*this\s*(?:edit|patch|command)/i,
      /Do\s*you\s*want\s*to\s*(?:proceed|continue)/i,
      // v0.13x dialog chrome (live-captured 2026-06-10): trust / sandbox /
      // confirm prompts all end with "Press enter to confirm…" and render
      // their options as a ›-caret numbered menu.
      /Press\s*enter\s*to\s*(?:confirm|continue)/i,
      /Do\s*you\s*trust\s*the\s*contents/i,
      /[❯›]\s*\d+\.\s/,
      /\[y\/N\]/i,
      /\(y\/n\)/i,
    ],
    done: [
      /Session\s*complete\./i,
      /\bExiting\b\./i,
    ],
  },
  // Cursor Agent / Cursor CLI. Similar Ink TUI patterns; "press enter" and
  // explicit "waiting for confirmation" copy when blocked.
  cursor: {
    working: [
      /esc\s*to\s*interrupt/i,
      /\(generating\)/i,
      /thinking[…\.]/i,
    ],
    blocked: [
      /Waiting\s*for\s*(?:confirmation|approval)/i,
      /Approve\s*(?:edit|patch|tool)/i,
      /Press\s*enter\s*to/i,
      /Continue\?\s*\(y\/n\)/i,
    ],
    done: [
      /Conversation\s*ended\./i,
    ],
  },
};

// Position-guarded pattern test: true iff some match of `re` ENDS strictly
// past `freshFrom` (an offset into `text`). Stream callers concatenate a
// carry of already-processed text in front of each new chunk so phrases
// split across chunk boundaries still match — but a footer that is merely
// SITTING in the carry (painted seconds ago, nothing new) must not keep
// re-asserting "working" on every later unrelated repaint. freshFrom = 0
// degrades to a plain test (snapshot callers like the renderer poller).
const GLOBAL_RE_CACHE = new Map<RegExp, RegExp>();
function matchEndsPast(re: RegExp, text: string, freshFrom: number): boolean {
  if (freshFrom <= 0) return re.test(text);
  let g = GLOBAL_RE_CACHE.get(re);
  if (!g) {
    g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    GLOBAL_RE_CACHE.set(re, g);
  }
  g.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    if (m.index + m[0].length > freshFrom) return true;
    if (m[0].length === 0) g.lastIndex += 1;
  }
  return false;
}

// Match plain text against a runtime's pattern table. Returns the first
// state that fires, in priority order: blocked > working > done. Blocked wins
// over working because a TUI can paint "esc to interrupt" inside a permission
// dialog (the dialog is still rendered above the streaming footer); the
// blocked prompt is the actionable one for the user.
//
// `freshFrom` (optional) is an offset into the STRIPPED text; when given,
// only pattern matches that end past it count. Stream callers pass
// stripAnsi(carry).length so stale carry content can't re-classify; buffer
// snapshot callers omit it.
export function classifyTail(
  runtime: "claude" | "codex" | "cursor",
  tail: string,
  freshFrom = 0,
): RuntimeState | null {
  const table = RUNTIME_PATTERNS[runtime];
  if (!table) return null;
  const stripped = stripAnsi(tail);
  for (const re of table.blocked) {
    if (matchEndsPast(re, stripped, freshFrom)) return "blocked";
  }
  for (const re of table.working) {
    if (matchEndsPast(re, stripped, freshFrom)) return "working";
  }
  for (const re of table.done) {
    if (matchEndsPast(re, stripped, freshFrom)) return "done";
  }
  return null;
}

// Reverse spark.ps1's __Spark-Esc encoding (control chars, ';' and '\'
// are emitted as `\xHH`). Best-effort: unknown escapes are passed through.
export function unescapeOsc633(value: string): string {
  return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

// Detects any "shell is back at a prompt" boundary marker — both VS Code
// OSC 633 (A/B/D/P; deliberately NOT E or C which fire DURING command
// execution) and FinalTerm OSC 133;A. Matches the raw text so it works
// even if xterm's OSC handler chain dropped the dispatch on the floor.
export const PROMPT_MARKER_RE = /\x1b\]633;[ABDP](?:;|\x07)|\x1b\]133;A(?:\x07|\x1b\\)/;
export function hasPromptMarker(text: string): boolean {
  return PROMPT_MARKER_RE.test(text);
}
