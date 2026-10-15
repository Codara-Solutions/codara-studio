// Unit and integration test for worktree setup kept in the repository
// (src/main/worktree-setup/*, src/shared/worktree-setup.ts): the file parser,
// the gitignore matcher (checked against git itself), finding the ignored
// files to copy, links and copies with their safety rules and budget, the
// command runner with its log and status, and removal's link release. The
// modules are Electron-free, bundled with esbuild and run against throwaway
// repositories under a fake HOME and git config.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function git(cwd, args, options = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commitAll(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

let passed = 0;
let skipped = 0;
// From the links on, the checks make symlinks and run POSIX shell commands
// (echo, test, sleep). The Windows paths (junctions, cmd, taskkill) are not
// exercised here, so Windows runs only the parsing and matching checks.
let posixOnly = false;
async function check(name, fn) {
  if (posixOnly && process.platform === "win32") {
    skipped += 1;
    console.log(`SKIP - ${name} (POSIX only)`);
    return;
  }
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `codara-worktree-setup-${process.pid}.cjs`);
  await esbuild.build({
    stdin: {
      contents: [
        'export * as shared from "./src/shared/worktree-setup";',
        'export * as gitignore from "./src/main/worktree-setup/gitignore";',
        'export * as plan from "./src/main/worktree-setup/plan";',
        'export * as materialize from "./src/main/worktree-setup/materialize";',
        'export * as links from "./src/main/worktree-setup/links";',
        'export * as service from "./src/main/worktree-setup/service";',
        'export * as files from "./src/main/worktree-setup/files";',
        'export * as agent from "./src/main/agent-worktrees";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  const m = require(outFile);
  fs.rmSync(outFile, { force: true });

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-wt-setup-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;

  try {
    await runSuite(m, scratch);
    await agentSuite(m, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${passed} checks passed${skipped ? `, ${skipped} skipped` : ""}`);
}

async function runSuite(m, scratch) {
  const { shared, gitignore, plan, materialize, links, service, files, agent } = m;

  // ── Parser ───────────────────────────────────────────────────────────────
  await check("parses a full setup file", () => {
    const parsed = shared.parseWorktreeSetupFile(
      JSON.stringify({
        $schema: "x",
        copy: ["config/*.local.json", " "],
        link: ["./node_modules/", "packages\\web\\node_modules"],
        setup: ["npm ci", "npm run build"],
        setupWindows: "npm ci",
        waitForSetup: true,
        terminals: [{ name: "Dev", command: "npm run dev" }, { command: "npm test -- --watch" }],
        extra: 1,
      }),
    );
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.warnings, [
      '"extra" is not a setting Codara knows; it is ignored',
      "The setup command installs into node_modules, which is linked to the main checkout's folder, so it changes that folder too. Link node_modules or install it, not both.",
      "The setup command installs into packages/web/node_modules, which is linked to the main checkout's folder, so it changes that folder too. Link packages/web/node_modules or install it, not both.",
    ]);
    assert.deepEqual(parsed.config.copy, ["config/*.local.json"]);
    assert.deepEqual(parsed.config.link, ["node_modules", "packages/web/node_modules"]);
    assert.equal(parsed.config.setup, "npm ci\nnpm run build");
    assert.equal(shared.repoSetupCommandFor(parsed.config, "win32"), "npm ci");
    assert.equal(shared.repoSetupCommandFor(parsed.config, "linux"), "npm ci\nnpm run build");
    assert.equal(parsed.config.waitForSetup, true);
    assert.deepEqual(parsed.config.terminals, [
      { name: "Dev", command: "npm run dev" },
      { name: "npm", command: "npm test -- --watch" },
    ]);
  });

  await check("warns when setup installs into a linked folder", () => {
    const warn = (links, ...commands) => shared.linkedInstallWarnings(links, commands).length;
    assert.equal(warn(["node_modules"], "npm ci"), 1);
    assert.equal(warn(["node_modules"], "corepack enable\npnpm install --frozen-lockfile"), 1);
    assert.equal(warn(["node_modules"], "yarn"), 1);
    assert.equal(warn(["node_modules"], "cd web && bun i"), 1);
    assert.equal(warn(["apps/web/node_modules"], null, "npm install"), 1, "setupWindows counts too");
    assert.equal(warn([".venv"], "uv sync"), 1);
    assert.equal(warn(["node_modules"], "npm run build"), 0);
    assert.equal(warn(["node_modules"], "uv sync"), 0);
    assert.equal(warn([".venv"], "npm ci"), 0);
    assert.equal(warn([], "npm ci"), 0);
    assert.equal(warn(["node_modules"], null), 0);
  });

  await check("rejects links that leave the repository or are patterns", () => {
    for (const bad of ["../x", "/abs", "C:/x", "a/../../b", "*.d", ".git/hooks", "a//b", "."]) {
      assert.equal(shared.normalizeLinkPath(bad), null, bad);
    }
    const parsed = shared.parseWorktreeSetupFile('{"link":["../up"],"waitForSetup":"yes","setup":5}');
    assert.equal(parsed.config.link.length, 0);
    assert.equal(parsed.config.waitForSetup, false);
    assert.equal(parsed.config.setup, null);
    assert.equal(parsed.errors.length, 3);
    assert.equal(shared.parseWorktreeSetupFile("{nope").config, null);
    assert.equal(shared.parseWorktreeSetupFile("[]").config, null);
  });

  await check("serializes a draft and reads it back", () => {
    const out = shared.serializeWorktreeSetupDraft({
      include: [".env", "", "config/*.local.json"],
      link: ["node_modules", "../bad"],
      setup: "npm ci\nnpm run build",
      waitForSetup: true,
      terminals: [{ name: "Dev", command: "npm run dev" }, { name: " ", command: "" }],
    });
    assert.match(out.worktreeInclude, /^# Ignored files/);
    assert.deepEqual(shared.parseWorktreeIncludeFile(out.worktreeInclude).patterns, [".env", "config/*.local.json"]);
    const back = shared.parseWorktreeSetupFile(out.setupFile).config;
    assert.deepEqual(back.link, ["node_modules"]);
    assert.equal(back.setup, "npm ci\nnpm run build");
    assert.equal(back.waitForSetup, true);
    assert.deepEqual(back.terminals, [{ name: "Dev", command: "npm run dev" }]);
    const empty = shared.serializeWorktreeSetupDraft({ include: [], link: [], setup: "", waitForSetup: false, terminals: [] });
    assert.deepEqual(empty, { worktreeInclude: null, setupFile: null });
  });

  // ── Gitignore matcher against git ────────────────────────────────────────
  await check("a failed status is not mistaken for a start error", () => {
    assert.equal(shared.isWorktreeSetupStartError({ error: "The worktree folder does not exist" }), true);
    assert.equal(shared.isWorktreeSetupStartError({ id: "abc", state: "failed", error: "exit 3" }), false);
  });

  await check("matches the way git does", () => {
    const repo = path.join(scratch, "matcher");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const paths = [
      ".env",
      ".env.local",
      ".env.example",
      "a/.env",
      "a/b/.env.local",
      "a/b/c.txt",
      "config/app.local.json",
      "config/app.json",
      "config/deep/app.local.json",
      "docs/x.md",
      "foo/bar/baz/qux.txt",
      "foo/qux.txt",
      "logs/one.log",
      "logs/keep/two.log",
      "build/out.js",
      "src/build/out.js",
      "x[1].txt",
      "y1.txt",
      "space name.txt",
      "#hash.txt",
      "abc/def/ghi.local",
    ];
    for (const p of paths) write(path.join(repo, p), "x");
    const sets = [
      [".env*", "!.env.example"],
      ["config/*.local.json"],
      ["**/qux.txt"],
      ["foo/**"],
      ["foo/**/qux.txt"],
      ["logs/", "!logs/keep/"],
      ["/build/"],
      ["build/"],
      ["*.txt", "!y?.txt"],
      ["x\\[1\\].txt", "space\\ name.txt"],
      ["\\#hash.txt"],
      ["a/**/.env*"],
      ["*.local", "!abc/"],
      ["[a-c]*/"],
      ["**/deep/**"],
    ];
    for (const set of sets) {
      write(path.join(repo, ".gitignore"), `${set.join("\n")}\n`);
      const expected = new Set(
        git(repo, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).split("\0").filter(Boolean),
      );
      const matcher = new gitignore.IgnoreMatcher(set);
      for (const p of paths) {
        assert.equal(matcher.matches(p, false), expected.has(p), `${JSON.stringify(set)} on ${p}`);
      }
    }
  });

  await check("knows which folders a pattern can reach into", () => {
    const matcher = new gitignore.IgnoreMatcher(["apps/*/config/.env", "*.pem"]);
    assert.equal(new gitignore.IgnoreMatcher(["apps/web/.env"]).mayMatchInside("apps"), "explicit");
    assert.equal(new gitignore.IgnoreMatcher(["apps/web/.env"]).mayMatchInside("lib"), null);
    assert.equal(matcher.mayMatchInside("apps/web"), "explicit");
    assert.equal(matcher.mayMatchInside("node_modules"), "wildcard");
    assert.equal(new gitignore.IgnoreMatcher(["**/x"]).mayMatchInside("a"), "wildcard");
  });

  // ── A repository with a main checkout and a worktree ─────────────────────
  const outside = path.join(scratch, "outside");
  write(path.join(outside, "secret.txt"), "do not copy");
  const repo = path.join(scratch, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  write(
    path.join(repo, ".gitignore"),
    [".env*", "!.env.example", "node_modules/", "cfg/", "apps/*/.env.local", "linked-out", "big/", "*.pem", ""].join("\n"),
  );
  write(path.join(repo, ".env.example"), "EXAMPLE=1\n");
  write(path.join(repo, "apps/web/src/index.ts"), "export {};\n");
  write(path.join(repo, "package-lock.json"), "{}\n");
  commitAll(repo, "init");
  write(path.join(repo, ".env"), "SECRET=1\n");
  write(path.join(repo, ".env.local"), "LOCAL=1\n");
  write(path.join(repo, "apps/web/.env.local"), "WEB=1\n");
  write(path.join(repo, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  write(path.join(repo, "node_modules/pkg/.env"), "inside a package\n");
  write(path.join(repo, "cfg/a.json"), "{}\n");
  write(path.join(repo, "cfg/sub/b.json"), "{}\n");
  fs.symlinkSync("../a.json", path.join(repo, "cfg/sub/rel-link.json"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "cfg/abs-link.txt"));
  fs.symlinkSync("../../../outside/secret.txt", path.join(repo, "cfg/sub/escape.txt"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "linked-out"));
  write(path.join(repo, "big/one.bin"), Buffer.alloc(4096));
  write(path.join(repo, "big/two.bin"), Buffer.alloc(4096));
  write(path.join(repo, "key.pem"), "pem\n");

  const includePatterns = [".env*", "!.env.example", "cfg/", "apps/*/.env.local", "linked-out", "big/", "*.pem"];

  await check("finds the ignored entries the patterns select", async () => {
    const found = await plan.resolveCopyCandidates(repo, includePatterns);
    const byPath = Object.fromEntries(found.candidates.map((c) => [c.path, c.kind]));
    assert.deepEqual(byPath, {
      ".env": "file",
      ".env.local": "file",
      "apps/web/.env.local": "file",
      big: "dir",
      cfg: "dir",
      "key.pem": "file",
      "linked-out": "file",
    });
    // Tracked files are never candidates, and node_modules is not searched
    // by a pattern without a slash.
    assert.ok(!found.candidates.some((c) => c.path.startsWith("node_modules")));
  });

  await check("a pattern naming a path inside node_modules still finds it", async () => {
    const found = await plan.resolveCopyCandidates(repo, ["node_modules/pkg/.env"]);
    assert.deepEqual(found.candidates.map((c) => c.path), ["node_modules/pkg/.env"]);
  });

  await check("finds ignored env files, link candidates and a setup command", async () => {
    assert.deepEqual(await plan.findIgnoredEnvFiles(repo), [".env", ".env.local", "apps/web/.env.local"]);
    assert.deepEqual(await plan.findLinkableFolders(repo), ["node_modules"]);
    assert.equal(await plan.suggestSetupCommand(repo), "npm ci");
  });

  function addWorktree(name) {
    const wt = path.join(scratch, "worktrees", name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repo, ["worktree", "add", "-q", "-b", name, wt]);
    return fs.realpathSync(wt);
  }

  posixOnly = true;
  await check("links and copies stay inside the repository and never overwrite", async () => {
    const wt = addWorktree("wt-materialize");
    write(path.join(wt, ".env.local"), "MINE=1\n");
    const found = await plan.resolveCopyCandidates(repo, includePatterns);
    const logLines = [];
    const result = await materialize.materializeSetup({
      sourceRoot: repo,
      worktreeRoot: wt,
      copies: found.candidates,
      links: ["node_modules"],
      log: (line) => logLines.push(line),
    });
    // The link points at the main checkout's folder.
    assert.equal(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(wt, "node_modules")), path.join(repo, "node_modules"));
    assert.deepEqual(result.linked.map((l) => l.path), ["node_modules"]);
    // Copies
    assert.equal(fs.readFileSync(path.join(wt, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(fs.readFileSync(path.join(wt, ".env.local"), "utf8"), "MINE=1\n", "existing file kept");
    assert.ok(result.skipped.some((s) => s.path === ".env.local" && /already/.test(s.reason)));
    assert.equal(fs.readFileSync(path.join(wt, "apps/web/.env.local"), "utf8"), "WEB=1\n");
    assert.equal(fs.readFileSync(path.join(wt, "cfg/sub/b.json"), "utf8"), "{}\n");
    // A relative link that stays inside is recreated; links that leave are not.
    assert.equal(fs.readlinkSync(path.join(wt, "cfg/sub/rel-link.json")), "../a.json");
    assert.equal(fs.existsSync(path.join(wt, "cfg/abs-link.txt")), false);
    assert.equal(fs.existsSync(path.join(wt, "cfg/sub/escape.txt")), false);
    assert.equal(fs.existsSync(path.join(wt, "linked-out")), false);
    assert.ok(result.skipped.some((s) => s.path === "linked-out" && /outside/.test(s.reason)));
    // The worktree shows nothing new to git, the link included.
    assert.equal(git(wt, ["status", "--porcelain", "--untracked-files=all"]), "");
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/node_modules$/m);
    // A second run adds nothing to info/exclude.
    await materialize.keepLinksIgnored(wt, ["node_modules"]);
    assert.equal(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), exclude);
    assert.ok(logLines.some((line) => /^Linked node_modules/.test(line)));
  });

  await check("never writes through a link in the worktree", async () => {
    const wt = addWorktree("wt-parent-link");
    fs.symlinkSync(outside, path.join(wt, "apps-out"));
    fs.mkdirSync(path.join(wt, "apps"), { recursive: true });
    fs.rmSync(path.join(wt, "apps"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(wt, "apps"));
    const result = await materialize.materializeSetup({
      sourceRoot: repo,
      worktreeRoot: wt,
      copies: [{ path: "apps/web/.env.local", kind: "file" }],
      links: [],
      log: () => undefined,
    });
    assert.equal(fs.existsSync(path.join(outside, "web")), false);
    assert.ok(result.skipped.some((s) => /link or a file/.test(s.reason)));
  });

  await check("stops at the copy budget and says so", async () => {
    const wt = addWorktree("wt-budget");
    const result = await materialize.materializeSetup({
      sourceRoot: repo,
      worktreeRoot: wt,
      copies: [
        { path: ".env", kind: "file" },
        { path: "big", kind: "dir" },
      ],
      links: [],
      budget: { bytes: 6000, entries: 100 },
      log: () => undefined,
    });
    assert.equal(fs.existsSync(path.join(wt, ".env")), true);
    assert.equal(fs.existsSync(path.join(wt, "big")), false);
    assert.ok(result.skipped.some((s) => s.path === "big" && /limit/.test(s.reason)));
    assert.equal(result.warnings.length, 1);
  });

  // ── Service ──────────────────────────────────────────────────────────────
  const changes = [];
  function makeService(extra = {}) {
    return new service.WorktreeSetupService({
      baseEnv: async () => {
        const env = {};
        for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
        return env;
      },
      userShell: async () => ({ path: "/bin/sh", kind: "posix" }),
      onChange: (status) => changes.push(status.state),
      ...extra,
    });
  }

  write(path.join(repo, ".worktreeinclude"), "# comment\n.env\ncfg/\n");
  write(
    path.join(repo, ".codara", "worktree.json"),
    JSON.stringify({
      link: ["node_modules"],
      setup: ['echo "root=$CODARA_ROOT_PATH"', 'echo "branch=$CODARA_WORKTREE_BRANCH"', "echo made > setup-ran.txt"],
      waitForSetup: true,
      terminals: [{ name: "Dev", command: "npm run dev" }],
    }),
  );
  write(path.join(repo, ".git", "info", "exclude"), fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8") + "setup-ran.txt\nuser-ran.txt\n");

  await check("runs links, copies, the repo command and the user command in order", async () => {
    const wt = addWorktree("wt-service");
    const svc = makeService();
    const first = await svc.start({
      sourceCwd: path.join(repo, "apps"),
      worktreePath: wt,
      trigger: "agent",
      branch: "wt-service",
      userCommand: "test -f setup-ran.txt && echo user > user-ran.txt",
    });
    assert.equal(first.state, "preparing");
    assert.equal(first.waitForSetup, true);
    assert.deepEqual(first.terminals, [{ name: "Dev", command: "npm run dev" }]);
    const done = await svc.waitFor(first.id, 20_000);
    assert.equal(done.state, "succeeded", done.error);
    assert.equal(done.exitCode, 0);
    assert.deepEqual(done.commands.map((c) => [c.kind, c.state]), [
      ["repo", "succeeded"],
      ["user", "succeeded"],
    ]);
    assert.deepEqual(done.linked, ["node_modules"]);
    assert.ok(done.copiedCount >= 3);
    assert.equal(fs.readFileSync(path.join(wt, "user-ran.txt"), "utf8"), "user\n");
    const log = await svc.readLog(first.id, 0);
    assert.match(log.text, new RegExp(`root=${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(log.text, /branch=wt-service/);
    assert.match(log.text, /Setup finished/);
    assert.match(await svc.tail(first.id, 3), /Setup finished/);
    const summary = service.agentSetupSummary(done, "tail");
    assert.equal(summary.state, "succeeded");
    assert.equal(summary.logTail, "tail");
    // A fresh service (Codara restarted) reads the stored status.
    const later = await makeService().get(wt);
    assert.equal(later.state, "succeeded");
    assert.equal(later.id, first.id);
    assert.ok(changes.includes("running") && changes.includes("succeeded"));
    // Removal takes the link out and leaves the main checkout's folder alone.
    const released = await links.releaseWorktreeLinks(wt);
    assert.deepEqual(released.map((l) => l.path), ["node_modules"]);
    assert.equal(fs.existsSync(path.join(wt, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(repo, "node_modules/pkg/index.js")), true);
    await links.restoreWorktreeLinks(wt, released);
    assert.equal(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), true);
  });

  await check("tells unchanged copies apart from edited ones", async () => {
    const wt = addWorktree("wt-regenerable");
    const svc = makeService();
    const started = await svc.start({ sourceCwd: repo, worktreePath: wt, trigger: "ui", runCommands: false });
    const done = await svc.waitFor(started.id, 20_000);
    assert.equal(done.state, "succeeded");
    assert.equal(done.commandsSkipped, true);
    assert.equal(fs.existsSync(path.join(wt, "setup-ran.txt")), false);
    const entries = git(wt, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
      .split("\0")
      .filter(Boolean);
    let provided = await links.setupProvidedEntries(wt, entries);
    assert.ok(provided.has(".env"));
    assert.ok(provided.has("cfg/"));
    assert.ok(provided.has("node_modules"));
    write(path.join(wt, ".env"), "EDITED=1\n");
    write(path.join(wt, "cfg/new.json"), "{}\n");
    provided = await links.setupProvidedEntries(wt, entries);
    assert.ok(!provided.has(".env"));
    assert.ok(!provided.has("cfg/"));
  });

  await check("a failing command fails setup and skips the rest", async () => {
    const wt = addWorktree("wt-fail");
    write(path.join(repo, ".codara", "worktree.json"), JSON.stringify({ setup: ["echo before", "exit 3", "echo never"] }));
    const svc = makeService();
    const started = await svc.start({ sourceCwd: repo, worktreePath: wt, trigger: "ui", userCommand: "echo user" });
    const done = await svc.waitFor(started.id, 20_000);
    assert.equal(done.state, "failed");
    assert.equal(done.exitCode, 3);
    assert.match(done.error, /exited with code 3/);
    assert.deepEqual(done.commands.map((c) => c.state), ["failed", "skipped"]);
    const log = (await svc.readLog(started.id)).text;
    assert.match(log, /^before$/m);
    assert.doesNotMatch(log, /^never$/m);
    // Run again after fixing the file.
    write(path.join(repo, ".codara", "worktree.json"), JSON.stringify({ setup: "echo fixed" }));
    const again = await svc.rerun(started.id, { userCommand: null });
    const second = await svc.waitFor(again.id, 20_000);
    assert.equal(second.state, "succeeded");
    const secondLog = (await svc.readLog(again.id)).text;
    assert.match(secondLog, /fixed/);
    // What the first run put there is expected, not listed as skipped.
    assert.ok(done.copiedCount > 0);
    assert.deepEqual(
      second.skipped.filter((skip) => /already/.test(skip.reason)),
      [],
      JSON.stringify(second.skipped),
    );
    assert.match(secondLog, /from an earlier setup already in place/);
    assert.doesNotMatch(secondLog, /Skipped \.env: already/);
  });

  await check("stop ends a running command and its children", async () => {
    const wt = addWorktree("wt-stop");
    write(path.join(repo, ".codara", "worktree.json"), JSON.stringify({ setup: "sleep 30 & wait" }));
    const svc = makeService();
    const started = await svc.start({ sourceCwd: repo, worktreePath: wt, trigger: "ui", userCommand: null });
    for (let i = 0; i < 100; i += 1) {
      if ((await svc.get(started.id)).state === "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const t0 = Date.now();
    const stopped = await svc.stop(started.id);
    assert.equal(stopped.state, "stopped");
    assert.ok(Date.now() - t0 < 5_000);
  });

  await check("a command that leaves a process in the background still ends", async () => {
    // The background sleep keeps the output pipes open: waiting for them
    // would hold the step (and the agents waiting on it) until it exits.
    const wt = addWorktree("wt-background");
    write(path.join(repo, ".codara", "worktree.json"), JSON.stringify({ setup: ["sleep 4 &", "echo started"] }));
    const svc = makeService({ exitDrainMs: 100 });
    const t0 = Date.now();
    const started = await svc.start({ sourceCwd: repo, worktreePath: wt, trigger: "ui", userCommand: null });
    const done = await svc.waitFor(started.id, 20_000);
    assert.equal(done.state, "succeeded", done.error);
    assert.ok(Date.now() - t0 < 3_000, `took ${Date.now() - t0} ms`);
    const log = (await svc.readLog(started.id)).text;
    assert.match(log, /^started$/m);
    assert.match(log, /still running/);
  });

  await check("a setup still running when Codara closed reads as stopped", async () => {
    const wt = addWorktree("wt-interrupted");
    write(path.join(repo, ".codara", "worktree.json"), JSON.stringify({ setup: "sleep 30" }));
    const svc = makeService();
    const started = await svc.start({ sourceCwd: repo, worktreePath: wt, trigger: "ui", userCommand: null });
    for (let i = 0; i < 100; i += 1) {
      if ((await svc.get(started.id)).state === "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    svc.dispose();
    const stored = await makeService().get(wt);
    assert.equal(stored.state, "stopped");
    assert.equal(stored.error, "Codara closed while setup was running");
  });

  await check("commands wait for a free slot", async () => {
    write(path.join(repo, ".codara", "worktree.json"), JSON.stringify({ setup: "sleep 0.4" }));
    const svc = makeService({ maxConcurrentCommands: 1 });
    const a = await svc.start({ sourceCwd: repo, worktreePath: addWorktree("wt-slot-a"), trigger: "ui", userCommand: null });
    const b = await svc.start({ sourceCwd: repo, worktreePath: addWorktree("wt-slot-b"), trigger: "ui", userCommand: null });
    await svc.whenPrepared(a.id);
    await svc.whenPrepared(b.id);
    const states = [(await svc.get(a.id)).state, (await svc.get(b.id)).state].sort();
    assert.deepEqual(states, ["queued", "running"]);
    assert.equal((await svc.waitFor(a.id, 10_000)).state, "succeeded");
    assert.equal((await svc.waitFor(b.id, 10_000)).state, "succeeded");
  });

  await check("an unreadable setup file fails after the copies", async () => {
    const wt = addWorktree("wt-badfile");
    write(path.join(repo, ".codara", "worktree.json"), "{ not json");
    const svc = makeService();
    const started = await svc.start({ sourceCwd: repo, worktreePath: wt, trigger: "ui", userCommand: null });
    const done = await svc.waitFor(started.id, 10_000);
    assert.equal(done.state, "failed");
    assert.match(done.error, /not valid JSON/);
    assert.equal(fs.existsSync(path.join(wt, ".env")), true, ".worktreeinclude still applied");
  });

  await check("refuses a worktree of another repository and the main checkout", async () => {
    const other = path.join(scratch, "other");
    execFileSync("git", ["init", "-q", "-b", "main", other]);
    write(path.join(other, "f.txt"), "x");
    commitAll(other, "init");
    const otherWt = path.join(scratch, "worktrees", "other-wt");
    git(other, ["worktree", "add", "-q", "-b", "x", otherWt]);
    const svc = makeService();
    await assert.rejects(svc.start({ sourceCwd: repo, worktreePath: otherWt, trigger: "ui" }), /does not belong/);
    await assert.rejects(svc.start({ sourceCwd: repo, worktreePath: repo, trigger: "ui" }), /not a linked git worktree/);
  });

  await check("a setup file behind a link is not read", async () => {
    const linkedRepo = path.join(scratch, "linked-file");
    execFileSync("git", ["init", "-q", "-b", "main", linkedRepo]);
    write(path.join(linkedRepo, "f.txt"), "x");
    commitAll(linkedRepo, "init");
    write(path.join(outside, "worktree.json"), JSON.stringify({ setup: "echo pwned" }));
    fs.mkdirSync(path.join(linkedRepo, ".codara"));
    fs.symlinkSync(path.join(outside, "worktree.json"), path.join(linkedRepo, ".codara", "worktree.json"));
    const sources = await plan.readSetupSources(linkedRepo);
    assert.equal(sources.file.present, false);
  });

  // ── Links git would see, removal, abortable waits ────────────────────────
  {
    // A repository of its own: the main one's info/exclude already lists
    // /node_modules from the checks above.
    const lone = path.join(scratch, "lone");
    execFileSync("git", ["init", "-q", "-b", "main", lone]);
    write(path.join(lone, ".gitignore"), "cache/\n.env\n");
    write(path.join(lone, "README.md"), "x\n");
    commitAll(lone, "init");
    write(path.join(lone, ".env"), "LONE=1\n");
    write(path.join(lone, "cache", "blob.bin"), "cached\n");
    const loneWorktree = (name) => {
      const wt = path.join(scratch, "lone-worktrees", name);
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(lone, ["worktree", "add", "-q", "-b", name, wt]);
      return fs.realpathSync(wt);
    };

    await check("links are on record before the copies start", async () => {
      const wt = loneWorktree("lone-record");
      const seen = [];
      const result = await materialize.materializeSetup({
        sourceRoot: lone,
        worktreeRoot: wt,
        copies: [{ path: ".env", kind: "file" }],
        links: ["cache"],
        log: () => undefined,
        onLinked: async (linked) => {
          seen.push({ linked: linked.map((link) => link.path), envCopied: fs.existsSync(path.join(wt, ".env")) });
        },
      });
      assert.deepEqual(seen, [{ linked: ["cache"], envCopied: false }]);
      assert.deepEqual(result.linked.map((link) => link.path), ["cache"]);
      assert.equal(fs.readFileSync(path.join(wt, ".env"), "utf8"), "LONE=1\n");
      assert.equal(git(wt, ["status", "--porcelain"]), "");
    });

    await check("a link git would still see is taken out again", async () => {
      const wt = loneWorktree("lone-unignored");
      // An info/exclude Codara cannot write: .git/info is a file.
      const info = path.join(lone, ".git", "info");
      const saved = fs.mkdtempSync(path.join(scratch, "info-"));
      fs.renameSync(info, path.join(saved, "info"));
      write(info, "not a folder\n");
      try {
        const result = await materialize.materializeSetup({
          sourceRoot: lone,
          worktreeRoot: wt,
          copies: [],
          links: ["cache"],
          log: () => undefined,
          onLinked: async () => assert.fail("nothing is linked"),
        });
        assert.deepEqual(result.linked, []);
        assert.equal(fs.existsSync(path.join(wt, "cache")), false);
        assert.ok(result.skipped.some((s) => s.path === "cache" && /taken out/.test(s.reason)), JSON.stringify(result));
        assert.ok(result.warnings.some((w) => /info is not a plain folder/.test(w)));
        assert.equal(fs.readFileSync(path.join(lone, "cache", "blob.bin"), "utf8"), "cached\n");
        assert.equal(git(wt, ["status", "--porcelain"]), "");
      } finally {
        fs.rmSync(info, { force: true });
        fs.renameSync(path.join(saved, "info"), info);
      }
    });

    await check("removal stops setup and waits until it no longer writes", async () => {
      const wt = loneWorktree("lone-quiesce");
      write(path.join(lone, ".codara", "worktree.json"), JSON.stringify({ link: ["cache"], setup: "sleep 30 & wait" }));
      const svc = makeService();
      const started = await svc.start({ sourceCwd: lone, worktreePath: wt, trigger: "agent", userCommand: null });
      for (let i = 0; i < 100; i += 1) {
        if ((await svc.get(started.id)).state === "running") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const t0 = Date.now();
      assert.equal(await svc.quiesce(wt, 10_000), true);
      assert.ok(Date.now() - t0 < 8_000);
      const stored = JSON.parse(fs.readFileSync(path.join(path.dirname(started.logPath), "status.json"), "utf8"));
      assert.equal(stored.state, "stopped");
      // The link is on record, so removal takes it out first.
      const released = await links.releaseWorktreeLinks(wt);
      assert.deepEqual(released.map((link) => link.path), ["cache"]);
      assert.equal(fs.readFileSync(path.join(lone, "cache", "blob.bin"), "utf8"), "cached\n");
      // Nothing running: quiesce answers at once.
      assert.equal(await svc.quiesce(path.join(scratch, "nowhere")), true);
      fs.rmSync(path.join(lone, ".codara"), { recursive: true, force: true });
    });

    await check("a queued setup leaves the queue when it is stopped", async () => {
      write(path.join(lone, ".codara", "worktree.json"), JSON.stringify({ setup: "sleep 30 & wait" }));
      const svc = makeService({ maxConcurrentCommands: 1 });
      const a = await svc.start({ sourceCwd: lone, worktreePath: loneWorktree("lone-slot-a"), trigger: "ui", userCommand: null });
      await svc.whenPrepared(a.id);
      const b = await svc.start({ sourceCwd: lone, worktreePath: loneWorktree("lone-slot-b"), trigger: "ui", userCommand: null });
      await svc.whenPrepared(b.id);
      assert.equal((await svc.get(b.id)).state, "queued");
      const t0 = Date.now();
      assert.equal(await svc.quiesce(b.id, 10_000), true);
      assert.ok(Date.now() - t0 < 3_000, `took ${Date.now() - t0} ms`);
      assert.equal((await svc.get(b.id)).state, "stopped");
      assert.equal((await svc.get(a.id)).state, "running", "the other setup is untouched");
      assert.equal((await svc.stop(a.id)).state, "stopped");
      // The slot is free again for the next one.
      write(path.join(lone, ".codara", "worktree.json"), JSON.stringify({ setup: "true" }));
      const c = await svc.start({ sourceCwd: lone, worktreePath: loneWorktree("lone-slot-c"), trigger: "ui", userCommand: null });
      assert.equal((await svc.waitFor(c.id, 10_000)).state, "succeeded");
      fs.rmSync(path.join(lone, ".codara"), { recursive: true, force: true });
    });

    await check("a wait gives up as soon as its caller is stopped", async () => {
      const wt = loneWorktree("lone-abort");
      write(path.join(lone, ".codara", "worktree.json"), JSON.stringify({ setup: "sleep 30 & wait", waitForSetup: true }));
      const svc = makeService();
      const started = await svc.start({ sourceCwd: lone, worktreePath: wt, trigger: "worker", userCommand: null });
      const t0 = Date.now();
      const waited = await svc.waitFor(started.id, 60_000, { aborted: () => Date.now() - t0 > 300, sliceMs: 50 });
      assert.ok(Date.now() - t0 < 3_000, `waited ${Date.now() - t0} ms`);
      assert.ok(!["succeeded", "failed", "stopped"].includes(waited.state), waited.state);
      assert.equal((await svc.stop(started.id)).state, "stopped");
      fs.rmSync(path.join(lone, ".codara"), { recursive: true, force: true });
    });

    await check("on Windows a Git Bash default shell runs your command", async () => {
      // The seam only: platform win32 with a POSIX default shell takes the
      // script route, not cmd (which does not exist here).
      const wt = loneWorktree("lone-gitbash");
      const svc = makeService({ platform: "win32", userShell: async () => ({ path: "/bin/sh", kind: "posix" }) });
      const started = await svc.start({ sourceCwd: lone, worktreePath: wt, trigger: "ui", userCommand: "echo bash > from-user.txt" });
      const done = await svc.waitFor(started.id, 20_000);
      assert.equal(done.state, "succeeded", done.error);
      assert.equal(fs.readFileSync(path.join(wt, "from-user.txt"), "utf8"), "bash\n");
      const viaCmd = makeService({ platform: "win32", userShell: async () => ({ path: "/nonexistent/cmd.exe", kind: "cmd" }) });
      const wtCmd = loneWorktree("lone-cmd");
      const failed = await viaCmd.waitFor(
        (await viaCmd.start({ sourceCwd: lone, worktreePath: wtCmd, trigger: "ui", userCommand: "echo x" })).id,
        20_000,
      );
      assert.equal(failed.state, "failed", "cmd is used when it is the default");
    });
  }

  // ── Files dialog ─────────────────────────────────────────────────────────
  await check("previews, suggests and writes the setup files", async () => {
    const fresh = path.join(scratch, "fresh");
    execFileSync("git", ["init", "-q", "-b", "main", fresh]);
    write(path.join(fresh, ".gitignore"), ".env*\nnode_modules/\n");
    write(path.join(fresh, "pnpm-lock.yaml"), "");
    commitAll(fresh, "init");
    write(path.join(fresh, ".env"), "A=1\n");
    write(path.join(fresh, "node_modules/x/i.js"), "");
    const before = await files.previewWorktreeSetup(fresh, "make deps", "linux");
    assert.equal(before.configured, false);
    assert.deepEqual(before.uncoveredEnvFiles, [".env"]);
    assert.deepEqual(before.commands, [{ kind: "user", label: "Your setup command", command: "make deps" }]);
    const suggestion = await files.suggestWorktreeSetup(path.join(fresh, "node_modules"));
    assert.equal(suggestion.isRepo, true);
    assert.deepEqual(suggestion.envFiles, [".env"]);
    assert.deepEqual(suggestion.linkCandidates, ["node_modules"]);
    assert.equal(suggestion.setupCommand, "pnpm install --frozen-lockfile");
    const draft = {
      sourceCwd: fresh,
      include: [".env"],
      link: ["node_modules"],
      setup: "pnpm install --frozen-lockfile",
      waitForSetup: true,
      terminals: [],
    };
    const written = await files.writeWorktreeSetupFiles(draft);
    assert.deepEqual(written, { ok: true, written: [".worktreeinclude", ".codara/worktree.json"] });
    const refused = await files.writeWorktreeSetupFiles(draft);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.exists, [".worktreeinclude", ".codara/worktree.json"]);
    const overwritten = await files.writeWorktreeSetupFiles({ ...draft, include: [], overwrite: true });
    assert.equal(overwritten.ok, true);
    assert.deepEqual(shared.parseWorktreeIncludeFile(fs.readFileSync(path.join(fresh, ".worktreeinclude"), "utf8")).patterns, []);
    const after = await files.previewWorktreeSetup(fresh, null, "linux");
    assert.equal(after.configured, true);
    assert.deepEqual(after.link, ["node_modules"]);
    assert.equal(after.waitForSetup, true);
    // A .codara that is a link is refused.
    const linked = path.join(scratch, "linked-codara");
    execFileSync("git", ["init", "-q", "-b", "main", linked]);
    fs.symlinkSync(outside, path.join(linked, ".codara"));
    const viaLink = await files.writeWorktreeSetupFiles({ ...draft, sourceCwd: linked, include: [] });
    assert.equal(viaLink.ok, false);
    assert.equal(fs.existsSync(path.join(outside, "worktree.json.tmp")), false);
    assert.match(viaLink.error, /not a plain folder/);
  });
}

async function agentSuite(m, scratch) {
  const { service, agent } = m;
  const repo = path.join(scratch, "agent-repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  write(path.join(repo, ".gitignore"), ".env\nnode_modules/\ndist/\n");
  write(path.join(repo, ".worktreeinclude"), ".env\n");
  write(
    path.join(repo, ".codara", "worktree.json"),
    JSON.stringify({ link: ["node_modules"], setup: "sleep 0.3 && mkdir -p dist && echo made > dist/made.txt", waitForSetup: true }),
  );
  write(path.join(repo, "README.md"), "# agent\n");
  commitAll(repo, "init");
  write(path.join(repo, ".env"), "TOKEN=1\n");
  write(path.join(repo, "node_modules/dep/index.js"), "module.exports = 1;\n");

  const svc = new service.WorktreeSetupService({
    baseEnv: async () => ({ ...process.env }),
    userShell: async () => null,
  });
  const runner = {
    start: (request) => svc.start({ ...request, userCommand: null }),
    whenPrepared: (id) => svc.whenPrepared(id),
    waitFor: (id, ms) => svc.waitFor(id, ms),
    get: (idOrPath) => svc.get(idOrPath),
    tail: (id, lines) => svc.tail(id, lines),
    summary: service.agentSetupSummary,
  };
  let ids = 0;
  const h = {
    state: {
      workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
      workspaceRailOrder: ["ws-repo"],
      activeWorkspaceId: "ws-repo",
    },
    prefs: { agentWorktreesEnabled: true, agentWorktreeRegenerableIgnoredByRepo: {} },
  };
  const deps = {
    loadState: async () => structuredClone(h.state),
    updateState: async (mutator) => {
      h.state = await mutator(structuredClone(h.state));
      return h.state;
    },
    loadPreferences: async () => h.prefs,
    publishState: () => {},
    invalidateGitCache: () => {},
    getRun: async () => null,
    listRuns: async () => [],
    paneWorkspaceId: async () => "ws-repo",
    sessionCwd: () => null,
    sessionsUnderCwd: () => [],
    listRendererTerminals: async () => [],
    processesUnderCwd: async () => [],
    github: { listPullRequestsForHead: async () => [], listMergedPullRequests: async () => [] },
    sendAgentEvent: () => {},
    audit: async () => {},
    worktreesRoot: () => path.join(scratch, "agent-worktrees"),
    now: () => new Date("2026-10-15T10:00:00Z"),
    randomId: () => (++ids).toString(16).padStart(8, "b"),
    worktreeSetup: runner,
  };
  const caller = { role: "studio", client: "claude-code", paneId: "pane-1" };

  await check("an agent worktree waits for setup when the file asks", async () => {
    const created = await agent.createAgentWorktree(caller, { branch: "agent/setup-wait" }, deps);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.setupCommand, null);
    assert.equal(created.setup.state, "succeeded", JSON.stringify(created.setup));
    assert.equal(created.setup.copied, 1);
    assert.deepEqual(created.setup.linked, ["node_modules"]);
    assert.equal(fs.readFileSync(path.join(created.path, "dist/made.txt"), "utf8"), "made\n");
    assert.doesNotMatch(created.next, /codara_worktree_setup/);
  });

  await check("waitForSetup:false returns at once and codara_worktree_setup waits", async () => {
    const created = await agent.createAgentWorktree(caller, { branch: "agent/setup-nowait", waitForSetup: false }, deps);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(["queued", "running"].includes(created.setup.state), created.setup.state);
    assert.match(created.next, /codara_worktree_setup/);
    const waited = await agent.getAgentWorktreeSetup(caller, { workspaceId: created.workspaceId, wait: true }, deps);
    assert.equal(waited.ok, true);
    assert.equal(waited.setup.state, "succeeded");
    assert.match(waited.setup.logTail, /Setup finished/);
    const byPath = await agent.getAgentWorktreeSetup(caller, { path: created.path }, deps);
    assert.equal(byPath.workspaceId, created.workspaceId);
    const own = await agent.getAgentWorktreeSetup(caller, {}, deps);
    assert.equal(own.code, "WORKTREE_NOT_FOUND", "the caller's own workspace is the main checkout");
    const worker = await agent.getAgentWorktreeSetup({ role: "worker", client: "cora" }, {}, deps);
    assert.equal(worker.code, "WORKTREE_FORBIDDEN");
  });

  await check("removal accepts untouched copies and takes the link out first", async () => {
    const created = await agent.createAgentWorktree(caller, { branch: "agent/setup-remove" }, deps);
    assert.equal(created.setup.state, "succeeded");
    const dry = await agent.removeAgentWorktree(caller, { workspaceId: created.workspaceId, dryRun: true }, deps);
    assert.ok(!(dry.blockers ?? []).includes("WORKTREE_IGNORED_FILES"), JSON.stringify(dry));
    const removed = await agent.removeAgentWorktree(caller, { workspaceId: created.workspaceId }, deps);
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(fs.existsSync(created.path), false);
    assert.equal(fs.readFileSync(path.join(repo, "node_modules/dep/index.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(fs.readFileSync(path.join(repo, ".env"), "utf8"), "TOKEN=1\n");
  });

  await check("an edited copy still blocks removal", async () => {
    const created = await agent.createAgentWorktree(caller, { branch: "agent/setup-edited" }, deps);
    write(path.join(created.path, ".env"), "TOKEN=changed\n");
    const dry = await agent.removeAgentWorktree(caller, { workspaceId: created.workspaceId, dryRun: true }, deps);
    assert.ok((dry.blockers ?? []).includes("WORKTREE_IGNORED_FILES"), JSON.stringify(dry));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
