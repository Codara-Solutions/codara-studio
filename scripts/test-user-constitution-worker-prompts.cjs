#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-constitution-"));
const SHARED_DIR = path.join(ROOT, "src/shared");

const aliasPlugin = {
  name: "worker-constitution-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^\.\/spark-home$/ }, () => ({
      path: "spark-home-test-stub",
      namespace: "worker-constitution-test",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "worker-constitution-test" },
      () => ({
        contents:
          'export function sparkHome() { throw new Error("unexpected current Settings access"); }',
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
    "src/main/orchestration/worker-constitution.ts",
  );
  const projectModule = await bundle(
    "project",
    "src/main/orchestration/project-constitution.ts",
  );
  const promptFiles = await bundle(
    "prompt-file",
    "src/main/orchestration/worker-constitution-file.ts",
  );
  const piWorkerConstitution = await bundle(
    "pi-worker-constitution",
    "resources/pi-cora/worker-constitution.ts",
  );
  const structuredSystem = await bundle(
    "structured-worker-system",
    "src/main/orchestration/structured-worker-system.ts",
  );

  const storeRoot = path.join(TMP, "store-root");
  const store = new storeModule.UserConstitutionStore(storeRoot);
  const initial = await store.load();
  const oldBody = "# Old worker constitution\nUse immutable old guidance.";
  const oldDocument = await store.save({
    enabled: true,
    body: oldBody,
    expectedRevision: initial.revision,
  });
  const oldCapture = await store.captureCurrent();
  const newBody = "# New worker constitution\nOnly later attempts receive this.";
  await store.save({
    enabled: true,
    body: newBody,
    expectedRevision: oldDocument.revision,
  });
  const newCapture = await store.captureCurrent();
  const resolveCapture = (capture) => store.resolveEnabledCapture(capture);

  const oldAttempt = { userConstitution: oldCapture };
  const oldBlock = await composer.resolveWorkerConstitutionBlock(
    oldAttempt,
    resolveCapture,
  );
  assert.ok(oldBlock.includes(oldBody));
  assert.ok(!oldBlock.includes(newBody));
  assert.ok(oldBlock.includes("[GLOBAL USER CONSTITUTION - WORKER]"));
  assert.ok(oldBlock.includes(`revision ${oldCapture.revision} (${oldCapture.sha256})`));
  assert.match(oldBlock, /cannot broaden the assigned worker task's scope or authority/);
  assert.match(oldBlock, /project constitution in the worker task prompt is more specific and wins/);

  // Attempt/run isolation: a newer run-level capture is irrelevant. Each
  // attempt resolves its own persisted pair and receives one body only.
  const simulatedNewRun = { userConstitution: newCapture };
  const newBlock = await composer.resolveWorkerConstitutionBlock(
    simulatedNewRun,
    resolveCapture,
  );
  assert.ok(newBlock.includes(newBody));
  assert.ok(!newBlock.includes(oldBody));
  assert.ok(oldBlock.includes(oldBody));

  const baseSystemPrompt = "existing provider system bytes\n";
  let disabledResolverCalled = false;
  const disabledBlock = await composer.resolveWorkerConstitutionBlock(
    {
      userConstitution: {
        enabledAtCapture: false,
        revision: oldCapture.revision,
        sha256: oldCapture.sha256,
      },
    },
    async () => {
      disabledResolverCalled = true;
      throw new Error("disabled captures must not touch the store");
    },
  );
  assert.equal(disabledResolverCalled, false);
  assert.equal(disabledBlock, "");
  assert.equal(
    composer.appendWorkerConstitutionBlock(baseSystemPrompt, disabledBlock),
    baseSystemPrompt,
  );
  const legacyBlock = await composer.resolveWorkerConstitutionBlock({}, async () => {
    throw new Error("legacy attempts must not touch current Settings");
  });
  assert.equal(legacyBlock, "");
  assert.equal(
    composer.appendWorkerConstitutionBlock(baseSystemPrompt, legacyBlock),
    baseSystemPrompt,
  );

  const projectText = "# Project-specific constitution\nProject value wins.";
  const project = {
    text: projectText,
    sha256: sha256(projectText),
    sourcePath: projectModule.PROJECT_CONSTITUTION_SOURCE_PATH,
  };
  const taskPrompt = projectModule.appendProjectConstitution(
    "existing worker task bytes",
    project,
  );
  assert.ok(taskPrompt.includes("[PROJECT CONSTITUTION]"));
  assert.ok(taskPrompt.includes(projectText));
  assert.ok(!taskPrompt.includes(oldBody));
  assert.ok(oldBlock.includes("project constitution in the worker task prompt"));
  const deliveredInstructionOrder =
    `${composer.appendWorkerConstitutionBlock(baseSystemPrompt, oldBlock)}\n\n${taskPrompt}`;
  assert.ok(
    deliveredInstructionOrder.indexOf("[GLOBAL USER CONSTITUTION - WORKER]") <
      deliveredInstructionOrder.indexOf("[PROJECT CONSTITUTION]"),
    "global system guidance is delivered before the more-specific project task guidance",
  );
  assert.equal(
    structuredSystem.structuredWorkerSystemPrompt(""),
    structuredSystem.STRUCTURED_WORKER_SYSTEM_PROMPT,
    "legacy structured-provider system bytes remain exact",
  );
  const structuredWithGlobal =
    structuredSystem.structuredWorkerSystemPrompt(oldBlock);
  assert.equal(
    structuredWithGlobal,
    `${structuredSystem.STRUCTURED_WORKER_SYSTEM_PROMPT}\n\n${oldBlock}`,
  );
  assert.equal(
    structuredWithGlobal.split("[GLOBAL USER CONSTITUTION - WORKER]").length - 1,
    1,
    "Claude SDK and Codex base-instruction composer inject one block",
  );

  const privateDirectory = path.join(TMP, "private-prompts");
  const privatePath = await promptFiles.writePrivateWorkerConstitutionPrompt({
    block: oldBlock,
    directory: privateDirectory,
    fileStem: "attempt-old",
  });
  assert.equal(fs.readFileSync(privatePath, "utf8"), oldBlock);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(privateDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
  }
  await promptFiles.cleanupPrivateWorkerConstitutionPrompt(privatePath);
  assert.equal(fs.existsSync(privatePath), false);

  const piPromptPath = path.join(TMP, "pi-worker-constitution.md");
  fs.writeFileSync(piPromptPath, oldBlock, { mode: 0o600 });
  assert.equal(
    piWorkerConstitution.loadWorkerConstitutionBlock({
      CODARA_PI_WORKER_CONSTITUTION_PATH: piPromptPath,
    }),
    oldBlock,
  );
  assert.equal(
    piWorkerConstitution.appendPiWorkerConstitution(baseSystemPrompt, ""),
    baseSystemPrompt,
    "legacy Pi system-prompt bytes remain exact",
  );
  assert.equal(
    piWorkerConstitution.appendPiWorkerConstitution(baseSystemPrompt, oldBlock),
    `${baseSystemPrompt}\n\n${oldBlock}`,
  );
  if (process.platform !== "win32") {
    const symlink = path.join(TMP, "pi-worker-constitution-link.md");
    fs.symlinkSync(piPromptPath, symlink);
    assert.throws(
      () => piWorkerConstitution.loadWorkerConstitutionBlock({
        CODARA_PI_WORKER_CONSTITUTION_PATH: symlink,
      }),
      /invalid/,
    );
  }

  const runStore = source("src/main/orchestration/run-store.ts");
  const structured = section(
    runStore,
    "async function runStructuredAutomationWorkerSession({",
    "async function readWorkerReportWithWorkspaceShadowRecovery(",
  );
  assert.ok(
    structured.indexOf("resolveCapturedWorkerConstitutionBlock") <
      structured.indexOf("const runningTimestamp"),
    "structured workers resolve before being marked running",
  );
  assert.ok(
    structured.indexOf("resolveCapturedWorkerConstitutionBlock") <
      structured.indexOf("runStructuredWorker"),
    "structured workers resolve before provider dispatch",
  );
  const piSession = section(
    runStore,
    "async function runPiWorkerSession({",
    "async function runWorkerSession({",
  );
  assert.ok(
    piSession.indexOf("resolveCapturedWorkerConstitutionBlock") <
      piSession.indexOf("createCodaraPiWorkerLaunchPlan"),
    "Pi resolves the attempt before plan/provider launch",
  );
  assert.ok(
    piSession.indexOf("resolveCapturedWorkerConstitutionBlock") <
      piSession.indexOf("client = new PiRpcClient"),
  );
  const cliSession = section(
    runStore,
    "async function runWorkerSession({",
    "async function stampAttemptAccountProfile(",
  );
  assert.ok(
    cliSession.indexOf("resolveCapturedWorkerConstitutionBlock") <
      cliSession.indexOf("handle.write(`${launchCommand}\\r`)"),
    "Claude CLI resolves and writes its private file before launch",
  );
  assert.ok(cliSession.includes("cleanupPrivateWorkerConstitutionPrompt"));
  assert.ok(runStore.includes('"--append-system-prompt-file"'));
  assert.ok(
    runStore.includes('task.runtimePreference === "claude" &&'),
    "unsupported shell/manual surfaces do not materialize a worker constitution file",
  );

  const structuredSource = source("src/main/orchestration/structured-worker.ts");
  assert.ok(structuredSource.includes("structuredWorkerSystemPrompt(input.workerConstitutionBlock)"));
  assert.ok(structuredSource.includes("baseInstructions: structuredWorkerSystemPrompt("));
  assert.ok(!structuredSource.includes("resolveEnabledUserConstitutionCapture"));
  assert.ok(!structuredSource.match(/env[^\n]*workerConstitutionBlock/));

  const piRuntime = source("src/main/orchestration/pi-runtime.ts");
  const piElectron = source("src/main/orchestration/pi-runtime-electron.ts");
  const piWorker = source("resources/pi-cora/worker.ts");
  assert.ok(piRuntime.includes("CODARA_PI_WORKER_CONSTITUTION_PATH"));
  assert.ok(!piRuntime.includes("workerConstitutionBlock"));
  assert.ok(piElectron.includes("writePrivateWorkerConstitutionPrompt"));
  assert.ok(piElectron.includes("workerConstitutionPromptPath"));
  assert.ok(piWorker.includes("loadWorkerConstitutionBlock()"));
  assert.ok(!piWorker.includes("CODARA_PI_MANAGER_CONSTITUTION_PATH"));
  assert.ok(
    piRuntime.includes("A Pi process cannot receive manager and worker constitution prompts together"),
  );

  const workerPromptSource = source("src/main/orchestration/worker-prompt.ts");
  assert.ok(!workerPromptSource.includes("userConstitution"));
  assert.ok(!workerPromptSource.includes("GLOBAL USER CONSTITUTION"));
  assert.ok(!runStore.match(/payload\s*:\s*\{[^}]*workerConstitutionBlock/s));
  for (const body of [oldBody, newBody]) {
    assert.ok(!runStore.includes(body));
    assert.ok(!structuredSource.includes(body));
    assert.ok(!piRuntime.includes(body));
  }

  // Corrupt only the old immutable blob. The exact attempt fails before the
  // fake provider can start; the newer attempt remains independently valid.
  const oldBlobPath = path.join(
    storeRoot,
    storeModule.USER_CONSTITUTION_DATA_DIRECTORY,
    storeModule.USER_CONSTITUTION_BLOBS_DIRECTORY,
    `${oldCapture.sha256}.txt`,
  );
  fs.writeFileSync(oldBlobPath, "corrupted old body", { mode: 0o600 });
  let fakeProviderStarted = false;
  await assert.rejects(async () => {
    const block = await composer.resolveWorkerConstitutionBlock(
      oldAttempt,
      resolveCapture,
    );
    fakeProviderStarted = true;
    return block;
  }, /invalid|corrupt/i);
  assert.equal(fakeProviderStarted, false);
  assert.ok(
    (await composer.resolveWorkerConstitutionBlock(
      simulatedNewRun,
      resolveCapture,
    )).includes(newBody),
    "one attempt's corrupt blob does not redirect or poison another capture",
  );

  console.log("PASS immutable global worker constitution delivery");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
