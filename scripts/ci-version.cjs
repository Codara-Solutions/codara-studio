#!/usr/bin/env node
// CI release versioning: derive the next semantic version from conventional
// commits since the last release TAG (vX.Y.Z), write it into package.json,
// and expose outputs for the workflow. Mirrors the rules in release.cjs:
// breaking change -> major, feat -> minor, anything else -> patch.
//
// Outputs (GITHUB_OUTPUT): version=<X.Y.Z> skip=<true|false>
// Skips when HEAD is a release bookkeeping commit ("release: vX.Y.Z" from the
// local pipeline) or when no commits landed since the last release tag.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function git(args) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function output(kv) {
  const line = Object.entries(kv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  console.log(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line + "\n");
}

const headSubject = git(["log", "-1", "--format=%s"]);
if (/^release: v\d/.test(headSubject)) {
  output({ skip: "true", version: "" });
  process.exit(0);
}

// Highest vX.Y.Z tag = the last shipped version.
const tags = git(["tag", "--list", "v[0-9]*"])
  .split("\n")
  .filter(Boolean)
  .map((t) => t.slice(1).split(".").map(Number))
  .filter((p) => p.length === 3 && p.every(Number.isFinite))
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
if (tags.length === 0) throw new Error("no vX.Y.Z release tag found; push one to seed CI releases");
const last = tags[tags.length - 1];
const lastTag = `v${last.join(".")}`;

const log = git(["log", "--format=%s%n%b", `${lastTag}..HEAD`]);
if (log.trim() === "") {
  output({ skip: "true", version: "" });
  process.exit(0);
}

const level =
  /^[a-z]+(\([^)]*\))?!:/m.test(log) || /^BREAKING CHANGE:/m.test(log)
    ? "major"
    : /^feat(\([^)]*\))?:/m.test(log)
      ? "minor"
      : "patch";
const next =
  level === "major"
    ? [last[0] + 1, 0, 0]
    : level === "minor"
      ? [last[0], last[1] + 1, 0]
      : [last[0], last[1], last[2] + 1];
const version = next.join(".");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = version;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log(`[ci-version] ${lastTag} + ${level} -> ${version}`);
output({ skip: "false", version });
