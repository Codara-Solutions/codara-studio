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
      "a previous record of ANOTHER session is not reused",
      claudeHookSessionCwd({
        sessionId,
        liveCwd: elsewhere,
        transcriptPath,
        previous: { runtime: "claude", sessionId: "other-session", cwd: startCwd },
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
