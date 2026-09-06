"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FEEDS = ["latest-mac.yml", "latest.yml"];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ +-]*$/;
const hash = (body) => crypto.createHash("sha512").update(body).digest("base64");

function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error("Invalid release version");
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function feedVersion(body) {
  const matches = [...body.toString("utf8").matchAll(/^version: *['"]?(\d+\.\d+\.\d+)['"]? *\r?$/gm)];
  if (matches.length !== 1 || !VERSION.test(matches[0][1])) throw new Error("Invalid release feed version");
  return matches[0][1];
}

function readFile(dir, name) {
  if (!NAME.test(name)) throw new Error(`Unsafe artifact name: ${name}`);
  const file = path.join(dir, name);
  if (!fs.lstatSync(file).isFile()) throw new Error(`Artifact is not a regular file: ${name}`);
  return fs.readFileSync(file);
}

function verifyBundle(dir, expected = {}) {
  const manifest = JSON.parse(readFile(dir, "release.json"));
  if (manifest.schema !== 1 || !VERSION.test(manifest.version) ||
      !/^[a-f0-9]{40}$/.test(manifest.sha) || !/^[1-9]\d*$/.test(manifest.runId) ||
      !Array.isArray(manifest.files) || manifest.files.length < 5) {
    throw new Error("Invalid release bundle metadata");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) throw new Error(`Release bundle ${key} does not match its source`);
  }
  const names = manifest.files.map((file) => file.name);
  if (new Set(names).size !== names.length || names.includes("release.json") ||
      FEEDS.some((name) => !names.includes(name)) ||
      [".dmg", ".zip", ".exe"].some((ext) => !names.some((name) => name.endsWith(ext)))) {
    throw new Error("Release bundle must contain both platforms without duplicate files");
  }
  const actual = fs.readdirSync(dir).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names, "release.json"].sort())) {
    throw new Error("Unexpected or missing files in release bundle");
  }
  for (const file of manifest.files) {
    const body = readFile(dir, file.name);
    if (body.length !== file.size || hash(body) !== file.sha512) throw new Error(`Artifact checksum mismatch: ${file.name}`);
    if (FEEDS.includes(file.name) && feedVersion(body) !== manifest.version) throw new Error("Feed version mismatch");
    if (file.name.endsWith(".yml") && !FEEDS.includes(file.name)) throw new Error("Unexpected release feed");
  }
  return manifest;
}

function createBundle(dist, dir, { version, sha, runId }) {
  // YAML is needed only on the build runner. Privileged jobs use the sealed file list.
  const yaml = require("js-yaml");
  const names = new Set(FEEDS);
  for (const name of FEEDS) {
    const feed = yaml.load(readFile(dist, name).toString("utf8"));
    if (feed.version !== version || !Array.isArray(feed.files) || !feed.files.length) throw new Error(`Incomplete feed: ${name}`);
    for (const entry of feed.files) {
      const body = readFile(dist, entry.url);
      if (entry.size !== body.length || entry.sha512 !== hash(body)) throw new Error(`Invalid feed checksum: ${entry.url}`);
      names.add(entry.url);
    }
    if (!feed.files.some((entry) => entry.url === feed.path && entry.sha512 === feed.sha512)) {
      throw new Error(`Legacy feed entry differs from files: ${name}`);
    }
  }
  // The DMG is a direct download and may not be listed by electron-updater.
  for (const name of fs.readdirSync(dist)) {
    if (name.endsWith(".dmg")) names.add(name);
    if (name.endsWith(".blockmap") && names.has(name.slice(0, -9))) names.add(name);
  }
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error("Release bundle destination must be empty");
  const files = [...names].sort().map((name) => {
    const body = readFile(dist, name);
    fs.writeFileSync(path.join(dir, name), body, { flag: "wx" });
    return { name, size: body.length, sha512: hash(body) };
  });
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ schema: 1, version, sha, runId, files }, null, 2) + "\n", { flag: "wx" });
  return verifyBundle(dir, { version, sha, runId });
}

module.exports = { FEEDS, compareVersions, feedVersion, hash, verifyBundle, createBundle };

if (require.main === module) {
  try {
    const [command, dir = "release-bundle"] = process.argv.slice(2);
    const expected = { sha: process.env.RELEASE_SHA, runId: process.env.RELEASE_RUN_ID };
    if (!expected.sha || !expected.runId) throw new Error("Release source SHA and run ID are required");
    const manifest = command === "create"
      ? createBundle("dist", dir, { ...expected, version: process.env.RELEASE_VERSION })
      : command === "verify" ? verifyBundle(dir, expected) : null;
    if (!manifest) throw new Error("Usage: release-bundle.cjs <create|verify> [directory]");
    console.log(`Verified v${manifest.version} at ${manifest.sha} from run ${manifest.runId}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${manifest.version}\n`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
