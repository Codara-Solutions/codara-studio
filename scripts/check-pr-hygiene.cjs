#!/usr/bin/env node
"use strict";

// Pull request hygiene, run by .github/workflows/pr-hygiene.yml.
//
// 1. Size. Counts added + deleted lines against the merge base, leaving out
//    lockfiles and docs. Above WARN_LINES it warns; above FAIL_LINES it fails
//    unless the pull request carries the LARGE_LABEL label.
// 2. Wrong base. Fails when the branch carries commits that are already
//    merged: a squash or merge commit of another pull request ("... (#123)",
//    "Merge pull request #123 ...") that is on an integration branch, or
//    whose subject is already on the base. Those commits inflate
//    the diff (one pull request grew to 21.6k lines by carrying three merged
//    ones) and usually mean the branch was cut from the wrong place.
//
// Usage (CI passes these through the environment):
//   node scripts/check-pr-hygiene.cjs --base origin/Cora --head HEAD \
//     [--head-ref my-branch] [--labels '["large-pr"]']
// Exit code 1 when a check fails. Annotations use the GitHub Actions
// "::warning::" / "::error::" syntax and a summary goes to
// $GITHUB_STEP_SUMMARY when it is set.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const WARN_LINES = 800;
const FAIL_LINES = 2000;
const LARGE_LABEL = "large-pr";
const INTEGRATION_BRANCHES = ["main", "Cora"];
// A squash merge ends its subject with "(#123)"; a merge commit starts with
// "Merge pull request #123".
const MERGED_SUBJECTS = [/\(#(\d+)\)\s*$/, /^Merge pull request #(\d+) /];

// Lines here are generated or prose; they do not make a change harder to
// review the way code does.
const EXCLUDED_PATHS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)(yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/,
  /^docs\//,
  /^CHANGELOG\.md$/,
];

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function shortRef(ref) {
  return ref.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
}

// `git diff --numstat -z`: "add\tdel\tpath\0", or for a rename
// "add\tdel\t\0old\0new\0". Binary files report "-" for both counts.
function parseNumstat(raw) {
  const files = [];
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry);
    if (!match) continue;
    let file = match[3];
    if (file === "") {
      file = parts[i + 2] ?? parts[i + 1] ?? "";
      i += 2;
    }
    const binary = match[1] === "-";
    files.push({
      path: file,
      added: binary ? 0 : Number(match[1]),
      deleted: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return files;
}

function measureSize(cwd, base, head) {
  const files = parseNumstat(git(cwd, ["diff", "--numstat", "-z", "-M", `${base}...${head}`]));
  let counted = 0;
  let excluded = 0;
  for (const file of files) {
    const lines = file.added + file.deleted;
    if (EXCLUDED_PATHS.some((pattern) => pattern.test(file.path))) excluded += lines;
    else counted += lines;
  }
  return { files: files.length, counted, excluded };
}

function findCarriedCommits(cwd, { base, head, headRef }) {
  const headName = headRef ? shortRef(headRef) : null;
  const integration = new Set([base]);
  for (const name of INTEGRATION_BRANCHES) {
    if (name === headName) continue;
    for (const ref of [`origin/${name}`, name]) {
      if (tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null) {
        integration.add(ref);
        break;
      }
    }
  }
  const baseSubjects = new Set(
    git(cwd, ["log", "--format=%s", "-n", "5000", base]).split("\n").filter(Boolean),
  );
  const commits = git(cwd, ["log", "--topo-order", "--format=%H%x00%s", `${base}..${head}`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\0");
      return { sha, subject };
    });
  const others = [...integration].filter((ref) => ref !== base);
  const integrationBranchOf = (sha) =>
    others.find((ref) => tryGit(cwd, ["merge-base", "--is-ancestor", sha, ref]) !== null) ?? null;
  const carried = [];
  for (const commit of commits) {
    const match = MERGED_SUBJECTS.map((pattern) => pattern.exec(commit.subject)).find(Boolean);
    if (!match) continue;
    const onBranch = baseSubjects.has(commit.subject) ? base : integrationBranchOf(commit.sha);
    if (onBranch) carried.push({ ...commit, pr: Number(match[1]), foundOn: shortRef(onBranch) });
  }
  // Commits that only came in with a carried merge (the merged pull
  // request's own commits) are on an integration branch too; they are not
  // the author's work and must stay out of the rebase advice.
  const carriedShas = new Set(carried.map((commit) => commit.sha));
  const own = carried.length
    ? commits.filter((commit) => !carriedShas.has(commit.sha) && !integrationBranchOf(commit.sha))
    : commits;
  return { carried, own, total: commits.length };
}

// The usual shape is a branch cut from a newer integration branch: every
// carried commit sits below the pull request's own work. Then one
// `rebase --onto` drops them. Otherwise the own commits are listed for a
// cherry-pick onto a fresh branch.
// Branch names may hold shell metacharacters; the advice is meant to be
// pasted into a shell.
function shellQuote(value) {
  return /^[A-Za-z0-9._\/@:+=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function rebaseAdvice(cwd, { base, headRef, carried, own }) {
  const baseName = shortRef(base);
  const branchName = headRef ? shortRef(headRef) : "your-branch";
  const branch = shellQuote(branchName);
  const upstream = shellQuote(`origin/${baseName}`);
  if (own.length === 0) {
    return [
      `Every commit on this branch is already merged. Close this pull request, or reset the branch to ${upstream}.`,
    ];
  }
  const newestCarried = carried[0].sha;
  const prefix = carried.every(
    (commit) => tryGit(cwd, ["merge-base", "--is-ancestor", commit.sha, newestCarried]) !== null,
  ) && own.every(
    (commit) => tryGit(cwd, ["merge-base", "--is-ancestor", newestCarried, commit.sha]) !== null,
  );
  if (prefix) {
    return [
      "Rebase only your own commits onto the base:",
      `  git fetch origin ${shellQuote(baseName)}`,
      `  git rebase --onto ${upstream} ${newestCarried.slice(0, 12)} ${branch}`,
      `  git push --force-with-lease origin ${branch}`,
    ];
  }
  return [
    "Your own commits are mixed with merged ones. Start a fresh branch from the base and copy only yours:",
    `  git fetch origin ${shellQuote(baseName)}`,
    `  git switch -c ${shellQuote(`${branchName}-rebased`)} ${upstream}`,
    `  git cherry-pick ${own.map((commit) => commit.sha.slice(0, 12)).reverse().join(" ")}`,
    `Then push it and point this pull request at it (or force-push it to ${branch}).`,
  ];
}

function analyze({ cwd = process.cwd(), base, head = "HEAD", headRef = "", labels = [] }) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const headName = headRef ? shortRef(headRef) : "";
  // A promotion (Cora into main) carries merged work by design.
  if (INTEGRATION_BRANCHES.includes(headName)) {
    notes.push(`Head is the integration branch ${headName}; size and base checks do not apply.`);
    return { errors, warnings, notes, size: null, carried: [] };
  }

  const size = measureSize(cwd, base, head);
  const large = labels.includes(LARGE_LABEL);
  if (size.counted > FAIL_LINES && !large) {
    errors.push(
      `This pull request changes ${size.counted} lines (limit ${FAIL_LINES}, lockfiles and docs not counted). ` +
        `Split it into smaller pull requests, or add the "${LARGE_LABEL}" label if it cannot be split.`,
    );
  } else if (size.counted > WARN_LINES) {
    warnings.push(
      `This pull request changes ${size.counted} lines (over ${WARN_LINES}). Smaller pull requests get reviewed faster and need fewer follow-ups.` +
        (large ? ` The "${LARGE_LABEL}" label allows up to any size.` : ""),
    );
  }

  const { carried, own } = findCarriedCommits(cwd, { base, head, headRef });
  if (carried.length > 0) {
    const listed = carried
      .map((commit) => `  ${commit.sha.slice(0, 12)} ${commit.subject}  (already on ${commit.foundOn})`)
      .join("\n");
    errors.push(
      [
        `This branch carries ${carried.length} commit(s) that are already merged, so the diff shows other people's work:`,
        listed,
        ...rebaseAdvice(cwd, { base, headRef, carried, own }),
      ].join("\n"),
    );
  }
  return { errors, warnings, notes, size, carried };
}

function parseArgs(argv) {
  const options = {
    base: process.env.PR_BASE ?? "",
    head: process.env.PR_HEAD || "HEAD",
    headRef: process.env.PR_HEAD_REF ?? "",
    labels: process.env.PR_LABELS ?? "[]",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key in options) options[key] = argv[++i] ?? "";
  }
  let labels = [];
  try {
    labels = JSON.parse(options.labels || "[]");
  } catch {
    labels = options.labels.split(",").map((label) => label.trim()).filter(Boolean);
  }
  return { ...options, labels: Array.isArray(labels) ? labels : [] };
}

// Annotation messages are one line; newlines must be escaped to survive.
function annotation(kind, message) {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${kind} title=PR hygiene::${escaped}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.base) {
    console.error("check-pr-hygiene: --base (or PR_BASE) is required, for example origin/Cora");
    process.exit(2);
  }
  const result = analyze(options);
  const inActions = process.env.GITHUB_ACTIONS === "true";
  for (const note of result.notes) console.log(note);
  if (result.size) {
    console.log(
      `Size: ${result.size.counted} lines counted across ${result.size.files} files ` +
        `(${result.size.excluded} more in lockfiles and docs not counted).`,
    );
  }
  for (const warning of result.warnings) console.log(inActions ? annotation("warning", warning) : `WARN: ${warning}`);
  for (const error of result.errors) console.log(inActions ? annotation("error", error) : `FAIL: ${error}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["## PR hygiene", ""];
    if (result.size) {
      lines.push(
        `| Lines counted | Not counted (lockfiles, docs) | Warn above | Fail above |`,
        `|---:|---:|---:|---:|`,
        `| ${result.size.counted} | ${result.size.excluded} | ${WARN_LINES} | ${FAIL_LINES} (unless \`${LARGE_LABEL}\`) |`,
        "",
      );
    }
    for (const note of result.notes) lines.push(`- ${note}`);
    for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
    for (const error of result.errors) lines.push("- Failed:", "", "```", error, "```");
    if (!result.errors.length && !result.warnings.length) lines.push("- All good.");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  process.exit(result.errors.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { analyze, parseNumstat, WARN_LINES, FAIL_LINES, LARGE_LABEL };
