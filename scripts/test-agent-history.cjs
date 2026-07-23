// Harness for the per-workspace conversation-history listing in
// src/main/agent-history.ts: Claude per-cwd transcript scan (title from first
// real user message, noise/stillborn/sidechain filtering) and the
// date-bucketed Codex rollout walk (cwd matching, schema-tolerant titles).
//
//   node scripts/test-agent-history.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "agent-history.ts");

async function main() {
  const workDir = path.join(os.tmpdir(), `spark-agent-history-test-${process.pid}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  const outfile = path.join(workDir, "agent-history.cjs");
  fs.mkdirSync(workDir, { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY], bundle: true, platform: "node", format: "cjs", outfile,
    logLevel: "silent",
  });
  delete require.cache[outfile];
  const { listAgentHistoryForCwd, extractClaudeTitle, extractCodexTitle } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // ---- pure title extraction ----

  const claudeLines = (lines) => lines.map((l) => JSON.stringify(l)).join("\n");
  const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });

  check(
    "claude title: plain string user message",
    extractClaudeTitle(claudeLines([user("Fix the login bug please")])).title === "Fix the login bug please",
  );
  check(
    "claude title: skips slash-command + caveat noise",
    extractClaudeTitle(
      claudeLines([
        user("Caveat: The messages below were generated..."),
        user("<command-name>/model</command-name>"),
        user("Real question here"),
      ]),
    ).title === "Real question here",
  );
  check(
    "claude title: text block array",
    extractClaudeTitle(claudeLines([user([{ type: "tool_result", content: "x" }, { type: "text", text: "  Block   title " }])])).title === "Block title",
  );
  check(
    "claude title: meta lines ignored",
    extractClaudeTitle(claudeLines([user("meta noise", { isMeta: true })])).title === null,
  );
  check(
    "claude title: sidechain flagged",
    extractClaudeTitle(claudeLines([{ type: "user", isSidechain: true, message: { content: "sub" } }])).sidechain === true,
  );
  check(
    "claude title: long message capped",
    (extractClaudeTitle(claudeLines([user("x".repeat(500))])).title ?? "").length <= 120,
  );

  check(
    "codex title: response_item input_text",
    extractCodexTitle(
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }),
        JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>skip me" }] } }),
        JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Deploy the api" }] } }),
      ].join("\n"),
    ) === "Deploy the api",
  );
  check(
    "codex title: event_msg user_message shape",
    extractCodexTitle(JSON.stringify({ payload: { type: "user_message", message: "Hola codex" } })) === "Hola codex",
  );

  // ---- filesystem listing ----

  const cwd = path.join(workDir, "My Project");
  fs.mkdirSync(cwd, { recursive: true });
  const claudeDir = path.join(workDir, "claude-projects");
  fs.mkdirSync(claudeDir, { recursive: true });

  const writeTranscript = (name, lines, mtime) => {
    const p = path.join(claudeDir, name);
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.utimesSync(p, mtime, mtime);
    return p;
  };
  const T0 = new Date("2026-07-20T10:00:00Z");
  const uuid = (n) => `${String(n).padStart(8, "0")}-1111-4222-8333-444444444444`;

  writeTranscript(`${uuid(1)}.jsonl`, [user("Oldest conversation")], new Date(T0.getTime() - 3600_000));
  writeTranscript(`${uuid(2)}.jsonl`, [user("<command-name>/usage</command-name>"), user("Newest conversation")], new Date(T0.getTime() - 60_000));
  // Stillborn: no user message — never listed (resume would refuse it).
  writeTranscript(`${uuid(3)}.jsonl`, [{ type: "summary", summary: "x" }], T0);
  // Subagent transcript — never listed.
  writeTranscript(`${uuid(4)}.jsonl`, [{ type: "user", isSidechain: true, message: { content: "sub" } }, user("hidden")], T0);
  // Non-uuid filename — ignored.
  fs.writeFileSync(path.join(claudeDir, "notes.jsonl"), JSON.stringify(user("not a session")));

  const codexRoot = path.join(workDir, "codex-sessions");
  const codexDirFor = (date) => {
    const pad = (n) => String(n).padStart(2, "0");
    return path.join(codexRoot, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
  };
  const codexUuid = "abcdef00-1234-4abc-8def-1234567890ab";
  const codexDay = codexDirFor(new Date(T0.getTime() - 2 * 24 * 3600_000));
  fs.mkdirSync(codexDay, { recursive: true });
  const rollout = path.join(codexDay, `rollout-2026-07-18T09-00-00-${codexUuid}.jsonl`);
  fs.writeFileSync(
    rollout,
    [
      JSON.stringify({ type: "session_meta", payload: { cwd } }),
      JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex task here" }] } }),
    ].join("\n") + "\n",
  );
  const codexMtime = new Date(T0.getTime() - 2 * 24 * 3600_000);
  fs.utimesSync(rollout, codexMtime, codexMtime);
  // A rollout for a DIFFERENT cwd in the same day bucket — must be filtered.
  const otherRollout = path.join(codexDay, `rollout-2026-07-18T09-30-00-ffffffff-1234-4abc-8def-1234567890ff.jsonl`);
  fs.writeFileSync(
    otherRollout,
    [
      JSON.stringify({ type: "session_meta", payload: { cwd: path.join(workDir, "Other") } }),
      JSON.stringify({ payload: { type: "user_message", message: "other workspace" } }),
    ].join("\n") + "\n",
  );

  const entries = await listAgentHistoryForCwd(cwd, {
    claudeDir,
    codexSessionsDirForDate: codexDirFor,
    now: T0,
  });

  check("listing: three resumable sessions found", entries.length === 3);
  check(
    "listing: newest activity first",
    entries[0]?.sessionId === uuid(2) && entries[1]?.sessionId === uuid(1) && entries[2]?.sessionId === codexUuid,
  );
  check("listing: claude titles skip command noise", entries[0]?.title === "Newest conversation");
  check("listing: codex entry carries runtime + title", entries[2]?.runtime === "codex" && entries[2]?.title === "Codex task here");
  check("listing: other-workspace codex rollout filtered", entries.every((e) => e.sessionId !== "ffffffff-1234-4abc-8def-1234567890ff"));
  check("listing: entries carry transcript paths", entries.every((e) => fs.existsSync(e.transcriptPath)));
  check(
    "listing: lastActivityAt reflects mtime ordering",
    Date.parse(entries[0].lastActivityAt) > Date.parse(entries[1].lastActivityAt),
  );

  const empty = await listAgentHistoryForCwd(path.join(workDir, "no-sessions"), {
    claudeDir: path.join(workDir, "missing-dir"),
    codexSessionsDirForDate: codexDirFor,
    now: T0,
  });
  check("listing: unknown cwd lists empty (no throw)", Array.isArray(empty) && empty.length === 0);

  fs.rmSync(workDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all agent-history checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
