import type { AutomationLoop, AutomationTrigger, LoomGraph, LoomWorkerConfig } from "@shared/types";

// Preset gallery for the node-flow editor. Each preset stamps the whole draft
// (trigger + loop + worker + prompt) so a new loom is one click + one prompt
// tweak away. Workers default to "auto" — the loom runs on whichever CLI agent
// is installed, and agent-driven loops may hand off between them.

export interface LoomPreset {
  id: string;
  title: string;
  blurb: string;
  trigger: AutomationTrigger;
  loop: AutomationLoop;
  worker: LoomWorkerConfig;
  promptHint: string;
  /** Optional starting graph (multi-node pipelines). When absent the loom opens
   *  as a single worker node carrying `promptHint`. */
  graph?: LoomGraph;
}

const AUTO: LoomWorkerConfig = { engine: "auto" };

// ── example graphs ───────────────────────────────────────────────────────────

/** "Fix until tests pass": worker → guard(tests); pass = done, fail loops back
 *  to the worker (a marked back-edge with a visit cap). */
export const GRAPH_FIX_UNTIL_TESTS: LoomGraph = {
  version: 1,
  nodes: [
    {
      id: "w0",
      kind: "worker",
      label: "Fix failures",
      ui: { x: 320, y: 60 },
      worker: AUTO,
      prompt:
        "Run the tests, read the failures, and fix the root cause. Make one focused change, then stop.",
    },
    {
      id: "g0",
      kind: "guard",
      label: "Tests pass?",
      ui: { x: 620, y: 60 },
      predicate: { type: "tests", command: "npm test" },
    },
  ],
  edges: [
    { id: "e-w0-g0", from: "w0", to: "g0" },
    // fail → back to the worker (loop-back, bounded).
    { id: "e-g0-w0", from: "g0", to: "w0", branch: "fail", backEdge: true, visitCap: 10 },
  ],
  entryNodeIds: ["w0"],
};

/** "Fan-out review": worker A + worker B run in parallel, then merge. */
export const GRAPH_FANOUT_REVIEW: LoomGraph = {
  version: 1,
  nodes: [
    {
      id: "a",
      kind: "worker",
      label: "Reviewer A",
      ui: { x: 320, y: 20 },
      worker: AUTO,
      prompt: "Review the latest diff for correctness bugs. List concrete findings.",
    },
    {
      id: "b",
      kind: "worker",
      label: "Reviewer B",
      ui: { x: 320, y: 200 },
      worker: AUTO,
      prompt: "Review the latest diff for simplification and reuse opportunities.",
    },
    {
      id: "m",
      kind: "merge",
      label: "Merge findings",
      ui: { x: 620, y: 110 },
      joinMode: "all",
    },
    {
      id: "w",
      kind: "worker",
      label: "Apply fixes",
      ui: { x: 880, y: 110 },
      worker: AUTO,
      prompt:
        "Two reviewers reported on the diff. Combine {{node:a}} and {{node:b}} and apply the high-confidence fixes.",
    },
  ],
  edges: [
    { id: "e-a-m", from: "a", to: "m" },
    { id: "e-b-m", from: "b", to: "m" },
    { id: "e-m-w", from: "m", to: "w" },
  ],
  entryNodeIds: ["a", "b"],
};

export const PRESETS: LoomPreset[] = [
  {
    id: "agent",
    title: "Agent decides",
    blurb: "The model keeps looping until it says it's done — bounded by your caps.",
    trigger: { kind: "manual" },
    loop: { kind: "agent", stop: { maxIterations: 20, budgetUsd: 5 } },
    worker: AUTO,
    promptHint:
      "Improve the codebase one focused change at a time. When you've made a change, end your summary with SPARK_LOOP_CONTINUE to keep going, or SPARK_LOOP_DONE when there's nothing left worth doing.",
  },
  {
    id: "until-tests",
    title: "Fix until tests pass",
    blurb: "Worker → tests guard; loops back on failure until green.",
    trigger: { kind: "manual" },
    loop: { kind: "until", stop: { untilTestsPass: true, testCommand: "npm test", maxIterations: 15 } },
    worker: AUTO,
    promptHint: "Find and fix the failing tests. Run the tests, read the failures, and fix the root cause.",
    graph: GRAPH_FIX_UNTIL_TESTS,
  },
  {
    id: "fanout-review",
    title: "Fan-out review",
    blurb: "Two reviewers in parallel → merge → apply fixes.",
    trigger: { kind: "manual" },
    loop: { kind: "once", stop: {} },
    worker: AUTO,
    promptHint: "Review the latest diff.",
    graph: GRAPH_FANOUT_REVIEW,
  },
  {
    id: "nightly",
    title: "Nightly digest",
    blurb: "Run once every night on a cron schedule.",
    trigger: { kind: "cron", expr: "0 2 * * *" },
    loop: { kind: "once", stop: {} },
    worker: AUTO,
    promptHint: "Summarize what changed in this repo today and write it to NOTES.md.",
  },
  {
    id: "watch",
    title: "Watch folder → act",
    blurb: "Fire when files change in a folder.",
    trigger: { kind: "folder", path: "", events: ["add", "change"] },
    loop: { kind: "once", stop: {} },
    worker: AUTO,
    promptHint: "A file changed at {{file}}. Review it and take the appropriate action.",
  },
  {
    id: "continuous",
    title: "Continuous polish",
    blurb: "Loop back-to-back until the budget runs out.",
    trigger: { kind: "continuous" },
    loop: { kind: "continuous", stop: { budgetUsd: 5, maxIterations: 20 } },
    worker: AUTO,
    promptHint: "Make one small, safe improvement to the codebase. Iteration {{iteration}}.",
  },
  {
    id: "blank",
    title: "Start blank",
    blurb: "A manual one-shot you can shape from scratch.",
    trigger: { kind: "manual" },
    loop: { kind: "once", stop: {} },
    worker: AUTO,
    promptHint: "",
  },
];
