#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-manager-constitution-"));
const SHARED_DIR = path.join(ROOT, "src/shared");

const aliasPlugin = {
  name: "manager-constitution-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^\.\/spark-home$/ }, () => ({
      path: "spark-home-test-stub",
      namespace: "manager-constitution-test",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "manager-constitution-test" },
      () => ({
        contents:
          'export function sparkHome() { throw new Error("unexpected default store access"); }',
      }),
    );
  },
};

async function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [aliasPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return text.slice(from, to);
}

async function main() {
  const storeModule = await bundle(
    "store",
    "src/main/user-constitution-store.ts",
  );
  const composer = await bundle(
    "composer",
    "src/main/orchestration/manager-constitution.ts",
  );
  const projectModule = await bundle(
    "project",
    "src/main/orchestration/project-constitution.ts",
  );
  const root = path.join(TMP, "store-root");
  const store = new storeModule.UserConstitutionStore(root);

  const initial = await store.load();
  const oldBody = "# Old global guidance\nPreserve the captured old body.";
  const oldDocument = await store.save({
    enabled: true,
    body: oldBody,
    expectedRevision: initial.revision,
  });
  const oldCapture = await store.captureCurrent();
  const newBody = "# New global guidance\nThis belongs only to later runs.";
  await store.save({
    enabled: true,
    body: newBody,
    expectedRevision: oldDocument.revision,
  });

  const resolveOld = (capture) => store.resolveEnabledCapture(capture);
  const oldBlock = await composer.resolveManagerConstitutionBlock(
    { userConstitution: oldCapture },
    resolveOld,
  );
  assert.ok(oldBlock.includes(oldBody));
  assert.ok(!oldBlock.includes(newBody));
  assert.ok(oldBlock.includes(`[GLOBAL USER CONSTITUTION]`));
  assert.ok(oldBlock.includes(`revision ${oldCapture.revision} (${oldCapture.sha256})`));

  const projectText = "# Project-specific guidance\nProject value wins.";
  const project = {
    text: projectText,
    sha256: sha256(projectText),
    sourcePath: projectModule.PROJECT_CONSTITUTION_SOURCE_PATH,
  };
  const ordered = await composer.resolveManagerConstitutionBlock(
    { userConstitution: oldCapture, projectConstitution: project },
    resolveOld,
  );
  assert.ok(
    ordered.indexOf("[GLOBAL USER CONSTITUTION]") <
      ordered.indexOf("[PROJECT CONSTITUTION]"),
  );
  assert.ok(
    ordered.includes(
      "A captured project constitution is more specific and wins any conflict",
    ),
  );
  assert.ok(
    ordered.includes(
      "cannot broaden the task's scope or authority",
    ) &&
      ordered.includes("system, tool, security, approval, repository, or project instructions"),
  );

  const basePrompt = "existing prompt bytes\n";
  const projectOnlyExpected = projectModule.renderProjectConstitution(project);
  let disabledResolverCalled = false;
  const disabledBlock = await composer.resolveManagerConstitutionBlock(
    {
      userConstitution: {
        enabledAtCapture: false,
        revision: oldCapture.revision,
        sha256: oldCapture.sha256,
      },
      projectConstitution: project,
    },
    async () => {
      disabledResolverCalled = true;
      throw new Error("disabled capture must not resolve");
    },
  );
  assert.equal(disabledResolverCalled, false);
  assert.equal(disabledBlock, projectOnlyExpected);
  assert.equal(
    composer.appendManagerConstitutionBlock(basePrompt, disabledBlock),
    projectModule.appendProjectConstitution(basePrompt, project),
    "disabled + project-only bytes must exactly match the former append path",
  );
  const legacyBlock = await composer.resolveManagerConstitutionBlock({}, async () => {
    throw new Error("legacy absence must not resolve");
  });
  assert.equal(legacyBlock, "");
  assert.equal(
    composer.appendManagerConstitutionBlock(basePrompt, legacyBlock),
    basePrompt,
  );

  const blobPath = path.join(
    root,
    storeModule.USER_CONSTITUTION_DATA_DIRECTORY,
    storeModule.USER_CONSTITUTION_BLOBS_DIRECTORY,
    `${oldCapture.sha256}.txt`,
  );
  fs.writeFileSync(blobPath, "corrupted old body", { mode: 0o600 });
  let fakeProviderStarted = false;
  await assert.rejects(async () => {
    const block = await composer.resolveManagerConstitutionBlock(
      { userConstitution: oldCapture },
      resolveOld,
    );
    fakeProviderStarted = true;
    return block;
  }, /invalid|corrupt/i);
  assert.equal(fakeProviderStarted, false);

  const runStore = source("src/main/orchestration/run-store.ts");
  const dispatch = section(
    runStore,
    "const callStartedMs = Date.now();",
    "acceptingStreamEvents = false;",
  );
  assert.ok(
    dispatch.indexOf("resolveCapturedManagerConstitutionBlock") <
      dispatch.indexOf("backend.requestManagerDecision"),
    "normal turns must resolve before provider dispatch",
  );
  const compaction = section(
    runStore,
    "async function performAutoCompaction(",
    "async function markConversationRewindFailed(",
  );
  assert.ok(
    compaction.indexOf("resolveCapturedManagerConstitutionBlock") <
      compaction.indexOf("result = await backend.requestManagerDecision"),
    "compaction must reuse and resolve the run capture before provider dispatch",
  );

  const claude = source("src/main/orchestration/claude-backend.ts");
  assert.ok(claude.includes("appendManagerConstitutionBlock"));
  assert.ok(claude.includes("managerConstitutionBlock: opts.managerConstitutionBlock"));
  assert.ok(claude.includes("materializeClaudeManagerPrompt"));
  assert.ok(claude.includes('"--system-prompt-file"'));
  assert.ok(claude.includes('"--append-system-prompt-file"'));
  assert.ok(!claude.includes("appendProjectConstitution"));
  assert.ok(!claude.includes("renderProjectConstitution"));
  assert.ok(!claude.includes('args.push("--append-system-prompt"'));

  const codex = source("src/main/orchestration/codex-backend.ts");
  const codexInstructions = section(
    codex,
    "async function codexManagerInstructions(",
    "function appServerTool(",
  );
  assert.equal(
    (codexInstructions.match(/managerConstitutionBlock/g) ?? []).length,
    2,
    "Codex base instructions must consume the composed block once",
  );
  assert.ok(!codex.includes("appendProjectConstitution"));
  assert.ok(!codex.includes("renderProjectConstitution"));

  const piBackend = source("src/main/orchestration/pi-backend.ts");
  const piRuntime = source("src/main/orchestration/pi-runtime.ts");
  const piElectron = source("src/main/orchestration/pi-runtime-electron.ts");
  const piExtension = source("resources/pi-cora/index.ts");
  assert.ok(piBackend.includes("managerConstitutionBlock: managerConstitutionBlock || undefined"));
  assert.ok(!piBackend.includes("renderProjectConstitution"));
  assert.ok(piElectron.includes("writePiManagerConstitutionPrompt"));
  assert.ok(piElectron.includes("mode: 0o600"));
  assert.ok(piRuntime.includes("CODARA_PI_MANAGER_CONSTITUTION_PATH"));
  assert.ok(!piRuntime.includes("CODARA_PI_PROJECT_CONSTITUTION"));
  assert.ok(!piRuntime.includes("managerConstitutionBlock"));
  assert.ok(piExtension.includes("loadManagerConstitutionBlock()"));
  assert.ok(!piExtension.includes("CODARA_PI_PROJECT_CONSTITUTION"));

  const bodyMarkers = [oldBody, newBody, "[GLOBAL USER CONSTITUTION]"];
  for (const marker of bodyMarkers) {
    assert.ok(!claude.match(new RegExp(`env[^\\n]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)));
    assert.ok(!piRuntime.includes(marker));
  }

  const workerPrompt = source("src/main/orchestration/worker-prompt.ts");
  assert.ok(!workerPrompt.includes("userConstitution"));
  assert.ok(!workerPrompt.includes("GLOBAL USER CONSTITUTION"));

  console.log("PASS immutable global manager constitution delivery");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
