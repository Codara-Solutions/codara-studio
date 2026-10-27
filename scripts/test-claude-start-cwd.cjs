// Harness for the Claude start-cwd helpers in
// src/main/orchestration/claude-paths.ts. Claude files a session's transcript
// under the cwd it was STARTED in, while hooks and transcript lines report the
// live cwd the agent's Bash tool moved into. A restore pointer that saved the
// live cwd probed the wrong project folder and fell back to a fresh session.
//
//   node scripts/test-claude-start-cwd.cjs
//
// esbuild-bundles the REAL claude-paths.ts and drives it against a temp
// Claude config dir. Nothing under the real ~/.claude or Codara home is read.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "orchestration", "claude-paths.ts");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-start-cwd-"));
  process.env.CODARA_HOME_DIR = path.join(dir, "codara-home");
  process.env.SPARK_SKIP_LEGACY_MIGRATION = "1";
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "personal-claude");

  const outfile = path.join(dir, "claude-paths.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const {
    encodeCwdForClaudeProjects,
    claudeProjectCwdForFolder,
    claudeProjectCwdForTranscript,
    claudeHookSessionCwd,
    readClaudeTranscriptCwds,
    locateClaudeTranscript,
  } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  try {
    const startCwd = path.join(dir, "work", "Codara SL");
    const movedCwd = path.join(startCwd, "Studio", "codara-studio");
    const elsewhere = path.join(dir, "other", "repo");
    const sessionId = "0d34e9f6-eaa0-4b77-b80e-11d4c469602b";
    const startFolder = encodeCwdForClaudeProjects(startCwd);
    // The lookup only resumes from a directory that exists.
    fs.mkdirSync(movedCwd, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });

    // --- folder → cwd mapping -------------------------------------------
    check(
      "the start cwd itself maps to its folder",
      claudeProjectCwdForFolder(startFolder, [startCwd]) === startCwd,
    );
    check(
      "a live cwd below the start cwd maps back to the start cwd",
      claudeProjectCwdForFolder(startFolder, [movedCwd]) === startCwd,
    );
    check(
      "an unrelated cwd maps to nothing",
      claudeProjectCwdForFolder(startFolder, [elsewhere]) === null,
    );
    check(
      "later candidates are tried when earlier ones do not fit",
      claudeProjectCwdForFolder(startFolder, [undefined, elsewhere, movedCwd]) === startCwd,
    );
    check(
      "folder of a transcript path drives the mapping",
      claudeProjectCwdForTranscript(
        path.join(dir, "cfg", "projects", startFolder, `${sessionId}.jsonl`),
        [movedCwd],
      ) === startCwd,
    );

    // --- hook record cwd (the source fix) --------------------------------
    const transcriptPath = path.join(
      process.env.CLAUDE_CONFIG_DIR,
      "projects",
      startFolder,
      `${sessionId}.jsonl`,
    );
    check(
      "hook after cd: records the start cwd, not the live cwd",
      claudeHookSessionCwd({ sessionId, liveCwd: movedCwd, transcriptPath }) === startCwd,
    );
    check(
      "hook in the start cwd: unchanged",
      claudeHookSessionCwd({ sessionId, liveCwd: startCwd, transcriptPath }) === startCwd,
    );
    check(
      "hook after cd outside the start dir: keeps the cwd already recorded for the session",
      claudeHookSessionCwd({
        sessionId,
        liveCwd: elsewhere,
        transcriptPath,
        previous: { runtime: "claude", sessionId, cwd: startCwd },
      }) === startCwd,
    );
    check(
      "another session's recorded cwd is not reused when it does not map to this transcript's folder",
      claudeHookSessionCwd({
        sessionId,
        liveCwd: elsewhere,
        transcriptPath: path.join(path.dirname(path.dirname(transcriptPath)), "-unmapped-folder", `${sessionId}.jsonl`),
        previous: { runtime: "claude", sessionId: "other-session", cwd: startCwd },
        spawnCwd: startCwd,
      }) === elsewhere,
    );
    const clearedPath = path.join(path.dirname(transcriptPath), "cleared-session.jsonl");
    check(
      "/clear outside the start dir: the previous record of the old session maps to the folder",
      claudeHookSessionCwd({
        sessionId: "cleared-session",
        liveCwd: elsewhere,
        transcriptPath: clearedPath,
        previous: { runtime: "claude", sessionId, cwd: startCwd },
      }) === startCwd,
    );
    check(
      "/clear outside the start dir: the pane's spawn cwd maps to the folder",
      claudeHookSessionCwd({
        sessionId: "cleared-session",
        liveCwd: elsewhere,
        transcriptPath: clearedPath,
        spawnCwd: startCwd,
      }) === startCwd,
    );
    check(
      "a nested claude started elsewhere keeps its own folder, not the pane's",
      claudeHookSessionCwd({
        sessionId: "nested-session",
        liveCwd: elsewhere,
        transcriptPath: path.join(
          path.dirname(path.dirname(transcriptPath)),
          encodeCwdForClaudeProjects(elsewhere),
          "nested-session.jsonl",
        ),
        previous: { runtime: "claude", sessionId, cwd: startCwd },
        spawnCwd: startCwd,
      }) === elsewhere,
    );
    check(
      "no transcript path and no previous record: the live cwd (old behaviour)",
      claudeHookSessionCwd({ sessionId, liveCwd: movedCwd }) === movedCwd,
    );

    // --- transcript cwd scan ---------------------------------------------
    const lines = (cwds) =>
      [
        JSON.stringify({ type: "file-history-snapshot", messageId: "m0" }),
        ...cwds.map((cwd, i) =>
          JSON.stringify({ type: i % 2 ? "assistant" : "user", cwd, sessionId, uuid: `u${i}` }),
        ),
      ].join("\n") + "\n";
    const scanFile = path.join(dir, "scan.jsonl");
    fs.writeFileSync(scanFile, lines([startCwd, movedCwd, movedCwd, startCwd]), "utf8");
    const scanned = await readClaudeTranscriptCwds(scanFile);
    check(
      "transcript cwds are distinct and in order of appearance",
      JSON.stringify(scanned) === JSON.stringify([startCwd, movedCwd]),
    );
    const injected = path.join(dir, "injected.jsonl");
    fs.writeFileSync(
      injected,
      [
        JSON.stringify({
          type: "assistant",
          cwd: movedCwd,
          message: { content: [{ type: "tool_use", input: { cwd: "/attacker/chosen" } }] },
        }),
        JSON.stringify({
          type: "user",
          cwd: startCwd,
          toolUseResult: { stdout: '{"cwd":"/from/tool/output"}' },
        }),
        '{"type":"user","cwd":"/cut/by/window',
      ].join("\n"),
      "utf8",
    );
    const injectedCwds = await readClaudeTranscriptCwds(injected);
    check(
      "only a record's own cwd counts, user records first; nested keys and cut lines are ignored",
      JSON.stringify(injectedCwds) === JSON.stringify([startCwd, movedCwd]),
    );
    check(
      "an unreadable transcript yields no cwds",
      (await readClaudeTranscriptCwds(path.join(dir, "missing.jsonl"))).length === 0,
    );

    // --- cross-folder lookup by session id -------------------------------
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR, "projects");
    fs.mkdirSync(path.join(projects, startFolder), { recursive: true });
    fs.mkdirSync(path.join(projects, encodeCwdForClaudeProjects(movedCwd)), { recursive: true });
    fs.mkdirSync(path.join(projects, encodeCwdForClaudeProjects(elsewhere)), { recursive: true });
    fs.writeFileSync(transcriptPath, lines([startCwd, movedCwd]), "utf8");

    // The incident: pointer saved the moved cwd and the transcript path is unknown.
    const healed = await locateClaudeTranscript({ sessionId, cwd: movedCwd });
    check(
      "found by id across project folders, resumed from the start cwd",
      healed && healed.path === transcriptPath && healed.cwd === startCwd,
    );

    // Pointer cwd unrelated to the start dir: the transcript's own cwd decides.
    const fromLines = await locateClaudeTranscript({ sessionId, cwd: elsewhere });
    check(
      "a pointer cwd outside the start dir heals from the transcript's recorded cwd",
      fromLines && fromLines.path === transcriptPath && fromLines.cwd === startCwd,
    );

    // The pointer's transcript path names the folder; it is rebuilt under the
    // profile, never followed as given.
    const hinted = await locateClaudeTranscript({
      sessionId,
      cwd: movedCwd,
      transcriptPath: path.join(dir, "somewhere-else", startFolder, `${sessionId}.jsonl`),
    });
    check(
      "a transcript-path hint only contributes its folder name",
      hinted && hinted.path === transcriptPath && hinted.cwd === startCwd,
    );

    // A session started in a worktree that was removed after merge: the
    // transcript survives, its start dir does not. Relocating there would
    // spawn the pane in a missing directory, so the lookup reports nothing
    // and the fresh fallback runs in the pointer's own folder.
    const removedWorktree = path.join(dir, "work", "Worktrees", "repo--feature");
    const removedId = "bbbbbbbb-1111-2222-3333-444444444444";
    const removedFolder = path.join(projects, encodeCwdForClaudeProjects(removedWorktree));
    fs.mkdirSync(removedFolder, { recursive: true });
    fs.writeFileSync(
      path.join(removedFolder, `${removedId}.jsonl`),
      lines([removedWorktree, elsewhere]),
      "utf8",
    );
    check(
      "a start dir that no longer exists is not relocated to",
      (await locateClaudeTranscript({ sessionId: removedId, cwd: elsewhere })) === null,
    );
    fs.mkdirSync(removedWorktree, { recursive: true });
    const restored = await locateClaudeTranscript({ sessionId: removedId, cwd: elsewhere });
    check(
      "the same start dir is used once it exists",
      restored && restored.cwd === removedWorktree,
    );

    // A copy of one id in two folders: the folder the pointer recorded wins
    // over a more recently written copy elsewhere.
    const dupId = "cccccccc-1111-2222-3333-444444444444";
    const hintedCopy = path.join(projects, startFolder, `${dupId}.jsonl`);
    const newerCopy = path.join(projects, encodeCwdForClaudeProjects(elsewhere), `${dupId}.jsonl`);
    fs.writeFileSync(hintedCopy, lines([startCwd]), "utf8");
    fs.writeFileSync(newerCopy, lines([elsewhere]), "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(hintedCopy, old, old);
    const dup = await locateClaudeTranscript({
      sessionId: dupId,
      cwd: path.join(dir, "unrelated"),
      transcriptPath: hintedCopy,
    });
    check(
      "the pointer's own transcript folder wins over a newer copy",
      dup && dup.path === hintedCopy && dup.cwd === startCwd,
    );
    const dupNoHint = await locateClaudeTranscript({
      sessionId: dupId,
      cwd: path.join(dir, "unrelated"),
    });
    check(
      "without a hint the most recently written copy wins",
      dupNoHint && dupNoHint.path === newerCopy && dupNoHint.cwd === elsewhere,
    );

    check(
      "a session that exists nowhere stays not found (fresh fallback)",
      (await locateClaudeTranscript({
        sessionId: "11111111-2222-3333-4444-555555555555",
        cwd: movedCwd,
      })) === null,
    );
    check(
      "a path-like session id is refused",
      (await locateClaudeTranscript({ sessionId: "../../etc/passwd", cwd: movedCwd })) === null,
    );

    // A transcript whose folder no known directory maps to cannot be resumed
    // from any cwd, so it is reported as not found rather than resumed wrongly.
    const orphanId = "99999999-8888-7777-6666-555555555555";
    const orphanFolder = path.join(projects, "-some-folder-nobody-knows");
    fs.mkdirSync(orphanFolder, { recursive: true });
    fs.writeFileSync(path.join(orphanFolder, `${orphanId}.jsonl`), lines([elsewhere]), "utf8");
    check(
      "a transcript with no mappable cwd is not resumed",
      (await locateClaudeTranscript({ sessionId: orphanId, cwd: movedCwd })) === null,
    );

    // A symlinked transcript is refused, matching the in-folder probe.
    const linkedId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const outside = path.join(dir, "outside.jsonl");
    fs.writeFileSync(outside, lines([startCwd]), "utf8");
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(projects, startFolder, `${linkedId}.jsonl`));
      linked = true;
    } catch {
      /* symlinks unavailable (Windows without privilege) */
    }
    if (linked) {
      check(
        "a symlinked transcript is not followed",
        (await locateClaudeTranscript({ sessionId: linkedId, cwd: movedCwd })) === null,
      );
    }
  } finally {
    delete process.env.CODARA_HOME_DIR;
    delete process.env.SPARK_SKIP_LEGACY_MIGRATION;
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall claude start-cwd checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
