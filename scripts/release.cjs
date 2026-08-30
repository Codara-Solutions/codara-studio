#!/usr/bin/env node
// One-command release from a PRISTINE checkout: never the live working tree.
//
//   npm run release:mac   ->  node scripts/release.cjs mac
//   npm run release:win   ->  node scripts/release.cjs win
//   npm run release:all   ->  node scripts/release.cjs all   (one version bump,
//                             both platforms; what the release automation runs)
//
// Flow: a temporary `git worktree` is created at RELEASE_SHA (default: the
// repo's current HEAD), the version bump + build + publish all happen inside
// that worktree, the bump commit is brought back onto the main repo's HEAD
// with cherry-pick, and the worktree is removed. Builds are therefore
// reproducible (a release IS a commit) and immune to concurrent edits in the
// live tree.
//
// node_modules is SYMLINKED into the worktree rather than reinstalled. That is
// safe because the build only reads dependencies: no lifecycle scripts run
// (we invoke electron-vite/electron-builder directly, not npm install), the
// native modules are already built for the pinned Electron, and all build
// outputs (out/, dist/) land inside the worktree, never inside node_modules.
//
// Loads .env.releases first so BOTH electron-builder (APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID for notarization) and the
// uploader (RELEASES_*) see their credentials; children inherit process.env.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const envFile = path.join(ROOT, ".env.releases");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const target = process.argv[2];
if (target !== "mac" && target !== "win" && target !== "all") {
  console.error("Usage: release.cjs <mac|win|all>");
  process.exit(1);
}
const platforms = target === "all" ? ["mac", "win"] : [target];

if (platforms.includes("mac") && !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
  console.warn(
    "\n[release] APPLE_APP_SPECIFIC_PASSWORD not set: the app will be signed " +
      "but NOT notarized.\nAdd APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / " +
      "APPLE_TEAM_ID to .env.releases for notarized builds.\n",
  );
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status ?? "signal"}`);
  }
}

function capture(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited with ${res.status ?? "signal"}: ${res.stderr ?? ""}`,
    );
  }
  return res.stdout.trim();
}

// Semantic bump from the conventional-commit subjects since the last release
// commit ("release: vX.Y.Z"): breaking change -> major, feat -> minor,
// anything else -> patch. RELEASE_BUMP=major|minor|patch overrides.
function bumpLevel(cwd) {
  const forced = process.env.RELEASE_BUMP;
  if (forced === "major" || forced === "minor" || forced === "patch") return forced;
  let range = "HEAD";
  const last = spawnSync(
    "git",
    ["log", "--grep", "^release: v", "--format=%H", "-1", "HEAD"],
    { cwd, encoding: "utf8" },
  ).stdout.trim();
  if (last) range = `${last}..HEAD`;
  const log = spawnSync("git", ["log", "--format=%s%n%b", range], {
    cwd,
    encoding: "utf8",
  }).stdout;
  if (/^[a-z]+(\([^)]*\))?!:/m.test(log) || /^BREAKING CHANGE:/m.test(log)) return "major";
  if (/^feat(\([^)]*\))?:/m.test(log)) return "minor";
  return "patch";
}

const sha = process.env.RELEASE_SHA || capture("git", ["rev-parse", "HEAD"], ROOT);
const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "codara-release-"));

function cleanup() {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: ROOT });
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(worktree, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    spawnSync("git", ["worktree", "prune"], { cwd: ROOT });
  } catch {
    /* best effort */
  }
}

let bumpSha = null;
let newVersion = null;
try {
  console.log(`[release] pristine worktree at ${sha.slice(0, 10)} -> ${worktree}`);
  // mkdtemp created the dir; worktree add wants to create it itself.
  fs.rmSync(worktree, { recursive: true, force: true });
  run("git", ["worktree", "add", "--detach", worktree, sha], ROOT);
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(worktree, "node_modules"), "junction");

  run("npm", ["version", bumpLevel(worktree), "--no-git-tag-version"], worktree);
  newVersion = JSON.parse(
    fs.readFileSync(path.join(worktree, "package.json"), "utf8"),
  ).version;
  console.log(`[release] building v${newVersion} for: ${platforms.join(", ")}`);

  // RELEASE_SKIP_BUILD=1 is a test seam: it exercises the worktree, bump,
  // commit and cherry-pick mechanics without a 15 minute build or an upload.
  if (process.env.RELEASE_SKIP_BUILD !== "1") {
    for (const platform of platforms) {
      run("npm", ["run", `package:${platform}`], worktree);
      run("node", [path.join(worktree, "scripts", "publish-release.cjs"), platform], worktree);
    }
  } else {
    console.log("[release] RELEASE_SKIP_BUILD=1: skipping build and publish");
  }

  // Record the shipped version as a commit made from the pristine checkout,
  // then bring it back onto the main repo's current branch. The "release:"
  // subject keeps the automation's nothing-to-release guard meaningful.
  run("git", ["add", "package.json", "package-lock.json"], worktree);
  run("git", ["commit", "-m", `release: v${newVersion}`], worktree);
  bumpSha = capture("git", ["rev-parse", "HEAD"], worktree);
} catch (err) {
  cleanup();
  console.error(`\n[release] FAILED: ${err.message}`);
  process.exit(1);
}

cleanup();

try {
  run("git", ["cherry-pick", bumpSha], ROOT);
  console.log(`\n[release] v${newVersion} published; version bump cherry-picked onto HEAD.`);
} catch (err) {
  // The artifacts are already live; only the bookkeeping commit failed (a
  // dirty package.json in the live tree, usually). Keep the commit reachable
  // and tell the operator exactly how to finish.
  try {
    run("git", ["cherry-pick", "--abort"], ROOT);
  } catch {
    /* nothing in flight */
  }
  spawnSync("git", ["branch", "-f", `release-v${newVersion}`, bumpSha], { cwd: ROOT });
  console.error(
    `\n[release] v${newVersion} is published, but the version-bump commit could not ` +
      `be cherry-picked onto the live tree (${err.message}).\nIt is preserved on ` +
      `branch release-v${newVersion}; merge or cherry-pick it manually.`,
  );
  process.exit(1);
}
