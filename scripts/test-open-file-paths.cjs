#!/usr/bin/env node
"use strict";

// Opening a file from what an agent printed or asked for:
//   1. The terminal's path detector (file-link-provider.ts): paths with
//      spaces when the file exists, ~/ paths, bare names like .env and
//      README.md in the pane's folder, line suffixes, and the URLs and prose
//      it must leave alone.
//   2. OSC 8 file:// hyperlinks (Claude Code's markdown links to files)
//      resolve to the exact path, spaces included.
//   3. .env and key files are recognized, so no editor feature sends them on.
//   4. codara_open_file's check (open-file.ts): missing, folder, binary, too
//      large, relative and bad lines are refused; ~/ and a line are kept.
//   5. The read sandbox grants the one file an agent opened, not its folder.
//   6. The file.open handler opens in the caller's workspace and refuses
//      without touching the tabs or the sandbox.
//   7. A file reached through a .env link is a secret too (secret-file-check),
//      and no secret file becomes a share link.
//
//   node scripts/test-open-file-paths.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-open-file-paths-"));
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

async function main() {
  const { Terminal } = require("@xterm/headless");
  const links = await bundle("src/renderer/src/components/Terminal/file-link-provider.ts", "file-links");
  const { fileLinkTarget } = await bundle("src/renderer/src/components/Terminal/terminalLinks.ts", "terminal-links");

  // A fake disk: the files that exist, by absolute path. Relative targets
  // resolve against the cwd and ~/ against HOME, as main's fs:pathExists does.
  const HOME = "/home/etienne";
  const CWD = "/home/etienne/Documents/Codara SL/Studio/app";
  const FILES = new Set([
    "/home/etienne/Documents/Codara SL/README.md",
    "/home/etienne/Documents/Codara SL/Worktrees/x/notes.md",
    "/home/etienne/Documents/Projects/AI Continous Improvment/global/AGENTS.md",
    `${CWD}/.env`,
    `${CWD}/config/.env`,
    `${CWD}/config/.env.local`,
    `${CWD}/README.md`,
    `${CWD}/src/a.ts`,
    `${CWD}/docs/my notes.txt`,
    `${CWD}/meeting notes.md`,
    "/tmp/report",
    "/tmp/report 2.md",
    "/tmp/x/dir with space/notes.md",
  ]);
  const checked = [];
  const resolveExisting = async (target, baseDir) => {
    checked.push(target);
    const abs = target.startsWith("~/")
      ? path.posix.join(HOME, target.slice(2))
      : path.posix.isAbsolute(target)
        ? target
        : baseDir
          ? path.posix.join(baseDir, target)
          : null;
    return abs && FILES.has(abs) ? abs : null;
  };
  const linksOf = async (text, cwd = CWD) => {
    const term = new Terminal({ cols: 160, rows: 4, allowProposedApi: true });
    await new Promise((resolve) => term.write(text, resolve));
    const activations = [];
    const provider = links.createFileLinkProvider(term, {
      getCwd: () => cwd,
      resolveExisting,
      onActivate: (activation) => activations.push(activation),
    });
    const found = (await new Promise((resolve) => provider.provideLinks(1, resolve))) ?? [];
    term.dispose();
    return found.map((link) => {
      link.activate({ ctrlKey: true });
      const { file, line, column } = activations.at(-1);
      return { text: link.text, file, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}), from: link.range.start.x, to: link.range.end.x };
    });
  };

  await check("a Claude tool line with a ~/ path through a folder with a space", async () => {
    const found = await linksOf("● Read(~/Documents/Codara SL/README.md)");
    assert.deepEqual(found, [
      { text: "~/Documents/Codara SL/README.md", file: "/home/etienne/Documents/Codara SL/README.md", from: 8, to: 38 },
    ]);
  });

  await check("absolute paths with spaces, with a line suffix, in prose and in Codex's parentheses", async () => {
    assert.deepEqual(await linksOf("Updated /home/etienne/Documents/Codara SL/Worktrees/x/notes.md:12 and more"), [
      {
        text: "/home/etienne/Documents/Codara SL/Worktrees/x/notes.md:12",
        file: "/home/etienne/Documents/Codara SL/Worktrees/x/notes.md",
        line: 12,
        from: 9,
        to: 65,
      },
    ]);
    assert.deepEqual(await linksOf("See ~/Documents/Projects/AI Continous Improvment/global/AGENTS.md."), [
      {
        text: "~/Documents/Projects/AI Continous Improvment/global/AGENTS.md",
        file: "/home/etienne/Documents/Projects/AI Continous Improvment/global/AGENTS.md",
        from: 5,
        to: 65,
      },
    ]);
    const codex = await linksOf("• notes.md (/tmp/x/dir with space/notes.md)");
    assert.deepEqual(codex.map((link) => link.file), ["/tmp/x/dir with space/notes.md"]);
  });

  await check("bare names and relative paths resolve in the pane's folder, with :line:col", async () => {
    assert.deepEqual(await linksOf("Added the key to .env and documented it in README.md:4:2."), [
      { text: ".env", file: `${CWD}/.env`, from: 18, to: 21 },
      { text: "README.md:4:2", file: `${CWD}/README.md`, line: 4, column: 2, from: 44, to: 56 },
    ]);
    assert.deepEqual(await linksOf("⏺ Read(meeting notes.md)"), [
      { text: "meeting notes.md", file: `${CWD}/meeting notes.md`, from: 8, to: 23 },
    ]);
    assert.deepEqual(await linksOf("⏺ Read(meeting notes.md:12)"), [
      { text: "meeting notes.md:12", file: `${CWD}/meeting notes.md`, line: 12, from: 8, to: 26 },
    ]);
    assert.deepEqual((await linksOf("Set it in config/.env and config/.env.local")).map((link) => link.file), [
      `${CWD}/config/.env`,
      `${CWD}/config/.env.local`,
    ]);
    assert.deepEqual(await linksOf("Wrote docs/my notes.txt"), [{ text: "docs/my notes.txt", file: `${CWD}/docs/my notes.txt`, from: 7, to: 23 }]);
    assert.deepEqual(await linksOf("src/a.ts(3,7): error TS2322"), [
      { text: "src/a.ts(3,7)", file: `${CWD}/src/a.ts`, line: 3, column: 7, from: 1, to: 13 },
    ]);
  });

  await check("a file that exists as printed is never grown across the space after it", async () => {
    assert.deepEqual((await linksOf("cat /tmp/report 2.md")).map((link) => link.text), ["/tmp/report"]);
  });

  await check("URLs, prose and missing files stay plain text", async () => {
    assert.deepEqual(await linksOf("Local: http://localhost:5173/README.md and https://example.com/.env"), []);
    assert.deepEqual(await linksOf("Built with Node.js, e.g. v1.2.3; mail me at dev@README.md"), []);
    assert.deepEqual(await linksOf("Missing ~/Documents/Codara SL/nothing.md here"), []);
    assert.deepEqual(await linksOf(".env", null), [], "with no known folder a bare name names nothing");
    // Codara's checks for a missing token are bounded: the token itself,
    // and a few words around it.
    checked.length = 0;
    await linksOf("x /no/such one two three four five six seven eight nine");
    assert.ok(checked.length <= 6, `${checked.length} existence checks for one missing token`);
  });

  await check("the scanner offers wider readings only where they can apply", () => {
    const [anchored] = links.scanRowForPaths("open ~/a b/c.md now");
    assert.deepEqual(anchored.wider.map((c) => c.file), ["~/a b/c.md now", "~/a b/c.md"]);
    const [suffixed] = links.scanRowForPaths("/a/b.ts:3 more");
    assert.deepEqual(suffixed.wider, [], "a line suffix ends the path");
    const [spacedSuffix] = links.scanRowForPaths("Read(meeting notes.md:12)");
    assert.deepEqual(spacedSuffix.wider.map((c) => [c.file, c.line]), [["meeting notes.md", 12]], "but it may start earlier");
    const [bare] = links.scanRowForPaths("see the README.md file");
    assert.deepEqual(bare.wider.map((c) => c.file), ["see the README.md", "the README.md"], "a bare name only grows backward");
    assert.deepEqual(
      links.dropOverlapping([
        { startCol: 1, endCol: 10 },
        { startCol: 5, endCol: 30 },
        { startCol: 40, endCol: 45 },
      ]),
      [
        { startCol: 5, endCol: 30 },
        { startCol: 40, endCol: 45 },
      ],
    );
  });

  await check("OSC 8 file:// links name the exact local path", () => {
    assert.deepEqual(fileLinkTarget("file:///tmp/x/dir%20with%20space/notes.md"), { path: "/tmp/x/dir with space/notes.md" });
    assert.deepEqual(fileLinkTarget("file://localhost/home/e/.env#L12"), { path: "/home/e/.env", line: 12 });
    assert.deepEqual(fileLinkTarget("file:///home/e/a.ts#L3C9"), { path: "/home/e/a.ts", line: 3, column: 9 });
    assert.deepEqual(fileLinkTarget("file:///C:/Users/e/a.md"), { path: "C:/Users/e/a.md" });
    assert.equal(fileLinkTarget("file://other-host/etc/passwd"), null, "another machine's file");
    assert.equal(fileLinkTarget("https://example.com/a.md"), null);
    assert.equal(fileLinkTarget("codara://tab/ws/t"), null);
    assert.equal(fileLinkTarget("not a url"), null);
  });

  const { isSecretFilePath } = await bundle("src/shared/secret-files.ts", "secret-files");
  await check(".env and key files are secret; ordinary text is not", () => {
    for (const p of ["/a/.env", "/a/.env.local", "C:\\a\\.ENV.production", "/a/secrets.env", "/a/.envrc", "/a/id_ed25519", "/a/tls.key", "/a/cert.pem", "/a/.npmrc"]) {
      assert.equal(isSecretFilePath(p), true, p);
    }
    for (const p of ["/a/README.md", "/a/notes.txt", "/a/environment.ts", "/a/env", "/a/id_ed25519.pub", ""]) {
      assert.equal(isSecretFilePath(p), false, p);
    }
  });

  const { isSecretFileOnDisk, MAX_LINK_HOPS } = await bundle("src/main/secret-file-check.ts", "secret-file-check");
  const { shareableKind } = await bundle("src/shared/share.ts", "share");
  await check("a file reached through a secret is a secret: every link, the kernel's way", async () => {
    const w = path.join(TMP, "links");
    fs.mkdirSync(path.join(w, "actual", "inner"), { recursive: true });
    fs.writeFileSync(path.join(w, "config.txt"), "KEY=x\n");
    fs.writeFileSync(path.join(w, "plain.txt"), "hello\n");
    fs.symlinkSync("config.txt", path.join(w, ".env"));
    fs.symlinkSync(".env", path.join(w, "notes.txt"));
    fs.symlinkSync("plain.txt", path.join(w, "readme.txt"));
    assert.equal(await isSecretFileOnDisk(path.join(w, "plain.txt")), false);
    assert.equal(await isSecretFileOnDisk(path.join(w, "readme.txt")), false, "an ordinary link");
    assert.equal(await isSecretFileOnDisk(path.join(w, "notes.txt")), true, "notes.txt -> .env -> config.txt");
    assert.equal(await isSecretFileOnDisk(path.join(w, "new.txt")), false, "a new file has only its name");
    assert.equal(await isSecretFileOnDisk(path.join(w, "new.env")), true);
    assert.equal(await isSecretFileOnDisk(path.join(w, "page.html")), false, "missing, ordinary name");

    // "d/../middle.txt" where d is a link into actual/inner: the kernel reads
    // actual/middle.txt (a link to a .env), not w/middle.txt.
    fs.writeFileSync(path.join(w, "actual", "config.txt"), "KEY=y\n");
    fs.symlinkSync("config.txt", path.join(w, "actual", ".env"));
    fs.symlinkSync(".env", path.join(w, "actual", "middle.txt"));
    fs.symlinkSync(path.join("actual", "inner"), path.join(w, "d"));
    fs.symlinkSync("d/../middle.txt", path.join(w, "dotdot.txt"));
    assert.equal(fs.readFileSync(path.join(w, "dotdot.txt"), "utf8"), "KEY=y\n", "the kernel follows d first");
    assert.equal(await isSecretFileOnDisk(path.join(w, "dotdot.txt")), true, "d/.. resolved after d");

    // A long chain with the .env deep inside, and one longer than the limit.
    const chain = (name, length, secretAt) => {
      const dirName = path.join(w, name);
      fs.mkdirSync(dirName);
      fs.writeFileSync(path.join(dirName, "end.txt"), "x\n");
      let next = "end.txt";
      for (let i = length; i >= 1; i -= 1) {
        const link = i === secretAt ? `.env.${i}` : `hop${i}.txt`;
        fs.symlinkSync(next, path.join(dirName, link));
        next = link;
      }
      return path.join(dirName, next);
    };
    assert.equal(await isSecretFileOnDisk(chain("short", 5, 4)), true, ".env four links in");
    assert.equal(await isSecretFileOnDisk(chain("plainchain", 5, 0)), false, "a chain of ordinary links");
    assert.equal(await isSecretFileOnDisk(chain("deep", MAX_LINK_HOPS + 1, MAX_LINK_HOPS)), true, ".env at the last hop looked at");
    assert.equal(await isSecretFileOnDisk(chain("long", MAX_LINK_HOPS + 3, 0)), true, "past the hop limit fails closed");

    // codara_open_file and the terminal's check name the file the kernel
    // reads: "d/.." is actual/, not w/.
    const { kernelPath, checkOpenFile: check2 } = await bundle("src/main/open-file.ts", "open-file-kernel");
    assert.equal(await kernelPath(`${w}/d/../config.txt`), path.join(w, "actual", "config.txt"));
    assert.equal(await kernelPath(`${w}//plain.txt`), path.join(w, "plain.txt"), "no .. keeps the spelling, tidied");
    assert.equal(await kernelPath(path.join(w, "d", "x.txt")), path.join(w, "d", "x.txt"), "a folder link keeps its name");
    const viaDotDot = await check2(`${w}/d/../config.txt`);
    assert.equal(viaDotDot.path, path.join(w, "actual", "config.txt"));
    assert.equal(viaDotDot.real, path.join(w, "actual", "config.txt"));

    fs.symlinkSync("loop-b.txt", path.join(w, "loop-a.txt"));
    fs.symlinkSync("loop-a.txt", path.join(w, "loop-b.txt"));
    assert.equal(await isSecretFileOnDisk(path.join(w, "loop-a.txt")), true, "a link loop fails closed");
    assert.equal(await isSecretFileOnDisk("ssh://host/home/e/.env"), false, "remote files are not read here");
  });

  await check("a .env never becomes a share link, whatever its last extension", () => {
    assert.equal(shareableKind("/a/.env.backup.html"), null);
    assert.equal(shareableKind("/a/secrets.env"), null);
    assert.equal(shareableKind("/a/page.html"), "html");
    assert.equal(shareableKind("/a/notes.md"), "markdown");
  });

  const { checkOpenFile } = await bundle("src/main/open-file.ts", "open-file");
  const dir = path.join(TMP, "work dir");
  fs.mkdirSync(path.join(dir, "folder"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), "API_KEY=do-not-print\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");
  fs.writeFileSync(path.join(dir, "empty.md"), "");
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
  fs.writeFileSync(path.join(dir, "big.log"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
  const reasonOf = async (p, line) => (await checkOpenFile(p, line)).reason;
  await check("codara_open_file's check: text files open, everything else is refused with a reason", async () => {
    assert.deepEqual(await checkOpenFile(path.join(dir, ".env"), 2), { ok: true, path: path.join(dir, ".env"), real: path.join(dir, ".env"), line: 2 });
    const ok = (p) => ({ ok: true, path: p, real: p });
    assert.deepEqual(await checkOpenFile(path.join(dir, "notes.txt")), ok(path.join(dir, "notes.txt")));
    assert.deepEqual(await checkOpenFile(path.join(dir, "empty.md")), ok(path.join(dir, "empty.md")));
    assert.deepEqual(await checkOpenFile("~/notes.txt", undefined, { homeDir: () => dir }), ok(path.join(dir, "notes.txt")));
    assert.equal(await reasonOf(`${path.join(dir, "notes.txt")} `), "missing", "a trailing space names another file");
    const reason = async (p, line) => (await checkOpenFile(p, line)).reason;
    assert.equal(await reason(path.join(dir, "missing.md")), "missing");
    assert.equal(await reason(path.join(dir, "folder")), "directory");
    assert.equal(await reason(path.join(dir, "logo.png")), "binary");
    assert.equal(await reason(path.join(dir, "big.log")), "too_large");
    assert.equal(await reason("notes.txt"), "invalid", "a relative path reaches Codara already resolved by the MCP server");
    assert.equal(await reason("file:///etc/hosts"), "invalid");
    assert.equal(await reason(""), "invalid");
    assert.equal(await reason(42), "invalid");
    assert.equal(await reason(path.join(dir, "notes.txt"), 0), "invalid");
    assert.equal(await reason(path.join(dir, "notes.txt"), 1.5), "invalid");
    const refused = await checkOpenFile(path.join(dir, "logo.png"));
    assert.ok(!JSON.stringify(refused).includes("PNG"), "a refusal carries no file content");
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(dir, "notes.txt"), path.join(dir, ".env.local"));
      assert.deepEqual(
        await checkOpenFile(path.join(dir, ".env.local")),
        { ok: true, path: path.join(dir, ".env.local"), real: path.join(dir, "notes.txt") },
        "a link keeps the name asked for, so a .env stays a .env to the editor",
      );
    }
  });

  const sandbox = await bundle("src/main/fs-sandbox.ts", "fs-sandbox", {
    electron: `export const app = { getPath: () => ${JSON.stringify(path.join(TMP, "app-data"))} };`,
  });
  await check("the read sandbox grants the one file an agent opened, not its folder", () => {
    const outside = path.join(TMP, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secrets.env"), "X=1\n");
    fs.writeFileSync(path.join(outside, "other.txt"), "y\n");
    sandbox.setAllowedRoots([dir]);
    assert.equal(sandbox.isAllowedReadPath(path.join(dir, "notes.txt")), true);
    assert.equal(sandbox.isAllowedReadPath(path.join(outside, "secrets.env")), false);
    sandbox.grantReadFile(path.join(outside, "secrets.env"));
    assert.equal(sandbox.isAllowedReadPath(path.join(outside, "secrets.env")), true);
    assert.equal(sandbox.isAllowedReadPath(path.join(outside, "other.txt")), false, "a sibling stays out");
    assert.equal(sandbox.isAllowedReadPath(outside), false, "the folder stays out");
  });

  const harness = { ops: [], grants: [], located: null, opResult: { ok: true, shown: true } };
  globalThis.__openFileHarness = harness;
  const { openFileTools } = await bundle("src/main/preview-tools/open-file.ts", "open-file-tool", {
    "../fs-sandbox": "export const grantReadFile = (p) => globalThis.__openFileHarness.grants.push(p);",
    "../terminal-bridge":
      "export const requestTerminalOp = async (op, params) => { globalThis.__openFileHarness.ops.push({ op, params }); return globalThis.__openFileHarness.opResult; };",
    "./workspace-status":
      "export const callerWorkspace = async () => globalThis.__openFileHarness.located ?? { workspaceId: 'ws-caller', by: { kind: 'agent', label: 'Claude Code' }, agentKey: null };",
  });
  const entry = openFileTools["file.open"];
  const run = (params) => entry.run(params, "file.open", {});
  await check("file.open opens the checked file in the caller's own workspace", async () => {
    assert.equal(entry.trustedRunsOnly, true, "an imported pull request cannot open files on the user's screen");
    const result = await run({ path: path.join(dir, ".env"), line: 1, workspaceId: "ws-other" });
    assert.deepEqual(harness.ops, [{ op: "openFile", params: { workspaceId: "ws-caller", path: path.join(dir, ".env"), line: 1 } }]);
    assert.deepEqual(harness.grants, [path.join(dir, ".env"), path.join(dir, ".env")]);
    assert.equal(result.opened, true);
    assert.equal(result.onScreen, true);
    assert.ok(!JSON.stringify(result).includes("do-not-print"), "the file's text is never returned");
    harness.opResult = { ok: true, shown: false };
    assert.equal((await run({ path: path.join(dir, "notes.txt") })).onScreen, false);
  });

  await check("file.open refuses without touching the tabs or the sandbox", async () => {
    harness.ops.length = 0;
    harness.grants.length = 0;
    assert.deepEqual(await run({ path: path.join(dir, "folder") }), { opened: false, reason: "directory", note: "that path is a folder, not a file" });
    assert.equal((await run({ path: path.join(dir, "logo.png") })).reason, "binary");
    assert.equal((await run({ path: path.join(dir, "missing.txt") })).reason, "missing");
    harness.located = { refusal: { updated: false, reason: "not_in_codara_workspace", note: "only in Codara" } };
    assert.deepEqual(await run({ path: path.join(dir, "notes.txt") }), { opened: false, reason: "not_in_codara_workspace", note: "only in Codara" });
    harness.located = null;
    assert.deepEqual(harness.ops, []);
    assert.deepEqual(harness.grants, []);
    harness.opResult = { ok: false, reason: "workspace_closed" };
    assert.equal((await run({ path: path.join(dir, "notes.txt") })).reason, "workspace_closed");
  });

  console.log(`\nPASS open file paths: ${passed} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
