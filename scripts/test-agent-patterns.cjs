// Sanity harness for src/shared/agent-patterns.ts — simulates the byte
// streams Claude Code / Codex paint while working, blocked, and idle, and
// asserts the classification the main-process terminal-agent notifier and
// the renderer state poller both depend on.
//   node scripts/test-agent-patterns.cjs
// Compiles the shared module to a temp dir on each run (tsc, ~2s) so the
// assertions always exercise the current source.
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const outDir = path.join(os.tmpdir(), "spark-ap-test");
// Resolve the local TypeScript compiler directly instead of shelling out to
// npx — avoids Windows shell quoting entirely.
const tscJs = require.resolve("typescript/bin/tsc", { paths: [repoRoot] });
execFileSync(
  process.execPath,
  [
    tscJs,
    path.join("src", "shared", "agent-patterns.ts"),
    "--outDir", outDir,
    "--module", "commonjs",
    "--target", "es2020",
    "--skipLibCheck",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
const ap = require(path.join(outDir, "agent-patterns.js"));

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} → ${JSON.stringify(actual)} (want ${JSON.stringify(expected)})`);
}

// ── classifyTail: working footers, with Ink-style cursor moves interleaved ──
check(
  "claude working footer",
  ap.classifyTail("claude", "\x1b[2K\x1b[G* Cogitating… (12s · \x1b[38;5;214m4.2k tokens\x1b[39m · esc to interrupt)"),
  "working",
);
check(
  "claude working footer split by CSI between chars",
  ap.classifyTail("claude", "e\x1b[1Cs\x1b[1Cc\x1b[1C \x1b[1Ct\x1b[1Co\x1b[1C \x1b[1Ci\x1b[1Cn\x1b[1Ct\x1b[1Ce\x1b[1Cr\x1b[1Cr\x1b[1Cu\x1b[1Cp\x1b[1Ct"),
  "working",
);
check(
  "codex working footer",
  ap.classifyTail("codex", "\x1b[2K▌ Working (32s • Esc to interrupt)"),
  "working",
);
check(
  "worker submit accepts Codex 0.144 bare Working shimmer",
  ap.workerSubmitTurnStarted("codex", "\x1b[27;3H\x1b[38;2;128;128;128mWorking"),
  true,
);
check(
  "worker submit rejects an active MCP startup spinner",
  ap.workerSubmitTurnStarted("codex", "Starting MCP servers (2/5) (0s • esc to interrupt)"),
  false,
);
check(
  "worker submit lets newer Working beat a stale MCP startup line",
  ap.workerSubmitTurnStarted("codex", "Starting MCP servers (3/3)\nready\nWorking"),
  true,
);
check(
  "worker submit rejects idle Codex composer",
  ap.workerSubmitTurnStarted("codex", "Ask about this codebase  Context 0% used"),
  false,
);
check(
  "claude permission prompt beats working footer",
  ap.classifyTail(
    "claude",
    "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n(esc to interrupt)",
  ),
  "blocked",
);
check(
  "codex approval prompt is not needs-you",
  ap.classifyTail("codex", "Approve shell command?\n  rm -rf node_modules"),
  null,
);
check("idle claude input box is unclassified", ap.classifyTail("claude", "> \n? for shortcuts"), null);
check("plain shell output is unclassified", ap.classifyTail("claude", "$ ls\nsrc package.json README.md"), null);

// ── banner sniffing ──
check("claude banner", ap.sniffRuntime("✻ Welcome!  Claude Code v2.1.139"), "claude");
check("codex banner", ap.sniffRuntime(">_ OpenAI Codex (v0.130.0)"), "codex");
check("banner with interleaved CSI", ap.sniffRuntime("C\x1b[1mlaude Code v\x1b[0m2.1.139"), "claude");
check("ls output is not a banner", ap.sniffRuntime("docs claude-notes.md codex_setup.txt"), null);

// ── OSC 633;E command-line runtime sniff ──
check(
  "633;E claude command",
  ap.sniffOsc633CommandRuntime("\x1b]633;E;claude --continue\x07"),
  "claude",
);
check(
  "633;E codex.exe path",
  ap.runtimeFromCommandLine("C:\\Users\\me\\AppData\\npm\\codex.exe resume"),
  "codex",
);
check("633;E npx codex", ap.runtimeFromCommandLine("npx @openai/codex"), "codex");
check("633;E pnpm exec claude", ap.runtimeFromCommandLine("pnpm exec claude --resume"), "claude");
check("633;E echo claude is not a launch", ap.runtimeFromCommandLine("echo claude"), null);
check("633;E plain shell command", ap.sniffOsc633CommandRuntime("\x1b]633;E;git status\x07"), null);

check("live sniff Codex working footer without banner", ap.sniffLiveRuntime("Working (0s • esc to interrupt)"), "codex");
check("live sniff Codex statusline without banner", ap.sniffLiveRuntime("gpt-5.6-sol xhigh fast · ~/src"), "codex");
check("live sniff Claude mode line", ap.sniffLiveRuntime("⏸ manual mode on"), "claude");
check("live sniff ignores plain shell", ap.sniffLiveRuntime("$ git status\nnothing to commit"), null);

// ── prompt-back markers ──
check("OSC 633;A marks prompt", ap.hasPromptMarker("\x1b]633;A\x07"), true);
check("OSC 133;A marks prompt", ap.hasPromptMarker("\x1b]133;A\x07"), true);
check("OSC 633;E does NOT mark prompt", ap.hasPromptMarker("\x1b]633;E;claude\x07"), false);
check("OSC 633;C does NOT mark prompt", ap.hasPromptMarker("\x1b]633;C\x07"), false);
// Hardened terminators / subcodes (Bug A, fix 4b/4c):
check("OSC 633;A with ST terminator marks prompt", ap.hasPromptMarker("\x1b]633;A\x1b\\"), true);
check("OSC 633;D with ST terminator marks prompt", ap.hasPromptMarker("\x1b]633;D\x1b\\"), true);
check("OSC 133;D (command finished) marks prompt", ap.hasPromptMarker("\x1b]133;D\x07"), true);
check("OSC 133;D with ST terminator marks prompt", ap.hasPromptMarker("\x1b]133;D\x1b\\"), true);
check("OSC 133;B does NOT mark prompt", ap.hasPromptMarker("\x1b]133;B\x07"), false);

// ── agentUiPresent: persistent TUI chrome vs returned-to-shell (Bug A) ──
// Idle Claude box: footer hint line + statusline present → UI present (true).
check(
  "claude idle box (auto-mode footer) is UI-present",
  ap.agentUiPresent(
    "claude",
    "❯ \n⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n󱙺 Sonnet 4.6 ╱ _staging ╱ staging ╱ no ctx",
  ),
  true,
);
// User-reported screenshot variant: bypass-permissions mode + ▶▶ glyph.
check(
  "claude idle box (bypass-permissions, ▶▶ glyph) is UI-present",
  ap.agentUiPresent(
    "claude",
    "› \n▶▶ bypass permissions on (shift+tab to cycle) · ← for agents\nOpus 4.8 ╱ spark-agent ╱ main ╱ no ctx",
  ),
  true,
);
// Working footer co-exists with chrome → still UI-present.
check(
  "claude working footer is UI-present",
  ap.agentUiPresent("claude", "✽ Pouncing… (3s · ↓ 1 tokens)\n⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"),
  true,
);
// "? for shortcuts" hint alone (minimal idle box) → UI-present.
check(
  "claude '? for shortcuts' hint is UI-present",
  ap.agentUiPresent("claude", "› \n? for shortcuts"),
  true,
);
// CC 2.1.204 default "manual" permission mode: the idle footer is just
// "⏸ manual mode on" — no "(shift+tab to cycle)", no "? for shortcuts" (live
// pty capture, 2026-07-08). This is the regression fixture: before the mode-
// text anchors were added, an idle pane in the default mode read as UI-ABSENT
// and the poller's absence-reset killed its chip a few seconds after boot.
check(
  "claude 2.1.204 idle box (manual mode, ⏸ glyph, no shift+tab) is UI-present",
  ap.agentUiPresent(
    "claude",
    "❯ Try \"refactor <filepath>\"\n⏸ manual mode on\n\n󱙺 Fable 5 ╱  spark-agent ╱ no ctx",
  ),
  true,
);
// Same, with Ink's inter-word gaps collapsed away (no spaces between words).
check(
  "claude 2.1.204 manual-mode footer with spaces stripped is UI-present",
  ap.agentUiPresent("claude", "⏸manualmodeon\n󱙺 Fable 5 ╱  spark-agent ╱ no ctx"),
  true,
);
// Other CC 2.1.204 modes cycled via shift+tab (live capture): plan mode also
// leads with the single ⏸ glyph; accept-edits uses "accept edits on" (no
// "mode"); auto/bypass keep the double glyph. All must read UI-present.
check(
  "claude 2.1.204 plan mode (⏸ glyph) is UI-present",
  ap.agentUiPresent("claude", "❯ \n⏸ plan mode on (shift+tab to cycle)\n        0 tokens"),
  true,
);
check(
  "claude 2.1.204 accept-edits mode is UI-present",
  ap.agentUiPresent("claude", "❯ \n⏵⏵ accept edits on (shift+tab to cycle)\n ╱ 5h 0% · 7d 4%"),
  true,
);
// Live banner still on screen early in the session → UI-present.
check(
  "claude banner on screen is UI-present",
  ap.agentUiPresent("claude", "✻ Welcome!  Claude Code v2.1.181"),
  true,
);
// Plain shell prompt back (powerlevel10k-ish), agent gone → UI ABSENT (false).
check(
  "plain shell prompt (agent exited) is NOT UI-present",
  ap.agentUiPresent("claude", "user@host ~/spark-agent main ❯ \n$ ls\nsrc package.json README.md"),
  false,
);
check(
  "empty/quiet shell tail is NOT UI-present",
  ap.agentUiPresent("claude", "\n\n"),
  false,
);
// Codex chrome anchors.
check(
  "codex banner is UI-present",
  ap.agentUiPresent("codex", "│ >_ OpenAI Codex (v0.138.0)                          │"),
  true,
);
check(
  "codex idle statusline is UI-present",
  ap.agentUiPresent("codex", "› Write tests for @filename\ngpt-5.6-sol default · Context 100% left"),
  true,
);
check(
  "codex working statusline from screenshot is UI-present",
  ap.agentUiPresent("codex", "Working (0s • esc to interrupt)\ngpt-5.6-sol xhigh fast · ~/Documents/Projects/Codara/hetzner-k8s-codara-platform"),
  true,
);
check(
  "plain shell (no codex chrome) is NOT UI-present",
  ap.agentUiPresent("codex", "$ git status\nnothing to commit"),
  false,
);

// ── absenceResetSafe: fail-safe gate for anchor-absence-only chip clearing ──
// Only Claude's IDLE chrome is verified against real frames, so only Claude may
// have its chip cleared by agentUiPresent()===false alone. Codex idle
// anchors are unverified (a 2026-06-18 live capture confirmed Codex renders
// inline like Claude — no alt-screen — but a clean idle composer frame could not
// be captured), so they must clear via POSITIVE exit signals only. If a real
// idle Codex frame is ever captured and asserted UI-present here, codex can be
// promoted into ABSENCE_RESET_SAFE and this expectation flipped to true.
check("absenceResetSafe(claude) — verified idle chrome", ap.absenceResetSafe("claude"), true);
check("absenceResetSafe(codex) — UNVERIFIED, fail-safe off", ap.absenceResetSafe("codex"), false);
check("absenceResetSafe(grok) — UNVERIFIED, fail-safe off", ap.absenceResetSafe("grok"), false);
check(
  "grok banner is UI-present",
  ap.agentUiPresent("grok", "Grok Build  ·  always-approve  ·  ? for shortcuts"),
  true,
);
check(
  "grok Responding… chrome is working",
  ap.classifyTail("grok", "Responding…  esc to cancel"),
  "working",
);
check(
  "grok Allow once prompt is blocked",
  ap.classifyTail("grok", "Allow once    Reject once    Enable always-approve mode"),
  "blocked",
);
check(
  "grok banner is not a working chip by itself",
  ap.classifyTail("grok", "Grok Build  ·  always-approve"),
  null,
);

// ── REAL Claude Code v2.1.170 frames (live pty capture, 2026-06-10) ──
// The v2.1.17x footer dropped "esc to interrupt" entirely; the reliable
// working signal is the stats group "(3s · ↓ 1 tokens)". Ink also encodes
// inter-word spacing as cursor-forward moves (\x1b[1C), so stripped text can
// have NO spaces between words — patterns must be whitespace-elastic.
check(
  "v2.1.170 banner with cursor-move word gaps",
  ap.sniffRuntime("\x1b[1m\x1b[3CClaude\x1b[1CCode\x1b[38;2;153;153;153m\x1b[22m\x1b[1Cv2.1.170\x1b[38;2;215;119;87m"),
  "claude",
);
check(
  "v2.1.170 stats footer frame (counter repaint)",
  ap.classifyTail("claude", "\x1b[?25l\x1b[38;2;215;119;87m\x1b[11;1H✽\x1b[38;2;153;153;153m\x1b[11C(3s · ↓\x1b[1C1 tokens)\x1b[14;3H\x1b[?25h"),
  "working",
);
check(
  "v2.1.170 full footer with verb",
  ap.classifyTail("claude", "\x1b[38;2;215;119;87m\x1b[13;1H✽ Pouncing… \x1b[38;2;153;153;153m(3s · ↓ 1 tokens)\x1b[K"),
  "working",
);
check(
  "v2.1.170 hook-runner footer",
  ap.classifyTail("claude", "\x1b[13;3HPouncing…\x1b[38;2;153;153;153m\x1b[2Crunning s\x1b[2Cp hooks… 0/2 · 3s · ↓\x1b[1C1 tokens)\x1b[16;3H"),
  "working",
);
check(
  "v2.1.170 idle UI (hints + statusline + usage bar) is unclassified",
  ap.classifyTail(
    "claude",
    "❯ \n⏵⏵ auto\x1b[1Cmode\x1b[1Con (shift+tab\x1b[1Cto\x1b[1Ccycle) · ← for agents\n󱙺 Sonnet\x1b[1C4.6 ╱ _staging ╱ staging ╱ no\x1b[1Cctx\n█▋ 17% 34k/200k ╱ 5h 12% · 7d 2%",
  ),
  null,
);
check(
  "v2.1.170 token footer with k-suffix",
  ap.classifyTail("claude", "✶ Deliberating… (114s · ↑ 4.2k tokens)"),
  "working",
);
check(
  "v2.1.170 verb-only spinner frame (turn start, no stats yet)",
  ap.classifyTail("claude", "\x1b[K\x1b[38;2;215;119;87m\r\n✻ Pouncing…\x1b[K\x1b[m"),
  "working",
);
check(
  "prose gerund without spinner glyph is unclassified",
  ap.classifyTail("claude", "I suggest Refactoring… the parser, then testing."),
  null,
);

// ── REAL Claude Code v2.1.204 frames (live pty capture, 2026-07-08) ──
// The boxed launch banner still carries "Claude Code v<n>" (Ink glues the
// words: "Claude Codev2.1.204"), so banner detection / arming is unchanged.
check(
  "v2.1.204 boxed banner (Ink-glued words)",
  ap.sniffRuntime("╭───Claude Codev2.1.204─────────────────────────────╮"),
  "claude",
);
// Working footer: the whimsical spinner verb ("✻Incubating…", glyph glued to
// the gerund) and the "↓ N tokens" stats group still classify as working. The
// elapsed group changed shape though — it now paints "(0s)" / "(4s)" and
// "6s ·" rather than the old "(3s ·", so the "(<n>s ·" pattern alone no longer
// fires; the gerund + tokens patterns carry it.
check(
  "v2.1.204 verb-only spinner frame (glyph glued to gerund)",
  ap.classifyTail("claude", "\x1b[38;2;215;119;87m✻Incubating… (0s)\x1b[m"),
  "working",
);
check(
  "v2.1.204 token stats footer",
  ap.classifyTail("claude", "Photosynthesizing…\x1b[38;2;153;153;153m 34s · ↓25 tokens)"),
  "working",
);
check(
  "v2.1.204 hook-runner footer (running stop hooks)",
  ap.classifyTail("claude", "\x1b[13;3Hrunning s\x1b[2Cp hooks… 0/2 · 6s · ↓74 tokens)"),
  "working",
);
// Idle footer in the DEFAULT manual mode must be unclassified (not working /
// blocked) AND UI-present — the two invariants the chip's absence-reset relies
// on together. classifyTail=null lets the baseline-idle path settle to "ready";
// agentUiPresent=true keeps the absence-reset from tearing the chip down.
const V204_MANUAL_IDLE =
  "● high · /effort\n❯ Try \"refactor <filepath>\"\n⏸ manual mode on\n\n󱙺 Fable 5 ╱  spark-agent ╱ no ctx";
check("v2.1.204 manual-mode idle footer is unclassified", ap.classifyTail("claude", V204_MANUAL_IDLE), null);
check("v2.1.204 manual-mode idle footer is UI-present", ap.agentUiPresent("claude", V204_MANUAL_IDLE), true);

// ── REAL Claude Code v2.1.205 frames (live pty capture, 2026-07-09) ──
// Regression check for the reported "CLAUDE chip gone on 2.1.205" break. A
// throwaway-dir pty capture of the real 2.1.205 binary is byte-for-byte
// identical to 2.1.204 in every detection-relevant frame — same boxed banner,
// same "⏸ manual mode on" idle footer, same working footer — so the update did
// NOT change the terminal output the patterns key off. These fixtures pin that
// invariant so a future CC release that DOES change the banner/footer trips
// here loudly instead of silently killing the chip. (The actual 2.1.205 chip
// break was an arming race in useTerminalSession.ts — the pane armed generically
// off ESC[?1049h before the banner arrived — not a pattern miss; see that file's
// runtime-PROMOTION block.)
check(
  "v2.1.205 boxed banner arms claude",
  ap.sniffRuntime("╭───Claude Codev2.1.205─────────────────────────────╮"),
  "claude",
);
// Working footer now appends the effort indicator ("· thinking with high
// effort") to the stats group: "✢ Cogitating… (4s · ↓ 25 tokens · thinking with
// high effort)". The gerund and "↓ N tokens" patterns carry the classification.
check(
  "v2.1.205 working footer (gerund + effort suffix)",
  ap.classifyTail("claude", "\x1b[38;2;215;119;87m✢ Cogitating… (4s · ↓ 25 tokens · thinking with high effort)\x1b[m"),
  "working",
);
check(
  "v2.1.205 hook-runner footer",
  ap.classifyTail("claude", "running stop hooks… 0/2 · 4s · ↓ 69 tokens · thinking with high effort)"),
  "working",
);
// Idle footer — same DEFAULT manual mode as 2.1.204: unclassified AND UI-present
// (the two invariants the absence-reset relies on). Statusline glyph is 󱙺.
const V205_MANUAL_IDLE =
  "● high · /effort\n❯ Try \"write a test for <filepath>\"\n⏸ manual mode on\n󱙺 Fable 5 ╱  cc-capture ╱ no ctx";
check("v2.1.205 manual-mode idle footer is unclassified", ap.classifyTail("claude", V205_MANUAL_IDLE), null);
check("v2.1.205 manual-mode idle footer is UI-present", ap.agentUiPresent("claude", V205_MANUAL_IDLE), true);

// ── Generic-arm runtime promotion (promoteGenericArm / advanceGenericArm) ──
// The renderer arms a pane running BEFORE it knows the runtime (generic
// ESC[?1049h alt-screen fallback, or a non-first-party CLI that coerces to
// null) and then promotes it to a first-party runtime when the banner appears.
// These pure helpers own the ring-slice + budget bookkeeping that keeps the
// promotion from mis-firing; unit-tested here because the renderer closure that
// drives them can't be.
const PRE = "shell: see Claude Code v2.1.9 in the changelog "; // pre-arm banner
const POST_BANNER = "welcome ╭───Claude Codev2.1.205───╮"; // a real post-arm banner
// A real banner appended AFTER the arm promotes (ringFrom points past pre-arm).
check(
  "promote: post-arm banner → claude",
  ap.promoteGenericArm(PRE + POST_BANNER, PRE.length, 64 * 1024),
  "claude",
);
// 3A regression: a THIRD-PARTY / generic arm whose ring already holds a Claude
// version string (echoed by the CLI, or pre-arm shell output) must NOT promote
// — the sniff runs only over the post-arm slice. With ringFrom=0 (the bug: the
// non-public arm left the offset unset) the whole ring sniffs and false-promotes.
check(
  "promote: pre-arm Claude version is guarded by ringFrom",
  ap.promoteGenericArm(PRE + "aider working, no banner here", PRE.length, 64 * 1024),
  null,
);
check(
  "promote: ringFrom=0 would have false-promoted (documents the 3A hole)",
  ap.promoteGenericArm(PRE + "aider working, no banner here", 0, 64 * 1024),
  "claude",
);
// Cross-boundary: pre-arm ends "Claude Code v" (no digit → no match at arm), a
// post-arm "2.1.5" would complete a spurious banner across the boundary. The
// post-arm slice sees only "2.1.5 …" → no promotion.
check(
  "promote: cross-boundary spurious banner is guarded",
  ap.promoteGenericArm("editing Claude Code v" + "2.1.5 release notes", "editing Claude Code v".length, 64 * 1024),
  null,
);
// A post-arm OSC 633;E command line promotes too.
check(
  "promote: post-arm 633;E command line → claude",
  ap.promoteGenericArm(PRE + "\x1b]633;E;claude\x07", PRE.length, 64 * 1024),
  "claude",
);
// Budget exhausted: never promote, even on a real post-arm banner.
check(
  "promote: spent budget disables promotion",
  ap.promoteGenericArm(PRE + POST_BANNER, PRE.length, 0),
  null,
);
// advanceGenericArm bookkeeping. Object results compared via JSON.
function checkAdv(name, actual, ringFrom, budget) {
  const ok = actual.ringFrom === ringFrom && actual.budget === budget;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} → ${JSON.stringify(actual)} (want {ringFrom:${ringFrom},budget:${budget}})`);
}
// Ring still under cap → nothing dropped: offset unchanged, budget burns by chunk.
checkAdv("advance: no slide (ring under cap)", ap.advanceGenericArm(20, 1000, 100, 150, 50), 20, 950);
// Ring pinned at the cap → dropped == chunkLen: offset walks fully back, floors at 0.
checkAdv("advance: full slide at cap floors ringFrom", ap.advanceGenericArm(20, 1000, 8192, 8192, 100), 0, 900);
// Partial slide as the ring crosses the cap: dropped = before+chunk-after.
checkAdv("advance: partial slide across cap", ap.advanceGenericArm(200, 1000, 8000, 8192, 300), 92, 700);
// Budget already spent → no-op (promotion is already disabled for this arm).
checkAdv("advance: spent budget is a no-op", ap.advanceGenericArm(50, 0, 100, 150, 50), 50, 0);
// Budget floors at 0 on the chunk that overshoots it.
checkAdv("advance: budget floors at 0", ap.advanceGenericArm(50, 30, 8192, 8192, 100), 0, 0);

// ── REAL Codex v0.138.0 frames (live pty capture, 2026-06-10) ──
check(
  "codex v0.138 working footer",
  ap.classifyTail("codex", "•\x1b[m \x1b[38;2;204;204;204m\x1b[1mWorking\x1b[m \x1b[2m(0s • esc to interrupt)\x1b[22m"),
  "working",
);
check(
  "codex shimmer-only repaint is unclassified (sustain covers it)",
  ap.classifyTail("codex", "\x1b[20;3HW\x1b[38;2;47;47;47mo\x1b[38;2;31;31;31mr\x1b[38;2;47;47;47mk\x1b[38;2;90;90;90mi\x1b[38;2;144;144;144mn\x1b[38;2;187;187;187mg\x1b[m"),
  null,
);
check(
  "codex boxed banner line",
  ap.sniffRuntime("│ >_ OpenAI Codex (v0.138.0)                          │"),
  "codex",
);
check(
  "codex sandbox dialog is not needs-you",
  ap.classifyTail("codex", "› 1. Set up default sandbox (requires Administrator permissions)\n  2. Use non-admin sandbox\n  3. Quit\n  Press enter to confirm or esc to go back"),
  null,
);

// ── Claude AskUserQuestion selector (user-reported, v2.1.170 screenshot) ──
check(
  "claude AskUserQuestion dialog is blocked",
  ap.classifyTail(
    "claude",
    "What would you like to work on?\n❯ 1. 1\n   Option number one\n  2. 2\n   Option number two\n 5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  ),
  "blocked",
);
check(
  "Enter-to-select footer alone is blocked",
  ap.classifyTail("claude", "Enter to select · ↑/↓ to navigate · Esc to cancel"),
  "blocked",
);
check(
  "plain numbered list without selector caret is unclassified",
  ap.classifyTail("claude", "Here are the steps:\n 1. Install deps\n 2. Run the build"),
  null,
);

// ── freshFrom guard: stale carry must not re-assert working ──
const STALE_CARRY = "✽ Pouncing… (3s · ↓ 1 tokens)";
const IDLE_REPAINT = "󱙺 Sonnet 4.6 ╱ _staging ╱ staging ╱ no ctx";
check(
  "stale footer in carry + idle repaint is unclassified",
  ap.classifyTail("claude", STALE_CARRY + IDLE_REPAINT, ap.stripAnsi(STALE_CARRY).length),
  null,
);
check(
  "footer split across carry/chunk boundary still matches",
  ap.classifyTail("claude", "✽ Pouncing… (3s · ↓ 1 tok" + "ens)", ap.stripAnsi("✽ Pouncing… (3s · ↓ 1 tok").length),
  "working",
);
check(
  "fresh footer painted entirely in the new chunk matches",
  ap.classifyTail("claude", IDLE_REPAINT + STALE_CARRY, ap.stripAnsi(IDLE_REPAINT).length),
  "working",
);

// ── countTeammateEvents: background-teammate lifecycle (v2.1.201 capture) ──
function checkTm(name, actual, started, finished) {
  const ok = actual && actual.started === started && actual.finished === finished;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} → ${JSON.stringify(actual)} (want {"started":${started},"finished":${finished}})`,
  );
}

// REAL captured Task tool result line announcing a background teammate.
checkTm(
  "teammate started (real Task result line)",
  ap.countTeammateEvents(
    "⎿  Initializing… ·  Pondering… (9s · ↓ 250 tokens · thought for 7s)  1 teammate started",
  ),
  1,
  0,
);
// REAL captured finish line — Ink's cursor-move word gaps stripped away ALL
// the spaces ("⏺ Teammate@napper finished" arrives as this).
checkTm(
  "teammate finished (space-stripped Ink form)",
  ap.countTeammateEvents("⏺Teammate@napperfinished"),
  0,
  1,
);
checkTm(
  "teammate finished (hyphenated name, spaces intact)",
  ap.countTeammateEvents("⏺ Teammate@models-page finished"),
  0,
  1,
);
checkTm("plural teammates started", ap.countTeammateEvents("2 teammates started"), 2, 0);
// Raw Ink form: inter-word gaps are cursor-forward moves, not spaces.
checkTm(
  "started with cursor-move word gaps (raw Ink)",
  ap.countTeammateEvents("1\x1b[1Cteammate\x1b[1Cstarted"),
  1,
  0,
);
// freshFrom guard: an event sitting entirely in the carry (before freshFrom)
// was already counted on a previous chunk and must not count again…
const TM_STALE = "⎿ 1 teammate started";
checkTm(
  "event entirely before freshFrom is not counted",
  ap.countTeammateEvents(TM_STALE, ap.stripAnsi(TM_STALE).length),
  0,
  0,
);
// …but an event STRADDLING the boundary (match ends past freshFrom) counts.
const TM_HEAD = "⏺ Teammate@napper fin";
checkTm(
  "event straddling freshFrom is counted",
  ap.countTeammateEvents(TM_HEAD + "ished", ap.stripAnsi(TM_HEAD).length),
  0,
  1,
);
checkTm(
  "plain prose has no teammate events",
  ap.countTeammateEvents("The team started reviewing the finished patch."),
  0,
  0,
);
// "restarted" must not read as "started": `teammates?\s*started` allows only
// whitespace between the words, so the "re" breaks the match.
checkTm("'restarted' does not count", ap.countTeammateEvents("5 teammates restarted"), 0, 0);

// ── resume-refusal watch: refusal signature vs TUI-launch disarm ──
// The restored-pane watch (useTerminalSession) matches CLAUDE_RESUME_FAILED_RE
// on stripped text but disarms permanently when the RAW stream shows
// TUI_ALT_SCREEN_ENTER — a resumed TUI can repaint the refusal sentence as
// transcript content, and only the disarm keeps that from triggering a bogus
// self-heal typed into the live session.
const refusalPrint = "\x1b[2mNo conversation \x1b[1mfound\x1b[0m with session ID abc";
check(
  "refusal print matches on stripped text",
  ap.CLAUDE_RESUME_FAILED_RE.test(ap.stripAnsi(refusalPrint)),
  true,
);
check(
  "refusal print never contains the disarm marker",
  refusalPrint.includes(ap.TUI_ALT_SCREEN_ENTER),
  false,
);
const resumedTui = "\x1b[?1049h\x1b[2J…transcript: 'No conversation found with session ID'…";
check(
  "resumed TUI raw stream carries the disarm marker",
  resumedTui.includes(ap.TUI_ALT_SCREEN_ENTER),
  true,
);
check(
  "disarm marker is gone after stripAnsi (watch must scan raw)",
  ap.stripAnsi(resumedTui).includes(ap.TUI_ALT_SCREEN_ENTER),
  false,
);
// Straddle: the watch keeps marker-length−1 raw chars between chunks, so a
// marker split across two pty chunks still completes.
const markerMid = Math.floor(ap.TUI_ALT_SCREEN_ENTER.length / 2);
const chunk1 = "resuming…" + ap.TUI_ALT_SCREEN_ENTER.slice(0, markerMid);
const chunk2 = ap.TUI_ALT_SCREEN_ENTER.slice(markerMid) + "\x1b[2J";
const carried = chunk1.slice(1 - ap.TUI_ALT_SCREEN_ENTER.length);
check(
  "straddled disarm marker completes across chunks",
  (carried + chunk2).includes(ap.TUI_ALT_SCREEN_ENTER),
  true,
);

process.exitCode = failures === 0 ? 0 : 1;
console.log(failures === 0 ? "\nAll agent-pattern checks passed." : `\n${failures} check(s) FAILED.`);
