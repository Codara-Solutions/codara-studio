#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, outfile, extraSetup) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "pi-commit-test-aliases",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          if (extraSetup) extraSetup(build);
        },
      },
    ],
  });
  delete require.cache[outfile];
  return require(outfile);
}

function inspection(statuses, defaults = {}) {
  const profiles = statuses.map((status, index) => ({
    id: status.profileId,
    provider: status.provider,
    label: `Profile ${index + 1}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  return {
    snapshot: { version: 1, profiles, defaults },
    statuses,
    reconciliation: {
      migratedProfileIds: [],
      missingCredentialProfileIds: [],
      orphanCredentialProfileIds: [],
    },
  };
}

function status(profileId, provider, overrides = {}) {
  return {
    profileId,
    provider,
    connected: true,
    expired: false,
    canRefresh: false,
    expiresAt: null,
    ...overrides,
  };
}

class FakeStdin extends EventEmitter {
  constructor({ writeResult = true, onWrite = null } = {}) {
    super();
    this.writeResult = writeResult;
    this.onWrite = onWrite;
    this.chunks = [];
    this.writeCalls = 0;
    this.endCalls = 0;
    this.ended = false;
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") callback = encoding;
    this.writeCalls += 1;
    this.chunks.push(Buffer.from(chunk));
    if (this.onWrite) this.onWrite(callback);
    return this.writeResult;
  }

  end() {
    this.endCalls += 1;
    this.ended = true;
    return this;
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class FakeChild extends EventEmitter {
  constructor(stdin = new FakeStdin()) {
    super();
    this.stdin = stdin;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killSignals = [];
  }

  kill(signal) {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }
}

async function settlesWithin(promise, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test promise did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-commit-test-"));
  try {
    const runner = await bundle(
      path.join(ROOT, "src", "main", "orchestration", "pi-commit-one-shot.ts"),
      path.join(temporaryRoot, "runner.cjs"),
    );

    const openaiId = "11111111-1111-4111-8111-111111111111";
    const anthropicId = "22222222-2222-4222-8222-222222222222";
    const both = inspection(
      [
        status(anthropicId, "anthropic"),
        status(openaiId, "openai-codex"),
      ],
      { anthropic: anthropicId, "openai-codex": openaiId },
    );
    assert.deepEqual(runner.resolvePiCommitRoute("auto", both), {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
    });
    assert.deepEqual(runner.resolvePiCommitRoute("claude-sonnet-5", both), {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    const anthropicOnly = inspection([
      status(anthropicId, "anthropic", { expired: true, canRefresh: true }),
    ]);
    assert.deepEqual(runner.resolvePiCommitRoute("auto", anthropicOnly), {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    assert.equal(
      runner.resolvePiCommitRoute("gpt-5.6-luna", anthropicOnly),
      null,
      "an unavailable explicit provider must not silently switch providers",
    );
    assert.equal(
      runner.resolvePiCommitRoute(
        "auto",
        inspection([status(openaiId, "openai-codex", { expired: true, canRefresh: false })]),
      ),
      null,
    );

    let captured = null;
    let removedPath = null;
    let inspectCalls = 0;
    let resolvedInput = null;
    const diffMarker = "SYNTHETIC_DIFF_MUST_STAY_OFF_ARGV";
    const largePrompt = `${diffMarker}\n${"x".repeat(27_900)}`;
    const successChild = new FakeChild(new FakeStdin({ writeResult: false }));
    const generated = await settlesWithin(runner.runSessionlessPiCommitMessage(
      {
        cwd: ROOT,
        modelSelection: "auto",
        systemPrompt: "Return one concise commit message.",
        prompt: largePrompt,
      },
      {
        inspectAccounts: async () => {
          inspectCalls += 1;
          return both;
        },
        resolveAccount: async (input) => {
          resolvedInput = input;
          return { configDir: "/isolated/codara/account", authFile: "/unused/auth.json" };
        },
        resolveLaunchRuntime: async () => ({
          executable: "/electron-helper",
          runtime: {
            packageRoot: "/runtime/pi",
            packageJsonPath: "/runtime/pi/package.json",
            entrypoint: "/runtime/pi/dist/cli.js",
            version: "0.82.0",
          },
        }),
        spawnProcess: (command, args, options) => {
          captured = { command, args: [...args], options };
          process.nextTick(() => {
            successChild.stdout.end("feat: use sessionless Pi\n");
            successChild.stderr.end();
            successChild.emit("close", 0, null);
          });
          return successChild;
        },
        createTemporaryDirectory: async (prefix) => fs.promises.mkdtemp(prefix),
        removeTemporaryDirectory: async (directory) => {
          removedPath = directory;
          await fs.promises.rm(directory, { recursive: true, force: true });
        },
        baseEnv: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "must-be-stripped",
          ANTHROPIC_API_KEY: "must-be-stripped",
          PI_SESSION_FILE: "/parent/session.jsonl",
          PI_SESSION_ID: "parent-session",
          SAFE_VALUE: "kept",
        },
      },
    ));
    assert.deepEqual(generated, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      text: "feat: use sessionless Pi",
    });
    assert.equal(inspectCalls, 1, "availability inspection must run exactly once");
    assert.deepEqual(resolvedInput, {
      provider: "openai-codex",
      preferredAccountProfileId: openaiId,
      requirePreferred: true,
    });
    assert.equal(captured.command, "/electron-helper");
    for (const flag of [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
    ]) {
      assert.ok(captured.args.includes(flag), `missing isolated Pi flag ${flag}`);
    }
    assert.equal(captured.args.includes("--api-key"), false);
    assert.equal(captured.args[captured.args.indexOf("--provider") + 1], "openai-codex");
    assert.equal(captured.args[captured.args.indexOf("--model") + 1], "gpt-5.6-luna");
    assert.equal(captured.args[captured.args.indexOf("--thinking") + 1], "off");
    assert.equal(captured.args.includes(largePrompt), false);
    assert.equal(captured.args.some((arg) => arg.includes(diffMarker)), false);
    assert.deepEqual(captured.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(captured.options.detached, false);
    assert.equal(successChild.stdin.writeCalls, 1);
    assert.equal(successChild.stdin.text(), largePrompt);
    assert.equal(successChild.stdin.endCalls, 1);
    assert.equal(successChild.stdin.ended, true);
    assert.equal(captured.options.env.OPENAI_API_KEY, undefined);
    assert.equal(captured.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured.options.env.PI_SESSION_FILE, undefined);
    assert.equal(captured.options.env.PI_SESSION_ID, undefined);
    assert.equal(captured.options.env.PI_CODING_AGENT_DIR, "/isolated/codara/account");
    assert.equal(captured.options.env.PI_TELEMETRY, "0");
    assert.equal(captured.options.env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(captured.options.env.SAFE_VALUE, "kept");
    assert.equal(fs.existsSync(removedPath), false, "temporary session directory must be removed");

    const childOverrides = (child, overrides = {}) => ({
      inspectAccounts: async () => both,
      resolveAccount: async () => ({ configDir: "/isolated", authFile: "/unused" }),
      resolveLaunchRuntime: async () => ({
        executable: "/fake",
        runtime: {
          packageRoot: "/runtime",
          packageJsonPath: "/runtime/package.json",
          entrypoint: "/runtime/cli.js",
          version: "0.82.0",
        },
      }),
      spawnProcess: () => child,
      baseEnv: {},
      ...overrides,
    });
    const syntheticInput = {
      cwd: ROOT,
      modelSelection: "auto",
      systemPrompt: "Synthetic system prompt",
      prompt: "Synthetic diff prompt",
    };

    const unicodeChild = new FakeChild();
    const unicodeOutput = Buffer.from("feat: preserve café and 🚀 chunks\n", "utf8");
    const rocketOffset = unicodeOutput.indexOf(Buffer.from("🚀", "utf8"));
    const unicodePromise = runner.runSessionlessPiCommitMessage(
      syntheticInput,
      childOverrides(unicodeChild, {
        spawnProcess: () => {
          process.nextTick(() => {
            unicodeChild.stdout.write(unicodeOutput.subarray(0, rocketOffset + 1));
            unicodeChild.stdout.write(unicodeOutput.subarray(rocketOffset + 1, rocketOffset + 3));
            unicodeChild.stdout.end(unicodeOutput.subarray(rocketOffset + 3));
            unicodeChild.stderr.end();
            unicodeChild.emit("close", 0, null);
          });
          return unicodeChild;
        },
      }),
    );
    assert.equal(
      (await settlesWithin(unicodePromise)).text,
      "feat: preserve café and 🚀 chunks",
    );

    const writeErrorInput = new FakeStdin({
      onWrite: (callback) => {
        process.nextTick(() => callback(new Error("synthetic write failure")));
      },
    });
    const writeErrorChild = new FakeChild(writeErrorInput);
    await assert.rejects(
      settlesWithin(
        runner.runSessionlessPiCommitMessage(
          syntheticInput,
          childOverrides(writeErrorChild, { timeoutMs: 10_000 }),
        ),
      ),
      /input failed/,
    );
    assert.equal(writeErrorInput.ended, true);
    assert.deepEqual(writeErrorChild.killSignals, ["SIGKILL"]);

    const streamErrorInput = new FakeStdin({
      onWrite: () => process.nextTick(() => streamErrorInput.emit("error", new Error("synthetic stdin error"))),
    });
    const streamErrorChild = new FakeChild(streamErrorInput);
    await assert.rejects(
      settlesWithin(
        runner.runSessionlessPiCommitMessage(
          syntheticInput,
          childOverrides(streamErrorChild, { timeoutMs: 10_000 }),
        ),
      ),
      /input failed/,
    );
    assert.equal(streamErrorInput.ended, true);
    assert.deepEqual(streamErrorChild.killSignals, ["SIGKILL"]);

    const earlyExitInput = new FakeStdin({ writeResult: false });
    const earlyExitChild = new FakeChild(earlyExitInput);
    const earlyExitPromise = runner.runSessionlessPiCommitMessage(
      syntheticInput,
      childOverrides(earlyExitChild, {
        timeoutMs: 10_000,
        spawnProcess: () => {
          process.nextTick(() => earlyExitChild.emit("close", 1, null));
          return earlyExitChild;
        },
      }),
    );
    await assert.rejects(settlesWithin(earlyExitPromise), /process failed/);
    assert.equal(earlyExitInput.ended, true);

    let oversizedSystemSpawned = false;
    await assert.rejects(
      runner.runSessionlessPiCommitMessage(
        {
          ...syntheticInput,
          systemPrompt: "s".repeat(runner.PI_COMMIT_SYSTEM_PROMPT_LIMIT_CHARS + 1),
        },
        {
          spawnProcess: () => {
            oversizedSystemSpawned = true;
            throw new Error("must not spawn");
          },
        },
      ),
      /argument limit/,
    );
    assert.equal(oversizedSystemSpawned, false);

    let unavailableSpawned = false;
    const unavailable = await runner.runSessionlessPiCommitMessage(
      {
        cwd: ROOT,
        modelSelection: "gpt-5.6-luna",
        systemPrompt: "Synthetic",
        prompt: "Synthetic",
      },
      {
        inspectAccounts: async () => anthropicOnly,
        spawnProcess: () => {
          unavailableSpawned = true;
          throw new Error("must not spawn");
        },
      },
    );
    assert.equal(unavailable, null);
    assert.equal(unavailableSpawned, false);

    let timeoutDirectory = null;
    const timeoutChild = new FakeChild();
    await assert.rejects(
      runner.runSessionlessPiCommitMessage(
        {
          cwd: ROOT,
          modelSelection: "auto",
          systemPrompt: "Synthetic",
          prompt: "Synthetic",
        },
        {
          inspectAccounts: async () => both,
          resolveAccount: async () => ({ configDir: "/isolated", authFile: "/unused" }),
          resolveLaunchRuntime: async () => ({
            executable: "/fake",
            runtime: {
              packageRoot: "/runtime",
              packageJsonPath: "/runtime/package.json",
              entrypoint: "/runtime/cli.js",
              version: "0.82.0",
            },
          }),
          spawnProcess: () => timeoutChild,
          createTemporaryDirectory: async (prefix) => {
            timeoutDirectory = await fs.promises.mkdtemp(prefix);
            return timeoutDirectory;
          },
          removeTemporaryDirectory: async (directory) =>
            fs.promises.rm(directory, { recursive: true, force: true }),
          baseEnv: {},
          timeoutMs: 5,
        },
      ),
      /timed out/,
    );
    assert.equal(timeoutChild.killed, true);
    assert.deepEqual(timeoutChild.killSignals, ["SIGKILL"]);
    assert.equal(fs.existsSync(timeoutDirectory), false);

    let outputDirectory = null;
    const outputChild = new FakeChild();
    await assert.rejects(
      runner.runSessionlessPiCommitMessage(
        {
          cwd: ROOT,
          modelSelection: "auto",
          systemPrompt: "Synthetic",
          prompt: "Synthetic",
        },
        {
          inspectAccounts: async () => both,
          resolveAccount: async () => ({ configDir: "/isolated", authFile: "/unused" }),
          resolveLaunchRuntime: async () => ({
            executable: "/fake",
            runtime: {
              packageRoot: "/runtime",
              packageJsonPath: "/runtime/package.json",
              entrypoint: "/runtime/cli.js",
              version: "0.82.0",
            },
          }),
          spawnProcess: () => {
            process.nextTick(() => outputChild.stdout.write("12345678901"));
            return outputChild;
          },
          createTemporaryDirectory: async (prefix) => {
            outputDirectory = await fs.promises.mkdtemp(prefix);
            return outputDirectory;
          },
          removeTemporaryDirectory: async (directory) =>
            fs.promises.rm(directory, { recursive: true, force: true }),
          baseEnv: {},
          outputLimitBytes: 10,
        },
      ),
      /output limit/,
    );
    assert.equal(outputChild.killed, true);
    assert.deepEqual(outputChild.killSignals, ["SIGKILL"]);
    assert.equal(fs.existsSync(outputDirectory), false);

    const storage = await bundle(
      path.join(ROOT, "src", "main", "storage.ts"),
      path.join(temporaryRoot, "storage.cjs"),
      (build) => {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `module.exports = { app: { getPath: () => ${JSON.stringify(temporaryRoot)} } };`,
          loader: "js",
        }));
      },
    );
    const migrated = storage.normalizeSettings({
      openRouterApiKey: "  editor-key  ",
      openRouterModel: "  editor/model  ",
    });
    assert.equal(migrated.commitMessageModel, "auto");
    assert.equal(migrated.openRouterApiKey, "editor-key");
    assert.equal(migrated.openRouterModel, "editor/model");
    assert.equal(
      storage.normalizeSettings({ commitMessageModel: "claude-sonnet-5" }).commitMessageModel,
      "claude-sonnet-5",
    );
    assert.equal(
      storage.normalizeSettings({ commitMessageModel: "invalid" }).commitMessageModel,
      "auto",
    );

    globalThis.__piCommitResponse = null;
    const generator = await bundle(
      path.join(ROOT, "src", "main", "git-commit-message.ts"),
      path.join(temporaryRoot, "generator.cjs"),
      (build) => {
        const stubs = new Map([
          ["git-ops", `module.exports = {
            computeGitStatus: async () => ({
              isRepo: true,
              staged: [],
              unstaged: [{ path: "src/widget.ts", status: "modified" }],
            }),
            readUntrackedAsDiff: async () => ({ lines: [], binary: false }),
          };`],
          ["git-exec", `module.exports = {
            readGitText: async (_cwd, args) => args[0] === "log" ? "Add prior feature\\nFix prior bug\\nRefactor prior code" : "synthetic diff",
          };`],
          ["storage", `module.exports = { loadSettings: async () => ({ commitMessageModel: "auto" }) };`],
          ["orchestration/pi-commit-one-shot", `module.exports = {
            runSessionlessPiCommitMessage: async () => {
              if (globalThis.__piCommitResponse instanceof Error) throw globalThis.__piCommitResponse;
              return globalThis.__piCommitResponse;
            },
          };`],
        ]);
        build.onResolve(
          { filter: /^(\.\/git-ops|\.\/git-exec|\.\/storage|\.\/orchestration\/pi-commit-one-shot)$/ },
          (args) => ({ path: args.path.slice(2), namespace: "commit-stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "commit-stub" }, (args) => ({
          contents: stubs.get(args.path),
          loader: "js",
        }));
      },
    );
    assert.deepEqual(await generator.generateCommitMessage(ROOT), {
      ok: true,
      message: "Update widget",
    });
    globalThis.__piCommitResponse = { text: "feat: sessionless commit draft" };
    assert.deepEqual(await generator.generateCommitMessage(ROOT), {
      ok: true,
      message: "feat: sessionless commit draft",
    });
    globalThis.__piCommitResponse = new Error("synthetic provider failure");
    assert.deepEqual(await generator.generateCommitMessage(ROOT), {
      ok: true,
      message: "Update widget",
    });

    const settingsSource = fs.readFileSync(
      path.join(ROOT, "src", "renderer", "src", "components", "SettingsDialog.tsx"),
      "utf8",
    );
    assert.match(
      settingsSource,
      /<Label text="Commit message model">\s*<CustomSelect/,
    );
    assert.doesNotMatch(settingsSource, /aria-label="Git commit message model"/);
    assert.match(settingsSource, /Automatic \(OpenAI first\)/);
    assert.match(settingsSource, /gpt-5\.6-luna/);
    assert.match(settingsSource, /claude-sonnet-5/);
    assert.match(settingsSource, /OpenRouter.*editor's inline AI/s);
    assert.doesNotMatch(
      settingsSource,
      /Ghost-text autocomplete and git commit-message drafts share/,
    );

    const commitComposerSource = fs.readFileSync(
      path.join(ROOT, "src", "renderer", "src", "components", "git", "CommitComposer.tsx"),
      "utf8",
    );
    assert.doesNotMatch(commitComposerSource, /Generate commit message with Inline AI/);
    assert.ok(
      commitComposerSource.includes('title="Draft a commit message with your Pi subscription"'),
      "CommitComposer must keep the exact Pi subscription tooltip",
    );

    const orchestrationSmokeSource = fs.readFileSync(
      path.join(ROOT, "tests", "e2e", "orchestration-smoke.spec.ts"),
      "utf8",
    );
    assert.ok(
      orchestrationSmokeSource.includes('page.getByLabel("Model", { exact: true })'),
      "OpenRouter model must use the exact visible label locator",
    );
    assert.ok(
      orchestrationSmokeSource.includes(
        'expect(settings.commitMessageModel).toBe("claude-sonnet-5")',
      ),
      "Settings smoke test must assert the persisted commit model",
    );

    console.log("sessionless Pi commit prototype: ok (stdin, EOF, argv privacy, UTF-8, lifecycle)");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
