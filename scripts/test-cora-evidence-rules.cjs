// Guards the four evidence/safety rules added after run-msdapnuk-opbm4s, where a
// plan shipped with (a) a regression test that had never been shown failing,
// (b) assertions against an invented CLI banner while a real captured frame sat
// unused, (c) the user's live ~/.codex/auth.json copied into a sandbox inside the
// repo, and (d) the first of three reported symptoms silently left uncovered.
//
// Asserts against the STRING THE MODEL ACTUALLY RECEIVES (every mode x policy),
// not against the source text, so a rule parked in an unreachable branch fails.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cora-evidence-rules-"));

function compile(entry, outfile) {
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(outDir, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  return require(path.join(outDir, outfile));
}

const { buildCoraPiSystemPrompt } = compile("resources/pi-cora/prompt.ts", "cora-prompt.cjs");

// Rules are wrapped prose, so a fragment can straddle a line break. Compare on
// whitespace-collapsed text: rewrapping a rule is fine, deleting it is not.
const flat = (s) => s.replace(/\s+/g, " ");

// Each rule is identified by several distinctive fragments so a reworded but
// intact rule still passes, while a deleted one cannot.
const CORA_RULES = [
  {
    name: "red before green (regression test must be shown failing first)",
    fragments: ["never failed proves nothing", "UNFIXED code FIRST", "repair the fixture"],
  },
  {
    name: "no invented fixture when a real capture exists",
    fragments: ["fixture you invented", "consumes THAT", "wrote it to pass"],
  },
  {
    name: "never copy the user's real credentials",
    fragments: ["NEVER copy the user's real credentials", "Refresh tokens ROTATE", "signed out"],
  },
  {
    name: "empty search is a reportable result, not license to invent",
    fragments: ["REPORTABLE RESULT, not permission to invent", "only the real thing can settle them"],
  },
  {
    name: "mechanical proof before the FIRST verifier, not only the last",
    fragments: ["EVERY verifier including the FIRST one", "reading the diff is not the same as holding exit codes"],
  },
  {
    name: "terminal tabs are for showing the user, not for the agent's own work",
    fragments: ["SHOWING THEM how to do something", "stays in bash where it costs them no screen"],
  },
  {
    name: "no full build in the live app's own workspace",
    fragments: ["full project build in the user's workspace", "output directory the live app is serving"],
  },
  {
    name: "partial coverage counts as not covered",
    fragments: ["PARTIAL counts as NOT COVERED", "Reassurance is not disclosure"],
  },
  {
    name: "answer every reported symptom explicitly",
    fragments: ["reports several symptoms", "covered or not covered", "reads as complete and is not"],
  },
];

const MODES = ["talk", "auto", "execute", "automation"];
const POLICIES = ["fast", "deep", "frontier"];

let checks = 0;
for (const mode of MODES) {
  for (const policy of POLICIES) {
    const prompt = flat(buildCoraPiSystemPrompt(mode, policy));
    for (const rule of CORA_RULES) {
      for (const fragment of rule.fragments) {
        assert.ok(
          prompt.includes(flat(fragment)),
          `Cora ${mode}/${policy} prompt lost the "${rule.name}" rule (missing: ${fragment})`,
        );
        checks += 1;
      }
    }
  }
}

// The credential rule must bind WORKERS too, not just Cora: a worker running a
// capture is exactly as able to copy an auth file into a sandbox.
const workerPrompt = flat(
  fs.readFileSync(path.join(root, "src/main/orchestration/worker-prompt.ts"), "utf8"),
);
for (const fragment of [
  "NEVER copy the user's real credentials",
  "Refresh tokens ROTATE",
  "~/.codex/auth.json",
]) {
  assert.ok(
    workerPrompt.includes(flat(fragment)),
    `worker prompt lost the credential rule (missing: ${fragment})`,
  );
  checks += 1;
}

console.log(`PASS Cora evidence + credential rules reach every mode and workers (${checks} checks)`);
