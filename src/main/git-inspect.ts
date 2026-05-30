import type {
  GitCommitDetail,
  GitCommitDetailResult,
  GitCommitFile,
  GitDiff,
  GitDiffLine,
  GitFileStatus,
} from "@shared/types";
import { errorText, runGit } from "./git-exec";

// Read-only commit inspection for the History view: full metadata + the list
// of changed files (with +/- counts), and the diff of a single file inside a
// commit. Owned by the history/inspection agent — keep the exported signatures
// stable (ipc.ts wires to them).

const UNIT = String.fromCharCode(0x1f);
const MAX_DIFF_LINES = 4000;

function mapStatusLetter(code: string): GitFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "T":
      return "typechange";
    case "U":
      return "conflicted";
    case "M":
    default:
      return "modified";
  }
}

// numstat: "<add>\t<del>\t<path>"; "-" counts mean a binary file.
function parseCount(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getCommitDetail(cwd: string, hash: string): Promise<GitCommitDetailResult> {
  if (!hash) return { ok: false, error: "No commit given." };
  try {
    const format = [
      "%H",
      "%h",
      "%s",
      "%b",
      "%an",
      "%ae",
      "%cr",
      "%cI",
      "%P",
      "%D",
    ].join(UNIT);
    const metaRaw = (await runGit(cwd, ["show", "-s", `--format=${format}`, hash])).stdout;
    const [
      fullHash,
      shortHash,
      subject,
      body,
      author,
      authorEmail,
      relativeDate,
      isoDate,
      parents,
      decoration,
    ] = metaRaw.replace(/\r?\n$/, "").split(UNIT);

    // name-status and numstat list files in the same order, so zip by index.
    // --first-parent makes a merge show what it brought onto its branch (a plain
    //   two-way diff) instead of git's combined diff, which otherwise emits an
    //   empty name-status and a mismatched numstat for merges.
    // -M -C turn on rename/copy detection so the status code carries the R###/
    //   C### form (→ oldPath) regardless of the repo's diff.renames config; both
    //   commands must use the same flags or their line counts diverge.
    const diffArgs = ["--no-color", "--first-parent", "-M", "-C"];
    const nameStatus = (
      await runGit(cwd, ["show", hash, "--format=", "--name-status", ...diffArgs])
    ).stdout;
    const numstat = (
      await runGit(cwd, ["show", hash, "--format=", "--numstat", ...diffArgs])
    ).stdout;

    const statusLines = nameStatus.split(/\r?\n/).filter(Boolean);
    const numstatLines = numstat.split(/\r?\n/).filter(Boolean);

    const files: GitCommitFile[] = statusLines
      .map((line, index) => {
        const cols = line.split("\t");
        const code = cols[0] ?? "M";
        const status = mapStatusLetter(code);
        // Renames / copies are "R###\told\tnew" (or "C###\told\tnew"); every
        // other status is "X\tpath". Fall back to the last column so a path
        // always lands even if the shape is unexpected.
        const isRenameOrCopy = /^[RC]/.test(code) && cols.length >= 3;
        const oldPath = isRenameOrCopy ? cols[1]?.trim() || undefined : undefined;
        const path = (isRenameOrCopy ? cols[2] : cols[1]) ?? cols[cols.length - 1] ?? "";
        const numCols = (numstatLines[index] ?? "").split("\t");
        return {
          path: path.trim(),
          oldPath,
          status,
          additions: parseCount(numCols[0]),
          deletions: parseCount(numCols[1]),
        };
      })
      .filter((f) => f.path.length > 0);

    const refs = (decoration ?? "")
      .split(",")
      .map((r) => r.trim().replace(/^HEAD -> /, "").replace(/^tag:\s*/, ""))
      .filter((r) => r && r !== "HEAD");

    const detail: GitCommitDetail = {
      hash: fullHash ?? hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      subject: subject ?? "",
      body: (body ?? "").trim(),
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      relativeDate: relativeDate ?? "",
      isoDate: isoDate ?? "",
      parentHashes: parents ? parents.split(" ").filter(Boolean) : [],
      refs,
      files,
    };
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

function classifyDiffLine(line: string): GitDiffLine["kind"] {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (/^(new file|deleted file|old mode|new mode|similarity |dissimilarity |rename |copy |\\)/.test(line)) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

// The diff of a single file as introduced by a commit (vs its first parent).
// --first-parent keeps this a plain two-way diff: for a merge it shows what the
// merge brought onto its branch (git's default combined diff for a merge is
// empty for most files), and for the root commit it diffs against the empty
// tree (full add) rather than failing on a missing parent.
export async function getCommitFileDiff(cwd: string, hash: string, path: string): Promise<GitDiff> {
  if (!hash || !path) return { path, binary: false, lines: [], error: "Missing commit or path." };
  try {
    const { stdout } = await runGit(cwd, [
      "show",
      hash,
      "--no-color",
      "--first-parent",
      "--format=",
      "--",
      path,
    ]);
    if (/^Binary files /m.test(stdout)) return { path, binary: true, lines: [] };
    const all = stdout.split(/\r?\n/);
    const lines: GitDiffLine[] = all
      .slice(0, MAX_DIFF_LINES)
      .map((line) => ({ kind: classifyDiffLine(line), text: line }));
    if (all.length > MAX_DIFF_LINES) {
      lines.push({ kind: "meta", text: `… diff truncated (${all.length - MAX_DIFF_LINES} more lines)` });
    }
    while (lines.length > 0 && lines[lines.length - 1].text === "") lines.pop();
    return { path, binary: false, lines };
  } catch (err) {
    return { path, binary: false, lines: [], error: errorText(err) };
  }
}
