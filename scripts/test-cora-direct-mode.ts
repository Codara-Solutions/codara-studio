import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import { registerHooks } from "node:module";
import path from "node:path";

// Studio's sources import their siblings without an extension (the bundler
// resolves them); Node's type stripping needs `.ts` spelled out.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || path.extname(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

const {
  followUpNeedsManager,
  isConversationalRequest,
  shouldUseDirectExecution,
} = await import("../src/main/orchestration/direct-execution.ts");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cora-direct-mode-"));
try {
  await fs.writeFile(path.join(root, "index.js"), "module.exports = {};\n");

  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "Implement the parser and run node test.js." }),
    true,
    "bounded work in a small workspace uses the direct lane",
  );
  const skillNames = new Set(["ceo", "verify", "ketchup"]);
  for (const prompt of ["/ceo", "/skill:verify the parser", "/ketchup"]) {
    assert.equal(
      await shouldUseDirectExecution({ cwd: root, prompt, skillNames }),
      false,
      `${prompt} runs a skill, which only the manager expands`,
    );
    assert.equal(followUpNeedsManager(prompt, skillNames), true, `${prompt} as a follow-up goes to the manager`);
  }
  // A leading path or an unknown name is not a skill: the direct lane keeps it.
  for (const prompt of ["/home/me/app/src/index.ts has a typo, fix it", "/tmp/build.log shows the failure", "/unknown do it"]) {
    assert.equal(await shouldUseDirectExecution({ cwd: root, prompt, skillNames }), true, prompt);
    assert.equal(followUpNeedsManager(prompt, skillNames), false, prompt);
  }
  assert.equal(followUpNeedsManager("/ceo"), false, "no skill list means no skill to run");
  assert.equal(followUpNeedsManager("fix src/app.ts"), false);
  assert.equal(isConversationalRequest("hello!"), true);
  assert.equal(isConversationalRequest("what is your favorite food?"), true);
  assert.equal(isConversationalRequest("fix the hello button"), false);
  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "hello" }),
    false,
    "a greeting stays in Cora's conversational lane",
  );
  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "what is your favorite food?" }),
    false,
    "a casual question does not launch an engineering worker",
  );
  assert.equal(
    await shouldUseDirectExecution({
      strategy: "managed",
      cwd: root,
      prompt: "Implement the parser.",
    }),
    false,
    "the managed override wins",
  );
  assert.equal(
    await shouldUseDirectExecution({
      cwd: root,
      prompt: "Research the web and plan a repository-wide migration.",
    }),
    false,
    "broad research and migration work stays orchestrated",
  );
  assert.equal(
    await shouldUseDirectExecution({
      strategy: "direct",
      cwd: root,
      prompt: "Handle this long task directly.",
    }),
    true,
    "the direct override wins for a compatible request",
  );
  assert.equal(
    await shouldUseDirectExecution({
      strategy: "direct",
      cwd: root,
      prompt: "Inspect the screenshot.",
      hasAttachments: true,
    }),
    false,
    "attachments stay on the managed path until direct workers receive them",
  );

  for (let index = 0; index < 100; index += 1) {
    await fs.writeFile(path.join(root, `file-${index}.js`), "\n");
  }
  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "Fix one bug." }),
    true,
    "a bounded fix stays direct in a large workspace without scanning the tree",
  );
  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "Refactor the whole codebase and fix all type errors." }),
    false,
    "repository-wide work stays managed regardless of workspace size",
  );
  for (const prompt of [
    "Draw the auth flow on the whiteboard.",
    "Move the login card to done on the board.",
    "Run my tests every night at 2am.",
    "Schedule a weekly dependency check.",
    "Create an automation that posts the build status.",
    "Add a cron job for the backup script.",
  ]) {
    assert.equal(
      await shouldUseDirectExecution({ cwd: root, prompt }),
      false,
      `a request for a surface the direct worker cannot write stays managed: ${prompt}`,
    );
  }
  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "Fix the dashboard keyboard shortcut." }),
    true,
    "board inside another word is not a board request",
  );
  for (const chatMode of ["plan", "automation", "talk"] as const) {
    assert.equal(
      await shouldUseDirectExecution({ strategy: "direct", cwd: root, prompt: "Fix one bug.", chatMode }),
      false,
      `${chatMode} mode never takes the direct lane`,
    );
  }
  assert.equal(
    await shouldUseDirectExecution({ cwd: root, prompt: "Fix one bug.", chatMode: "auto" }),
    true,
  );
  // A finished direct chat hands a follow-up to the manager only when the
  // direct worker cannot serve it; greetings and bounded fixes stay direct.
  assert.equal(followUpNeedsManager("now draw this on the whiteboard"), true);
  assert.equal(followUpNeedsManager("refactor the whole codebase in parallel"), true);
  assert.equal(followUpNeedsManager("run this every night"), true);
  assert.equal(followUpNeedsManager("thanks!"), false);
  assert.equal(followUpNeedsManager("also fix the typo in utils.ts"), false);

  // A direct worker is one model that cannot start helpers or stop to ask, so
  // delegation to agents or several models, and a "let me pick first" gate,
  // go to the manager, as a first message and as a follow-up.
  for (const prompt of [
    "Build the settings page. Use astra for the hard task and sol for the simpler tasks.",
    "Use opus for the parser and sonnet on the tests.",
    "Spawn sub-agents to fix each failing file.",
    "Delegate the work to three agents and merge their results.",
    "Use a different model for each task.",
    "Show me 3 options for the landing page before you build anything.",
    "Give me some options to choose from, then build the one I pick.",
    "Draft two layouts and I decide which one.",
    "Plan the change and only implement it once I approve.",
    "Wait for my approval before touching the database code.",
    "spin up 3 subagents",
    "have opus write the parser and sonnet write the tests",
    "make 3 versions, I'll pick one",
    "Propose 2 designs, wait for me",
    "show me some options of changes to the onboarding, then I decide, and once I approve you build it",
    "use astra for the hard task and sol for the simpler tasks",
    "Don't change anything until I confirm the plan.",
  ]) {
    assert.equal(await shouldUseDirectExecution({ cwd: root, prompt }), false, `stays with the manager: ${prompt}`);
    assert.equal(followUpNeedsManager(prompt), true, `a follow-up goes to the manager: ${prompt}`);
  }
  for (const prompt of [
    "Fix the options menu so it closes on Escape.",
    "Add a setting that lets me choose the theme.",
    "The approve button does nothing when I click it.",
    "Use flexbox for the header and grid for the cards.",
    "Fix the subagent count in the rail.",
    "Use sol for this fix.",
    "Show the alternatives list sorted by name.",
    "Fix the dialog so I can pick a file.",
    "Run the tests with two workers in jest config.",
    "show me the options in the config file",
    "Show me the designs folder",
    "show me the choices array in settings.ts",
    "Crash happens when I pick a file",
    "Fix the bug when I approve a PR",
    "after I confirm the dialog the page reloads",
    "Add a dropdown so I can pick which theme",
    "the rail crashes with sub-agents",
    "Run the subagent tests",
    "Use the sub-agent API in agent-socket.ts",
    "codex on linux and claude on mac both crash",
  ]) {
    assert.equal(await shouldUseDirectExecution({ cwd: root, prompt }), true, `stays direct: ${prompt}`);
    assert.equal(followUpNeedsManager(prompt), false, `a follow-up stays direct: ${prompt}`);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("PASS Cora direct-execution routing");
