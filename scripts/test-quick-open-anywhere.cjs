#!/usr/bin/env node
"use strict";

// Quick Open's "Elsewhere on this computer" (src/main/quick-open-anywhere.ts):
//   1. Queries: too short is no search, a leading dot lets hidden files in,
//      the name part fd matches is the last path segment.
//   2. The skip rules: dependency trees, caches, the trash, browser profiles,
//      Codara's own data, SSH/GPG keys, hidden paths unless asked for.
//   3. fd and the fallback walk find the same files, follow no links, leave
//      the active workspace out, and cap the results at the limit.
//   4. A new search from a window cancels the previous one, and a cancelled
//      or disabled search returns nothing.
//   5. The pick grants the read sandbox exactly the one file the window's
//      last search returned: not another path, not a link swapped in since,
//      not its folder, and nothing when the setting is off.
//
//   node scripts/test-quick-open-anywhere.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-quick-open-anywhere-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

async function bundle(entry, name, stubs = {}) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => (stubs[args.path] ? { path: args.path, namespace: "stub" } : undefined));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
        },
      },
    ],
  });
  return require(outfile);
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function write(file, text = "hello\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function main() {
  const qo = await bundle("src/main/quick-open-anywhere.ts", "quick-open-anywhere");

  await check("queries: too short, hidden on a leading dot, name part", () => {
    assert.equal(qo.planHomeQuery("a"), null);
    assert.equal(qo.planHomeQuery("   "), null);
    assert.equal(qo.planHomeQuery(42), null);
    assert.equal(qo.planHomeQuery("x\0y"), null);
    assert.deepEqual(qo.planHomeQuery("Notes"), { tokens: ["notes"], namePart: "notes", hidden: false });
    assert.equal(qo.planHomeQuery(".env").hidden, true);
    assert.equal(qo.planHomeQuery("env").hidden, false);
    assert.deepEqual(qo.planHomeQuery("studio Read").tokens, ["studio", "read"]);
    assert.equal(qo.planHomeQuery("studio Read").namePart, "read");
    assert.equal(qo.planHomeQuery("Studio/README").namePart, "readme");
    assert.equal(qo.planHomeQuery("docs\\plan.md").namePart, "plan.md");
  });

  await check("skip rules: dependency trees, caches, profiles, keys, Codara data, hidden", () => {
    const skipped = (rel, hidden = false) => qo.isSkippedHomePath(rel, { hidden });
    for (const rel of [
      "code/app/node_modules/x/readme.md",
      "code/app/.git/HEAD",
      "code/py/__pycache__/m.pyc",
      ".cache/thing/notes.md",
      ".npm/_logs/x.log",
      ".cargo/registry/src/a.rs",
      ".local/share/Trash/files/old.md",
      ".mozilla/firefox/abc.default/prefs.js",
      ".config/google-chrome/Default/Preferences",
      ".config/BraveSoftware/Brave-Browser/Default/x",
      ".codarastudio/remote/identity.json",
      ".codarastudio/worktrees/repo/feat/README.md",
      ".ssh/id_ed25519",
      ".gnupg/private-keys-v1.d/k.key",
      "snap/firefox/common/x",
    ]) {
      assert.equal(skipped(rel, true), true, `${rel} stays out even with hidden files on`);
    }
    assert.equal(skipped("Documents/notes.md"), false);
    assert.equal(skipped("Documents/.env"), true, "hidden file without a leading dot in the query");
    assert.equal(skipped("Documents/.env", true), false);
    assert.equal(skipped(".config/app/settings.json"), true);
    assert.equal(skipped(".config/app/settings.json", true), false);
    assert.equal(skipped(".cargo/config.toml", true), false, "only the registry is a cache");
    assert.equal(skipped(".cachefile", true), false, "a prefix matches whole segments");
    assert.equal(skipped("../etc/passwd", true), true);
    assert.equal(skipped("/etc/passwd", true), true);
    assert.equal(skipped("", true), true);
    assert.equal(qo.isSkippedHomePath("data/codara/runs/x.md", { hidden: true, extraPrefixes: ["data/codara"] }), true);
  });

  // A fake home with the cases both engines must agree on.
  const HOME = path.join(TMP, "home");
  write(path.join(HOME, "Documents", "plan-notes.md"));
  write(path.join(HOME, "Documents", "deep", "a", "b", "notes.md"));
  write(path.join(HOME, "notes.txt"));
  write(path.join(HOME, "Projects", "app", "notes-app.md"));
  write(path.join(HOME, "Projects", "app", ".env"), "TOKEN=do-not-print\n");
  write(path.join(HOME, "Projects", "app", "node_modules", "pkg", "notes.md"));
  write(path.join(HOME, "Projects", "app", ".git", "notes"));
  write(path.join(HOME, ".cache", "notes.md"));
  write(path.join(HOME, ".config", "tool", "notes.ini"));
  write(path.join(HOME, ".ssh", "notes"));
  write(path.join(HOME, ".codarastudio", "memory", "notes.md"));
  write(path.join(HOME, "Workspace", "notes-in-workspace.md"));
  const OUTSIDE = path.join(TMP, "outside");
  write(path.join(OUTSIDE, "secret-notes.md"), "outside\n");
  fs.symlinkSync(OUTSIDE, path.join(HOME, "linked-folder"));
  fs.symlinkSync(path.join(OUTSIDE, "secret-notes.md"), path.join(HOME, "linked-notes.md"));

  const fdPath = qo.findFdBinary(process.env, os.homedir());
  const engines = [["walk", null], ...(fdPath ? [["fd", fdPath]] : [])];
  if (!fdPath) console.log("note: fd is not installed; only the fallback walk is checked");

  for (const [engine, bin] of engines) {
    await check(`${engine}: finds by name, skips what it must, follows no links`, async () => {
      const result = await qo.searchHomeFiles("notes", { home: HOME, fdPath: bin });
      const rels = result.hits.map((hit) => hit.rel).sort();
      assert.deepEqual(rels, [
        "Documents/deep/a/b/notes.md",
        "Documents/plan-notes.md",
        "Projects/app/notes-app.md",
        "Workspace/notes-in-workspace.md",
        "notes.txt",
      ]);
      assert.equal(result.truncated, false);
      const top = result.hits[0];
      assert.equal(top.rel, "notes.txt", "an exact name near the top of the home ranks first");
      assert.equal(top.path, path.join(HOME, "notes.txt"));
      assert.equal(top.name, "notes.txt");
    });

    await check(`${engine}: a leading dot lets hidden files in, never the skipped ones`, async () => {
      const result = await qo.searchHomeFiles(".env", { home: HOME, fdPath: bin });
      assert.deepEqual(result.hits.map((hit) => hit.rel), ["Projects/app/.env"]);
      assert.ok(!JSON.stringify(result).includes("do-not-print"), "a search never returns file content");
      const hidden = await qo.searchHomeFiles(".notes", { home: HOME, fdPath: bin });
      assert.deepEqual(hidden.hits, [], "'.notes' names no file");
      const config = await qo.searchHomeFiles(".config notes", { home: HOME, fdPath: bin });
      assert.deepEqual(config.hits.map((hit) => hit.rel), [".config/tool/notes.ini"]);
    });

    await check(`${engine}: path tokens narrow, and the workspace is left out`, async () => {
      const narrowed = await qo.searchHomeFiles("deep notes", { home: HOME, fdPath: bin });
      assert.deepEqual(narrowed.hits.map((hit) => hit.rel), ["Documents/deep/a/b/notes.md"]);
      const slashed = await qo.searchHomeFiles("app/notes", { home: HOME, fdPath: bin });
      assert.deepEqual(slashed.hits.map((hit) => hit.rel), ["Projects/app/notes-app.md"]);
      const withoutWorkspace = await qo.searchHomeFiles("notes", { home: HOME, fdPath: bin, excludeRoot: path.join(HOME, "Workspace") });
      assert.ok(!withoutWorkspace.hits.some((hit) => hit.rel.startsWith("Workspace/")));
      assert.equal(withoutWorkspace.hits.length, 4);
      const homeIsWorkspace = await qo.searchHomeFiles("notes", { home: HOME, fdPath: bin, excludeRoot: HOME });
      assert.deepEqual(homeIsWorkspace.hits, [], "a workspace at the home already lists every file");
    });
  }

  await check("the cap: at most `limit` hits, and the candidate cap stops the walk", async () => {
    const many = path.join(TMP, "many");
    for (let i = 0; i < 120; i += 1) write(path.join(many, `dir${i % 7}`, `report-${String(i).padStart(3, "0")}.md`));
    write(path.join(many, "report.md"));
    for (const [engine, bin] of engines) {
      const capped = await qo.searchHomeFiles("report", { home: many, fdPath: bin });
      assert.equal(capped.hits.length, qo.HOME_SEARCH_LIMIT, `${engine}: the default cap`);
      assert.equal(capped.hits[0].rel, "report.md", `${engine}: the best match survives the cap`);
      const small = await qo.searchHomeFiles("report", { home: many, fdPath: bin, limit: 5 });
      assert.equal(small.hits.length, 5);
      const stopped = await qo.searchHomeFiles("report", { home: many, fdPath: bin, maxCandidates: 10 });
      assert.equal(stopped.truncated, true, `${engine}: hitting the candidate cap says so`);
      assert.equal(stopped.hits.length, 10);
    }
    const ranked = qo.rankHomeHits(["x/y/z/plan.md", "plan.md", "a/my-plan.md", "planner.txt"], qo.planHomeQuery("plan"), "/h", 3);
    assert.deepEqual(ranked.map((hit) => hit.rel), ["plan.md", "x/y/z/plan.md", "planner.txt"], "an exact name beats a prefix; depth breaks ties");
  });

  await check("cancel: an aborted search returns nothing; a timeout stops it", async () => {
    for (const [engine, bin] of engines) {
      const controller = new AbortController();
      controller.abort();
      const result = await qo.searchHomeFiles("notes", { home: HOME, fdPath: bin, signal: controller.signal });
      assert.deepEqual(result, { hits: [], truncated: false, cancelled: true }, engine);
    }
    const timedOut = await qo.searchHomeFiles("notes", { home: HOME, fdPath: null, timeoutMs: 0 });
    assert.equal(timedOut.cancelled, undefined, "a timeout is not a cancel");
    assert.equal(await qo.searchHomeFiles("x", { home: HOME, fdPath: null }).then((r) => r.hits.length), 0);
    assert.deepEqual(await qo.searchHomeFiles("notes", { home: "relative/home", fdPath: null }), { hits: [], truncated: false });
  });

  // The service, with a search that waits for its test to release it.
  const grants = [];
  let enabled = true;
  const gates = [];
  const fakeSearch = (query, opts) =>
    new Promise((resolve) => {
      gates.push({
        query,
        opts,
        release: () => resolve(opts.signal.aborted ? { hits: [], truncated: false, cancelled: true } : qo.searchHomeFiles(query, { ...opts, fdPath: null })),
      });
    });
  const service = qo.createHomeSearchService({ home: () => HOME, enabled: () => enabled, grantReadFile: (p) => grants.push(p), search: fakeSearch });

  await check("service: a new query from a window cancels its previous one, not another window's", async () => {
    const first = service.search(1, "plan", null);
    const other = service.search(2, "plan", null);
    const second = service.search(1, "notes", "/somewhere");
    assert.equal(gates.length, 3);
    assert.equal(gates[0].opts.signal.aborted, true, "the first search of window 1 is cancelled");
    assert.equal(gates[1].opts.signal.aborted, false, "window 2 keeps its search");
    assert.equal(gates[2].opts.excludeRoot, "/somewhere");
    gates.forEach((gate) => gate.release());
    assert.equal((await first).cancelled, true);
    assert.equal((await other).hits.length, 1);
    assert.equal((await second).hits.length, 5);
    gates.length = 0;
    const cancelled = service.search(1, "deep", null);
    service.cancel(1);
    gates[0].release();
    assert.equal((await cancelled).cancelled, true, "an explicit cancel (the panel closed) ends it");
    gates.length = 0;
  });

  await check("service: the pick grants exactly the one file the last search returned", async () => {
    const pickable = path.join(HOME, "notes.txt");
    assert.deepEqual(await service.pick(1, path.join(HOME, "Projects", "app", ".env")), {
      ok: false,
      message: "Pick the file from the Quick Open list.",
    }, "a real file the search did not return");
    assert.equal((await service.pick(2, pickable)).ok, false, "another window's results do not count");
    assert.equal((await service.pick(1, path.join(OUTSIDE, "secret-notes.md"))).ok, false);
    assert.equal((await service.pick(1, 7)).ok, false);
    assert.deepEqual(grants, [], "no refusal touches the sandbox");
    assert.deepEqual(await service.pick(1, pickable), { ok: true, path: pickable });
    assert.deepEqual(grants, [pickable], "one path, never its folder");
  });

  await check("service: a file swapped for a link after the search is refused", async () => {
    grants.length = 0;
    const victim = path.join(HOME, "Documents", "plan-notes.md");
    const search = service.search(3, "plan-notes", null);
    gates[0].release();
    gates.length = 0;
    assert.deepEqual((await search).hits.map((hit) => hit.path), [victim]);
    fs.rmSync(victim);
    fs.symlinkSync(path.join(HOME, ".ssh", "notes"), victim);
    assert.equal((await service.pick(3, victim)).ok, false);
    fs.rmSync(victim);
    assert.deepEqual(await service.pick(3, victim), { ok: false, message: "That file no longer exists." });
    write(victim);
    assert.equal((await service.pick(3, victim)).ok, true, "a plain file again is fine");
    assert.deepEqual(grants, [victim]);
  });

  await check("service: off in Settings means no search and no grant", async () => {
    grants.length = 0;
    enabled = false;
    assert.deepEqual(await service.search(1, "notes", null), { hits: [], truncated: false, disabled: true });
    assert.equal(gates.length, 0, "the disk is not walked");
    assert.equal((await service.pick(1, path.join(HOME, "notes.txt"))).ok, false);
    assert.deepEqual(grants, []);
    enabled = true;
    service.forget(1);
    assert.equal((await service.pick(1, path.join(HOME, "notes.txt"))).ok, false, "a closed window's results are forgotten");
  });

  const sandbox = await bundle("src/main/fs-sandbox.ts", "fs-sandbox", {
    electron: `export const app = { getPath: () => ${JSON.stringify(path.join(TMP, "app-data"))} };`,
  });
  await check("the real read sandbox: the picked file opens, its siblings and folder do not", async () => {
    sandbox.setAllowedRoots([path.join(TMP, "workspace-root")]);
    const real = qo.createHomeSearchService({ home: () => HOME, enabled: () => true, grantReadFile: sandbox.grantReadFile, search: (q, o) => qo.searchHomeFiles(q, { ...o, fdPath: null }) });
    const target = path.join(HOME, "Projects", "app", "notes-app.md");
    assert.equal(sandbox.isAllowedReadPath(target), false, "outside every workspace before the pick");
    await real.search(9, "notes-app", null);
    assert.equal(sandbox.isAllowedReadPath(target), false, "a search alone grants nothing");
    assert.equal((await real.pick(9, target)).ok, true);
    assert.equal(sandbox.isAllowedReadPath(target), true);
    assert.equal(sandbox.isAllowedReadPath(path.join(HOME, "Projects", "app", ".env")), false);
    assert.equal(sandbox.isAllowedReadPath(path.join(HOME, "Projects", "app")), false);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
