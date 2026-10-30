#!/usr/bin/env node
"use strict";

// Quick Open's path mode and the checks behind "open this path"
// (src/shared/path-query.ts, src/main/quick-open-path.ts):
//   1. What counts as a path, and what stays plain text.
//   2. Listing: the one folder named, hidden entries included, filtered as you
//      type, links followed for their kind, private data left out, a big
//      folder cut off, files never opened.
//   3. A folder that never answers costs a bounded number of fs threads, main
//      keeps answering, and a listing makes no synchronous fs call at all.
//   4. The pick: only what the last listing returned, links allowed, a file
//      gets a one-file read grant, a folder gets none.
//   5. What may not open: Codara's private data, a folder on or above a
//      network mount, the home folder, the root.
//   6. Credential stores count as secrets, so they open as plain text only.
//
//   node scripts/test-quick-open-path.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-quick-open-path-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

async function bundle(entry, name) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
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

function write(file, text = "text\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function main() {
  const { isPathQuery } = await bundle("src/shared/path-query.ts", "path-query");
  const {
    createPathQueryService,
    isCodaraPrivatePath,
    parseNetworkMounts,
    resolveOpenTarget,
    resolvePathQuery,
    searchPathQuery,
    withFsDeadline,
    workspaceRefusal,
    FsDeadlineError,
  } = await bundle("src/main/quick-open-path.ts", "quick-open-path");
  const { isSecretFilePath, isCredentialHomePath } = await bundle("src/shared/secret-files.ts", "secret-files");

  const home = path.join(TMP, "home");
  const codaraHome = path.join(home, ".codarastudio");
  const claude = path.join(home, ".claude");
  const cwd = path.join(home, "Projects", "app");
  write(path.join(claude, "settings.json"), "{}\n");
  write(path.join(claude, "session-env", "a.txt"));
  write(path.join(claude, ".hidden-note"));
  write(path.join(claude, "Sessions.md"));
  write(path.join(claude, "my-settings.md"));
  write(path.join(home, ".claude.json"), "{}\n");
  write(path.join(home, "Documents", "Codara SL", "Año nuevo.md"));
  write(path.join(cwd, "src", "index.ts"));
  write(path.join(codaraHome, "pi-agent", "auth.json"), "{}\n");
  write(path.join(codaraHome, "remote", "identity.json"), "{}\n");
  write(path.join(codaraHome, "worktrees", "repo", "README.md"));
  fs.symlinkSync(path.join(claude, "settings.json"), path.join(claude, "linked.json"));
  fs.symlinkSync(path.join(claude, "session-env"), path.join(claude, "linked-folder"));
  fs.symlinkSync(path.join(claude, "gone"), path.join(claude, "broken"));
  fs.symlinkSync(path.join(codaraHome, "remote", "identity.json"), path.join(home, "innocent.txt"));

  const search = (query, extra = {}) => searchPathQuery(query, { home, cwd, codaraHome, ...extra });
  const names = (result) => result.hits.map((hit) => hit.name);

  await check("paths and plain text are told apart", () => {
    for (const query of ["~", "~/", "~/.claude", "/", "/etc/hosts", "./src", "../x", "  ~/.claude"]) {
      assert.equal(isPathQuery(query, cwd), true, query);
    }
    for (const query of ["", ".env", "..", ".", "~user", "~user/x", "src/index.ts", "index", "a/b", "foo ~/bar"]) {
      assert.equal(isPathQuery(query, cwd), false, query);
    }
    assert.equal(isPathQuery("./src", null), false, "no workspace, no ./");
    assert.equal(isPathQuery("./src", "ssh://host/home/e/app"), false, "a remote workspace is on another computer");
    assert.equal(isPathQuery("~/x", "ssh://host/home/e/app"), true);
    assert.equal(isPathQuery(`/${"x".repeat(5000)}`, cwd), false, "too long");
    assert.equal(isPathQuery("/etc\0/x", cwd), false, "NUL");
  });

  await check("a query splits into a folder and what is typed after it", () => {
    const at = (query) => resolvePathQuery(query, { home, cwd });
    assert.deepEqual(at("~"), { folder: home, typedFolder: "~/", prefix: "" });
    assert.deepEqual(at("~/.claude"), { folder: home, typedFolder: "~/", prefix: ".claude" });
    assert.deepEqual(at("~/.claude/"), { folder: claude, typedFolder: "~/.claude/", prefix: "" });
    assert.deepEqual(at("~/.claude/se"), { folder: claude, typedFolder: "~/.claude/", prefix: "se" });
    assert.deepEqual(at("./src/in"), { folder: path.join(cwd, "src"), typedFolder: "./src/", prefix: "in" });
    assert.deepEqual(at("../"), { folder: `${cwd}/../`, typedFolder: "../", prefix: "" });
    assert.deepEqual(at("~/.claude/.."), { folder: `${home}/.claude/../`, typedFolder: "~/.claude/../", prefix: "" });
    assert.equal(at("plain"), null);
    assert.equal(at(42), null);
  });

  await check("a folder and its hidden entries are listed", async () => {
    const result = await search("~/.claude/");
    assert.equal(result.hits[0].kind, "folder");
    assert.equal(result.hits[0].path, claude);
    assert.equal(result.hits[0].completion, "~/.claude/");
    assert.deepEqual(names(result).slice(1), [
      "broken",
      "linked-folder",
      "linked.json",
      "my-settings.md",
      "session-env",
      "Sessions.md",
      "settings.json",
      ".hidden-note",
    ]);
  });

  await check("the exact path comes first, then what the text starts, then what it holds", async () => {
    const top = await search("~/.claude");
    assert.equal(top.hits[0].kind, "exact");
    assert.equal(top.hits[0].path, claude);
    assert.equal(top.hits[0].isDir, true);
    assert.equal(top.hits[0].completion, "~/.claude/");
    assert.deepEqual(names(top), [".claude", ".claude.json"]);

    const filtered = await search("~/.claude/se");
    assert.deepEqual(names(filtered), ["session-env", "Sessions.md", "settings.json", "my-settings.md"]);
    assert.equal(filtered.hits[0].completion, "~/.claude/session-env/");
    assert.equal(filtered.hits[2].completion, "~/.claude/settings.json");
    assert.equal(filtered.hits[2].label, "~/.claude");
  });

  await check("links are looked at, spaces and accents survive", async () => {
    const result = await search("~/.claude/linked");
    assert.deepEqual(
      result.hits.map((hit) => [hit.name, hit.isDir]),
      [["linked-folder", true], ["linked.json", false]],
    );
    const spaced = await search("~/Documents/Codara SL/Añ");
    assert.equal(spaced.hits[0].path, path.join(home, "Documents", "Codara SL", "Año nuevo.md"));
    assert.equal(spaced.hits[0].completion, "~/Documents/Codara SL/Año nuevo.md");
  });

  await check("relative paths start in the workspace", async () => {
    assert.deepEqual(names(await search("./src/")).slice(1), ["index.ts"]);
    assert.deepEqual(names(await search("./s")), ["src"]);
  });

  await check("\"..\" is what the kernel says, after the links before it", async () => {
    fs.mkdirSync(path.join(home, "deep", "er"), { recursive: true });
    write(path.join(home, "deep", "marker.txt"));
    fs.symlinkSync(path.join(home, "deep", "er"), path.join(home, "hop"));
    const result = await search("~/hop/../");
    assert.equal(result.hits[0].path, path.join(home, "deep"), "the link's parent, not the home folder");
    assert.ok(names(result).includes("marker.txt"));
    assert.equal(result.hits[1].path, path.join(home, "deep", "er"));
    assert.deepEqual(names(await search("~/.claude/..")).slice(0, 1), [path.basename(home)]);
  });

  await check("no match, no folder, and a file used as a folder", async () => {
    assert.deepEqual(await search("~/.claude/zzz"), { hits: [], truncated: false });
    assert.deepEqual(await search("~/nowhere/x"), { hits: [], truncated: false, missing: true });
    assert.deepEqual(await search("~/.claude/settings.json/"), { hits: [], truncated: false, missing: true });
    assert.deepEqual(await search("plain text"), { hits: [], truncated: false });
  });

  await check("Codara's private data is not listed", async () => {
    assert.deepEqual(names(await search("~/.codarastudio/")).slice(1), ["worktrees"]);
    const inside = await search("~/.codarastudio/remote/");
    assert.equal(inside.hits.length, 0);
    assert.match(inside.message, /private/);
    assert.equal((await search("~/.codarastudio/pi-agent/")).hits.length, 0);
    assert.deepEqual(names(await search("~/.codarastudio/worktrees/")).slice(1), ["repo"]);
    // A link into it, and a home reached through a link, list nothing either.
    fs.symlinkSync(path.join(codaraHome, "remote"), path.join(home, "alias"));
    const viaLink = await search("~/alias/");
    assert.equal(viaLink.hits.length, 0);
    assert.match(viaLink.message, /private/);
    const linkedHome = path.join(TMP, "linked-codara");
    fs.symlinkSync(codaraHome, linkedHome);
    const spelledViaLink = await search("~/.codarastudio/", { codaraHome: linkedHome });
    assert.deepEqual(names(spelledViaLink).slice(1), ["worktrees"], "the child filter sees the real home");
    assert.equal(isCodaraPrivatePath(path.join(codaraHome, "remote-x"), codaraHome), true);
    assert.equal(isCodaraPrivatePath(`${codaraHome}-other/file`, codaraHome), false);
    assert.equal(isCodaraPrivatePath(codaraHome, codaraHome), false);
  });

  await check("a big folder is cut off and says so", async () => {
    const big = path.join(home, "big");
    fs.mkdirSync(big);
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(big, `f${i}`), "");
    const capped = await search("~/big/", { limit: 5 });
    assert.equal(capped.hits.length, 5);
    assert.equal(capped.truncated, true);
    const scanned = await search("~/big/", { maxEntries: 10 });
    assert.equal(scanned.truncated, true);
    assert.equal(scanned.hits.length, 11);
    // A name typed in full is found wherever it falls in the folder.
    const all = fs.readdirSync(path.join(home, "big"));
    const last = all[all.length - 1];
    const typed = await search(`~/big/${last}`, { maxEntries: 3 });
    assert.equal(typed.hits[0].path, path.join(home, "big", last));
    assert.equal(typed.hits[0].kind, "exact");
  });

  await check("a listing touches names only, in the one folder", async () => {
    const calls = [];
    const spy = {
      realpath: (target) => fs.promises.realpath(target),
      stat: (target) => {
        calls.push(["stat", target]);
        return fs.promises.stat(target);
      },
      readdir: (target) => {
        calls.push(["readdir", target]);
        return fs.promises.readdir(target);
      },
    };
    await search("~/.claude/", { fs: spy });
    assert.deepEqual(calls.filter(([kind]) => kind === "readdir"), [["readdir", claude]], "no walk: session-env stays closed");
  });

  await check("a listing and a pick make no synchronous fs call", async () => {
    const sync = ["statSync", "lstatSync", "realpathSync", "readdirSync", "openSync", "readSync", "existsSync"];
    const saved = sync.map((name) => fs[name]);
    const used = [];
    sync.forEach((name, at) => {
      fs[name] = (...args) => {
        used.push(name);
        return saved[at](...args);
      };
    });
    try {
      await search("~/.claude/");
      await resolveOpenTarget(path.join(claude, "linked.json"), { home: () => home, codaraHome: () => codaraHome, networkMounts: async () => [] });
    } finally {
      sync.forEach((name, at) => {
        fs[name] = saved[at];
      });
    }
    assert.deepEqual(used, []);
  });

  await check("a folder that never answers costs two threads and main stays free", async () => {
    let started = 0;
    const dead = {
      realpath: () => {
        started += 1;
        return new Promise(() => undefined);
      },
      stat: () => new Promise(() => undefined),
      readdir: () => new Promise(() => undefined),
    };
    const stuck = await Promise.all([1, 2, 3, 4].map(() => search("~/.claude/", { fs: dead, timeoutMs: 30 })));
    for (const result of stuck) assert.deepEqual(result, { hits: [], truncated: false, message: "That folder is not answering." });
    assert.equal(started, 2, "the others never reached the disk");
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    await new Promise((done) => setTimeout(done, 20));
    clearInterval(timer);
    assert.ok(ticks > 3, "the event loop keeps turning");
    // Both slots stay taken: a dead mount does not get more threads later.
    const later = await search("~/.claude/", { fs: dead, timeoutMs: 20 });
    assert.equal(later.message, "That folder is not answering.");
    assert.equal(started, 2);
  });

  // The slots above are held forever by design, so the rest runs on a fresh
  // copy of the module.
  const fresh = await bundle("src/main/quick-open-path.ts", "quick-open-path-fresh");

  await check("the slot passes to whoever waits, and a finished job frees it", async () => {
    let release = () => undefined;
    const held = fresh.withFsDeadline(() => new Promise((resolve) => (release = () => resolve("first"))), 1_000);
    const second = fresh.withFsDeadline(async () => "second", 1_000);
    const third = fresh.withFsDeadline(async () => "third", 1_000);
    release();
    assert.deepEqual(await Promise.all([held, second, third]), ["first", "second", "third"]);
    await assert.rejects(
      fresh.withFsDeadline(() => Promise.reject(new Error("disk says no")), 1_000),
      /disk says no/,
    );
    assert.equal(await fresh.withFsDeadline(async () => "still free", 1_000), "still free");
    assert.ok(FsDeadlineError);
    assert.ok(withFsDeadline);
  });

  const deps = { home: () => home, codaraHome: () => codaraHome, networkMounts: async () => [] };

  await check("a pick opens a file and grants exactly that file", async () => {
    const grants = [];
    const service = fresh.createPathQueryService({
      ...deps,
      enabled: () => true,
      grantResolvedFile: (file, real) => grants.push([file, real]),
      search: (query, opts) => fresh.searchPathQuery(query, opts),
    });
    assert.deepEqual(await service.pick(1, path.join(claude, "settings.json")), {
      ok: false,
      message: "Pick the path from the Quick Open list.",
    });
    await service.search(1, "~/.claude/", cwd);
    const file = path.join(claude, "settings.json");
    assert.deepEqual(await service.pick(1, file), { ok: true, kind: "file", path: file });
    assert.deepEqual(grants, [[file, file]]);

    grants.length = 0;
    const link = path.join(claude, "linked.json");
    assert.deepEqual(await service.pick(1, link), { ok: true, kind: "file", path: link });
    assert.deepEqual(grants, [[link, file]], "a link grants its spelling and its real path");

    grants.length = 0;
    assert.deepEqual(await service.pick(1, claude), { ok: true, kind: "folder", path: claude });
    assert.deepEqual(grants, [], "a folder gets no read grant here");

    assert.equal((await service.pick(2, file)).ok, false, "another window's listing does not count");
    assert.equal((await service.pick(1, path.join(claude, "broken"))).ok, false);

    await service.search(1, "~/.claude/se", cwd);
    assert.equal((await service.pick(1, link)).ok, false, "only the latest listing counts");
    service.forget(1);
    assert.equal((await service.pick(1, file)).ok, false);
  });

  await check("the setting turns the whole mode off", async () => {
    const service = fresh.createPathQueryService({ ...deps, enabled: () => false, grantResolvedFile: () => assert.fail("no grant") });
    assert.deepEqual(await service.search(1, "~/.claude/", cwd), { hits: [], truncated: false, disabled: true });
    assert.equal((await service.pick(1, claude)).ok, false);
  });

  await check("a new listing cancels the one before it", async () => {
    const seen = [];
    const service = fresh.createPathQueryService({
      ...deps,
      enabled: () => true,
      grantResolvedFile: () => undefined,
      search: (query, opts) =>
        new Promise((resolve) => {
          seen.push(opts.signal);
          opts.signal.addEventListener("abort", () => resolve({ hits: [], truncated: false }));
          if (query === "/second") resolve({ hits: [], truncated: false });
        }),
    });
    const first = service.search(1, "/first", cwd);
    await new Promise((done) => setTimeout(done, 1));
    const second = await service.search(1, "/second", cwd);
    assert.deepEqual(await first, { hits: [], truncated: false, cancelled: true });
    assert.deepEqual(second, { hits: [], truncated: false });
    assert.equal(seen[0].aborted, true);
  });

  await check("binary, oversized and special files are refused without opening a tab", async () => {
    write(path.join(home, "image.bin"), Buffer.from([0x89, 0x00, 0x01]));
    assert.equal((await fresh.resolveOpenTarget(path.join(home, "image.bin"), deps)).reason, "binary");
    fs.writeFileSync(path.join(home, "big.log"), Buffer.alloc(6 * 1024 * 1024, 0x61));
    assert.equal((await fresh.resolveOpenTarget(path.join(home, "big.log"), deps)).reason, "too_large");
    assert.equal((await fresh.resolveOpenTarget(path.join(home, "no-such-file"), deps)).reason, "missing");
    const fifo = path.join(home, "pipe");
    require("node:child_process").execFileSync("mkfifo", [fifo]);
    assert.equal((await fresh.resolveOpenTarget(fifo, deps)).reason, "missing", "a FIFO is never opened");
  });

  await check("Codara's private files stay shut, however they are named", async () => {
    const identity = path.join(codaraHome, "remote", "identity.json");
    assert.equal((await fresh.resolveOpenTarget(identity, deps)).reason, "refused");
    assert.equal((await fresh.resolveOpenTarget(path.join(home, "innocent.txt"), deps)).reason, "refused", "through a link");
    assert.equal((await fresh.resolveOpenTarget(path.join(codaraHome, "pi-agent"), deps)).reason, "refused");
    const readme = path.join(codaraHome, "worktrees", "repo", "README.md");
    assert.equal((await fresh.resolveOpenTarget(readme, deps)).kind, "file");
    assert.equal((await fresh.resolveOpenTarget(path.join(codaraHome, "worktrees", "repo"), deps)).kind, "folder");
  });

  await check("a folder that would be indexed badly is not a workspace", async () => {
    const mount = path.join(home, "OneDrive-Codara", "Codara - Codara");
    fs.mkdirSync(mount, { recursive: true });
    fs.symlinkSync(mount, path.join(home, "Documents", "SharePoint"));
    const mounted = { ...deps, networkMounts: async () => [mount] };
    const refused = async (target) => (await fresh.resolveOpenTarget(target, mounted)).reason;
    assert.equal(await refused(mount), "refused", "the mount");
    assert.equal(await refused(path.join(home, "OneDrive-Codara")), "refused", "above the mount");
    assert.equal(await refused(path.join(home, "Documents", "SharePoint")), "refused", "through a shortcut");
    assert.equal(await refused(home), "refused", "the home folder");
    assert.equal(await refused("/"), "refused", "the root");
    assert.equal(await refused(codaraHome), "refused", "holds Studio's keys");
    assert.equal((await fresh.resolveOpenTarget(cwd, mounted)).kind, "folder");
    write(path.join(mount, "Deck.md"));
    assert.equal((await fresh.resolveOpenTarget(path.join(mount, "Deck.md"), mounted)).kind, "file", "a file there still opens");
    assert.equal(workspaceRefusal("/data/x", "/home/e", "/home/e/.codarastudio", []), null);
  });

  await check("a stuck drive times out when opening too", async () => {
    const stuck = { ...deps, networkMounts: () => new Promise(() => undefined) };
    const result = await fresh.resolveOpenTarget(cwd, stuck, 20);
    assert.equal(result.reason, "timeout");
  });

  await check("mountinfo is read for network and cloud drives only", () => {
    const text = [
      "24 29 0:22 / /proc rw,nosuid - proc proc rw",
      "29 1 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
      "61 29 0:48 / /home/e/OneDrive-Codara/Codara\\040-\\040Codara rw,nosuid - fuse.rclone codara-sharepoint rw",
      "62 29 0:49 / /mnt/nas rw - nfs4 nas:/share rw",
      "63 29 8:1 / /mnt/usb rw - fuseblk /dev/sdb1 rw",
    ].join("\n");
    assert.deepEqual(parseNetworkMounts(text), ["/home/e/OneDrive-Codara/Codara - Codara", "/mnt/nas"]);
    assert.deepEqual(parseNetworkMounts("garbage\n\n"), []);
  });

  await check("credential stores and login files count as secrets", () => {
    for (const name of [".credentials.json", "credentials", "credentials.json", "auth.json"]) {
      assert.equal(isSecretFilePath(`/home/e/.x/${name}`), true, name);
    }
    assert.equal(isSecretFilePath("/home/e/notes/author.json"), false);
    assert.equal(isCredentialHomePath(".aws/config"), true);
    assert.equal(isCredentialHomePath(".ssh"), true);
    assert.equal(isCredentialHomePath(".sshfoo/x"), false);
    assert.equal(isCredentialHomePath(".config/gh/hosts.yml"), true);
    assert.equal(isCredentialHomePath(".config/other/x"), false);
  });

  assert.ok(resolveOpenTarget);
  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
