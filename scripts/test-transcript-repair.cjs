// Harness for the Claude transcript tail-repair helpers in
// src/main/orchestration/claude-paths.ts (inspectClaudeTranscriptTail /
// repairClaudeTranscriptTail). These recover a transcript whose LAST line an
// abrupt kill (sleep/crash mid-write) truncated, so `claude --resume` accepts it
// instead of the renderer silently starting a fresh session and losing the
// conversation.
//
//   node scripts/test-transcript-repair.cjs
//
// esbuild-bundles the REAL claude-paths.ts (node builtins only) and drives the
// helpers against temp .jsonl fixtures.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "orchestration", "claude-paths.ts");

// A couple of realistic-shaped transcript records (only that each line is valid
// standalone JSON matters to the repair logic).
const line = (type, i) => JSON.stringify({ type, uuid: `u${i}`, message: { role: type, content: `m${i}` } });

async function main() {
  const dir = path.join(os.tmpdir(), "spark-transcript-repair-test");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const codaraHome = path.join(dir, "codara-home");
  process.env.CODARA_HOME_DIR = codaraHome;
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
    inspectClaudeTranscriptTail,
    repairClaudeTranscriptTail,
    resolveSafeClaudeTranscriptPath,
  } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };
  const write = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  };

  // ── healthy transcript: clean, newline-terminated → not repairable, no-op ──
  const healthy = write("healthy.jsonl", `${line("user", 0)}\n${line("assistant", 1)}\n`);
  const healthyInspect = await inspectClaudeTranscriptTail(healthy);
  check("healthy transcript not flagged repairable", healthyInspect.repairable === false);
  const healthyBefore = fs.readFileSync(healthy, "utf8");
  check("healthy transcript repair is a no-op", (await repairClaudeTranscriptTail(healthy)) === false);
  check("healthy transcript content unchanged", fs.readFileSync(healthy, "utf8") === healthyBefore);
  check("healthy transcript left no .bak", !fs.existsSync(`${healthy}.bak`));

  // ── truncated tail: last line is a partial JSON write (the sleep/crash case) ──
  const goodPart = `${line("user", 0)}\n${line("assistant", 1)}\n`;
  const truncated = write("truncated.jsonl", `${goodPart}{"type":"assistant","uuid":"u2","messa`);
  const truncInspect = await inspectClaudeTranscriptTail(truncated);
  check("truncated tail flagged repairable", truncInspect.repairable === true);
  check("truncated tail repaired", (await repairClaudeTranscriptTail(truncated)) === true);
  const repaired = fs.readFileSync(truncated, "utf8");
  check("repaired file drops the partial line", repaired === goodPart);
  check("repaired file's every line parses", repaired.trim().split("\n").every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  }));
  check("repair kept a .bak copy", fs.existsSync(`${truncated}.bak`));

  // ── complete-but-unterminated last line (no trailing newline): valid, no-op ──
  const unterminated = write("unterminated.jsonl", `${line("user", 0)}\n${line("assistant", 1)}`);
  const unterminatedInspect = await inspectClaudeTranscriptTail(unterminated);
  check("complete-but-unterminated last line NOT repairable", unterminatedInspect.repairable === false);
  check("unterminated last line repair is a no-op", (await repairClaudeTranscriptTail(unterminated)) === false);

  // ── empty file: nothing to inspect or repair ──
  const empty = write("empty.jsonl", "");
  check("empty transcript not repairable", (await inspectClaudeTranscriptTail(empty)).repairable === false);
  check("empty transcript repair is a no-op", (await repairClaudeTranscriptTail(empty)) === false);

  // ── missing file: helpers stay quiet, never throw ──
  const missing = path.join(dir, "does-not-exist.jsonl");
  check("missing transcript not repairable", (await inspectClaudeTranscriptTail(missing)).repairable === false);
  check("missing transcript repair is a no-op", (await repairClaudeTranscriptTail(missing)) === false);

  // ── only a truncated line (no prior good record): nothing parseable → leave ──
  const allBad = write("allbad.jsonl", `{"type":"user","uuid":"u0","conte`);
  check("all-truncated repair leaves it for self-heal", (await repairClaudeTranscriptTail(allBad)) === false);

  // The IPC repair path resolves the transcript from the frozen Claude home
  // before invoking the low-level truncator. Prove selected-home isolation and
  // reject every symlinked ancestor/leaf used to escape that home.
  const cwd = path.join(dir, "workspace");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const selectedHome = path.join(dir, "selected-home");
  const selectedProject = path.join(selectedHome, "projects", encoded);
  fs.mkdirSync(selectedProject, { recursive: true });
  const selectedTranscript = path.join(selectedProject, `${sessionId}.jsonl`);
  fs.writeFileSync(selectedTranscript, `${goodPart}{"partial":`, "utf8");
  const safeSelected = await resolveSafeClaudeTranscriptPath(
    cwd,
    sessionId,
    selectedHome,
    { requireExisting: true },
  );
  check("repair resolves inside the explicitly selected Claude home", safeSelected === selectedTranscript);
  check("selected-home truncated tail repaired", (await repairClaudeTranscriptTail(safeSelected)) === true);

  const otherHome = path.join(dir, "other-home");
  const otherProject = path.join(otherHome, "projects", encoded);
  fs.mkdirSync(otherProject, { recursive: true });
  const otherTranscript = path.join(otherProject, `${sessionId}.jsonl`);
  fs.writeFileSync(otherTranscript, `${goodPart}{"other":`, "utf8");
  let crossHomeRejected = false;
  try {
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, selectedHome, {
      requireExisting: true,
    });
    fs.rmSync(selectedTranscript);
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, selectedHome, {
      requireExisting: true,
    });
  } catch {
    crossHomeRejected = true;
  }
  check(
    "repair lookup never falls through to another Claude home",
    crossHomeRejected && fs.readFileSync(otherTranscript, "utf8").endsWith('{"other":'),
  );

  const outside = path.join(dir, "outside-repair");
  fs.mkdirSync(path.join(outside, encoded), { recursive: true });
  fs.writeFileSync(
    path.join(outside, encoded, `${sessionId}.jsonl`),
    `${goodPart}{"outside":`,
  );
  const projectsLinkHome = path.join(dir, "projects-link-home");
  fs.mkdirSync(projectsLinkHome, { recursive: true });
  fs.symlinkSync(outside, path.join(projectsLinkHome, "projects"), "dir");
  let projectsLinkRejected = false;
  try {
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, projectsLinkHome, {
      requireExisting: true,
    });
  } catch {
    projectsLinkRejected = true;
  }
  check("repair rejects a symlinked projects ancestor", projectsLinkRejected);

  const encodedLinkHome = path.join(dir, "encoded-link-home");
  fs.mkdirSync(path.join(encodedLinkHome, "projects"), { recursive: true });
  fs.symlinkSync(
    path.join(outside, encoded),
    path.join(encodedLinkHome, "projects", encoded),
    "dir",
  );
  let encodedLinkRejected = false;
  try {
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, encodedLinkHome, {
      requireExisting: true,
    });
  } catch {
    encodedLinkRejected = true;
  }
  check("repair rejects a symlinked encoded-project ancestor", encodedLinkRejected);

  // A managed Claude home links projects into the user's own home, and the
  // resume probe must find transcripts through that one link (otherwise every
  // pane restarts fresh after a relaunch). A managed home's link anywhere else
  // and a deeper link are still refused.
  const personalHome = path.join(dir, "personal-claude");
  const personalProject = path.join(personalHome, "projects", encoded);
  fs.mkdirSync(personalProject, { recursive: true });
  const personalTranscript = path.join(personalProject, `${sessionId}.jsonl`);
  fs.writeFileSync(personalTranscript, `${goodPart}`, "utf8");
  const liveHome = path.join(codaraHome, "claude-cli", "live", "home");
  fs.mkdirSync(liveHome, { recursive: true });
  fs.symlinkSync(path.join(personalHome, "projects"), path.join(liveHome, "projects"), "dir");
  const throughShared = await resolveSafeClaudeTranscriptPath(cwd, sessionId, liveHome, {
    requireExisting: true,
  }).catch((error) => error);
  check(
    "a managed home finds transcripts through its link to the personal projects",
    throughShared === path.join(liveHome, "projects", encoded, `${sessionId}.jsonl`),
  );
  const strayHome = path.join(codaraHome, "claude-cli", "accounts", "x", "home");
  fs.mkdirSync(strayHome, { recursive: true });
  fs.symlinkSync(outside, path.join(strayHome, "projects"), "dir");
  let strayRejected = false;
  try {
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, strayHome, { requireExisting: true });
  } catch {
    strayRejected = true;
  }
  check("a managed home's link outside the personal home is refused", strayRejected);
  fs.rmSync(personalProject, { recursive: true });
  fs.symlinkSync(path.join(outside, encoded), personalProject, "dir");
  let deeperRejected = false;
  try {
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, liveHome, { requireExisting: true });
  } catch {
    deeperRejected = true;
  }
  check("a link below the shared projects folder is refused", deeperRejected);

  const leafLinkHome = path.join(dir, "leaf-link-home");
  const leafLinkProject = path.join(leafLinkHome, "projects", encoded);
  fs.mkdirSync(leafLinkProject, { recursive: true });
  fs.symlinkSync(
    path.join(outside, encoded, `${sessionId}.jsonl`),
    path.join(leafLinkProject, `${sessionId}.jsonl`),
  );
  let leafLinkRejected = false;
  try {
    await resolveSafeClaudeTranscriptPath(cwd, sessionId, leafLinkHome, {
      requireExisting: true,
    });
  } catch {
    leafLinkRejected = true;
  }
  check("repair rejects a transcript leaf symlink", leafLinkRejected);

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all transcript-repair checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
