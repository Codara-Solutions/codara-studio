#!/usr/bin/env node
// Tests for "Split into commits" — the feature's safety property is that it
// can produce fewer/uglier commits than ideal but can NEVER lose, duplicate,
// or half-commit a change. Three layers:
//   1. pure validators (normalizeSplitGroups / splitPlanViolation) fuzzed with
//      adversarial model output;
//   2. parsePlanText against fenced/prose/garbage model replies;
//   3. executeSplitCommits against REAL throwaway git repos, including
//      renames, deletions, staged+unstaged mixes, stale plans, and a
//      mid-sequence failure (bad path injected after validation).
"use strict";

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

// ── bundle the real modules (same @shared alias trick as the other suites) ──
async function bundle(entry, extra = {}) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["electron", "cpu-features", "ssh2", ...(extra.external ?? [])],
    alias: { "@shared": path.join(ROOT, "src/shared") },
    plugins: extra.stub
      ? [
          {
            name: "stubs",
            setup(build) {
              build.onResolve({ filter: extra.stub }, (args) => ({
                path: args.path,
                namespace: "stub",
              }));
              build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
                contents: extra.stubSource,
                loader: "ts",
              }));
            },
          },
        ]
      : [],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// Loaded inside main() — esbuild's plugin API is async-only.
let normalizeSplitGroups, splitPlanViolation, parsePlanText, executeSplitCommits, planSplitCommits;
let extractDiffSymbols, orderSplitGroups;

async function loadModules() {
  const shared = await bundle("src/shared/git-split.ts");
  ({ normalizeSplitGroups, splitPlanViolation } = shared);
  extractDiffSymbols = shared.extractDiffSymbols;
  orderSplitGroups = shared.orderSplitGroups;
  const mainMod = await bundle("src/main/git-split-commits.ts", {
    stub: /orchestration\/pi-commit-one-shot|^\.\/storage$|^\.\/inline-ai$/,
    stubSource: `
      export const runSessionlessPiCommitMessage = async () => { throw new Error("no model in tests"); };
      export const loadSettings = async () => ({ commitMessageModel: "auto", openRouterModel: "x" });
      export const runInlineAiChatCompletion = async () => ({ error: "no model in tests" });
    `,
  });
  ({ parsePlanText, executeSplitCommits, planSplitCommits } = mainMod);
}

// ── helpers: real throwaway repos ──
const CLEANUP = [];
function makeRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "codara-split-test-"));
  CLEANUP.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@codara.local");
  git("config", "user.name", "Split Test");
  git("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return { dir, git };
}
function log(git) {
  return git("log", "--pretty=format:%s").split("\n");
}
function commitFiles(git, ref) {
  return git("show", "--name-only", "--pretty=format:", ref).trim().split("\n").filter(Boolean).sort();
}
/** Rename-blind view: a rename shows as its delete+add pair. */
function commitFilesNoRename(git, ref) {
  return git("show", "--name-only", "--no-renames", "--pretty=format:", ref)
    .trim().split("\n").filter(Boolean).sort();
}

(async () => {
  await loadModules();

  /* ═══ 1. normalizeSplitGroups: adversarial input ═══ */
  {
    const changed = ["a.ts", "b.ts", "c.ts"];
    // hallucinated path dropped, duplicate stays in FIRST group, missing file -> leftover
    const r = normalizeSplitGroups(
      [
        { message: "one", files: ["a.ts", "ghost.ts", "b.ts"] },
        { message: "two", files: ["b.ts"] },
      ],
      changed,
    );
    assert.deepStrictEqual(r.groups.map((g) => g.files), [["a.ts", "b.ts"]], "dup claimed by first, ghost dropped, empty group two removed");
    assert.deepStrictEqual(r.leftover, ["c.ts"], "unmentioned file surfaces as leftover");

    assert.strictEqual(normalizeSplitGroups([], changed), null, "empty array -> null");
    assert.strictEqual(normalizeSplitGroups("nope", changed), null, "non-array -> null");
    assert.strictEqual(normalizeSplitGroups([{ message: "", files: ["a.ts"] }], changed), null, "no salvageable group -> null");
    assert.strictEqual(normalizeSplitGroups([{ message: "x", files: ["ghost.ts"] }], changed), null, "all-ghost group -> null");
    assert.strictEqual(
      normalizeSplitGroups([{ message: "x", files: [1, null, {}] }], changed),
      null,
      "non-string paths ignored -> null",
    );
    console.log("PASS normalizeSplitGroups adversarial input");
  }

  /* ═══ 2. splitPlanViolation: the execution gate ═══ */
  {
    const changed = ["a.ts", "b.ts"];
    const good = [
      { message: "m1", files: ["a.ts"] },
      { message: "m2", files: ["b.ts"] },
    ];
    assert.strictEqual(splitPlanViolation(good, changed), null, "valid plan passes");
    assert.match(splitPlanViolation([], changed), /no commits/);
    assert.match(splitPlanViolation([{ message: "m", files: ["a.ts"] }], changed), /misses a changed file/);
    assert.match(
      splitPlanViolation([{ message: "m", files: ["a.ts", "a.ts", "b.ts"] }], changed),
      /twice/,
    );
    assert.match(
      splitPlanViolation([{ message: "m", files: ["a.ts", "b.ts", "ghost.ts"] }], changed),
      /no changes/,
    );
    assert.match(splitPlanViolation([{ message: " ", files: ["a.ts", "b.ts"] }], changed), /no message/);
    console.log("PASS splitPlanViolation gate");
  }

  /* ═══ 3. parsePlanText: messy model replies ═══ */
  {
    const groups = [{ message: "m", reason: "r", files: ["a.ts"] }];
    const clean = JSON.stringify({ groups });
    assert.deepStrictEqual(parsePlanText(clean), groups, "clean JSON");
    assert.deepStrictEqual(parsePlanText("```json\n" + clean + "\n```"), groups, "fenced JSON");
    assert.deepStrictEqual(
      parsePlanText("Here is the plan you asked for:\n" + clean + "\nHope that helps!"),
      groups,
      "prose-wrapped JSON",
    );
    assert.strictEqual(parsePlanText("no json at all"), null, "garbage -> null");
    assert.strictEqual(parsePlanText('{"broken": '), null, "truncated JSON -> null");
    assert.strictEqual(parsePlanText('{"notgroups": []}'), null, "wrong shape -> null");
    console.log("PASS parsePlanText messy replies");
  }

  /* ═══ 4. execute: happy path with staged+unstaged mix, deletion, new file ═══ */
  {
    const { dir, git } = makeRepo({ "src/app.ts": "app v1\n", "src/lib.ts": "lib v1\n", "README.md": "readme\n" });
    writeFileSync(path.join(dir, "src/app.ts"), "app v2\n"); // modify
    rmSync(path.join(dir, "README.md")); // delete
    git("rm", "-q", "--cached", "README.md");
    writeFileSync(path.join(dir, "src/new.ts"), "brand new\n"); // untracked
    git("add", "src/app.ts"); // stage ONE of them — mixed index

    const res = await executeSplitCommits(dir, [
      { message: "feat: rework app", files: ["src/app.ts", "src/new.ts"] },
      { message: "chore: drop readme", files: ["README.md"] },
    ]);
    assert.strictEqual(res.ok, true, `execute ok: ${res.error}`);
    assert.strictEqual(res.committed.length, 2);
    assert.deepStrictEqual(log(git).slice(0, 2), ["chore: drop readme", "feat: rework app"]);
    assert.deepStrictEqual(commitFiles(git, res.committed[0].hash), ["src/app.ts", "src/new.ts"]);
    assert.deepStrictEqual(commitFiles(git, res.committed[1].hash), ["README.md"]);
    assert.strictEqual(git("status", "--porcelain").trim(), "", "working tree clean after full split");
    assert.match(res.committed[0].hash, /^[0-9a-f]{40}$/, "real hashes reported");
    console.log("PASS execute: mixed staged/unstaged + deletion + untracked");
  }

  /* ═══ 5. execute: rename travels as one unit ═══ */
  {
    const { dir, git } = makeRepo({ "old-name.ts": "content that is long enough to be tracked as a rename\n", "other.ts": "x\n" });
    git("mv", "old-name.ts", "new-name.ts");
    writeFileSync(path.join(dir, "other.ts"), "y\n");

    const res = await executeSplitCommits(dir, [
      { message: "refactor: rename module", files: ["new-name.ts"] },
      { message: "fix: other", files: ["other.ts"] },
    ]);
    assert.strictEqual(res.ok, true, `rename split ok: ${res.error}`);
    const first = commitFilesNoRename(git, res.committed[0].hash);
    assert.ok(first.includes("new-name.ts") && first.includes("old-name.ts"), `rename commit carries both sides: ${first}`);
    assert.strictEqual(git("status", "--porcelain").trim(), "", "clean tree after rename split");
    console.log("PASS execute: rename staged as one unit");
  }

  /* ═══ 6. execute: stale plan refused (file changed between plan and run) ═══ */
  {
    const { dir, git } = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" });
    writeFileSync(path.join(dir, "a.ts"), "a2\n");
    // plan claims b.ts too, but b.ts is unchanged -> violation, nothing committed
    const res = await executeSplitCommits(dir, [
      { message: "m", files: ["a.ts", "b.ts"] },
    ]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.committed.length, 0, "nothing committed on stale plan");
    assert.match(res.error, /no changes/, "stale plan explained");
    assert.match(res.error, /Generate the plan again/, "recovery hint present");
    assert.deepStrictEqual(log(git), ["initial"], "repo untouched");
    console.log("PASS execute: stale plan refused, repo untouched");
  }

  /* ═══ 7. execute: mid-sequence failure reports partial result honestly ═══ */
  {
    const { dir, git } = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" });
    writeFileSync(path.join(dir, "a.ts"), "a2\n");
    writeFileSync(path.join(dir, "b.ts"), "b2\n");
    // Sabotage group 2 AFTER validation would pass: monkey-patch is not
    // possible from outside, so simulate the failure class git actually
    // produces mid-run — lock the index so the second stage fails.
    const groups = [
      { message: "first: lands", files: ["a.ts"] },
      { message: "second: blocked", files: ["b.ts"] },
    ];
    // Run sequentially but inject the failure between commits via a hook: a
    // commit-msg hook (it receives the REAL message file as $1, unlike
    // pre-commit which runs before the message is written) that fails only
    // for the second group's message.
    mkdirSync(path.join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(
      path.join(dir, ".git/hooks/commit-msg"),
      `#!/bin/sh\nif grep -q "second: blocked" "$1"; then exit 1; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const res = await executeSplitCommits(dir, groups);
    assert.strictEqual(res.ok, false, "run reports failure");
    assert.strictEqual(res.committed.length, 1, "exactly the first commit landed");
    assert.strictEqual(res.committed[0].message, "first: lands");
    assert.match(res.error, /second: blocked/, "failing group named");
    assert.match(res.error, /still in your working tree/, "reassurance present");
    assert.deepStrictEqual(log(git).slice(0, 1), ["first: lands"]);
    // NOTE: no trim — porcelain's first column IS the staged side, and a
    // leading space is meaningful (" M" = unstaged-only).
    const porcelain = git("status", "--porcelain").replace(/\n$/, "");
    assert.match(porcelain, /b\.ts/, "unfinished file still in working tree");
    assert.ok(
      porcelain.split("\n").every((l) => l.startsWith(" ") || l.startsWith("??")),
      `nothing left staged after failure: ${JSON.stringify(porcelain)}`,
    );
    console.log("PASS execute: mid-sequence failure — partial result honest, nothing staged");
  }

  /* ═══ 8. planSplitCommits guards (no model available in tests) ═══ */
  {
    const { dir, git } = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" });
    // clean tree
    let res = await planSplitCommits(dir);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /No changes/);
    // single file -> refuse
    writeFileSync(path.join(dir, "a.ts"), "a2\n");
    res = await planSplitCommits(dir);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /at least two/);
    // two files, model unavailable -> honest single-group fallback, not error
    writeFileSync(path.join(dir, "b.ts"), "b2\n");
    res = await planSplitCommits(dir);
    assert.strictEqual(res.ok, true, `fallback plan: ${res.error}`);
    assert.strictEqual(res.source, "fallback");
    assert.strictEqual(res.groups.length, 1);
    assert.deepStrictEqual([...res.groups[0].files].sort(), ["a.ts", "b.ts"], "fallback covers every file");
    assert.strictEqual(splitPlanViolation(res.groups, ["a.ts", "b.ts"]), null, "fallback plan is executable");
    // not a repo
    const empty = mkdtempSync(path.join(tmpdir(), "codara-split-norepo-"));
    CLEANUP.push(empty);
    res = await planSplitCommits(empty);
    assert.strictEqual(res.ok, false, "non-repo refused");
    console.log("PASS planSplitCommits guards + model-down fallback");
  }

  /* ═══ 8b. dependency ordering: extractDiffSymbols + orderSplitGroups ═══ */
  {
    // Symbol extraction from added lines only.
    const sym = extractDiffSymbols(
      [
        "+export interface GitDiffStats {",
        "+export function computeDiffStats(cwd) {",
        "+export const FOO_LIMIT = 4;",
        '+import { GitDiffStats, type GitFileDiffStat } from "@shared/types";',
        '+import ChangeTree from "./ChangeTree";',
        '-import { OldThing } from "./gone";', // removed line: ignored
        " import { ContextThing } from './ctx';", // context line: ignored
        '+import { renamed as alias } from "./x";',
      ].join("\n"),
    );
    assert.deepStrictEqual(
      [...sym.exports].sort(),
      ["FOO_LIMIT", "GitDiffStats", "computeDiffStats"],
      "added exports extracted",
    );
    assert.ok(
      sym.imports.includes("GitDiffStats") &&
        sym.imports.includes("GitFileDiffStat") &&
        sym.imports.includes("ChangeTree") &&
        sym.imports.includes("renamed"),
      `added imports extracted (source names, type strip, default, alias): ${sym.imports}`,
    );
    assert.ok(!sym.imports.includes("OldThing"), "removed-line import ignored");
    assert.ok(!sym.imports.includes("ContextThing"), "context-line import ignored");

    // Ordering: group 0 imports what group 2 exports -> 2 must come first;
    // group 1 is independent and keeps its relative position.
    const order = orderSplitGroups([
      { exports: [], imports: ["SharedType"] }, // feature (depends on 2)
      { exports: [], imports: [] }, // independent
      { exports: ["SharedType"], imports: [] }, // foundations
    ]);
    assert.ok(
      order.indexOf(2) < order.indexOf(0),
      `foundations before dependent: ${order}`,
    );
    // No dependencies -> original order untouched.
    assert.deepStrictEqual(
      orderSplitGroups([
        { exports: ["A"], imports: [] },
        { exports: ["B"], imports: [] },
      ]),
      [0, 1],
      "independent groups keep original order",
    );
    // Cycle -> degrade to original order, never throw or drop a group.
    const cyc = orderSplitGroups([
      { exports: ["A"], imports: ["B"] },
      { exports: ["B"], imports: ["A"] },
    ]);
    assert.deepStrictEqual([...cyc].sort(), [0, 1], "cycle keeps every group");
    console.log("PASS dependency ordering: symbols + topological sort + cycle degrade");
  }

  /* ═══ 8c. end-to-end ordering on a real repo (fallback-free path) ═══ */
  {
    // A repo where the "feature" file imports a symbol the "types" file adds.
    // With the model stubbed out, planSplitCommits falls back to one group —
    // so exercise the ordering path directly: two groups, wrong order in,
    // right order out, via the real per-group diffs.
    const { dir, git } = makeRepo({ "types.ts": "export const OLD = 1;\n", "feature.ts": "// empty\n" });
    writeFileSync(path.join(dir, "types.ts"), "export const OLD = 1;\nexport interface NewShape { a: number }\n");
    writeFileSync(path.join(dir, "feature.ts"), 'import { NewShape } from "./types";\nexport const use = (x: NewShape) => x.a;\n');
    const featDiff = git("diff", "--", "feature.ts");
    const typesDiff = git("diff", "--", "types.ts");
    const order = orderSplitGroups([extractDiffSymbols(featDiff), extractDiffSymbols(typesDiff)]);
    assert.deepStrictEqual(order, [1, 0], `types-first from real git diffs: ${order}`);
    console.log("PASS dependency ordering: real git diffs sort foundations first");
  }

  /* ═══ 9. source contract: the renderer wiring exists ═══ */
  {
    const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8");
    assert.match(ipc, /git:splitPlan/, "ipc handler for plan");
    assert.match(ipc, /git:splitExecute/, "ipc handler for execute");
    const preload = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8");
    assert.match(preload, /splitPlan/, "preload exposes splitPlan");
    assert.match(preload, /splitExecute/, "preload exposes splitExecute");
    console.log("PASS source contract: IPC + preload wiring present");
  }

  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
  console.log("\nAll split-into-commits checks passed.");
})().catch((err) => {
  for (const dir of CLEANUP) try { rmSync(dir, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});
