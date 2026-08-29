#!/usr/bin/env node
"use strict";

// Dev harness: run the REAL commit-message pipeline end-to-end against a repo.
//
//   node scripts/dev-commit-message-preview.cjs [repoPath] [--model <selection>] [--show-prompt]
//   node scripts/dev-commit-message-preview.cjs [repoPath] --split
//
// Bundles src/main/git-commit-message.ts (or, with --split, the
// git-split-commits planner) with the production prompt builder, sanitizer,
// and Pi one-shot spawn (real subscription accounts from ~/.codara), stubbing
// only the Electron shell (storage/app). Prints the generated message / plan
// so prompt changes can be evaluated on real diffs instead of shipped blind.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { repo: ROOT, model: null, showPrompt: false, split: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--show-prompt") args.showPrompt = true;
    else if (argv[i] === "--split") args.split = true;
    else rest.push(argv[i]);
  }
  if (rest[0]) args.repo = path.resolve(rest[0]);
  return args;
}

async function main() {
  const { repo, model, showPrompt, split } = parseArgs(process.argv.slice(2));
  const codaraHome = process.env.CODARA_HOME_DIR ?? path.join(os.homedir(), ".codarastudio");
  const settingsFile = path.join(codaraHome, "spark-settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  if (model) settings.commitMessageModel = model;
  console.error(`[preview] repo=${repo}`);
  console.error(`[preview] commitMessageModel=${settings.commitMessageModel ?? "auto"}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-commit-preview-"));
  try {
    const outfile = path.join(temporaryRoot, "generator.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", split ? "git-split-commits.ts" : "git-commit-message.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      // git-ops imports remote-path support (ssh2) which ships native .node
      // binaries; leave them as runtime requires instead of bundling.
      external: ["cpu-features", "ssh2"],
      plugins: [
        {
          name: "commit-preview-aliases",
          setup(build) {
            build.onResolve({ filter: /^@shared\// }, (args) => ({
              path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
            }));
            // codara-home imports electron's `app` at module scope but only
            // touches it inside functions the pipeline never calls in dev
            // (codaraHome() prefers $CODARA_HOME_DIR / default dir).
            build.onResolve({ filter: /^electron$/ }, () => ({
              path: "electron-stub",
              namespace: "stub",
            }));
            build.onLoad({ filter: /^electron-stub$/, namespace: "stub" }, () => ({
              loader: "js",
              contents: `module.exports = { app: { isPackaged: false, getPath: () => ${JSON.stringify(codaraHome)}, getName: () => "codara-studio-preview" } };`,
            }));
            // Real storage would import electron. Feed the on-disk settings.
            build.onResolve({ filter: /^\.\/storage$/ }, () => ({
              path: "storage-stub",
              namespace: "stub",
            }));
            // inline-ai pulls the whole OpenRouter client; only needed when
            // commitMessageModel === "openrouter".
            build.onResolve({ filter: /^\.\/inline-ai$/ }, () => ({
              path: "inline-ai-stub",
              namespace: "stub",
            }));
            // pi-runtime-electron expects Electron; give the plain-node
            // equivalents (repo-pinned Pi runtime + current node binary).
            build.onResolve({ filter: /\.\/pi-runtime-electron$/ }, () => ({
              path: "pi-runtime-electron-stub",
              namespace: "stub",
            }));
            build.onLoad({ filter: /^storage-stub$/, namespace: "stub" }, () => ({
              loader: "js",
              contents: `module.exports = { loadSettings: async () => (${JSON.stringify(settings)}) };`,
            }));
            build.onLoad({ filter: /^inline-ai-stub$/, namespace: "stub" }, () => ({
              loader: "js",
              contents: `module.exports = { runInlineAiChatCompletion: async () => { throw new Error("openrouter path not supported in preview harness"); } };`,
            }));
            build.onLoad({ filter: /^pi-runtime-electron-stub$/, namespace: "stub" }, () => ({
              loader: "js",
              contents: `
                const { join } = require("node:path");
                module.exports = {
                  electronAsNodeInterpreter: () => process.execPath,
                  resolveCodaraPiRuntime: async () => {
                    const packageRoot = join(${JSON.stringify(ROOT)}, "node_modules", "@earendil-works", "pi-coding-agent");
                    const manifest = require(join(packageRoot, "package.json"));
                    return {
                      packageRoot,
                      packageJsonPath: join(packageRoot, "package.json"),
                      entrypoint: join(packageRoot, manifest.bin.pi),
                      version: manifest.version,
                    };
                  },
                };
              `,
            }));
          },
        },
      ],
    });
    // The auth store resolves ~/.codara via CODARA_HOME_DIR in plain node.
    process.env.CODARA_HOME_DIR = codaraHome;
    // ELECTRON_RUN_AS_NODE is set by the spawn env builder and is harmless
    // for a plain node child.
    if (showPrompt) {
      const source = fs.readFileSync(path.join(ROOT, "src", "main", "git-commit-message.ts"), "utf8");
      const sys = source.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
      if (sys) console.error(`\n[preview] SYSTEM PROMPT:\n${sys[1]}\n`);
    }
    delete require.cache[outfile];
    const generator = require(outfile);
    const startedAt = Date.now();
    if (split) {
      const plan = await generator.planSplitCommits(repo);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (!plan.ok) {
        console.error(`[preview] SPLIT FAILED after ${elapsed}s: ${plan.error}`);
        process.exitCode = 1;
        return;
      }
      console.error(`[preview] split plan (source=${plan.source}) in ${elapsed}s:\n`);
      plan.groups.forEach((g, i) => {
        console.log(`── Commit ${i + 1} ─ ${g.files.length} file(s) ──`);
        if (g.reason) console.log(`   (${g.reason})`);
        console.log(g.message.split("\n").map((l) => `   ${l}`).join("\n"));
        for (const f of g.files) console.log(`     • ${f}`);
        console.log("");
      });
      return;
    }
    const result = await generator.generateCommitMessage(repo);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!result.ok) {
      console.error(`[preview] FAILED after ${elapsed}s: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.error(`[preview] generated in ${elapsed}s:\n`);
    console.log(result.message);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
