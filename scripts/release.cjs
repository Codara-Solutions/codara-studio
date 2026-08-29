#!/usr/bin/env node
// One-command release: build, sign (+notarize when Apple creds are present),
// package, and publish to the release bucket.
//
//   npm run release:mac   ->  node scripts/release.cjs mac
//   npm run release:win   ->  node scripts/release.cjs win
//
// Loads .env.releases first so BOTH electron-builder (APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID for notarization) and the
// uploader (RELEASES_*) see their credentials.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const envFile = path.join(ROOT, ".env.releases");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const platform = process.argv[2];
if (platform !== "mac" && platform !== "win") {
  console.error("Usage: release.cjs <mac|win>");
  process.exit(1);
}

if (platform === "mac" && !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
  console.warn(
    "\n[release] APPLE_APP_SPECIFIC_PASSWORD not set - the app will be signed " +
      "but NOT notarized.\nAdd APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / " +
      "APPLE_TEAM_ID to .env.releases for notarized builds.\n",
  );
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

run("npm", ["run", `package:${platform}`]);
run("node", [path.join(__dirname, "publish-release.cjs"), platform]);
