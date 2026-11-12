// src/main/worktree-cleanup/mounts.ts under the Electron binary (as Node,
// headless). Electron's fs reads an .asar file as a folder and makes up its
// entries, device included, so an installed electron package
// (node_modules/electron/dist/resources/default_app.asar) looked like a drive
// mounted inside the worktree: Clean up kept every worktree that had one
// ("... default_app.asar is a mounted drive or on another disk"). Plain Node
// has no asar layer, which is why the walk's own tests passed.
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// A minimal .asar archive: a size pickle, a header pickle holding the JSON
// index, then the files' bytes.
function writeAsar(file) {
  const body = Buffer.from("1;\n");
  const json = Buffer.from(JSON.stringify({ files: { "main.js": { size: body.length, offset: "0" } } }));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([size, header, body]));
}

const CHILD = String.raw`
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const [bundle, worktree, archive] = process.argv.slice(2);
const mounts = require(bundle);
(async () => {
  assert.ok(fs.statSync(path.join(worktree, archive)).isDirectory(), "Electron reads the archive as a folder, so this run can show the bug");
  assert.strictEqual(await mounts.mountRefusal(worktree), null, "an installed electron package is not a mounted drive");
  console.log("ok - an .asar inside node_modules is not a mount, under Electron");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

async function main() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `spark-worktree-mounts-${process.pid}.cjs`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spark-mounts-electron-"));
  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "worktree-cleanup", "mounts.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      external: ["electron"],
      logLevel: "silent",
    });
    const worktree = path.join(scratch, "worktree");
    const archive = path.join("node_modules", "electron", "dist", "resources", "default_app.asar");
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "a.ts"), "export {};\n");
    writeAsar(path.join(worktree, archive));
    const child = path.join(scratch, "mounts-child.cjs");
    fs.writeFileSync(child, CHILD);
    execFileSync(require("electron"), ["--no-deprecation", child, outfile, worktree, archive], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
      timeout: 60_000,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outfile, { force: true });
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
