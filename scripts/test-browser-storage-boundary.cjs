"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const browserPane = read("src/renderer/src/components/Preview/BrowserPane.tsx");
const main = read("src/main/index.ts");
const privateUserData = read("src/main/private-user-data.ts");
const gitignore = read(".gitignore");

assert.doesNotMatch(browserPane, /setAttribute\("partition"/, "existing browser logins stay in place");
assert.doesNotMatch(browserPane, /document\.cookie|session\.cookies/);
assert.match(privateUserData, /isInsideGitRepository/);
assert.match(privateUserData, /existsSync\(join\(cursor, "\.git"\)\)/);
assert.match(privateUserData, /realpathSync\.native/);
assert.match(main, /safeUserDataOverride\(requestedUserDataDir\)/);
assert.match(main, /delete process\.env\.SPARK_USER_DATA_DIR/);
assert.match(gitignore, /\*\*\/Network\/Cookies/);
assert.match(gitignore, /\*\*\/Cookies/);
assert.match(gitignore, /\*\*\/Local Storage\/leveldb\//);
assert.match(gitignore, /\*\*\/IndexedDB\/\*\.indexeddb\.\*\//);

const tracked = childProcess.execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
for (const file of tracked.split("\0").filter(Boolean)) {
  assert.doesNotMatch(
    file,
    /(?:^|\/)(?:Network\/Cookies(?:-journal)?|Local Storage\/leveldb|Session Storage|WebStorage\/QuotaManager)/i,
    `private browser artifact is tracked: ${file}`,
  );
}

const bundled = esbuild.buildSync({
  entryPoints: [path.join(root, "src/main/private-user-data.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", bundled.outputFiles[0].text)(mod, mod.exports, require);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-browser-privacy-"));
try {
  const repo = path.join(temp, "repo");
  const outside = path.join(temp, "private-profile");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  assert.equal(mod.exports.safeUserDataOverride(path.join(repo, "profile")), undefined);
  assert.equal(mod.exports.safeUserDataOverride(outside), outside);
  if (process.platform !== "win32") {
    const link = path.join(temp, "repo-link");
    fs.symlinkSync(repo, link);
    assert.equal(mod.exports.safeUserDataOverride(path.join(link, "profile")), undefined);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("PASS embedded browser state is isolated outside Git workspaces");
