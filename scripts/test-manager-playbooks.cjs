// Guards the RUN PLAYBOOKS guidance in EVERY manager prompt surface.
//
// The load-bearing fact this test exists to enforce: there are six copies, and
// only five of them are live.
//
//   - src/main/orchestration/prompt-profile.ts appends the block in
//     buildManagerSystemPrompt, which is reachable only from manager-protocol's
//     buildManagerRequest. No shipping backend calls that. Placing playbooks
//     ONLY there reaches zero real manager turns.
//   - Every shipping backend drives a CLI session whose system prompt is a
//     resource file: resources/orchestration/{cc,codex}-{auto,execute}-prompt.md
//     for the claude and codex backends, resources/pi-cora/prompt.ts for pi
//     (the default). Those bytes are what spark-agent-backend's
//     buildManagerStablePrefix caches, so that is where the playbooks must be.
//
// So this file checks both halves:
//   1. the code block reaches every manager mode, exactly once, from both the
//      bundled JSON profile and the TypeScript fallback profile, and stays
//      inside its size budget (under 40 lines, at most 6 lines per playbook),
//   2. each playbook states when it applies, a taskClass mix (asserted on the
//      Mix line itself, not on the title line), and a verification shape, and
//      the run still has to declare which playbook it picked,
//   3. all five LIVE surfaces carry the same three playbooks, with the audit
//      entry demanding a concrete write scope for reviewers rather than
//      allowedPaths=[] (leaf reviewers write, so an empty scope makes
//      autopilot-wave's hasConcreteParallelScope serialize the batch).
//
//   node scripts/test-manager-playbooks.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_JSON = path.join(ROOT, "resources", "orchestration", "manager-profile.json");
const MODES = ["plan_analysis", "chat", "step_planning", "worker_result_review"];

const BLOCK_HEADER = "RUN PLAYBOOKS:";
const MAX_BLOCK_LINES = 40;
const MAX_PLAYBOOK_LINES = 6;
const EXPECTED_PLAYBOOKS = ["research brief", "feature build", "audit"];
const TASK_CLASSES = ["skeleton", "feature", "leaf", "verifier"];
const EM_DASH = "—";
const EN_DASH = "–";

// The markdown guidance files a claude or codex manager session is actually
// given. Every one of these must carry the playbooks section verbatim.
const LIVE_MARKDOWN_SURFACES = [
  "resources/orchestration/cc-auto-prompt.md",
  "resources/orchestration/cc-execute-prompt.md",
  "resources/orchestration/codex-auto-prompt.md",
  "resources/orchestration/codex-execute-prompt.md",
];
const PI_PROMPT_SOURCE = "resources/pi-cora/prompt.ts";
const MARKDOWN_SECTION_HEADER = "## Run playbooks";
const PI_SECTION_HEADER = "Run playbooks:";
// pi's auto and execute modes plan and delegate; talk and automation do not
// spawn coding workers, so they must NOT pay for the block.
const PI_PLAYBOOK_MODES = ["auto", "execute"];
const PI_NON_PLAYBOOK_MODES = ["talk", "automation"];

/** Slice a "## Run playbooks" section out of a markdown prompt file. */
function markdownSection(text) {
  const at = text.indexOf(MARKDOWN_SECTION_HEADER);
  if (at < 0) return null;
  const rest = text.slice(at + MARKDOWN_SECTION_HEADER.length);
  const end = rest.indexOf("\n## ");
  return (MARKDOWN_SECTION_HEADER + (end < 0 ? rest : rest.slice(0, end))).trim();
}

const harness = {
  name: "manager-playbooks-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    // Same trick as test-prompt-punctuation: load the profile that actually
    // ships, not a fixture.
    build.onResolve({ filter: /bundled-resources/ }, () => ({
      path: "bundled-resources",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `module.exports = { resolveBundledResourcePath: () => ${JSON.stringify(PROFILE_JSON)} };`,
      loader: "js",
    }));
  },
};

/** The block is appended last, so it runs from its header to end of prompt. */
function extractBlock(prompt) {
  const at = prompt.indexOf(BLOCK_HEADER);
  return at < 0 ? null : prompt.slice(at).trim();
}

/** Split the block into its header, one entry per playbook, and the tail line. */
function splitPlaybooks(block) {
  const lines = block.split("\n");
  const entries = [];
  let current = null;
  let announce = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith("- ")) {
      current = { title: line.slice(2).trim(), lines: [line] };
      entries.push(current);
    } else if (line.startsWith(" ") && current) {
      current.lines.push(line);
    } else if (line.trim().length > 0) {
      // A non-indented, non-bullet line after the playbooks is the tail
      // instruction telling the manager to declare its pick.
      announce = line.trim();
      current = null;
    }
  }
  return { entries, announce };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-playbooks-"));
  const outfile = path.join(tmp, "profile.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "prompt-profile.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [harness],
    logLevel: "silent",
  });
  const {
    loadManagerPromptProfile,
    buildManagerSystemPrompt,
    DEFAULT_MANAGER_PROMPT_PROFILE,
  } = require(outfile);

  let pass = 0;
  const check = (name, ok) => {
    if (!ok) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  const bundled = loadManagerPromptProfile();
  const profiles = [
    ["bundled profile", bundled],
    ["TS fallback profile", DEFAULT_MANAGER_PROMPT_PROFILE],
  ];

  // 1. Reach: every mode, both profile sources, exactly one copy.
  for (const [label, profile] of profiles) {
    for (const mode of MODES) {
      const prompt = buildManagerSystemPrompt(profile, mode);
      const hits = prompt.split(BLOCK_HEADER).length - 1;
      check(`${label}: ${mode} carries the playbooks block`, hits >= 1);
      check(`${label}: ${mode} carries it exactly once`, hits === 1);
    }
    check(
      `${label}: the no-mode prompt carries the playbooks block`,
      (buildManagerSystemPrompt(profile).split(BLOCK_HEADER).length - 1) === 1,
    );
  }

  const block = extractBlock(buildManagerSystemPrompt(bundled, "plan_analysis"));
  check("the playbooks block is extractable", Boolean(block));

  // The block must be identical whatever mode or profile built it, otherwise it
  // is not a stable prefix and every mode pays a fresh cache miss.
  for (const [label, profile] of profiles) {
    for (const mode of MODES) {
      check(
        `${label}: ${mode} block text is byte-identical to the plan_analysis one`,
        extractBlock(buildManagerSystemPrompt(profile, mode)) === block,
      );
    }
  }

  // 2. Size budget.
  const blockLines = block.split("\n");
  check(
    `the block is under ${MAX_BLOCK_LINES} lines (actual ${blockLines.length})`,
    blockLines.length < MAX_BLOCK_LINES,
  );

  const { entries, announce } = splitPlaybooks(block);
  check(
    `the block defines exactly ${EXPECTED_PLAYBOOKS.length} playbooks (actual ${entries.length})`,
    entries.length === EXPECTED_PLAYBOOKS.length,
  );
  for (const name of EXPECTED_PLAYBOOKS) {
    check(
      `playbook "${name}" is present`,
      entries.some((entry) => entry.title.toLowerCase().startsWith(name)),
    );
  }

  // 3. Shape of each playbook: size, when it applies, taskClass mix, verification.
  for (const entry of entries) {
    const name = entry.title.split(".")[0];
    const text = entry.lines.join("\n");
    check(
      `playbook "${name}" is at most ${MAX_PLAYBOOK_LINES} lines (actual ${entry.lines.length})`,
      entry.lines.length <= MAX_PLAYBOOK_LINES,
    );
    check(`playbook "${name}" states when it applies`, /\bApplies when\b/.test(text));
    // Assert the taskClass mix on the Mix LINE, not on the whole entry: the
    // entry starts with the playbook title, so "- feature build." would satisfy
    // a whole-entry `includes("feature")` even if the Mix line named no class
    // at all, and the guard would silently stop guarding.
    const mixLine = entry.lines.find((line) => /\bMix:/.test(line)) || "";
    check(`playbook "${name}" has a Mix line`, mixLine.length > 0);
    check(
      `playbook "${name}" names a taskClass on its Mix line`,
      TASK_CLASSES.some((klass) => mixLine.slice(mixLine.indexOf("Mix:")).includes(klass)),
    );
    check(`playbook "${name}" states its verification shape`, /\bVerification:/.test(text));
    // Every verification line must say WHO spawns the verifier and when.
    // taskClass=verifier is a read-only follow-up that manager-protocol rejects
    // in a plan_analysis plannedAgents list and in a run's first batch, so a
    // bare "Verification: one verifier" reads as part of the initial plan shape.
    const verificationLine = entry.lines.find((line) => /\bVerification:/.test(line)) || "";
    check(
      `playbook "${name}" says when its verifier is spawned`,
      /\b(after|once)\b/i.test(verificationLine) || /worker_result_review/.test(verificationLine),
    );
  }

  // Leaf reviewers WRITE (autopilot-wave's taskWritesWorkspace is false only for
  // taskClass=verifier), so allowedPaths=[] fails hasConcreteParallelScope and
  // the "parallel audit" the playbook promises collapses to a serial chain.
  const auditEntry = entries.find((entry) => entry.title.toLowerCase().startsWith("audit"));
  check("the audit playbook is extractable", Boolean(auditEntry));
  check(
    "the audit playbook gives its reviewers a concrete write scope",
    /concrete write scope/i.test((auditEntry || { lines: [] }).lines.join("\n")),
  );

  // 4. The run must declare which playbook it picked.
  check("the block ends with the declare-your-pick line", Boolean(announce));
  check(
    "the declare-your-pick line points at the first decision",
    /first decision/i.test(announce || ""),
  );
  for (const name of EXPECTED_PLAYBOOKS) {
    check(
      `the declare-your-pick line offers "${name}" by name`,
      (announce || "").toLowerCase().includes(name),
    );
  }

  // 5. The block obeys the punctuation rule that sits beside it.
  check(
    "the block contains no em or en dash",
    !block.includes(EM_DASH) && !block.includes(EN_DASH),
  );

  // 6. Idempotence: a profile whose override already inlines the block must not
  // receive a second copy, the same guard the punctuation rule relies on.
  const inlined = JSON.parse(JSON.stringify(DEFAULT_MANAGER_PROMPT_PROFILE));
  inlined.manager.systemPromptOverrides.plan_analysis = `Some override text.\n\n${block}`;
  check(
    "a profile that already inlines the block gets exactly one copy",
    (buildManagerSystemPrompt(inlined, "plan_analysis").split(BLOCK_HEADER).length - 1) === 1,
  );

  // 7. THE LIVE SURFACES. Everything above only proves the block survives a
  // path no shipping backend calls. These are the bytes a real manager reads.
  const sections = [];
  for (const rel of LIVE_MARKDOWN_SURFACES) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const section = markdownSection(text);
    check(`${rel} carries a "${MARKDOWN_SECTION_HEADER}" section`, Boolean(section));
    if (!section) continue;
    sections.push([rel, section]);
    for (const name of EXPECTED_PLAYBOOKS) {
      check(`${rel} names the "${name}" playbook`, section.toLowerCase().includes(name));
    }
    check(
      `${rel} states a Mix for each of the ${EXPECTED_PLAYBOOKS.length} playbooks`,
      (section.split("Mix:").length - 1) === EXPECTED_PLAYBOOKS.length,
    );
    check(
      `${rel} states a Verification shape for each playbook`,
      (section.split("Verification:").length - 1) === EXPECTED_PLAYBOOKS.length,
    );
    // Every verification clause must say WHEN the verifier runs. A bare
    // "Verification: one verifier" reads as part of the initial plan shape, and
    // a verifier in a run's first batch is rejected by the spawn batch guard.
    check(
      `${rel} says when each verifier is spawned`,
      (section.split("Verification: once").length - 1) === EXPECTED_PLAYBOOKS.length,
    );
    check(
      `${rel} gives audit reviewers a concrete write scope`,
      /concrete write scope/i.test(section),
    );
    check(
      `${rel} tells the manager to name the shape it picked`,
      /name the shape you picked/i.test(section),
    );
    check(
      `${rel} playbooks contain no em or en dash`,
      !section.includes(EM_DASH) && !section.includes(EN_DASH),
    );
  }
  // One text, four files: a fix applied to one prompt must not skip the others.
  for (const [rel, section] of sections) {
    check(
      `${rel} playbooks section is byte-identical to ${sections[0][0]}`,
      section === sections[0][1],
    );
  }

  // pi is the DEFAULT backend and builds its prompt in TypeScript, so bundle it
  // and ask the real builder rather than grepping the source.
  const piOut = path.join(tmp, "pi-prompt.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, PI_PROMPT_SOURCE)],
    outfile: piOut,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const { buildCoraPiSystemPrompt } = require(piOut);
  for (const mode of PI_PLAYBOOK_MODES) {
    const prompt = buildCoraPiSystemPrompt(mode);
    check(`pi ${mode} mode carries the playbooks`, prompt.includes(PI_SECTION_HEADER));
    check(
      `pi ${mode} mode carries them exactly once`,
      (prompt.split(PI_SECTION_HEADER).length - 1) === 1,
    );
    for (const name of EXPECTED_PLAYBOOKS) {
      check(`pi ${mode} mode names the "${name}" playbook`, prompt.toLowerCase().includes(name));
    }
    check(
      `pi ${mode} mode gives audit reviewers a concrete write scope`,
      /concrete write scope/i.test(prompt),
    );
    check(
      `pi ${mode} mode playbooks contain no em or en dash`,
      !prompt.includes(EM_DASH) && !prompt.includes(EN_DASH),
    );
  }
  for (const mode of PI_NON_PLAYBOOK_MODES) {
    check(
      `pi ${mode} mode does not pay for the playbooks`,
      !buildCoraPiSystemPrompt(mode).includes(PI_SECTION_HEADER),
    );
  }

  console.log(`\nAll ${pass} manager-playbook checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
