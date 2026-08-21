// Guards the RUN PLAYBOOKS block in Cora's LIVE system prompt
// (resources/pi-cora/prompt.ts, built by buildCoraPiSystemPrompt). The
// playbooks are the manager's default run shapes; this pins that they exist,
// stay small, keep their structure, and only reach the modes that can spawn
// workers.
//
//   node scripts/test-manager-playbooks.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SECTION_HEADER = "Run playbooks:";
const MAX_BLOCK_LINES = 40;
const MAX_PLAYBOOK_LINES = 10;
const EXPECTED_PLAYBOOKS = ["research brief", "feature build", "audit"];
const TASK_CLASSES = ["skeleton", "feature", "leaf", "verifier"];
const EM_DASH = "—";
const EN_DASH = "–";

// auto and execute plan and delegate; talk and automation do not spawn coding
// workers, so they must NOT pay tokens for the block.
const PLAYBOOK_MODES = ["auto", "execute"];
const NON_PLAYBOOK_MODES = ["talk", "automation"];

/** The playbooks section runs from its header to the next blank-line+section. */
function extractBlock(prompt) {
  const at = prompt.indexOf(SECTION_HEADER);
  if (at < 0) return null;
  const rest = prompt.slice(at);
  // The next top-level section starts after a blank line with a non-indented,
  // non-bullet line ending in ":".
  const next = rest.slice(SECTION_HEADER.length).search(/\n\n[A-Z][^\n]*:\n/);
  return (next < 0 ? rest : rest.slice(0, SECTION_HEADER.length + next)).trim();
}

/** Split into one entry per "- Name. ..." playbook bullet. */
function splitPlaybooks(block) {
  const lines = block.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith("- ")) {
      current = { title: line.slice(2).trim(), lines: [line] };
      entries.push(current);
    } else if (line.startsWith(" ") && current) {
      current.lines.push(line);
    }
  }
  return entries;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-playbooks-"));
  const outfile = path.join(tmp, "pi-prompt.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "resources", "pi-cora", "prompt.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const { buildCoraPiSystemPrompt } = require(outfile);

  let pass = 0;
  const check = (name, ok) => {
    if (!ok) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  // 1. Reach: the spawning modes carry the block exactly once; the others not
  // at all. The block is byte-identical across modes and policies so it rides
  // the cacheable prompt prefix.
  let block = null;
  for (const mode of PLAYBOOK_MODES) {
    for (const policy of ["fast", "deep"]) {
      const prompt = buildCoraPiSystemPrompt(mode, policy);
      const hits = prompt.split(SECTION_HEADER).length - 1;
      check(`${mode}/${policy} carries the playbooks block`, hits >= 1);
      check(`${mode}/${policy} carries it exactly once`, hits === 1);
      const extracted = extractBlock(prompt);
      check(`${mode}/${policy} block is extractable`, Boolean(extracted));
      if (block === null) block = extracted;
      check(`${mode}/${policy} block is byte-identical across modes`, extracted === block);
    }
  }
  for (const mode of NON_PLAYBOOK_MODES) {
    check(
      `${mode} does not pay for the playbooks`,
      !buildCoraPiSystemPrompt(mode).includes(SECTION_HEADER),
    );
  }

  // 2. Size budget: playbooks are defaults, not an essay.
  const blockLines = block.split("\n");
  check(
    `the block is under ${MAX_BLOCK_LINES} lines (actual ${blockLines.length})`,
    blockLines.length < MAX_BLOCK_LINES,
  );

  const entries = splitPlaybooks(block);
  // First bullet is the pick-and-declare instruction; the playbooks follow.
  const playbooks = entries.filter((entry) =>
    EXPECTED_PLAYBOOKS.some((name) => entry.title.toLowerCase().startsWith(name)),
  );
  check(
    `the block defines exactly ${EXPECTED_PLAYBOOKS.length} playbooks (actual ${playbooks.length})`,
    playbooks.length === EXPECTED_PLAYBOOKS.length,
  );

  // 3. Shape: each playbook says when it applies, names a taskClass on its Mix
  // line, and says when its verifier spawns.
  for (const entry of playbooks) {
    const name = entry.title.split(".")[0];
    const text = entry.lines.join("\n");
    check(
      `playbook "${name}" is at most ${MAX_PLAYBOOK_LINES} lines (actual ${entry.lines.length})`,
      entry.lines.length <= MAX_PLAYBOOK_LINES,
    );
    check(`playbook "${name}" states when it applies`, /\bApplies when\b/.test(text));
    const mixAt = text.indexOf("Mix:");
    check(`playbook "${name}" has a Mix line`, mixAt >= 0);
    check(
      `playbook "${name}" names a taskClass in its Mix`,
      TASK_CLASSES.some((klass) => text.slice(mixAt, mixAt + 300).includes(klass)),
    );
    check(`playbook "${name}" states its verification shape`, /\bVerification:/.test(text));
    const verifyAt = text.indexOf("Verification:");
    check(
      `playbook "${name}" says when its verifier is spawned`,
      /\b(after|once)\b/i.test(text.slice(verifyAt, verifyAt + 200)),
    );
  }

  // Leaf reviewers WRITE, so the audit playbook must give them a concrete
  // write scope; allowedPaths=[] would serialize the parallel batch.
  const audit = playbooks.find((entry) => entry.title.toLowerCase().startsWith("audit"));
  check(
    "the audit playbook gives its reviewers a concrete write scope",
    /concrete write scope/i.test((audit || { lines: [] }).lines.join("\n")),
  );

  // 4. The run must declare which playbook it picked, in the first commentary.
  const declare = entries[0] ? entries[0].lines.join(" ") : "";
  check("the block opens with the pick-and-declare instruction", /name your pick/i.test(declare));
  check("the declare instruction points at the first commentary", /first commentary/i.test(declare));
  for (const name of EXPECTED_PLAYBOOKS) {
    check(`the declare instruction offers "${name}" by name`, declare.toLowerCase().includes(name));
  }

  // 5. The block obeys the punctuation rule that sits beside it.
  check(
    "the block contains no em or en dash",
    !block.includes(EM_DASH) && !block.includes(EN_DASH),
  );

  console.log(`\nAll ${pass} manager-playbook checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
