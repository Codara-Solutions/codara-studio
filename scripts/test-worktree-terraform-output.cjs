// A .terraform folder that terraform init wrote, and module clones it made
// that nobody touched since, are regenerable: no new work, no nested
// checkout. Anything else in it is asked about, and a clone with anything of
// anyone's in it is a checkout (src/main/agent-worktrees.ts
// isRegenerableIgnored, checkoutsInIgnored; git-worktrees.ts
// worktreeFingerprint). Throwaway repositories in the system temp folder;
// nothing here deletes a worktree.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

const outputs = [];
async function bundle(entry, name) {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-terraform-output-${name}-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["electron", "ssh2", "cpu-features"],
    logLevel: "silent",
  });
  outputs.push(outfile);
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const [removeMod, agent, gitWorktrees] = await Promise.all([
    bundle("src/main/worktree-cleanup/remove.ts", "remove"),
    bundle("src/main/agent-worktrees.ts", "agent"),
    bundle("src/main/git-worktrees.ts", "gitWorktrees"),
  ]);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-terraform-output-")));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  fs.writeFileSync(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = home;

  try {
    const origin = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    const trees = path.join(scratch, "trees");
    fs.mkdirSync(trees);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commitFile(repo, ".gitignore", ".terraform/\n", "ignore");
    commitFile(repo, "infra/main.tf", 'module "vpc" {}\n', "infra");
    commitFile(repo, "infra/.terraform.lock.hcl", "# lock\n", "lock");
    commitFile(repo, "docs/readme.md", "docs\n", "docs");
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);

    const add = (name, branch) => {
      const dir = path.join(trees, name);
      git(repo, ["worktree", "add", "-q", dir, "-b", branch]);
      return dir;
    };
    const infra = add("infra", "feat/infra");
    const h = {
      state: {
        workspaces: [{ id: "ws-repo", name: "repo", cwd: repo, color: "#123456", workers: [] }],
        workspaceRailOrder: ["ws-repo"],
        activeWorkspaceId: "ws-repo",
      },
    };
    const deps = {
      loadState: async () => structuredClone(h.state),
      updateState: async (mutator) => {
        h.state = await mutator(structuredClone(h.state));
        return h.state;
      },
      publishState: () => {},
      invalidateGitCache: () => {},
      listRuns: async () => [],
      sessionCwd: () => null,
      sessionsUnderCwd: () => [],
      listRendererTerminals: async () => [],
      processesUnderCwds: async (dirs) => new Map(dirs.map((dir) => [dir, []])),
      runningServers: () => 0,
      pullRequests: async () => ({ open: [], merged: [] }),
      regenerableIgnored: async () => [],
      appPaths: () => [path.join(scratch, "app-not-here")],
      isProtectedPath: () => false,
      audit: agent.createWorktreeAuditLog(path.join(home, "logs", "worktree-audit.jsonl")),
      now: () => new Date(),
    };
    const checkOf = async (dir) => (await removeMod.checkCleanupTargets(deps, [{ repoRoot: repo, path: dir }]))[0];
    const codes = (entry) => entry.blockers.map((blocker) => blocker.code);

    // ── Terraform ──────────────────────────────────────────────────────────
    const moduleSource = path.join(scratch, "module.git");
    const moduleWork = path.join(scratch, "module-work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", moduleSource]);
    execFileSync("git", ["clone", "-q", moduleSource, moduleWork]);
    commitFile(moduleWork, "main.tf", 'variable "cidr" {}\n', "module");
    git(moduleWork, ["push", "-q", "origin", "main"]);
    git(moduleWork, ["tag", "v1.0.0"]);
    git(moduleWork, ["push", "-q", "origin", "v1.0.0"]);
    const vpc = path.join(infra, "infra", ".terraform", "modules", "vpc");
    fs.mkdirSync(path.dirname(vpc), { recursive: true });
    // As terraform init does it: a clone, checked out at the tag asked for.
    execFileSync("git", ["clone", "-q", moduleSource, vpc]);
    git(vpc, ["checkout", "-q", "v1.0.0"]);
    fs.writeFileSync(
      path.join(infra, "infra", ".terraform", "modules", "modules.json"),
      JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }, { Key: "vpc", Source: "git::https://example.invalid/vpc.git?ref=v1.0.0", Dir: ".terraform/modules/vpc" }] }),
    );
    fs.mkdirSync(path.join(infra, "infra", ".terraform", "providers"), { recursive: true });
    fs.writeFileSync(path.join(infra, "infra", ".terraform", "providers", "terraform-provider-null_v3"), "binary\n");

    await check("a module init cloned is no nested checkout, and .terraform/ beside its lock file regenerates", async () => {
      const entry = await checkOf(infra);
      assert.deepEqual(codes(entry), [], JSON.stringify(entry.blockers));
      assert.equal(entry.localWork, null, JSON.stringify(entry.localWork));
      assert.equal(entry.merge.state, "merged");
      assert.equal(agent.isRegenerableIgnored("infra/.terraform/", [], agent.packageRootTester(infra)), true);
      const rooted = path.join(scratch, "rooted");
      fs.mkdirSync(path.join(rooted, ".terraform", "providers"), { recursive: true });
      fs.writeFileSync(path.join(rooted, ".terraform.lock.hcl"), "# lock\n");
      assert.equal(agent.isRegenerableIgnored(".terraform/", [], agent.packageRootTester(rooted)), true, "at the root too");
      assert.equal(agent.isRegenerableIgnored(".terraform/", []), false, "never without looking in it");
    });

    await check("a file init never writes in .terraform/ is asked about", async () => {
      const note = path.join(infra, "infra", ".terraform", "notes.txt");
      fs.writeFileSync(note, "mine\n");
      const entry = await checkOf(infra);
      assert.ok(entry.localWork?.ignored.includes("infra/.terraform/"), JSON.stringify(entry.localWork));
      fs.rmSync(note);
      assert.equal((await checkOf(infra)).localWork, null);
    });

    await check("a file init never writes deeper in .terraform/ is asked about", async () => {
      for (const note of [
        path.join(infra, "infra", ".terraform", "providers", "notes.txt"),
        path.join(infra, "infra", ".terraform", "modules", "notes.txt"),
      ]) {
        fs.writeFileSync(note, "mine\n");
        const entry = await checkOf(infra);
        assert.ok(entry.localWork?.ignored.includes("infra/.terraform/"), `${note}: ${JSON.stringify(entry.localWork)}`);
        fs.rmSync(note);
      }
      fs.writeFileSync(path.join(infra, "infra", ".terraform", "providers", "terraform-provider-aws_v5"), "binary\n");
      assert.equal((await checkOf(infra)).localWork, null, "a provider binary is init's");
      fs.rmSync(path.join(infra, "infra", ".terraform", "providers", "terraform-provider-aws_v5"));
    });

    await check("a module folder modules.json does not name, or one that is no clone, is asked about", async () => {
      const hand = path.join(infra, "infra", ".terraform", "modules", "handwritten");
      fs.mkdirSync(hand);
      fs.writeFileSync(path.join(hand, "notes.txt"), "mine\n");
      let entry = await checkOf(infra);
      assert.ok(entry.localWork?.ignored.includes("infra/.terraform/"), JSON.stringify(entry.localWork));
      fs.rmSync(hand, { recursive: true, force: true });
      const manifest = path.join(infra, "infra", ".terraform", "modules", "modules.json");
      const written = fs.readFileSync(manifest, "utf8");
      fs.writeFileSync(manifest, JSON.stringify({ Modules: [{ Key: "vpc", Dir: ".terraform/modules/vpc" }, { Key: "x", Dir: ".terraform/modules/x" }] }));
      fs.mkdirSync(path.join(infra, "infra", ".terraform", "modules", "x"));
      fs.writeFileSync(path.join(infra, "infra", ".terraform", "modules", "x", "main.tf"), "# no clone\n");
      entry = await checkOf(infra);
      assert.ok(entry.localWork?.ignored.includes("infra/.terraform/"), "named but no clone");
      fs.rmSync(path.join(infra, "infra", ".terraform", "modules", "x"), { recursive: true, force: true });
      fs.rmSync(manifest);
      entry = await checkOf(infra);
      assert.ok(entry.localWork?.ignored.includes("infra/.terraform/") || codes(entry).length > 0, "no modules.json");
      fs.writeFileSync(manifest, written);
      assert.equal((await checkOf(infra)).localWork, null);
    });

    await check("a modules.json that is no file, or a state with resources, is asked about", async () => {
      const modulesDir = path.join(infra, "infra", ".terraform", "modules");
      const manifest = path.join(modulesDir, "modules.json");
      const written = fs.readFileSync(manifest, "utf8");
      fs.rmSync(manifest);
      fs.mkdirSync(manifest);
      fs.writeFileSync(path.join(manifest, "notes.txt"), "mine\n");
      let entry = await checkOf(infra);
      assert.ok(entry.localWork?.ignored.includes("infra/.terraform/") || codes(entry).length > 0, JSON.stringify(entry.localWork));
      fs.rmSync(manifest, { recursive: true, force: true });
      fs.writeFileSync(manifest, written);
      const state = path.join(infra, "infra", ".terraform", "terraform.tfstate");
      fs.writeFileSync(state, JSON.stringify({ version: 4, resources: [{ type: "aws_s3_bucket", name: "mine" }] }));
      entry = await checkOf(infra);
      assert.ok(entry.localWork?.ignored.includes("infra/.terraform/"), "a local state");
      fs.writeFileSync(state, JSON.stringify({ version: 3, backend: { type: "s3", config: { bucket: "b" } }, modules: [{ path: ["root"], resources: {} }] }));
      assert.equal((await checkOf(infra)).localWork, null, "the backend record init writes");
      fs.rmSync(state);
    });

    await check("a module sharing git metadata with another folder is a checkout", async () => {
      fs.writeFileSync(path.join(vpc, ".git", "commondir"), "../../elsewhere/.git\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "commondir");
      fs.rmSync(path.join(vpc, ".git", "commondir"));
      const outside = path.join(scratch, "module-linked");
      git(vpc, ["worktree", "add", "-q", "--detach", outside, "v1.0.0"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a worktree of its own elsewhere");
      git(vpc, ["worktree", "remove", "--force", outside]);
      fs.rmSync(path.join(vpc, ".git", "worktrees"), { recursive: true, force: true });
      git(vpc, ["reflog", "expire", "--expire=now", "--all"]);
      assert.deepEqual(codes(await checkOf(infra)), []);
    });

    await check("a commit only a module's reflog holds makes it a checkout", async () => {
      git(vpc, ["checkout", "-q", "--detach"]);
      commitFile(vpc, "gone.tf", "# mine\n", "reset away");
      git(vpc, ["checkout", "-q", "v1.0.0"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "only the reflog holds it");
      git(vpc, ["reflog", "expire", "--expire=now", "--all"]);
      assert.deepEqual(codes(await checkOf(infra)), []);
    });

    await check("a filter from the user's own git config never runs in a module", async () => {
      const marker = path.join(scratch, "global-filter-ran");
      const attributes = path.join(scratch, "global-attributes");
      const plain = fs.readFileSync(gitConfig, "utf8");
      fs.writeFileSync(attributes, "/main.tf filter=spy\n");
      fs.writeFileSync(gitConfig, `${plain}[core]\n\tattributesFile = ${attributes}\n[filter "spy"]\n\tclean = \"sh -c 'touch ${marker}; cat'\"\n`);
      try {
        // A changed stat makes git read the file again, through its filter.
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(path.join(vpc, "main.tf"), later, later);
        await checkOf(infra);
        assert.equal(fs.existsSync(marker), false, "the filter ran");
      } finally {
        fs.writeFileSync(gitConfig, plain);
      }
    });

    await check("review 1: a module holding a submodule is a checkout, and git never runs in the submodule", async () => {
      // The submodule: commits only on this disk, and a filter in its own config.
      const subWork = path.join(scratch, "sub-work");
      execFileSync("git", ["init", "-q", "-b", "main", subWork]);
      commitFile(subWork, ".gitattributes", "* filter=x\n", "attributes");
      const subTip = commitFile(subWork, "a.txt", "only here\n", "only on this disk");
      const marker = path.join(scratch, "submodule-filter-ran");
      fs.appendFileSync(path.join(subWork, ".git", "config"), `[filter "x"]\n\tclean = "sh -c 'touch ${marker}; cat'"\n`);
      // The module records it as a gitlink, pushed to its origin.
      const netSource = path.join(scratch, "net.git");
      const netWork = path.join(scratch, "net-work");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", netSource]);
      execFileSync("git", ["clone", "-q", netSource, netWork]);
      commitFile(netWork, "main.tf", "# net\n", "net");
      git(netWork, ["update-index", "--add", "--cacheinfo", `160000,${subTip},sub`]);
      git(netWork, ["commit", "-q", "-m", "sub"]);
      git(netWork, ["push", "-q", "origin", "main"]);
      const modules = path.join(infra, "infra", ".terraform", "modules");
      const manifest = path.join(modules, "modules.json");
      const written = fs.readFileSync(manifest, "utf8");
      const net = path.join(modules, "net");
      execFileSync("git", ["clone", "-q", netSource, net]);
      fs.rmSync(path.join(net, "sub"), { recursive: true, force: true });
      fs.cpSync(subWork, path.join(net, "sub"), { recursive: true });
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(path.join(net, "sub", "a.txt"), later, later);
      const listed = JSON.parse(written);
      listed.Modules.push({ Key: "net", Source: "git::https://example.invalid/net.git", Dir: ".terraform/modules/net" });
      fs.writeFileSync(manifest, JSON.stringify(listed));
      try {
        assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a submodule's commits are no clone's");
        assert.equal(fs.existsSync(marker), false, "the submodule's filter ran");
      } finally {
        fs.rmSync(net, { recursive: true, force: true });
        fs.writeFileSync(manifest, written);
      }
      assert.deepEqual(codes(await checkOf(infra)), []);
      // A submodule's git folder kept inside the clone's own.
      fs.mkdirSync(path.join(vpc, ".git", "modules"));
      try {
        assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), ".git/modules");
      } finally {
        fs.rmSync(path.join(vpc, ".git", "modules"), { recursive: true });
      }
      assert.deepEqual(codes(await checkOf(infra)), []);
    });

    await check("a local tag, a hidden edit or a config of its own makes a module a checkout, and git never runs there", async () => {
      // A commit only a local tag holds.
      git(vpc, ["checkout", "-q", "--detach"]);
      commitFile(vpc, "tagged.tf", "# mine\n", "tagged locally");
      git(vpc, ["tag", "mine"]);
      git(vpc, ["checkout", "-q", "v1.0.0"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a local tag proves nothing");
      git(vpc, ["tag", "-d", "mine"]);
      git(vpc, ["reflog", "expire", "--expire=now", "--all"]);
      assert.deepEqual(codes(await checkOf(infra)), []);
      // An edit git status is told not to look at.
      git(vpc, ["update-index", "--assume-unchanged", "main.tf"]);
      fs.writeFileSync(path.join(vpc, "main.tf"), "hidden edit\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "assume-unchanged");
      git(vpc, ["update-index", "--no-assume-unchanged", "main.tf"]);
      git(vpc, ["checkout", "-q", "--", "main.tf"]);
      assert.deepEqual(codes(await checkOf(infra)), []);
      // A filter in its own config: refused before any git command runs there.
      const marker = path.join(scratch, "filter-ran");
      const config = path.join(vpc, ".git", "config");
      const plain = fs.readFileSync(config, "utf8");
      fs.writeFileSync(config, `${plain}[filter "x"]\n\tclean = touch ${marker}\n`);
      fs.mkdirSync(path.join(vpc, ".git", "info"), { recursive: true });
      fs.writeFileSync(path.join(vpc, ".git", "info", "attributes"), "* filter=x\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a config of its own");
      assert.equal(fs.existsSync(marker), false, "its filter never ran");
      fs.writeFileSync(config, plain);
      fs.rmSync(path.join(vpc, ".git", "info", "attributes"));
      assert.deepEqual(codes(await checkOf(infra)), []);
    });

    await check("an edit to a module after the check changes the removal's last fingerprint", async () => {
      const regenerable = agent.fingerprintRegenerable(infra, []);
      const before = await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable);
      assert.equal(await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable), before, "stable when nothing changes");
      fs.writeFileSync(path.join(vpc, "main.tf"), "edited during removal\n");
      assert.notEqual(await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable), before, "a module file");
      git(vpc, ["checkout", "-q", "--", "main.tf"]);
      const restored = await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable);
      commitFile(vpc, "late.tf", "# late\n", "late commit");
      assert.notEqual(await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable), restored, "a commit in it");
      git(vpc, ["checkout", "-q", "v1.0.0"]);
      git(vpc, ["reflog", "expire", "--expire=now", "--all"]);
      const settled = await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable);
      fs.mkdirSync(path.join(vpc, ".git", "info"), { recursive: true });
      fs.writeFileSync(path.join(vpc, ".git", "info", "attributes"), "* -text\n");
      assert.notEqual(await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable), settled, "anything in its .git");
      fs.rmSync(path.join(vpc, ".git", "info", "attributes"));
      const linkless = await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable);
      fs.symlinkSync("main.tf", path.join(vpc, "alias.tf"));
      assert.notEqual(await gitWorktrees.worktreeFingerprint(infra, undefined, regenerable), linkless, "a link made in it");
      fs.rmSync(path.join(vpc, "alias.tf"));
      assert.deepEqual(codes(await checkOf(infra)), []);
    });

    await check("a module with an edit, an untracked file or a commit of its own is a checkout", async () => {
      fs.writeFileSync(path.join(vpc, "main.tf"), "edited\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "an edit");
      git(vpc, ["checkout", "-q", "--", "main.tf"]);
      fs.writeFileSync(path.join(vpc, "notes.txt"), "mine\n");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "an untracked file");
      fs.rmSync(path.join(vpc, "notes.txt"));
      git(vpc, ["checkout", "-q", "-b", "local"]);
      commitFile(vpc, "extra.tf", "# mine\n", "local commit");
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a commit no remote branch or tag holds");
      git(vpc, ["checkout", "-q", "v1.0.0"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a local branch no remote branch holds");
      git(vpc, ["branch", "-q", "-D", "local"]);
      fs.writeFileSync(path.join(vpc, "stash.tf"), "x\n");
      git(vpc, ["add", "stash.tf"]);
      git(vpc, ["stash", "-q"]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a stash");
      git(vpc, ["stash", "drop", "-q"]);
      git(vpc, ["reflog", "expire", "--expire=now", "--all"]);
      assert.deepEqual(codes(await checkOf(infra)), [], "clean again");
    });

    await check("a checkout elsewhere in .terraform/, a .git file, or a folder without a lock file still blocks", async () => {
      const hand = path.join(infra, "infra", ".terraform", "hand");
      execFileSync("git", ["init", "-q", hand]);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "not a module folder");
      fs.rmSync(hand, { recursive: true, force: true });
      const pointer = path.join(infra, "infra", ".terraform", "modules", "sub");
      fs.mkdirSync(pointer);
      fs.writeFileSync(path.join(pointer, ".git"), `gitdir: ${path.join(repo, ".git")}\n`);
      assert.ok(codes(await checkOf(infra)).includes("NESTED_CHECKOUT"), "a .git file points elsewhere");
      fs.rmSync(pointer, { recursive: true, force: true });
      const docs = path.join(infra, "docs", ".terraform");
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, "state"), "x\n");
      assert.deepEqual((await checkOf(infra)).localWork.ignored, ["docs/.terraform/"], "no lock file beside it");
      fs.rmSync(docs, { recursive: true, force: true });
    });

    await check("a worktree registered inside a module folder still blocks", async () => {
      const inner = path.join(infra, "infra", ".terraform", "modules", "wt");
      git(repo, ["worktree", "add", "-q", "--detach", inner, "main"]);
      try {
        const ctxCheck = await checkOf(infra);
        assert.ok(codes(ctxCheck).includes("NESTED_CHECKOUT"), JSON.stringify(ctxCheck.blockers));
      } finally {
        git(repo, ["worktree", "remove", "--force", inner]);
      }
      assert.deepEqual(codes(await checkOf(infra)), []);
    });


    // ── Round 5 of #335 ────────────────────────────────────────────────────
    const asked = async () => (await checkOf(infra)).localWork?.ignored.includes("infra/.terraform/") === true;
    const tfdir = path.join(infra, "infra", ".terraform");

    await check("round 5: a terraform.tfstate with a backend and outputs, or a key init never writes, is asked about", async () => {
      const state = path.join(tfdir, "terraform.tfstate");
      const backend = { type: "s3", config: { bucket: "b" }, hash: 1 };
      const write = (value) => fs.writeFileSync(state, JSON.stringify(value));
      try {
        write({ version: 3, terraform_version: "1.9.0", backend });
        assert.equal(await asked(), false, "the record terraform 1.x writes");
        write({ version: 3, serial: 1, lineage: "x", backend, modules: [{ path: ["root"], outputs: {}, resources: {}, depends_on: [] }] });
        assert.equal(await asked(), false, "the record older terraform writes");
        write({ version: 3, backend, modules: [{ path: ["root"], outputs: { secret: { value: "mine" } }, resources: {} }] });
        assert.equal(await asked(), true, "outputs in a module");
        write({ version: 4, backend, outputs: { secret: { value: "mine" } } });
        assert.equal(await asked(), true, "outputs at the top");
        write({ version: 3, backend, check_results: [] });
        assert.equal(await asked(), true, "a key init never writes");
        write({ version: 3, backend: { ...backend, extra: true } });
        assert.equal(await asked(), true, "a backend key init never writes");
        write({ version: 3, backend: { config: {} } });
        assert.equal(await asked(), true, "a backend without a type");
        write([{ backend }]);
        assert.equal(await asked(), true, "not an object");
      } finally {
        fs.rmSync(state, { force: true });
      }
      assert.equal(await asked(), false);
    });

    await check("round 5: a modules.json with any record terraform never writes is asked about", async () => {
      const manifest = path.join(tfdir, "modules", "modules.json");
      const written = fs.readFileSync(manifest, "utf8");
      const vpc = { Key: "vpc", Source: "git::https://example.invalid/vpc.git?ref=v1.0.0", Dir: ".terraform/modules/vpc" };
      try {
        for (const [label, record] of [
          ["no Source", { Key: "x", Dir: ".terraform/modules/x" }],
          ["a Key that is no string", { Key: 1, Source: "s", Dir: "d" }],
          ["no Dir", { Key: "y", Source: "s" }],
          ["not an object", "vpc"],
          ["a Version that is no string", { Key: "z", Source: "s", Dir: "d", Version: 2 }],
        ]) {
          fs.writeFileSync(manifest, JSON.stringify({ Modules: [vpc, record] }));
          assert.equal(await asked(), true, label);
        }
        fs.writeFileSync(manifest, JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }, { ...vpc, Version: "1.0.0" }] }));
        assert.equal(await asked(), false, "records as terraform writes them");
      } finally {
        fs.writeFileSync(manifest, written);
      }
      assert.equal(await asked(), false);
    });

    await check("environment and plugin_path only as terraform writes them", async () => {
      const environment = path.join(tfdir, "environment");
      const pluginPath = path.join(tfdir, "plugin_path");
      try {
        fs.writeFileSync(environment, "staging");
        fs.writeFileSync(pluginPath, JSON.stringify(["/opt/plugins"]));
        assert.equal(await asked(), false);
        fs.writeFileSync(environment, "my notes\nabout this\n");
        assert.equal(await asked(), true, "an environment that is no workspace name");
        fs.writeFileSync(environment, "staging");
        fs.writeFileSync(pluginPath, "notes\n");
        assert.equal(await asked(), true, "a plugin_path that is no list of folders");
      } finally {
        fs.rmSync(environment, { force: true });
        fs.rmSync(pluginPath, { force: true });
      }
      assert.equal(await asked(), false);
    });
  } finally {
    for (const file of outputs) fs.rmSync(file, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
