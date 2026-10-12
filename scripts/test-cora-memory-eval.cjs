// Offline evaluation of Cora memory v3, end to end, with seeded multi-session
// conversations: user messages go through the same capture path the run
// store's commit hook uses, and every check reads the memory text that the
// next manager or worker prompt would actually carry
// (formatCoraMemoryForTurn / formatCoraMemoryForWorker). No model and no
// network: the review step uses a scripted runner.
//
//   node scripts/test-cora-memory-eval.cjs        (also: npm run eval:memory)
//
// Prints a metrics table and exits non-zero when a scenario fails or a
// metric falls under its floor.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-memory-eval-"));
const ORCHESTRATION = path.join(__dirname, "..", "src", "main", "orchestration");

let failures = 0;
const results = [];
function scenario(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${passed ? "" : `: ${detail}`}`);
  if (!passed) failures += 1;
}

const harness = {
  name: "memory-eval-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(__dirname, "..", "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /\/codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
    build.onResolve({ filter: /\/pi-commit-one-shot$/ }, () => ({ path: "pi-commit-one-shot", namespace: "stub" }));
    build.onLoad({ filter: /^codara-home$/, namespace: "stub" }, () => ({
      contents: `export const codaraHome = () => ${JSON.stringify(TMP_HOME)};`,
      loader: "js",
    }));
    build.onLoad({ filter: /^pi-commit-one-shot$/, namespace: "stub" }, () => ({
      contents: `export async function runSessionlessPiCommitMessage() { throw new Error("model call in the offline eval"); }`,
      loader: "js",
    }));
  },
};

async function loadAll() {
  const entry = path.join(TMP_HOME, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * as learning from ${JSON.stringify(path.join(ORCHESTRATION, "memory-learning.ts"))};`,
      `export * as items from ${JSON.stringify(path.join(ORCHESTRATION, "memory-items.ts"))};`,
      `export * as coraMemory from ${JSON.stringify(path.join(ORCHESTRATION, "cora-memory.ts"))};`,
      `export * as profiles from ${JSON.stringify(path.join(ORCHESTRATION, "cora-profiles.ts"))};`,
    ].join("\n"),
  );
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

// ── a tiny chat simulator ───────────────────────────────────────────────────

let clock = Date.parse("2026-09-01T08:00:00Z");
let sequence = 0;
function stamp() {
  clock += 60_000;
  return new Date(clock).toISOString();
}

function makeChat(workspaceId, profileId = "default", extra = {}) {
  sequence += 1;
  return {
    id: `run-${sequence}`,
    workspaceId,
    coraProfileId: profileId,
    title: `chat ${sequence}`,
    humanMessages: [],
    ...extra,
  };
}

async function say(learning, chat, message) {
  chat.humanMessages.push({
    id: `${chat.id}-u${chat.humanMessages.length}`,
    runId: chat.id,
    author: "user",
    kind: "note",
    message,
    createdAt: stamp(),
  });
  learning.noteRunMessages(chat);
  await learning.flushMemoryCapture(chat.id);
  chat.humanMessages.push({
    id: `${chat.id}-c${chat.humanMessages.length}`,
    runId: chat.id,
    author: "spark",
    kind: "note",
    message: "Done.",
    createdAt: stamp(),
  });
}

async function main() {
  const { learning, items, coraMemory, profiles } = await loadAll();
  const reviews = [];
  learning.setReflectionRunnerForTests(async (request) => {
    reviews.push(request);
    return JSON.stringify({ operations: [] });
  });
  const turnPrompt = (chat, query) =>
    coraMemory.formatCoraMemoryForTurn(chat.workspaceId, chat.id, { profileId: chat.coraProfileId, query });
  const workerPrompt = (workspaceId, query, profileId = "default") =>
    coraMemory.formatCoraMemoryForWorker(workspaceId, profileId, query) ?? "";
  const blockChars = [];
  const measure = (text) => {
    const start = (text ?? "").indexOf("CORA LEARNED MEMORY (");
    if (start >= 0) blockChars.push(text.slice(start).length);
    return text ?? "";
  };

  // 1. A stated language preference reaches the next chat's first prompt.
  const first = makeChat("ws-app");
  await say(learning, first, "From now on, always answer in Spanish.");
  const next = makeChat("ws-app");
  const p1 = measure(await turnPrompt(next, "Fix the login redirect bug."));
  scenario("preference from chat 1 is in chat 2's first prompt", /Always answer in Spanish\./.test(p1), p1);
  const elsewhere = measure(await turnPrompt(makeChat("ws-other"), "Write a README."));
  scenario("a global preference follows the user to another workspace", /answer in Spanish/.test(elsewhere), elsewhere);

  // 2. A correction is scoped to its repository and retrieved when relevant.
  const install = makeChat("ws-app");
  await say(learning, install, "Add zod to the project.");
  await say(learning, install, "No, use pnpm instead of npm in this repository.");
  const relevant = measure(workerPrompt("ws-app", "Install the dependencies and add date-fns."));
  scenario("workspace correction is retrieved for a related task", /Use pnpm instead of npm in this repository\./.test(relevant), relevant);
  const otherRepo = measure(workerPrompt("ws-other", "Install the dependencies and add date-fns."));
  scenario("workspace correction never leaks into another repository", !/pnpm/.test(otherRepo), otherRepo);
  const unrelated = measure(workerPrompt("ws-app", "Rename the hero heading on the landing page."));
  scenario("a one-off correction is not always-on", !/pnpm/.test(unrelated), unrelated);

  // 3. Saying it again makes it a standing rule.
  const again = makeChat("ws-app");
  await say(learning, again, "Update the lockfile.");
  await say(learning, again, "No, use pnpm instead of npm in this repository.");
  const confirmed = items.listMemoryItems("default", { workspaceId: "ws-app" }).filter((item) => /pnpm/.test(item.text));
  scenario("a repeated correction confirms, never duplicates", confirmed.length === 1 && confirmed[0].confirmations === 2, JSON.stringify(confirmed));
  const nowCore = measure(workerPrompt("ws-app", "Rename the hero heading on the landing page."));
  scenario("a repeated correction becomes always-on", /pnpm/.test(nowCore), nowCore);

  // 4. A change of mind replaces the old rule in later prompts.
  const change = makeChat("ws-app");
  await say(learning, change, "Summarize the release notes.");
  await say(learning, change, "Actually, reply in English from now on.");
  const after = measure(await turnPrompt(makeChat("ws-app"), "Summarize the open issues."));
  scenario("the newer preference is in the prompt", /reply in English/i.test(after), after);
  scenario("the replaced preference is gone from the prompt", !/answer in Spanish/.test(after), after);
  const commitRule = makeChat("ws-app");
  await say(learning, commitRule, "Always write commit messages in English.");
  await say(learning, commitRule, "Remember that I chat in Spanish when I'm tired.");
  const languages = items.listMemoryItems("default").filter((item) => item.status === "active" && /English|Spanish/.test(item.text));
  scenario(
    "related but different rules coexist (reply vs commit language)",
    languages.some((item) => /commit messages/.test(item.text)) && languages.some((item) => /reply in English/i.test(item.text)),
    JSON.stringify(languages.map((item) => item.text)),
  );

  // 5. Profiles are separate people (or roles) with separate memories.
  const workProfile = await profiles.createCoraProfile({ name: "Work" });
  const work = makeChat("ws-app", workProfile.id);
  await say(learning, work, "Remember that invoices go to finance@acme.test.");
  const defaultPrompt = measure(await turnPrompt(makeChat("ws-app"), "Send the invoice."));
  const workPrompt = measure(await turnPrompt(makeChat("ws-app", workProfile.id), "Send the invoice."));
  scenario("profile memory stays in its profile", /finance@acme\.test/.test(workPrompt) && !/finance@acme\.test/.test(defaultPrompt), `${workPrompt}\n---\n${defaultPrompt}`);
  scenario("the default profile's preferences do not leak into another profile", !/reply in English/i.test(workPrompt), workPrompt);

  // 6. Memory off writes nothing; secrets are never stored.
  await coraMemory.setMemoryEnabled("workspace", "ws-locked", false);
  const locked = makeChat("ws-locked");
  await say(learning, locked, "Remember that in this repo the staging URL is staging.internal.");
  scenario("workspace memory off: nothing learned there", !items.listMemoryItems("default", { includeArchived: true }).some((item) => /staging\.internal/.test(item.text)), "");
  const secret = makeChat("ws-app");
  await say(learning, secret, "Remember that the deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789.");
  scenario("a secret is never stored", !items.listMemoryItems("default", { includeArchived: true }).some((item) => /ghp_/.test(item.text)), "");

  // 7. Manager injection is a delta: one copy per session, again after compaction.
  const session = makeChat("ws-app");
  const t1 = await turnPrompt(session, "Refactor the auth module.");
  const t2 = await turnPrompt(session, "Refactor the auth module.");
  coraMemory.resetCoraMemoryInjection(session.id);
  const t3 = await turnPrompt(session, "Refactor the auth module.");
  scenario("delta: an unchanged second turn re-sends nothing", t1 && /CORA LEARNED MEMORY/.test(t1) && t2 === null, `${t1}\n---\n${t2}`);
  scenario("delta: after a compaction the memory is sent again", t3 && /reply in English/i.test(t3), String(t3));

  // 8. Retrieval quality against distractors.
  const RW = "ws-retrieval";
  const targets = [
    ["The staging database is reset every Monday at 06:00.", "why is staging data missing after the weekend"],
    ["Feature flags live in config/flags.yaml, not in the database.", "turn on the new checkout feature flag"],
    ["The iOS build needs Xcode 16 and a manual signing step.", "the ios build fails at signing"],
    ["Use the shared Button component instead of raw buttons in the UI.", "add a cancel button to the settings dialog"],
    ["Playwright specs must run headless with a single worker.", "the e2e tests hang when run in parallel"],
    ["Database migrations are generated with drizzle-kit, never written by hand.", "add a column to the users table"],
    ["Releases are tagged by CI; never create tags locally.", "cut a release for version 2.3"],
    ["Error messages shown to users must be translated with t().", "show an error when the upload fails"],
  ];
  const distractorTopics = ["billing", "analytics", "search", "notifications", "avatars", "exports", "webhooks", "audit log", "rate limits", "sitemaps"];
  const distractors = [];
  for (let i = 0; i < 40; i += 1) {
    const topic = distractorTopics[i % distractorTopics.length];
    distractors.push(`The ${topic} service ${["caches results for", "retries failed jobs after", "logs to stdout every", "batches writes each"][i % 4]} ${5 + i} seconds.`);
  }
  await items.applyLearned("default", [...targets.map(([text]) => text), ...distractors].map((text) => ({
    scope: "workspace",
    workspaceId: RW,
    kind: "fact",
    text,
    source: "user",
    confidence: 0.75,
  })));
  let hitsAt1 = 0;
  let hitsAt3 = 0;
  let injected = 0;
  for (const [text, query] of targets) {
    const ranked = items.searchMemoryItems("default", RW, query, 3).map((item) => item.text);
    if (ranked[0] === text) hitsAt1 += 1;
    else console.log(`  rank miss: "${query}" -> ${JSON.stringify(ranked[0])}`);
    if (ranked.includes(text)) hitsAt3 += 1;
    if (measure(workerPrompt(RW, query)).includes(text)) injected += 1;
  }
  const recallAt1 = hitsAt1 / targets.length;
  const recallAt3 = hitsAt3 / targets.length;
  const injectedRate = injected / targets.length;
  scenario(`recall@3 against 40 distractors >= 0.75 (got ${recallAt3.toFixed(2)})`, recallAt3 >= 0.75, "");
  scenario(`the right item reaches the worker prompt >= 0.75 (got ${injectedRate.toFixed(2)})`, injectedRate >= 0.75, "");

  // 9. The review is gated: a quiet chat costs no model call, a signal does.
  const quietReview = makeChat("ws-app");
  await say(learning, quietReview, "Bump the version.");
  await learning.maybeReflect(quietReview);
  const reviewsAfterQuiet = reviews.length;
  const signalReview = makeChat("ws-app");
  await say(learning, signalReview, "Write the migration.");
  await say(learning, signalReview, "No, that's not how we do it, check the docs first.");
  await learning.maybeReflect(signalReview);
  scenario("review: a quiet chat makes no model call", reviewsAfterQuiet === 0, String(reviewsAfterQuiet));
  scenario("review: a correction signal makes exactly one call", reviews.length === 1, String(reviews.length));

  // 10. Budget.
  const maxBlock = Math.max(0, ...blockChars);
  const avgBlock = blockChars.length > 0 ? blockChars.reduce((a, b) => a + b, 0) / blockChars.length : 0;
  const ceiling = items.LEARNED_CORE_BUDGET_CHARS + items.LEARNED_RELEVANT_BUDGET_CHARS + 600;
  scenario(`learned block stays inside its budget (max ${maxBlock} <= ${ceiling} chars)`, maxBlock <= ceiling, "");

  const passed = results.filter((result) => result.passed).length;
  console.log("\nCora memory eval");
  console.log("----------------");
  console.log(`scenarios passed        ${passed}/${results.length}`);
  console.log(`recall@1 (8 targets)    ${recallAt1.toFixed(2)}`);
  console.log(`recall@3 (8 targets)    ${recallAt3.toFixed(2)}`);
  console.log(`in worker prompt        ${injectedRate.toFixed(2)}`);
  console.log(`learned block chars     avg ${Math.round(avgBlock)}, max ${maxBlock} (~${Math.round(maxBlock / 4)} tokens)`);
  console.log(`model reviews           ${reviews.length}`);

  learning.setReflectionRunnerForTests(null);
  await items.flushMemoryItemUse();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} scenario(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
