#!/usr/bin/env node
"use strict";

// Capability Center skill origins and updates (src/main/skill-origin-store.ts,
// skill-updates.ts, claude-plugin-skills.ts, the import's record in
// skill-import.ts) against a fake HOME and a local repository. The real git
// runs: an https address is rewritten to the fixture with url.insteadOf in
// GIT_CONFIG_*, so the tests touch no network and no real CLI folder.
//
//   node scripts/test-skill-updates.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-skill-updates-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
const SKILLS = path.join(CODARA, "skills");
const STATE = path.join(CODARA, "skill-origins");
const STAGING = path.join(CODARA, "tmp");
const REMOTE_ROOT = path.join(TMP, "remote");
const REPO = path.join(REMOTE_ROOT, "team", "skills");
const URL_BASE = "https://skills.example.test/";

fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CODARA_HOME_DIR = CODARA;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;
// Every git child inherits these: the fixture stands in for the https host,
// and nothing from the machine's own git config takes part.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(TMP, "gitconfig");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
process.env.GIT_CONFIG_COUNT = "3";
process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(REMOTE_ROOT).href}/.insteadOf`;
process.env.GIT_CONFIG_VALUE_0 = URL_BASE;
process.env.GIT_CONFIG_KEY_1 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_1 = "always";
process.env.GIT_CONFIG_KEY_2 = "uploadpack.allowFilter";
process.env.GIT_CONFIG_VALUE_2 = "true";

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  const main = (name) => path.join(ROOT, "src", "main", name);
  fs.writeFileSync(
    entry,
    [
      `export * as store from ${JSON.stringify(main("skill-origin-store.ts"))};`,
      `export * as updates from ${JSON.stringify(main("skill-updates.ts"))};`,
      `export * as importer from ${JSON.stringify(main("skill-import.ts"))};`,
      `export * as plugins from ${JSON.stringify(main("claude-plugin-skills.ts"))};`,
      `export * as guard from ${JSON.stringify(main("outside-write-guard.ts"))};`,
    ].join("\n"),
  );
  const out = path.join(TMP, "harness.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    external: ["electron"],
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  return require(out);
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

const skillMd = (name, body) => `---\nname: ${name}\ndescription: Use when writing ${name}.\n---\n\n# ${name}\n\n${body}\n`;

function writeRepoFile(rel, content) {
  const file = path.join(REPO, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(message) {
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", message);
  return git(REPO, "rev-parse", "HEAD");
}

function listTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full).split(path.sep).join("/") + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const H = await buildHarness();
  const { store, updates, importer, plugins, guard } = H;
  const real = importer.makeGitRunner();
  const calls = [];
  const runGit = (args, options) => {
    calls.push(args.filter((arg) => !arg.startsWith("protocol.") && !arg.startsWith("core.") && arg !== "-c"));
    return real(args, options);
  };
  const options = (extra = {}) => ({ stateDir: STATE, stagingDir: STAGING, runGit, ...extra });
  const sawClone = (filter) =>
    calls.some((args) => args.includes("clone") && (filter === undefined || args.includes(filter)));

  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  writeRepoFile("skills/release-notes/SKILL.md", skillMd("release-notes", "Version one."));
  writeRepoFile("skills/release-notes/reference.md", "v1 reference\n");
  writeRepoFile("skills/other/SKILL.md", skillMd("other", "Another skill."));
  const firstCommit = commit("one");
  const skillDir = path.join(SKILLS, "release-notes");

  await check("a git import records its origin in Codara's folder, never inside the skill", async () => {
    const result = await importer.importCodaraSkill(
      { kind: "git", url: `${URL_BASE}team/skills/tree/main/skills/release-notes` },
      { skillsDir: SKILLS, stagingDir: STAGING, originsDir: STATE, runGit },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.path, skillDir);
    assert.deepEqual(listTree(skillDir), ["reference.md", "SKILL.md"].sort((a, b) => a.localeCompare(b)));
    const receipt = await store.readSkillOrigin(STATE, skillDir);
    assert.ok(receipt, "a record was written");
    assert.equal(receipt.name, "release-notes");
    assert.equal(receipt.origin.kind, "git");
    assert.equal(receipt.origin.url, `${URL_BASE}team/skills`);
    assert.equal(receipt.origin.ref, "main");
    assert.equal(receipt.origin.commit, firstCommit);
    assert.equal(receipt.origin.subpath, "skills/release-notes");
    assert.equal(receipt.origin.tree, git(REPO, "rev-parse", "HEAD:skills/release-notes"));
    assert.ok(!Number.isNaN(Date.parse(receipt.origin.installedAt)));
    // Keyed by the folder, stored under the state dir only.
    assert.equal(fs.existsSync(store.skillOriginReceiptPath(STATE, skillDir)), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(store.skillOriginReceiptPath(STATE, skillDir)).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(STAGING), [], "the clone is cleaned up");
  });

  await check("an import of the default branch records the branch it resolved to", async () => {
    const result = await importer.importCodaraSkill(
      { kind: "git", url: `${URL_BASE}team/skills`, subdir: "skills/other" },
      { skillsDir: SKILLS, stagingDir: STAGING, originsDir: STATE, runGit },
    );
    assert.equal(result.ok, true, result.error);
    const receipt = await store.readSkillOrigin(STATE, result.path);
    assert.equal(receipt.origin.ref, undefined);
    assert.equal(receipt.origin.branch, "main");
    assert.equal(receipt.origin.subpath, "skills/other");
    const statuses = await updates.listSkillOrigins(options());
    assert.deepEqual(statuses.map((status) => status.name).sort(), ["other", "release-notes"]);
    assert.ok(statuses.every((status) => status.state === "unchecked"));
  });

  await check("a folder import records where it came from; writing a skill clears a stale record", async () => {
    const source = path.join(TMP, "local-skill");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), skillMd("local-skill", "Local."));
    const imported = await importer.importCodaraSkill({ kind: "folder", path: source }, { skillsDir: SKILLS, originsDir: STATE });
    assert.equal(imported.ok, true, imported.error);
    const receipt = await store.readSkillOrigin(STATE, imported.path);
    assert.equal(receipt.origin.kind, "folder");
    assert.equal(receipt.origin.sourcePath, source);
    // Removed by hand, then written again under the same name.
    fs.rmSync(imported.path, { recursive: true });
    const created = await importer.createCodaraSkill(
      { name: "local-skill", description: "Written by hand.", instructions: "# Hand" },
      { skillsDir: SKILLS, originsDir: STATE },
    );
    assert.equal(created.ok, true, created.error);
    assert.equal(await store.readSkillOrigin(STATE, created.path), null);
  });

  await check("a check asks only ls-remote while the remote has not moved, and caches the answer", async () => {
    calls.length = 0;
    const statuses = await updates.checkSkillUpdates(options());
    const release = statuses.find((status) => status.name === "release-notes");
    assert.equal(release.state, "current");
    assert.equal(release.remoteCommit, firstCommit);
    assert.ok(calls.some((args) => args.includes("ls-remote")));
    assert.equal(sawClone(), false, "nothing is cloned when the commit did not move");
    calls.length = 0;
    const again = await updates.checkSkillUpdates(options());
    assert.equal(calls.length, 0, "a fresh answer is reused without asking git");
    assert.equal(again.find((status) => status.name === "release-notes").state, "current");
  });

  await check("a commit that leaves the skill's folder alone does not flag it", async () => {
    writeRepoFile("skills/other/SKILL.md", skillMd("other", "Another skill, edited."));
    const moved = commit("other only");
    calls.length = 0;
    const statuses = await updates.checkSkillUpdates(options({ force: true }));
    const release = statuses.find((status) => status.name === "release-notes");
    const other = statuses.find((status) => status.name === "other");
    assert.equal(release.state, "current", release.error);
    assert.equal(release.remoteCommit, moved);
    assert.equal(other.state, "update-available");
    assert.ok(sawClone("--filter=blob:none"), "the trees come from a clone without file contents");
    assert.ok(calls.find((args) => args.includes("clone")).includes("--no-checkout"));
  });

  let secondCommit;
  await check("a change to the skill's folder shows an update; a repeat check reuses it without a clone", async () => {
    writeRepoFile("skills/release-notes/SKILL.md", skillMd("renamed-upstream", "Version two."));
    writeRepoFile("skills/release-notes/reference.md", "v2 reference\n");
    writeRepoFile("skills/release-notes/scripts/run.sh", "echo v2\n");
    secondCommit = commit("two");
    const statuses = await updates.checkSkillUpdates(options({ force: true }));
    const release = statuses.find((status) => status.name === "release-notes");
    assert.equal(release.state, "update-available");
    assert.equal(release.remoteCommit, secondCommit);
    calls.length = 0;
    const again = await updates.checkSkillUpdates(options({ ttlMs: 0 }));
    assert.equal(again.find((status) => status.name === "release-notes").state, "update-available");
    assert.equal(sawClone(), false, "the same remote commit is not probed twice");
  });

  await check("update replaces the skill, keeps its name, and keeps the old version for rollback", async () => {
    const before = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const result = await updates.updateSkills({ dirs: [skillDir] }, options());
    assert.equal(result.ok, true, result.errors.join(" "));
    assert.deepEqual(result.updated, [skillDir]);
    const document = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    assert.match(document, /Version two\./);
    assert.match(document, /^---\nname: release-notes\n/, "the folder keeps the name agents know it by");
    assert.equal(fs.readFileSync(path.join(skillDir, "reference.md"), "utf8"), "v2 reference\n");
    assert.equal(fs.existsSync(path.join(skillDir, "scripts", "run.sh")), true);
    const backup = path.join(store.skillOriginBackupDir(STATE, skillDir), "skill");
    assert.equal(fs.readFileSync(path.join(backup, "SKILL.md"), "utf8"), before);
    const status = result.origins.find((entry) => entry.skillDir === skillDir);
    assert.equal(status.state, "current");
    assert.equal(status.origin.commit, secondCommit);
    assert.equal(status.rollback.commit, firstCommit);
    assert.deepEqual(fs.readdirSync(STAGING), [], "staging is cleaned up");
  });

  await check("rollback restores the replaced version in one step and the update is offered again", async () => {
    const result = await updates.rollbackSkills({ dirs: [skillDir] }, options());
    assert.equal(result.ok, true, result.errors.join(" "));
    assert.match(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"), /Version one\./);
    assert.equal(fs.readFileSync(path.join(skillDir, "reference.md"), "utf8"), "v1 reference\n");
    assert.equal(fs.existsSync(path.join(skillDir, "scripts")), false);
    assert.equal(fs.existsSync(store.skillOriginBackupDir(STATE, skillDir)), false);
    const status = result.origins.find((entry) => entry.skillDir === skillDir);
    assert.equal(status.origin.commit, firstCommit);
    assert.equal(status.state, "update-available");
    assert.equal(status.rollback, undefined);
    const twice = await updates.rollbackSkills({ dirs: [skillDir] }, options());
    assert.equal(twice.ok, false);
    assert.match(twice.errors[0], /no earlier version/);
  });

  await check("an update only touches folders Codara holds a git record for", async () => {
    const forged = path.join(TMP, "not-a-skill");
    fs.mkdirSync(forged);
    fs.writeFileSync(path.join(forged, "SKILL.md"), skillMd("forged", "Mine."));
    const result = await updates.updateSkills({ dirs: [forged] }, options());
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /no git source/);
    assert.match(fs.readFileSync(path.join(forged, "SKILL.md"), "utf8"), /Mine\./);
    // A record edited by hand to point anywhere but https is refused.
    const tampered = path.join(SKILLS, "other");
    const receipt = await store.readSkillOrigin(STATE, tampered);
    fs.writeFileSync(
      store.skillOriginReceiptPath(STATE, tampered),
      JSON.stringify({ ...receipt, origin: { ...receipt.origin, url: "file:///etc" } }),
    );
    assert.equal(await store.readSkillOrigin(STATE, tampered), null);
    const refused = await updates.updateSkills({ dirs: [tampered] }, options());
    assert.equal(refused.ok, false);
    await store.writeSkillOrigin(STATE, receipt);
  });

  await check("a copy in a CLI's skill folder keeps its origin and is written only with the capability", async () => {
    const cliCopy = path.join(HOME, ".claude", "skills", "release-notes");
    fs.cpSync(skillDir, cliCopy, { recursive: true });
    assert.equal(await updates.copySkillOrigin({ from: skillDir, to: cliCopy }, options()), true);
    const copied = await store.readSkillOrigin(STATE, cliCopy);
    assert.equal(copied.origin.commit, firstCommit);
    assert.equal(copied.origin.url, `${URL_BASE}team/skills`);
    const refused = await updates.updateSkills({ dirs: [cliCopy] }, options());
    assert.equal(refused.ok, false);
    assert.match(refused.errors[0], /does not write inside another tool's home/);
    assert.match(fs.readFileSync(path.join(cliCopy, "SKILL.md"), "utf8"), /Version one\./, "nothing changed without it");
    const capability = guard.outsideWriteCapability("test: the user clicked Update");
    const allowed = await updates.updateSkills({ dirs: [cliCopy, skillDir] }, options({ outsideWrite: capability }));
    assert.equal(allowed.ok, true, allowed.errors.join(" "));
    assert.deepEqual(allowed.updated.sort(), [cliCopy, skillDir].sort());
    assert.equal(calls.filter((args) => args.includes("clone")).length >= 1, true);
    assert.match(fs.readFileSync(path.join(cliCopy, "SKILL.md"), "utf8"), /Version two\./);
    // Rolling back the CLI copy needs the capability too.
    const noRollback = await updates.rollbackSkills({ dirs: [cliCopy] }, options());
    assert.equal(noRollback.ok, false);
    assert.match(fs.readFileSync(path.join(cliCopy, "SKILL.md"), "utf8"), /Version two\./);
    const rolledBack = await updates.rollbackSkills({ dirs: [cliCopy] }, options({ outsideWrite: capability }));
    assert.equal(rolledBack.ok, true, rolledBack.errors.join(" "));
    assert.match(fs.readFileSync(path.join(cliCopy, "SKILL.md"), "utf8"), /Version one\./);
  });

  await check("an update whose files already match only records the new commit", async () => {
    writeRepoFile("README.md", "readme\n");
    const third = commit("readme");
    calls.length = 0;
    const result = await updates.updateSkills({ dirs: [path.join(SKILLS, "release-notes")] }, options());
    assert.equal(result.ok, true, result.errors.join(" "));
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.unchanged, [skillDir]);
    const status = result.origins.find((entry) => entry.skillDir === skillDir);
    assert.equal(status.origin.commit, third);
    assert.equal(status.state, "current");
  });

  await check("a gone branch or an unreachable repository is reported on the row, not thrown", async () => {
    const pinned = path.join(SKILLS, "release-notes");
    const receipt = await store.readSkillOrigin(STATE, pinned);
    await store.writeSkillOrigin(STATE, { ...receipt, origin: { ...receipt.origin, ref: "gone-branch" } });
    let statuses = await updates.checkSkillUpdates(options({ force: true }));
    let status = statuses.find((entry) => entry.skillDir === pinned);
    assert.equal(status.state, "error");
    assert.match(status.error, /no branch or tag named gone-branch/);
    await store.writeSkillOrigin(STATE, { ...receipt, origin: { ...receipt.origin, url: `${URL_BASE}team/missing` } });
    statuses = await updates.checkSkillUpdates(options({ force: true }));
    status = statuses.find((entry) => entry.skillDir === pinned);
    assert.equal(status.state, "error");
    assert.match(status.error, /Could not reach https:\/\/skills\.example\.test\/team\/missing/);
    await store.writeSkillOrigin(STATE, receipt);
  });

  await check("concurrent checks share one run", async () => {
    calls.length = 0;
    const [a, b] = await Promise.all([
      updates.checkSkillUpdates(options({ force: true })),
      updates.checkSkillUpdates(options({ force: true })),
    ]);
    assert.deepEqual(a, b);
    const lsRemotes = calls.filter((args) => args.includes("ls-remote")).length;
    assert.ok(lsRemotes >= 1 && lsRemotes <= 2, `one ls-remote per repository and ref, saw ${lsRemotes}`);
    // A forced check asked for while a cached one runs still asks the remote.
    calls.length = 0;
    await Promise.all([updates.checkSkillUpdates(options()), updates.checkSkillUpdates(options({ force: true }))]);
    assert.ok(calls.some((args) => args.includes("ls-remote")), "the forced check ran after the cached one");
  });

  await check("removing a skill forgets its record and kept version", async () => {
    await updates.updateSkills({ dirs: [skillDir] }, options());
    const backupRoot = store.skillOriginBackupDir(STATE, skillDir);
    assert.equal(await updates.forgetSkillOrigins({ dirs: [skillDir] }, options()), 1);
    assert.equal(await store.readSkillOrigin(STATE, skillDir), null);
    assert.equal(fs.existsSync(backupRoot), false);
    // A record whose folder is gone is not listed.
    fs.rmSync(path.join(SKILLS, "other"), { recursive: true });
    const listed = await updates.listSkillOrigins(options());
    assert.equal(listed.some((status) => status.name === "other"), false);
  });

  await check("ls-remote output resolves branches, peeled annotated tags, lightweight tags and HEAD", async () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);
    const output = `${a}\trefs/tags/v1\n${b}\trefs/tags/v1^{}\n${c}\trefs/heads/main\n${a}\tHEAD\n`;
    assert.equal(updates.pickRemoteCommit(output, "v1"), b);
    assert.equal(updates.pickRemoteCommit(output, "main"), c);
    assert.equal(updates.pickRemoteCommit(output, undefined), a);
    assert.equal(updates.pickRemoteCommit(`${a}\trefs/tags/light\n`, "light"), a);
    assert.equal(updates.pickRemoteCommit("", "main"), null);
  });

  await check("moving a folder copies across volumes and retries a busy rename on Windows", async () => {
    const from = path.join(TMP, "move-from");
    fs.mkdirSync(path.join(from, "inner"), { recursive: true });
    fs.writeFileSync(path.join(from, "inner", "f.txt"), "x");
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    await updates.moveDir(from, path.join(TMP, "move-to"), { rename: async () => { throw exdev; } });
    assert.equal(fs.readFileSync(path.join(TMP, "move-to", "inner", "f.txt"), "utf8"), "x");
    assert.equal(fs.existsSync(from), false);
    let attempts = 0;
    const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
    await updates.moveDir(path.join(TMP, "move-to"), path.join(TMP, "move-back"), {
      platform: "win32",
      rename: async (a, b) => {
        attempts += 1;
        if (attempts < 3) throw busy;
        fs.renameSync(a, b);
      },
    });
    assert.equal(attempts, 3);
    assert.equal(fs.existsSync(path.join(TMP, "move-back", "inner", "f.txt")), true);
    await assert.rejects(
      updates.moveDir(path.join(TMP, "move-back"), path.join(TMP, "never"), { platform: "linux", rename: async () => { throw busy; } }),
      /busy/,
    );
  });

  await check("record keys fold case on macOS and Windows only", async () => {
    assert.equal(store.skillOriginKey("/Skills/A", "darwin"), store.skillOriginKey("/skills/a", "darwin"));
    assert.equal(store.skillOriginKey("/Skills/A", "win32"), store.skillOriginKey("/skills/a", "win32"));
    assert.notEqual(store.skillOriginKey("/Skills/A", "linux"), store.skillOriginKey("/skills/a", "linux"));
    assert.equal(store.parseSkillOriginReceipt("{"), null);
    assert.equal(store.parseSkillOriginReceipt(JSON.stringify({ schemaVersion: 2 })), null);
  });

  // ── Claude Code plugin skills ─────────────────────────────────────────────
  const claudeDir = path.join(HOME, ".claude");
  const cache = path.join(claudeDir, "plugins", "cache");
  const project = path.join(TMP, "project");
  fs.mkdirSync(project, { recursive: true });
  const writePlugin = (dir, skills, manifest) => {
    for (const [rel, name] of skills) {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
      fs.writeFileSync(path.join(dir, rel, "SKILL.md"), skillMd(name, "Plugin."));
    }
    if (manifest) {
      fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
    }
  };
  writePlugin(path.join(cache, "review", "1.0.0"), [["skills/old-review", "old-review"]]);
  writePlugin(path.join(cache, "review", "2.0.0"), [["skills/code-review", "code-review"], ["extra/lint-rules", "lint-rules"]], {
    name: "review",
    skills: ["./extra", "./../../escape"],
  });
  writePlugin(path.join(cache, "docs", "0.1.0"), [["skills/doc-writer", "doc-writer"]]);
  writePlugin(path.join(cache, "off", "1.0.0"), [["skills/never", "never"]]);
  writePlugin(path.join(TMP, "escape"), [["", "escaped"]]);
  fs.mkdirSync(path.join(claudeDir, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "review@team-market": [
          { scope: "user", installPath: path.join(cache, "review", "1.0.0"), version: "1.0.0" },
          { scope: "project", projectPath: project, installPath: path.join(cache, "review", "2.0.0"), version: "2.0.0" },
        ],
        "docs@official": [{ scope: "user", installPath: path.join(cache, "docs", "0.1.0"), version: "0.1.0" }],
        "off@official": [{ scope: "user", installPath: path.join(cache, "off", "1.0.0") }],
        "relative@x": [{ scope: "user", installPath: "relative/path" }],
      },
    }),
  );
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "review@team-market": true, "docs@official": true, "off@official": true, "relative@x": true } }),
  );
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "off@official": false } }));

  await check("plugin skills come from the enabled plugins' applicable installs, inside the plugin only", async () => {
    const inProject = await plugins.listClaudePluginSkills({ claudeDir, cwd: project });
    assert.deepEqual(
      inProject.skills.map((skill) => `${skill.pluginId}:${skill.name}:${skill.scope}`),
      ["docs@official:doc-writer:user", "review@team-market:code-review:project", "review@team-market:lint-rules:project"],
    );
    const review = inProject.skills.find((skill) => skill.name === "code-review");
    assert.equal(review.plugin, "review");
    assert.equal(review.marketplace, "team-market");
    assert.equal(review.version, "2.0.0");
    assert.match(review.description, /Use when writing code-review/);
    const elsewhere = await plugins.listClaudePluginSkills({ claudeDir, cwd: null });
    assert.deepEqual(
      elsewhere.skills.map((skill) => skill.name),
      ["doc-writer", "never", "old-review"],
      "outside the project the user install applies and the project's off switch does not",
    );
    assert.equal(elsewhere.skills.some((skill) => skill.name === "escaped"), false);
  });

  await check("version 1 records and missing files read as plugins or nothing, never a throw", async () => {
    const v1 = plugins.resolveEnabledPluginInstalls(
      {
        installedPlugins: JSON.stringify({ version: 1, plugins: { "a@m": { installPath: path.join(cache, "docs", "0.1.0"), version: "9" } } }),
        settings: [JSON.stringify({ enabledPlugins: { "a@m": true } })],
      },
      null,
    );
    assert.equal(v1.length, 1);
    assert.equal(v1[0].install.scope, "user");
    assert.deepEqual(plugins.resolveEnabledPluginInstalls({ installedPlugins: "{oops", settings: [] }, null), []);
    assert.deepEqual(await plugins.listClaudePluginSkills({ claudeDir: path.join(TMP, "nothing"), cwd: null }), { skills: [] });
  });

  console.log(`PASS skill updates (${passed} checks)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
