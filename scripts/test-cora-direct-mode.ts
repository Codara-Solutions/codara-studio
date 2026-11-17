import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  followUpNeedsManager,
  isConversationalRequest,
  shouldUseDirectExecution,
} from "../src/main/orchestration/direct-execution.ts";

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
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("PASS Cora direct-execution routing");
