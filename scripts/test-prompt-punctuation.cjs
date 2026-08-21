// Guards the "no em dashes" rule at both ends: the rule must REACH every
// prompt a model receives (the live manager system prompt, the worker brief,
// and the verifier brief), and no prompt surface may itself contain the
// character. It exists because the rule silently died twice in earlier
// profile plumbing; asserting on the strings the model actually receives is
// the only durable guard.
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
const PI_MODES = ["talk", "auto", "execute", "automation"];

// Every file whose text reaches a model: system prompts, worker prompts, and
// MCP tool descriptions (which are injected into the model's tool schema).
const PROMPT_SURFACES = [
  "src/main/orchestration/prompt-profile.ts",
  "src/main/orchestration/worker-prompt.ts",
  // The RPC/tool layer: its validation and error strings land verbatim in the
  // model's tool results, so it must obey the same punctuation rule.
  "src/main/agent-socket.ts",
  "resources/orchestration/manager-profile.json",
  "resources/codara-studio-mcp/server.js",
  "resources/pi-cora/prompt.ts",
  "resources/pi-cora/worker.ts",
  "resources/pi-cora/worker-policy.ts",
  "resources/pi-cora/mcp-bridge.ts",
  "resources/pi-cora/deep-search.ts",
  "resources/pi-cora/repeat-guard.ts",
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
    DEFAULT_MANAGER_PROMPT_PROFILE,
  } = require(outfile);
  const piOutfile = path.join(tmp, "pi-prompt.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "resources", "pi-cora", "prompt.ts")],
    outfile: piOutfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const { buildCoraPiSystemPrompt } = require(piOutfile);

  let pass = 0;
  const check = (name, ok) => {
    if (!ok) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  const marker = /PUNCTUATION: never write an em dash/;

  // The rule must reach every live manager mode.
  for (const mode of PI_MODES) {
    check(
      `pi ${mode} prompt carries the punctuation rule`,
      marker.test(buildCoraPiSystemPrompt(mode, "fast")),
    );
  }

  // ...and both worker briefs, from the bundled JSON and the TS fallback.
  const bundled = loadManagerPromptProfile();
  for (const [label, profile] of [
    ["bundled profile", bundled],
    ["TS fallback profile", DEFAULT_MANAGER_PROMPT_PROFILE],
  ]) {
    check(
      `${label}: the worker opening carries the punctuation rule`,
      profile.workerPrompt.opening.some((line) => marker.test(line)),
    );
    check(
      `${label}: the verifier opening carries the punctuation rule`,
      profile.workerPrompt.verifierOpening.some((line) => marker.test(line)),
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
