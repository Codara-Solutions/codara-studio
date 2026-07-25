// Guards the "no em dashes" rule at both ends: the rule must REACH every
// manager prompt, and no prompt surface may itself contain the character.
//
// This exists because the rule silently died twice. First it was added to
// manager-profile.json but not to the TypeScript default that the JSON
// overrides, so it vanished whenever the default was in force. Then it was
// added to `manager.identity` in both, which reaches nothing: a per-mode
// `systemPromptOverrides` entry REPLACES identity + coreOperatingModel + rules
// wholesale, and every mode defines one. The rule is now appended in
// buildManagerSystemPrompt, and this test pins that it survives for each mode.
//
//   node scripts/test-prompt-punctuation.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PROFILE_JSON = path.join(ROOT, "resources", "orchestration", "manager-profile.json");
const MODES = ["plan_analysis", "chat", "step_planning", "worker_result_review"];

// Every file whose text reaches a model: system prompts, worker prompts, and
// MCP tool descriptions (which are injected into the model's tool schema).
const PROMPT_SURFACES = [
  "src/main/orchestration/prompt-profile.ts",
  "src/main/orchestration/worker-prompt.ts",
  "resources/orchestration/manager-profile.json",
  "resources/orchestration/cc-auto-prompt.md",
  "resources/orchestration/cc-execute-prompt.md",
  "resources/orchestration/cc-automation-prompt.md",
  "resources/orchestration/codex-auto-prompt.md",
  "resources/orchestration/codex-execute-prompt.md",
  "resources/codara-studio-mcp/server.js",
  "resources/pi-cora/prompt.ts",
  "resources/pi-cora/worker.ts",
  "resources/pi-cora/mcp-bridge.ts",
  "resources/pi-cora/deep-search.ts",
];

const EM_DASH = "—";
const EN_DASH = "–";

const harness = {
  name: "prompt-punctuation-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    // Point the loader at the real bundled profile so the test exercises the
    // JSON that actually ships, not a fixture.
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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-punct-"));
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

  const marker = /PUNCTUATION: never write an em dash/g;

  // The rule must reach every mode, including the ones with a full override.
  const bundled = loadManagerPromptProfile();
  for (const mode of MODES) {
    const prompt = buildManagerSystemPrompt(bundled, mode);
    const hits = (prompt.match(marker) || []).length;
    check(`bundled profile: ${mode} carries the punctuation rule`, hits >= 1);
    check(`bundled profile: ${mode} carries it exactly once`, hits === 1);
  }
  check(
    "bundled profile: the no-mode prompt carries the rule",
    marker.test(buildManagerSystemPrompt(bundled)),
  );

  // The TypeScript default is the fallback whenever the bundled JSON cannot be
  // read. It must satisfy the same contract, which is the failure mode that
  // started all of this.
  const fallback = DEFAULT_MANAGER_PROMPT_PROFILE;
  for (const mode of MODES) {
    const prompt = buildManagerSystemPrompt(fallback, mode);
    check(
      `TS fallback profile: ${mode} carries the punctuation rule`,
      (prompt.match(marker) || []).length === 1,
    );
  }

  // No prompt the model reads may contain the character it is told never to
  // emit. An instruction that violates itself teaches the opposite.
  for (const rel of PROMPT_SURFACES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error(`FAIL prompt surface is missing: ${rel}`);
      process.exit(1);
    }
    const text = fs.readFileSync(abs, "utf8");
    const em = text.split(EM_DASH).length - 1;
    const en = text.split(EN_DASH).length - 1;
    check(`${rel} contains no em or en dash (em=${em}, en=${en})`, em === 0 && en === 0);
  }

  console.log(`\nAll ${pass} prompt-punctuation checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
