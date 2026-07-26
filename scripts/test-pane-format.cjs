// Harness for src/shared/pane-format.ts, the single home for text Codara
// paints itself into a terminal pane: the sanctioned-vs-crash exit banner the
// renderer writes on pty exit, and the head/tail collapse the Pi worker
// display uses for a pathological tool result.
//
//   node scripts/test-pane-format.cjs
//
// Bundles the real module (esbuild, so the shared stripAnsi import resolves)
// and asserts on exact byte output, since these strings go straight to xterm.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "shared", "pane-format.ts");
const RUN_STORE = path.join(ROOT, "src", "main", "orchestration", "run-store.ts");

async function main() {
  const outfile = path.join(os.tmpdir(), "codara-pane-format-test.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const pane = require(outfile);

  let failures = 0;
  const check = (name, condition, detail) => {
    if (!condition) {
      failures += 1;
      if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
    }
    console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  };
  const eq = (name, actual, expected) => check(name, actual === expected, actual);

  // ── exit banner ───────────────────────────────────────────────────────────
  eq(
    "sanctioned teardown reads as a sentence, no scary parens",
    pane.formatPaneExitLine({ exitCode: 0, signal: 1, sanctioned: true }),
    "\r\n\x1b[2msession ended by Cora\x1b[0m\r\n",
  );
  // The code a pty reports after a teardown Cora asked for belongs to the
  // teardown, not to the work: a failed worker whose pane is then killed must
  // not sign off with a reassuring "exit 0" under its own red failure frame.
  eq(
    "a sanctioned line never quotes the teardown's exit code",
    pane.formatPaneExitLine({ exitCode: 3, sanctioned: true }),
    "\r\n\x1b[2msession ended by Cora\x1b[0m\r\n",
  );
  check(
    "no exit number leaks into the sanctioned sentence",
    !/\d/.test(pane.formatPaneExitLine({ exitCode: 137, signal: 9, sanctioned: true }).replace(/\x1b\[[0-9;]*m/g, "")),
  );
  eq(
    "unexpected death keeps the raw banner byte for byte",
    pane.formatPaneExitLine({ exitCode: 1 }),
    "\r\n\x1b[2m[process exited (1)]\x1b[0m\r\n",
  );
  eq(
    "an explicitly unsanctioned exit is never softened",
    pane.formatPaneExitLine({ exitCode: 137, signal: 9, sanctioned: false }),
    "\r\n\x1b[2m[process exited (137)]\x1b[0m\r\n",
  );
  eq(
    "a missing exit code still renders a number",
    pane.formatPaneExitLine({ exitCode: undefined }),
    "\r\n\x1b[2m[process exited (0)]\x1b[0m\r\n",
  );

  // ── collapse: the pathological command result ─────────────────────────────
  const flood = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const collapsed = pane.collapsePaneOutput(flood);
  eq("flood keeps the default head window", collapsed.head.length, pane.PANE_COLLAPSE_HEAD_LINES);
  eq("flood keeps the default tail window", collapsed.tail.length, pane.PANE_COLLAPSE_TAIL_LINES);
  eq("flood counts every folded line", collapsed.collapsedLines, 100 - 20 - 12);
  eq("head starts at the first line", collapsed.head[0], "line 1");
  eq("tail ends at the last line", collapsed.tail[collapsed.tail.length - 1], "line 100");
  eq("total line count is reported", collapsed.totalLines, 100);
  check(
    "head plus marker plus tail is far shorter than the flood",
    collapsed.head.length + collapsed.tail.length + 1 < 100,
  );

  const short = pane.collapsePaneOutput(Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"));
  eq("at the threshold nothing is collapsed", short.collapsedLines, 0);
  eq("at the threshold every line survives", short.head.length, 40);
  eq("at the threshold the tail window is unused", short.tail.length, 0);

  eq("empty input collapses to nothing", pane.collapsePaneOutput("").totalLines, 0);
  eq("empty input renders no block", pane.formatPaneCollapsedBlock(""), "");
  eq("whitespace-only input renders no block", pane.formatPaneCollapsedBlock("\n\n   \n"), "");

  // Structure preserved: a stack trace still reads like one, and the tail (the
  // part that names the failure) is never the part that gets dropped.
  const trace = [
    "usage: git commit [-a] [-m <msg>]",
    ...Array.from({ length: 60 }, (_, i) => `    --flag-${i}`),
    "error: pathspec 'nope' did not match any file(s)",
  ].join("\n");
  const traceBlock = pane.formatPaneCollapsedBlock(trace, { indent: "    ", color: pane.PANE_RED });
  check("collapsed block keeps the first line", traceBlock.includes("usage: git commit"));
  check(
    "collapsed block keeps the last line, where the error is",
    traceBlock.includes("error: pathspec 'nope' did not match any file(s)"),
  );
  check(
    "collapsed block names how much it folded and where the rest is",
    traceBlock.includes("lines collapsed (full output in the run log)"),
  );
  check("collapse marker is dim", traceBlock.includes("\x1b[2m… "));
  check("content lines carry the caller's color", traceBlock.includes(`\x1b[31musage: git commit`));
  check("every rendered line is CRLF terminated", !/[^\r]\n/.test(traceBlock));
  check("every rendered line carries the caller's indent", !/\r\n(?!    )/.test(traceBlock));
  eq(
    "collapsed block prints exactly head + marker + tail lines",
    traceBlock.split("\r\n").length - 1,
    pane.PANE_COLLAPSE_HEAD_LINES + 1 + pane.PANE_COLLAPSE_TAIL_LINES,
  );

  // ── collapse: hostile bytes ───────────────────────────────────────────────
  const colored = "\x1b[31mred failure\x1b[0m\nplain";
  const strippedBlock = pane.formatPaneCollapsedBlock(colored, { color: pane.PANE_RED });
  check("foreign ANSI is stripped so our color owns the block", !strippedBlock.includes("\x1b[0mred"));
  check("stripped text is preserved", strippedBlock.includes("red failure"));

  const longLine = `${"x".repeat(5000)}\nsecond`;
  const longBlock = pane.collapsePaneOutput(longLine);
  eq("one pathological line is capped", longBlock.head[0].length, pane.PANE_COLLAPSE_MAX_LINE_LENGTH);
  check("capped line is marked with an ellipsis", longBlock.head[0].endsWith("…"));
  eq("a capped line does not eat its neighbours", longBlock.head[1], "second");

  // The tighter per-line cap exists to hold back a flood of long lines. A lone
  // error sentence has no flood behind it, so it keeps the wider budget rather
  // than being truncated harder than the character cut it replaced.
  const oneLiner = `command failed: ${"e".repeat(600)}`;
  eq("a lone error line is not folded at the flood cap", pane.collapsePaneOutput(oneLiner).head[0], oneLiner);
  const hugeSingle = pane.collapsePaneOutput("y".repeat(5000));
  eq(
    "a lone line is still capped, just later",
    hugeSingle.head[0].length,
    pane.PANE_COLLAPSE_MAX_SINGLE_LINE_LENGTH,
  );
  check("the lone-line budget is the wider one", pane.PANE_COLLAPSE_MAX_SINGLE_LINE_LENGTH > pane.PANE_COLLAPSE_MAX_LINE_LENGTH);
  const twoLines = pane.collapsePaneOutput(`${"z".repeat(600)}\ntail`);
  eq("as soon as there are two lines the flood cap applies", twoLines.head[0].length, pane.PANE_COLLAPSE_MAX_LINE_LENGTH);

  const crlf = pane.collapsePaneOutput("a\r\nb\rc\nd");
  eq("CR, CRLF and LF all split into lines", crlf.head.join("|"), "a|b|c|d");

  const noisy = pane.collapsePaneOutput("a\x07\x00b\nc\td");
  eq("C0 noise is neutralised, tabs survive", noisy.head.join("|"), "a  b|c\td");

  const padded = pane.collapsePaneOutput("\n\n\nreal\n\n\n\nother\n\n\n");
  eq("blank runs fold and edges are trimmed", padded.head.join("|"), "real||other");

  const marker = pane.paneCollapseMarker(1);
  check("a single folded line is not pluralised", marker === "… 1 line collapsed (full output in the run log)", marker);

  // Non-string results (a structured tool payload) still collapse instead of
  // reaching the pane as one enormous JSON line.
  const structured = pane.collapsePaneOutput({ a: 1, b: "two" });
  check("object input renders as text", structured.head.join("").includes("\"b\""));

  // ── tool markers ──────────────────────────────────────────────────────────
  eq(
    "tool start marker is teal glyph plus a soft label",
    pane.paneToolStartMarker("Run command"),
    "\x1b[38;2;74;222;208m◇\x1b[0m \x1b[38;2;203;213;225mRun command\x1b[0m",
  );
  eq("success marker keeps the word quiet", pane.paneToolOkMarker(), "\x1b[32m✓\x1b[0m \x1b[2mdone\x1b[0m");
  eq("failure marker stays fully red", pane.paneToolFailMarker(), "\x1b[31m×\x1b[0m \x1b[31mfailed\x1b[0m");
  eq("retry marker is a yellow glyph with dim text", pane.paneRetryMarker("Provider retry…"), "\x1b[33m↻\x1b[0m \x1b[2mProvider retry…\x1b[0m");
  eq("empty text styles to nothing", pane.paneDim(""), "");

  // ── streamed prose budget ─────────────────────────────────────────────────
  eq("stream line count is newline based", pane.paneStreamLineCount("a\nb\nc"), 2);
  eq("a chunk with no newline adds no lines", pane.paneStreamLineCount("abc"), 0);
  check("the stream budget is well above ordinary narration", pane.PANE_STREAM_MAX_LINES >= 200);
  check("the stream cut note points at the run log", pane.PANE_STREAM_CUT_NOTE.includes("run log"));

  const fresh = pane.paneStreamBudget();
  eq("a fresh budget starts empty", `${fresh.lines}/${fresh.chars}`, "0/0");
  check("an empty budget is never over", !pane.paneStreamExceeded(fresh));

  let calm = fresh;
  for (let i = 0; i < 40; i += 1) calm = pane.paneStreamAdd(calm, "a normal sentence of worker narration.\n");
  check("ordinary narration is never cut", !pane.paneStreamExceeded(calm));

  let lineFlood = pane.paneStreamBudget();
  lineFlood = pane.paneStreamAdd(lineFlood, "line\n".repeat(pane.PANE_STREAM_MAX_LINES + 1));
  check("a line flood trips the budget", pane.paneStreamExceeded(lineFlood));

  // Newline-free prose (a JSON blob, a base64 payload, one unbroken
  // paragraph) soft wraps for pages while adding zero lines, so the character
  // half of the budget is what stops it.
  let wall = pane.paneStreamBudget();
  wall = pane.paneStreamAdd(wall, "x".repeat(pane.PANE_STREAM_MAX_CHARS + 1));
  eq("a newline free wall adds no lines", wall.lines, 0);
  check("a newline free wall still trips the budget", pane.paneStreamExceeded(wall));

  let drip = pane.paneStreamBudget();
  // Deltas arrive token by token, so the character count has to survive across
  // chunks or a wall delivered in small pieces would never be caught.
  for (let i = 0; i < 1200; i += 1) drip = pane.paneStreamAdd(drip, "token ".repeat(5));
  eq("small chunks add no lines either", drip.lines, 0);
  check("small newline free chunks accumulate across deltas", pane.paneStreamExceeded(drip));

  // ── the run-store seam: what the pane folds, the log must still keep ──────
  // The collapse marker promises "full output in the run log", and the Pi
  // worker's paint() logs exactly what it paints, so the folded call site has
  // to hand the untouched text to the log itself. Guarded at the source
  // because that pipeline lives inside a long-lived session function.
  const runStore = fs.readFileSync(RUN_STORE, "utf8");
  const toolEndAt = runStore.indexOf('event.type === "tool_execution_end"');
  const toolEndBranch = runStore.slice(toolEndAt, runStore.indexOf('event.type === "message_update"', toolEndAt));
  check("the failed-tool branch was found", toolEndBranch.length > 0 && toolEndBranch.length < 4000);
  const foldedCall = /paintFolded\(([\s\S]*?)\);/.exec(toolEndBranch);
  check("the failed-tool branch paints pane and log separately", Boolean(foldedCall));
  const foldedArgs = foldedCall ? foldedCall[1].split(",") : [];
  check("the pane argument is the folded block", (foldedArgs[0] ?? "").includes("detail"));
  check(
    "the log argument is the untouched result text",
    (foldedArgs.slice(1).join(",") || "").includes("raw") && !(foldedArgs.slice(1).join(",") || "").includes("detail"),
  );
  check("the collapsed block is never the only copy written", !/paint\(`\s*\$\{marker\}\$\{detail\}/.test(toolEndBranch));
  check("the folded result comes from the raw helper", toolEndBranch.includes("piWorkerResultRaw(event.result)"));

  const streamAt = runStore.indexOf('delta?.type === "text_delta"');
  const streamBranch = runStore.slice(streamAt, runStore.indexOf('event.type === "message_end"', streamAt));
  check("the streamed-prose branch was found", streamBranch.length > 0 && streamBranch.length < 4000);
  check("the stream cut asks the shared budget, not a bare line count", streamBranch.includes("paneStreamExceeded("));
  check("the stream budget is fed every delta", streamBranch.includes("paneStreamAdd("));

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\npane format OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
