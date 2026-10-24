// Coverage for the deterministic capture of what a user message teaches Cora
// (src/main/orchestration/memory-signals.ts): explicit "remember" requests,
// standing preferences, corrections, their scope and confidence, and the
// cases that must stay quiet (questions, descriptions, code, quotes, logs,
// secrets, a first message that cannot correct anything).
//
//   node scripts/test-memory-signals.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const path = require("node:path");
const esbuild = require("esbuild");

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

const harness = {
  name: "memory-signals-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(__dirname, "..", "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [harness],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const { detectMemorySignals, classifyMemoryScope } = await load(
    path.join(__dirname, "..", "src", "main", "orchestration", "memory-signals.ts"),
  );
  const first = { followsCoraReply: false };
  const reply = { followsCoraReply: true };
  const one = (message, context) => detectMemorySignals(message, context).candidates;

  // ── explicit remember ─────────────────────────────────────────────────────
  let found = one("Remember that I deploy from the release branch.", first);
  check("remember: captured", found.length === 1 && found[0].trigger === "remember", JSON.stringify(found));
  check("remember: filler removed", found[0] && found[0].text === "I deploy from the release branch.", found[0] && found[0].text);
  check("remember: high confidence", found[0] && found[0].confidence === 0.9, JSON.stringify(found[0]));
  check("remember: quote is the user's sentence", found[0] && found[0].quote === "Remember that I deploy from the release branch.", JSON.stringify(found[0]));
  found = one("Recuerda que me llamo Etienne y prefiero respuestas cortas.", first);
  check("remember (es): captured as a global preference", found.length === 1 && found[0].scope === "global" && found[0].kind === "preference", JSON.stringify(found));
  found = one("Souviens-toi que je travaille sur Linux.", first);
  check("remember (fr): captured", found.length === 1, JSON.stringify(found));
  check("remember: 'do you remember when' is a question, not a request", one("Do you remember when we fixed the updater?", first).length === 0, "");
  check("remember: 'remember how' is not a request", one("I remember how this broke last week, it was the cache.", first).length === 0, "");

  // ── standing preferences ──────────────────────────────────────────────────
  found = one("From now on, always answer in Spanish.", first);
  check("preference: captured", found.length === 1 && found[0].trigger === "preference" && found[0].confidence === 0.75, JSON.stringify(found));
  check("preference: reply language is global", found[0] && found[0].scope === "global", JSON.stringify(found[0]));
  found = one("Never push to main without asking me first.", first);
  check("preference: a working-style rule is global", found.length === 1 && found[0].scope === "global", JSON.stringify(found));
  found = one("In this repo always run `npm run typecheck` before committing.", first);
  check("preference: a repository command is workspace scoped", found.length === 1 && found[0].scope === "workspace", JSON.stringify(found));
  found = one("Siempre usa pnpm en este proyecto.", first);
  check("preference (es): workspace scoped", found.length === 1 && found[0].scope === "workspace", JSON.stringify(found));
  found = one("Ab jetzt antworte bitte immer auf Deutsch.", first);
  check("preference (de): captured", found.length === 1, JSON.stringify(found));
  check("preference: a description of the world is not a rule", one("The test always fails on CI after the cache is cleared.", first).length === 0, "");
  check("preference: 'never' about the user's machine is not a rule", one("The build never finishes on my machine.", first).length === 0, "");
  check("preference: 'siempre' describing a failure is not a rule", one("Siempre me falla el test de integracion.", first).length === 0, "");
  found = one("I prefer short answers without a summary at the end.", first);
  check("preference: 'I prefer' is captured", found.length === 1 && found[0].scope === "global", JSON.stringify(found));
  found = one("No me gusta que uses emojis.", first);
  check("preference (es): 'no me gusta que' is captured", found.length === 1, JSON.stringify(found));
  check("preference: a question is not a rule", one("Should we always run the e2e suite?", first).length === 0, "");

  // ── corrections ───────────────────────────────────────────────────────────
  let scan = detectMemorySignals("No, use pnpm instead of npm in this repository.", reply);
  check("correction: rule after rejection is captured", scan.candidates.length === 1 && scan.candidates[0].trigger === "correction", JSON.stringify(scan));
  check("correction: implicit correction starts below the always-on threshold", scan.candidates[0] && scan.candidates[0].confidence === 0.55, JSON.stringify(scan.candidates[0]));
  check("correction: filler removed and capitalized", scan.candidates[0] && scan.candidates[0].text === "Use pnpm instead of npm in this repository.", scan.candidates[0] && scan.candidates[0].text);
  check("correction: noted as a signal for the review", scan.sawCorrection, "");
  scan = detectMemorySignals("No, never add emojis to my replies.", reply);
  check("correction with a preference word is stronger", scan.candidates[0] && scan.candidates[0].kind === "correction" && scan.candidates[0].confidence === 0.8, JSON.stringify(scan));
  scan = detectMemorySignals("No. Use pnpm instead of npm.", reply);
  check("correction: a bare 'No.' still opens a correction", scan.candidates.length === 1 && scan.sawCorrection, JSON.stringify(scan));
  found = one("Remember that I sign emails as Dr. Ruiz.", first);
  check("sentences: a title's period does not split the memory", found[0] && found[0].text === "I sign emails as Dr. Ruiz.", JSON.stringify(found));
  scan = detectMemorySignals("No, that's wrong, the file is in src/main.", reply);
  check("correction without a reusable rule: signal only", scan.candidates.length === 0 && scan.sawCorrection, JSON.stringify(scan));
  scan = detectMemorySignals("No, use pnpm instead of npm.", first);
  check("correction: the first message of a chat corrects nothing", scan.candidates.length === 0 && !scan.sawCorrection, JSON.stringify(scan));
  scan = detectMemorySignals("Te dije que uses pnpm en vez de npm.", reply);
  check("correction (es): captured", scan.candidates.length === 1 && scan.candidates[0].trigger === "correction", JSON.stringify(scan));

  // ── staying quiet ─────────────────────────────────────────────────────────
  check(
    "quiet: code blocks are not the user's words",
    one("Here is the snippet:\n```\n// always use the cache, never skip it\nconst x = 1;\n```", first).length === 0,
    "",
  );
  check("quiet: quoted lines are not the user's words", one("> Always answer in French.\nWhat do you think of this?", first).length === 0, "");
  check(
    "quiet: log lines are skipped",
    one("2026-01-01T10:00:00Z warn: never retry the upload\n[10:00] always fails", first).length === 0,
    "",
  );
  check(
    "quiet: a secret is never captured",
    one("Remember that my password is hunter2hunter2.", first).length === 0,
    "",
  );
  check("quiet: plain task request", one("Add a dark mode toggle to the settings page.", first).length === 0, "");
  const many = one(
    "Always answer in Spanish. Never push without asking. Always run the tests. Never add emojis. Always keep replies short.",
    first,
  );
  check("cap: at most three candidates per message", many.length === 3, String(many.length));

  // ── pasted material ───────────────────────────────────────────────────────
  const footer = "Vendor Inc, 123 Street, Some City. This message and any attachments are confidential and intended only for the addressee; if you received it in error, delete it and notify the sender.";
  const pastedEmail = [
    "Can you summarize this email from the vendor for me?",
    "Hi team,",
    "Thanks for the call. Going forward, always reply to vendors within 24 hours and always CC billing@vendor.example on every answer. Never mention the discount to anyone.",
    `Best,\nJohn\n${footer}`,
  ].join("\n\n");
  check("paste: rules inside a pasted email are not the user's", one(pastedEmail, reply).length === 0, JSON.stringify(one(pastedEmail, reply)));
  const wrapped = [
    "From now on, always answer in Spanish.",
    "Here is the vendor's email:",
    `Hi team, going forward always reply to vendors within 24 hours. ${footer} ${footer}`,
    "Please summarize it in two lines.",
  ].join("\n\n");
  found = one(wrapped, reply);
  check(
    "paste: the user's own ask around the paste is still read",
    found.length === 1 && found[0].text === "Always answer in Spanish.",
    JSON.stringify(found),
  );
  check(
    "paste: a short message of several paragraphs is read whole",
    one("Thanks.\n\nFrom now on, always run the linter before you commit.\n\nNow fix the login bug.", reply).length === 1,
    "",
  );

  // ── scope classification ──────────────────────────────────────────────────
  check("scope: explicit everywhere wins", classifyMemoryScope("Use pnpm everywhere.") === "global", "");
  check("scope: explicit this repo wins", classifyMemoryScope("Answer briefly in this repo.") === "workspace", "");
  check("scope: file names are workspace", classifyMemoryScope("Don't edit package.json by hand.") === "workspace", "");
  check("scope: style is global", classifyMemoryScope("Keep explanations short.") === "global", "");

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll memory-signals checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
