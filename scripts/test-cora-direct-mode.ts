import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
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
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("PASS Cora direct-execution routing");
