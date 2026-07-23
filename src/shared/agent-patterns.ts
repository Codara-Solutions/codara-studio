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
// Codara's public surface (App.tsx, TerminalStack.tsx, run-store, etc.) still
// only models the two first-party runtimes — anything outside that set is
// coerced to `null` at the onAgentState boundary so the UI accent / tab-type
// machinery doesn't need to grow new cases for each new banner we recognise.
// Detection is still useful even when coerced: the running=true edge fires,
// which is enough to keep the activity indicator in sync.
export type AgentRuntime =
  | "claude"
  | "codex"
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

// Public runtime tag emitted through onAgentState. Mirrors the two runtimes
// the rest of the app already knows how to render. The boundary in
// useTerminalSession coerces every other AgentRuntime down to `null`.
export type PublicAgentRuntime = "claude" | "codex";

export const KNOWN_PUBLIC_RUNTIMES: ReadonlySet<AgentRuntime> = new Set([
  "claude",
  "codex",
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

// Resume-refusal signature. `claude --resume <id>` prints this (then exits to
// the shell) when the id has no resumable conversation — a transcript that was
// deleted, moved, or never got a real user message. The restored pane watches
// its output for this for a short window after delivering the resume command
// so it can self-heal (clear the stale pointer + launch a fresh session)
// instead of leaving a dead shell and a confusing error. Match on stripped
// text (see stripAnsi) — Ink may interleave cursor moves inside the sentence.
export const CLAUDE_RESUME_FAILED_RE = /No conversation found with session ID/i;

// Alt-screen enter — the sequence every Ink TUI (claude / codex, also vim /
// less) emits the moment it actually takes over the terminal. The refusal
// watch above disarms permanently on this marker: a SUCCESSFULLY resumed
// conversation repaints its transcript inside the TUI, and that transcript can
// itself contain the refusal sentence (e.g. the user pasted it) — matching it
// there would "self-heal" a live session. A real refusal prints at the shell
// prompt and exits without ever entering the alt screen. Test on RAW text
// (stripAnsi would remove the sequence).
export const TUI_ALT_SCREEN_ENTER = "\x1b[?1049h";

// CSI / OSC stripper. Ink-based agents often position individual
// characters with cursor moves, so a banner like "Claude Code v2.1.139"
// arrives in the raw byte stream as `C\x1b[H l\x1b[H a…` and a literal
// regex against the unstripped text would never match. Stripping the
// escapes coalesces the characters back into a normal line.
export const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(CSI_RE, "").replace(OSC_RE, "");
}

// ── run-store strippers ──────────────────────────────────────────────────
//
// Two run-store call sites need slightly different ANSI cleanup than the
// canonical stripAnsi above. Both are consolidated here so there is a single
// home for escape-stripping. Their regexes are intentionally NOT the same as
// stripAnsi's — each preserves the exact behavior of the run-store local it
// replaced (this is a refactor, not a fix), so do not "unify" them without
// re-checking the affected outputs.

// Direct-summary cleanup (was run-store's stripAnsiForDirectSummary). Strips
// ANSI escapes AND C0 control noise so a raw TUI tail reads as plain text in
// the summary ladder. Note the looser CSI form (`[0-9;?]*[a-zA-Z]`) and the
// OSC form accepting BEL *or* ST termination, then a final control-char pass.
const DIRECT_CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const DIRECT_OSC_RE = /\x1b\][^\x07]*(\x07|\x1b\\)/g;
const C0_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
export function stripAnsiAndControls(text: string): string {
  return text
    .replace(DIRECT_CSI_RE, "")
    .replace(DIRECT_OSC_RE, "")
    .replace(C0_CONTROL_RE, "");
}

// Worker pty-tap stripper (was run-store's local stripAnsi at the worker
// spawn path). Runs on every data chunk across N concurrent workers, so the
// regexes are hoisted to module scope to avoid per-chunk recompilation.
// Behaviorally distinct from the canonical stripAnsi: OSC is BEL-terminated
// only (no ST), and it does NOT strip control characters.
const WORKER_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const WORKER_OSC_RE = /\x1b\][^\x07]*\x07/g;
export function stripAnsiWorkerTap(text: string): string {
  return text.replace(WORKER_CSI_RE, "").replace(WORKER_OSC_RE, "");
}

// Identify which agent CLI is running by scanning a short rolling buffer of
// recent visible text against the RUNTIME_BANNERS table above. Patterns are
// specific enough to live launch banners / first-prompt boilerplate that
// ordinary shell output (file listings, commit messages, README content,
// `claude --help`) does NOT trigger them. Examples:
//   - Codex:  `OpenAI Codex (v0.130.0)`
//   - Claude: `Claude Code v2.1.139`
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
  return null;
}

// ── Generic-arm runtime promotion (renderer arming-race recovery) ──────────
// The renderer's terminal poller can "arm" a pane as running BEFORE it knows
// which agent CLI it is: Claude enters the alt screen (`ESC[?1049h`) a beat
// before it paints its banner, so on a heavy boot (banner and alt-enter split
// across the main process's 16 ms PTY-flush window) the generic alt-screen
// fallback tags the pane with NO runtime; and a recognised-but-non-first-party
// CLI (aider/opencode/droid/…) coerces to a null public runtime. Either way the
// pane is live but has no first-party working/ready chip and no state poller.
// The poller then keeps sniffing to PROMOTE the pane to a first-party runtime
// the moment that runtime's banner (or an OSC 633;E command line) appears. The
// two pure helpers below own the fiddly bookkeeping that keeps promotion safe —
// extracted here so they can be unit-tested directly (the renderer closure that
// hosts the live state cannot be).
//
// `promoteGenericArm` — the promotion DECISION. Sniffs ONLY the post-arm slice
// of the rolling ring (`ring.slice(ringFrom)`) so pre-arm output — a cat'd
// changelog naming "Claude Code v2.x", or the third-party CLI's own banner still
// sitting in the ring at arm time — cannot promote the pane to the wrong
// runtime. Returns null once the give-up budget is spent: banners appear at
// boot, so there is no reason to keep sniffing a long-lived vim/aider session.
export function promoteGenericArm(
  ring: string,
  ringFrom: number,
  budget: number,
): PublicAgentRuntime | null {
  if (budget <= 0) return null;
  const fresh = ring.slice(Math.max(0, ringFrom));
  const sniffed = sniffOsc633CommandRuntime(fresh) ?? sniffRuntime(fresh);
  return sniffed ? coercePublicRuntime(sniffed) : null;
}

// `advanceGenericArm` — per-chunk bookkeeping. The renderer's ring is a rolling
// buffer capped at a fixed char length; when it sheds chars off the front to
// stay under the cap, the post-arm slice boundary (`ringFrom`) must walk back by
// the same amount so it keeps pointing at the arm boundary. The give-up budget
// burns down by the appended chunk size. `ringLenBefore`/`ringLenAfter` are the
// ring's char length immediately before and after this chunk was folded in.
// Returns the updated `{ ringFrom, budget }`; `budget <= 0` means "stop
// attempting promotion". A no-op once the budget is already spent.
export function advanceGenericArm(
  ringFrom: number,
  budget: number,
  ringLenBefore: number,
  ringLenAfter: number,
  chunkLen: number,
): { ringFrom: number; budget: number } {
  if (budget <= 0) return { ringFrom, budget: 0 };
  const dropped = Math.max(0, ringLenBefore + chunkLen - ringLenAfter);
  return {
    ringFrom: Math.max(0, ringFrom - dropped),
    budget: Math.max(0, budget - chunkLen),
  };
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
//              detection — Codara surfaces them as the "needs you" signal.
//   `done`   : the agent has actively printed a completion line (vs simply
//              going quiet, which is `idle`). Today we mostly fall back to
//              the OSC 633;A "prompt is back" boundary (handled elsewhere),
//              but a positive completion match lets us cut over without
//              waiting for the debounce window.
//
// Patterns were lifted from herdr's hand-tuned table (research/HERDR_LEARNINGS
// quick-win B), trimmed to the three runtimes Codara spawns today. The patterns
// match against the CSI/OSC-stripped tail string so Ink's per-character cursor
// moves do not interleave bytes inside the literal we're looking for.
export interface RuntimePatterns {
  working: RegExp[];
  blocked: RegExp[];
  done: RegExp[];
}

export const RUNTIME_PATTERNS: Record<PublicAgentRuntime, RuntimePatterns> = {
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
  runtime: PublicAgentRuntime,
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

// Narrow post-submit detector for Cora's worker launch driver. Unlike the
// always-on terminal classifier, its input tap starts only after the agent TUI
// is input-ready and immediately before Codara pastes a worker prompt. That
// makes Codex 0.144's bare shimmer word "Working" a safe positive here even
// though it is deliberately too broad for general terminal polling.
export function workerSubmitTurnStarted(
  runtime: PublicAgentRuntime,
  visible: string,
): boolean {
  const stripped = stripAnsi(visible);
  const lastMcpStartup = stripped.toLowerCase().lastIndexOf("starting mcp servers");
  // A completed startup line can remain in the rolling buffer after the turn
  // begins. Only let it veto signals that occur at/before that line; a newer
  // Codex shimmer or composer marker proves the prompt was submitted.
  const afterLastMcp = lastMcpStartup >= 0 ? stripped.slice(lastMcpStartup + 20) : stripped;
  if (lastMcpStartup >= 0) {
    return (
      (runtime === "codex" && /\bWorking\b/i.test(afterLastMcp)) ||
      /Context\s+[1-9][0-9]?%\s+used/i.test(afterLastMcp) ||
      /\btokens used\b/i.test(afterLastMcp) ||
      /\bComposing\b/.test(afterLastMcp) ||
      /ctrl\+c to stop/i.test(afterLastMcp) ||
      /Composer\s+2\.5\s+Fast\s+·\s+[0-9]+(?:\.[0-9]+)?%/i.test(afterLastMcp)
    );
  }
  return (
    classifyTail(runtime, stripped) === "working" ||
    (runtime === "codex" && /\bWorking\b/i.test(stripped)) ||
    /esc to interrupt/i.test(stripped) ||
    /Context\s+[1-9][0-9]?%\s+used/i.test(stripped) ||
    /\btokens used\b/i.test(stripped) ||
    /\bComposing\b/.test(stripped) ||
    /ctrl\+c to stop/i.test(stripped) ||
    /Composer\s+2\.5\s+Fast\s+·\s+[0-9]+(?:\.[0-9]+)?%/i.test(stripped)
  );
}

// ── Teammate lifecycle events ─────────────────────────────────────────────
// Claude Code ≥2.1.2x background agents / Task-tool teammates print parseable
// transcript lines when they start and finish. Counted from the stream so the
// notifier can hold its "done" alert while a background teammate is still
// running — the teammate strip's per-second ticks are digit-only partial
// repaints that match no `working` pattern, so repaint recency alone cannot
// see a live teammate (verified against a live v2.1.201 capture, 2026-07-06).
// Inter-word gaps are `\s*` because Ink encodes them as cursor moves; the
// stripped stream can drop ALL spaces ("⏺Teammate@napperfinished").
//
//   started:  `1 teammate started` / `2 teammates started` — appears in the
//             Task tool result line; the leading count is summed.
//   finished: `⏺ Teammate@napper finished` — "stopped|exited|failed" are
//             defensive alternates; only "finished" was captured live.
//
// Module-level globals with lastIndex reset on entry (mirrors matchEndsPast's
// zero-length-match loop guard) so no state leaks between calls.
const TEAMMATE_STARTED_RE = /(\d+)\s*teammates?\s*started/gi;
const TEAMMATE_FINISHED_RE = /Teammate\s*@\s*[\w-]+\s*(?:finished|stopped|exited|failed)/gi;
// Cap each started-count capture to bound the damage from a garbled digit run
// (a corrupted repaint reading "999999 teammates started" must not wedge the
// notifier's counter until the silence self-heal).
const TEAMMATE_STARTED_CAP = 32;

// Count teammate start/finish events in `text`. Semantics mirror
// classifyTail's: the text is stripAnsi-stripped first, and only matches that
// END strictly past `freshFrom` (an offset into the STRIPPED text) count —
// stream callers pass stripAnsi(carry).length so an event merely sitting in
// the carry can't be double-counted; freshFrom = 0 counts everything.
export function countTeammateEvents(
  text: string,
  freshFrom = 0,
): { started: number; finished: number } {
  const stripped = stripAnsi(text);
  let started = 0;
  let finished = 0;
  let m: RegExpExecArray | null;
  TEAMMATE_STARTED_RE.lastIndex = 0;
  while ((m = TEAMMATE_STARTED_RE.exec(stripped))) {
    if (m.index + m[0].length > freshFrom) {
      started += Math.min(TEAMMATE_STARTED_CAP, parseInt(m[1], 10) || 0);
    }
    if (m[0].length === 0) TEAMMATE_STARTED_RE.lastIndex += 1;
  }
  TEAMMATE_FINISHED_RE.lastIndex = 0;
  while ((m = TEAMMATE_FINISHED_RE.exec(stripped))) {
    if (m.index + m[0].length > freshFrom) finished += 1;
    if (m[0].length === 0) TEAMMATE_FINISHED_RE.lastIndex += 1;
  }
  return { started, finished };
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
// execution) and FinalTerm OSC 133;A / 133;D. Matches the raw text so it
// works even if xterm's OSC handler chain dropped the dispatch on the floor.
//
// Terminator handling: a 633 marker can be closed by `;` (more params
// follow), BEL (`\x07`), or the 7-bit ST (`\x1b\\`). Some shells emit the
// ST form — accepting it here means a `633;A`/`633;D` that arrives with an
// ESC-backslash terminator (instead of BEL) is still recognised as a prompt
// boundary. FinalTerm 133;D (command finished) is treated as a prompt-return
// signal alongside 133;A (prompt start): some shells emit D, not A, when the
// foreground program exits and control returns to the read-line state.
//
// GUARD-RAIL — why 133;D is safe to treat as "agent exited": today an agent CLI
// holds the shell's foreground for the whole session, so the shell's
// precmd/preexec integration is suspended while the agent runs and only resumes
// (emitting 133;A/D) once the agent has actually exited and control is back at
// the read-line state. There is therefore no mid-session 133;D. This assumption
// BREAKS if a future feature runs a NESTED INTERACTIVE shell INSIDE an agent
// pane (e.g. the agent spawns a child shell that inherits ZDOTDIR / the bash
// integration): that child would emit 133;A/D on every one of ITS prompts,
// which this regex would read as the agent exiting and falsely reset the chip.
// If that ever ships, re-gate 133;D (e.g. require it only when no agent-UI
// chrome is present, or scope it to the top-level shell's integration).
export const PROMPT_MARKER_RE = /\x1b\]633;[ABDP](?:;|\x07|\x1b\\)|\x1b\]133;[AD](?:\x07|\x1b\\)/;
export function hasPromptMarker(text: string): boolean {
  return PROMPT_MARKER_RE.test(text);
}

// ── Persistent agent-UI chrome detector ───────────────────────────────────
// Returns true when the agent's PERSISTENT TUI chrome (the input box, footer
// hint line, and statusline that frame the agent whether it is working OR
// idle) is visible in `tail`. This is the "is the agent still on screen at
// all" signal, distinct from classifyTail's "what is the agent doing right
// now" — it stays true through an idle Claude box (between turns, or after a
// Ctrl+C turn-interrupt) and goes false only once the agent's TUI is gone and
// the plain shell prompt has returned.
//
// Used by the renderer poller / Ctrl+C path to clear a manual chip after the
// agent EXITS, in environments where no alt-screen-leave or OSC prompt marker
// arrives (inline-rendering Claude Code v2, "no-flicker" mode). It deliberately
// errs toward TRUE: a false "UI gone" would wrongly clear a live agent, so we
// only return false when NONE of the persistent anchors are present. A live
// agent — working or idle — reliably keeps at least its footer hint line or
// statusline on the bottom rows that the tail covers.
//
// Anchors (CSI/OSC-stripped, whitespace-elastic for Ink cursor-move gaps):
//   Claude Code v2: the footer mode/hint line ("⏵⏵ auto mode on (shift+tab to
//     cycle) · ← for agents", "▶▶ bypass permissions on …", "accept edits
//     on …"), the universal "? for shortcuts" hint, the "← for agents" /
//     "shift+tab to cycle" fragments, and the live launch banner. These are
//     painted by Ink as a pinned bottom region and persist across the whole
//     session, idle or busy.
//   Codex: its boxed banner chrome and the same generic shortcut-hint footer.
//     (Codex also emits alt-screen-leave on exit, so its chip clears via that
//     path too — this detector is mainly the inline-Claude backstop.)
const AGENT_UI_ANCHORS: Record<PublicAgentRuntime, RegExp[]> = {
  claude: [
    // Footer mode + hint line. The mode word varies (auto mode / bypass
    // permissions / accept edits / plan mode) but "(shift+tab to cycle)" and
    // "← for agents" are stable across modes and versions. The double
    // fast-forward glyph leads the line: ⏵⏵ (U+23F5) or ▶▶ (U+25B6).
    /shift\s*\+?\s*tab\s*to\s*cycle/i,
    /←\s*for\s*agents|\bfor\s*agents\b/i,
    /[⏵▶]\s*[⏵▶]\s*(?:auto|bypass|accept|plan)/i,
    // CC 2.1.204+ permission-mode badge (VERIFIED against a live v2.1.204 pty
    // capture, 2026-07-08). This version added a "manual" permission mode that
    // is the NEW DEFAULT, and its idle footer is just "⏸ manual mode on" — a
    // SINGLE pause glyph (⏸ U+23F8), the mode word "manual", and NO
    // "(shift+tab to cycle)" suffix and NO "? for shortcuts" hint. So on a
    // fresh idle pane in the default mode NONE of the glyph / shift+tab /
    // shortcuts anchors above match, agentUiPresent goes false the moment the
    // launch banner scrolls out of the tail, and the poller's absence-reset
    // tears the chip down (with Fix-1 re-detection, itself anchor-based, unable
    // to recover it) — the reported "CLAUDE chip never appears" regression.
    // Match the mode badge's TEXT directly, glyph-independent, across every
    // mode: "⏸ manual mode on", "⏸ plan mode on", "⏵⏵ auto mode on",
    // "⏵⏵ accept edits on (shift+tab to cycle)", "▶▶ bypass permissions on".
    // Inter-word gaps are \s* because Ink encodes them as cursor moves.
    /\b(?:manual|auto|plan)\s*mode\s*on\b/i,
    /\baccept\s*edits\s*on\b/i,
    /\bbypass\s*permissions\s*on\b/i,
    // Universal shortcut hint shown under the idle input box (pre-2.1.204).
    /\?\s*for\s*shortcuts/i,
    // Live launch banner still on screen (early session, before the user has
    // scrolled it away).
    /Claude\s*Code\s*v?\d/,
  ],
  codex: [
    /OpenAI\s*Codex\s*\(?v?\d/,
    /\?\s*for\s*shortcuts/i,
    /shift\s*\+?\s*tab/i,
    /ctrl\s*\+?\s*c\s*to\s*(?:quit|exit|interrupt)/i,
    /esc\s*to\s*interrupt/i,
  ],
};

export function agentUiPresent(
  runtime: PublicAgentRuntime,
  tail: string,
): boolean {
  const anchors = AGENT_UI_ANCHORS[runtime];
  if (!anchors) return false;
  const stripped = stripAnsi(tail);
  for (const re of anchors) {
    if (re.test(stripped)) return true;
  }
  return false;
}

// Whether it is SAFE to clear an agent's chip purely because agentUiPresent()
// went false (i.e. anchor-absence alone, with no positive exit signal). This is
// true ONLY for runtimes whose IDLE chrome anchors have been verified against a
// real idle frame — otherwise a false "UI gone" on a live-but-idle agent would
// wrongly kill its chip.
//
//   claude: VERIFIED. The idle footer ("⏵⏵/▶▶ <mode> on (shift+tab to cycle) ·
//           ← for agents", "? for shortcuts", and the CC 2.1.204 "⏸ manual mode
//           on" default) and statusline are captured in the harness
//           (scripts/test-agent-patterns.cjs) from real v2.1.17x/v2.1.181/v2.1.204
//           frames and are reliably last-painted. Claude v2 also renders inline
//           with no alt-screen-leave on Ctrl+C exit, so absence-based detection
//           is the ONLY general backstop — keep it aggressive here. Because this
//           reset is so aggressive, the AGENT_UI_ANCHORS.claude table MUST track
//           every footer shape a new CC version ships: a mode line the anchors
//           miss (as happened when 2.1.204 introduced "manual" mode) makes an
//           idle pane read as "UI gone" and kills its chip a few seconds after
//           boot.
//   codex: NOT VERIFIED. A 2026-06-18 live capture of Codex CLI
//           (v0.125.0 → v0.141.0) confirmed Codex now renders INLINE too (no
//           ESC[?1049h alt-screen enter/leave), but a clean idle-composer frame
//           could not be captured, so its persistent idle hint/footer anchors
//           above are best-effort guesses, not ground truth. If they don't match
//           the real idle composer, an idle Codex would read as "UI gone" and an
//           absence-based reset would clear a LIVE agent's chip after ~1.2s —
//           the exact "chip vanishes while alive" failure. FAIL-SAFE: do NOT let
//           anchor-absence alone clear Codex chips. It still clears
//           promptly via POSITIVE signals (OSC 633/133 prompt markers — present
//           whenever shell integration is loaded — alt-screen-leave if a future
//           build re-enters the alt screen, and pty exit). Worst case without a
//           positive signal is an occasional stuck idle chip (self-healing on
//           the next prompt marker / pty exit), which is strictly better than
//           killing a live agent's chip. Re-enable once a real idle Codex frame
//           is captured and added as a regression test.
const ABSENCE_RESET_SAFE: ReadonlySet<PublicAgentRuntime> = new Set([
  "claude",
]);
export function absenceResetSafe(runtime: PublicAgentRuntime): boolean {
  return ABSENCE_RESET_SAFE.has(runtime);
}
