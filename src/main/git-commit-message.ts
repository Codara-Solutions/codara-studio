import type { GitCommitMessageResult, GitFileChange, GitStatus } from "@shared/types";
import { computeGitStatus, readUntrackedAsDiff } from "./git-ops";
import { readGitText } from "./git-exec";
import { runSessionlessPiCommitMessage } from "./orchestration/pi-commit-one-shot";
import { loadSettings } from "./storage";

// Drafts an editable commit message from the current changes using an
// isolated, subscription-backed Pi one-shot. The model does the real
// summarizing; the deterministic fallback below runs when no subscription is
// usable or generation fails, and it stays fully
// general — no repository-specific phrasing.

const MAX_PROMPT_CHARS = 28_000;
const MAX_DIFF_CHARS = 10_000;
const MAX_UNTRACKED_FILES = 10;

type Scope = "staged" | "all";

const SYSTEM_PROMPT = `You write concise, high-quality Git commit messages from a diff.

STYLE: The "RECENT COMMIT SUBJECTS" block is your style guide — match its convention exactly. If those subjects use conventional-commit prefixes (e.g. "feat:", "fix:", "refactor:"), use the same kind of prefix; if they are plain imperative ("Add X", "Fix Y"), do NOT invent a prefix. Mirror their capitalization and tone. When there are no prior subjects, default to an imperative subject ("Add X", "Fix Y", "Refactor Z").

SUBJECT: One line, specific and concrete — name the actual capability, component, file, API, or bug the diff changes. Keep it under ~72 characters and with no trailing period. Avoid vague filler ("update", "changes", "various", "misc", "improvements", "enhance handling").

BODY: For a small, focused change, the subject line alone is best. If the diff spans several distinct areas or many files, write the subject, then ONE blank line, then 2-5 bullet points (each starting with "- ") naming the main groups of changes. Do not pad a trivial change with bullets.

OUTPUT: Return only the raw commit message — no markdown code fences, no surrounding quotes, no "Commit message:" / "Here is" label, and no explanation. Never return an empty message.`;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function commitTargetChanges(status: GitStatus, scope: Scope): GitFileChange[] {
  return scope === "staged" ? status.staged : [...status.staged, ...status.unstaged];
}

function formatChangeList(files: GitFileChange[]): string {
  return files
    .map((file) => {
      const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
      return `${file.status}: ${path}`;
    })
    .join("\n");
}

async function collectUntrackedDiff(cwd: string, status: GitStatus): Promise<string> {
  const untracked = status.unstaged.filter((file) => file.untracked);
  if (untracked.length === 0) return "";
  const chunks: string[] = [];
  for (const file of untracked.slice(0, MAX_UNTRACKED_FILES)) {
    const diff = await readUntrackedAsDiff(cwd, file.path);
    if (diff.binary) {
      chunks.push(`diff --git a/${file.path} b/${file.path}\nBinary file`);
    } else if (diff.error) {
      chunks.push(`diff --git a/${file.path} b/${file.path}\n[error: ${diff.error}]`);
    } else {
      chunks.push(
        `diff --git a/${file.path} b/${file.path}\n${diff.lines.map((line) => line.text).join("\n")}`,
      );
    }
  }
  if (untracked.length > MAX_UNTRACKED_FILES) {
    chunks.push(`[${untracked.length - MAX_UNTRACKED_FILES} more untracked files omitted]`);
  }
  return chunks.join("\n\n");
}

// A label models sometimes prepend to the answer ("Here is the commit
// message:", "Commit message:", "Subject:"). Matched case-insensitively at the
// very start and stripped with any trailing colon / dash. Fully generic.
const LEADING_LABEL =
  /^(?:(?:here(?:'s| is| are)?|this is)\s+(?:the |your |a |an )?)?(?:suggested |proposed |final |generated |draft |recommended )?(?:commit message|commit msg|commit|message|subject|title|response|answer)\s*[:\-—]\s*/i;

// Strip the wrappers models like to add (code fences, a leading label, matching
// outer quotes) and normalize whitespace / unicode punctuation.
function sanitize(raw: string): string {
  let text = raw
    .replace(/\r\n/g, "\n")
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .trim();
  // Peel a fenced code block: an opening ``` (optionally language-tagged) on
  // its own line and a closing ``` after it. Loop so a doubly-wrapped reply
  // (a fence inside an outer quote, a label inside a fence, …) is fully
  // unwrapped before we inspect the text.
  for (let i = 0; i < 3; i++) {
    const before = text;
    const fence = text.match(/^```[^\n`]*\n([\s\S]*?)\n?```\s*$/);
    if (fence) text = fence[1].trim();
    else text = text.replace(/^```[a-zA-Z0-9_+-]*\s*/, "").replace(/\s*```$/, "").trim();
    text = text.replace(LEADING_LABEL, "").trim();
    // Drop matching outer quotes (straight, curly, or single backticks)
    // wrapping the whole reply.
    if (
      text.length >= 2 &&
      ((text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'")) ||
        (text.startsWith("“") && text.endsWith("”")) ||
        (text.startsWith("`") && text.endsWith("`") && !text.includes("\n")))
    ) {
      text = text.slice(1, -1).trim();
    }
    if (text === before) break;
  }

  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n");
  if (lines.length === 0) return "";

  // A lone trailing period on the subject is noise; strip it. Leave an ellipsis
  // ("…", "...") and a "type:" prefix's colon untouched.
  lines[0] = lines[0].replace(/(?<!\.)\.$/, "").trimEnd();

  // Guarantee the canonical shape: a body following the subject must be
  // separated by exactly one blank line. Insert it when the model omitted it.
  if (lines.length > 1 && lines[1].trim() !== "") {
    lines.splice(1, 0, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function firstLine(message: string): string {
  return message.split("\n").find((line) => line.trim())?.trim() ?? "";
}

// Drop a leading conventional-commit type prefix ("feat:", "fix(scope):",
// "chore!:") so the vague-word test sees the real subject text.
function stripTypePrefix(subject: string): string {
  return subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").trim();
}

const VAGUE_SUBJECT =
  /^(update|updates|change|changes|changed|modify|modified|edit|edits|tweak|tweaks|misc|miscellaneous|various|sundry|wip|stuff|things|fix|fixes|fixed|improve|improvements?|enhance|enhancements?|cleanup|refactor|patch|commit|work|progress)$/i;

// A generic "the model gave up" detector: empty, or a subject that boils down to
// a vague filler phrase ("update", "various changes", "misc fixes"). Strips any
// type prefix and trailing punctuation first. Stays repository-agnostic.
function looksWeak(message: string): boolean {
  const subject = firstLine(message);
  if (subject.length < 3) return true;
  const core = stripTypePrefix(subject).replace(/[.!]+$/, "").trim();
  if (core.length < 3) return true;
  if (VAGUE_SUBJECT.test(core)) return true;
  // Two-word "<filler> <generic-noun>" forms with no concrete subject:
  // "various changes", "misc fixes", "minor updates", "update files".
  const words = core.split(/\s+/);
  if (words.length === 2) {
    const filler = /^(various|misc|miscellaneous|minor|small|several|some|general|assorted|update|modify|change|code|project|repo|repository)$/i;
    const noun = /^(changes?|updates?|edits?|tweaks?|fixes?|files?|stuff|things|improvements?|cleanups?|work|code)$/i;
    if (filler.test(words[0]) && noun.test(words[1])) return true;
  }
  return false;
}

// ── Deterministic fallback (model unavailable / unusable) ─────────────────────

// Sniff whether the repo's recent history follows conventional-commits
// ("type: subject"). Returns the dominant type-word casing convention so the
// deterministic fallback can blend in, or null for plain imperative subjects.
// Purely statistical over whatever subjects exist — no hardcoded repo terms.
function detectConventionalPrefix(recentSubjects: string): boolean {
  const subjects = recentSubjects
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (subjects.length < 3) return false;
  const conventional = subjects.filter((s) =>
    /^[a-z]+(?:\([^)]*\))?!?:\s+\S/.test(s),
  ).length;
  // Only claim the convention when a clear majority follows it.
  return conventional / subjects.length >= 0.6;
}

// Map our coarse verb to a conventional-commits type word.
function conventionalType(files: GitFileChange[]): string {
  if (files.length === 0) return "chore";
  if (files.some((f) => f.status === "conflicted")) return "fix";
  if (files.every((f) => f.status === "added" || f.untracked)) return "feat";
  if (files.every((f) => f.status === "deleted")) return "chore";
  return "chore";
}

function humanizeName(value: string): string {
  const stem = value
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim();
  return stem || "project files";
}

// Deepest directory shared by every changed path, or null when they diverge at
// the root.
function commonDirectory(paths: string[]): string | null {
  const parts = paths.map((p) => p.split("/").filter(Boolean).slice(0, -1));
  if (parts.length === 0 || parts.some((p) => p.length === 0)) return null;
  const first = parts[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const segment = first[i];
    if (parts.every((p) => p[i] === segment)) common.push(segment);
    else break;
  }
  return common.length > 0 ? common[common.length - 1] : null;
}

function describeArea(files: GitFileChange[]): string {
  const paths = files.map((f) => f.path);
  if (paths.length === 1) {
    const name = paths[0].split("/").pop() ?? paths[0];
    return humanizeName(name);
  }
  const dir = commonDirectory(paths);
  if (dir) return humanizeName(dir);
  return "project files";
}

function fallbackVerb(files: GitFileChange[]): string {
  if (files.length === 0) return "Update";
  if (files.every((f) => f.status === "added" || f.untracked)) return "Add";
  if (files.every((f) => f.status === "deleted")) return "Remove";
  if (files.every((f) => f.status === "renamed")) return "Rename";
  if (files.some((f) => f.status === "conflicted")) return "Resolve";
  return "Update";
}

// Build a never-empty, genuinely descriptive draft straight from the file
// statuses and paths. Matches a conventional-commits convention when the repo's
// recent history clearly uses one, otherwise writes a plain imperative subject.
function buildFallbackMessage(files: GitFileChange[], recentSubjects = ""): string {
  const area = describeArea(files);
  const subject = detectConventionalPrefix(recentSubjects)
    ? `${conventionalType(files)}: ${area}`
    : `${fallbackVerb(files)} ${area}`;
  if (files.length <= 5) return subject;

  // Many files: list the top-level areas they touch so the body is still
  // informative without inventing specifics.
  const areas = new Map<string, number>();
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const top = segments.length > 1 ? segments[0] : segments[0] || file.path;
    areas.set(top, (areas.get(top) ?? 0) + 1);
  }
  const bullets = [...areas.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `- ${name} (${count} file${count === 1 ? "" : "s"})`);
  return bullets.length > 1 ? `${subject}\n\n${bullets.join("\n")}` : subject;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(input: {
  scope: Scope;
  recentSubjects: string;
  statusShort: string;
  changeList: string;
  stagedDiff: string;
  unstagedDiff: string;
  untrackedDiff: string;
}): string {
  const target =
    input.scope === "staged"
      ? "the staged changes only. Unstaged and untracked changes are NOT part of this commit."
      : "all current changes. Nothing is staged yet, so everything below will be committed together.";
  const diffSections =
    input.scope === "staged"
      ? `STAGED DIFF:\n${truncate(input.stagedDiff || "(none)", MAX_DIFF_CHARS)}`
      : `STAGED DIFF:\n${truncate(input.stagedDiff || "(none)", MAX_DIFF_CHARS)}\n\nUNSTAGED DIFF:\n${truncate(
          input.unstagedDiff || "(none)",
          MAX_DIFF_CHARS,
        )}\n\nUNTRACKED FILE PREVIEW:\n${truncate(input.untrackedDiff || "(none)", MAX_DIFF_CHARS / 2)}`;

  const body = `RECENT COMMIT SUBJECTS (style reference):
${input.recentSubjects || "(no previous commits)"}

COMMIT TARGET: ${target}

GIT STATUS:
${input.statusShort || "(none)"}

CHANGED FILES:
${input.changeList || "(none)"}

${diffSections}

Write the commit message for the commit target described above.`;
  return truncate(body, MAX_PROMPT_CHARS);
}

export async function generateCommitMessage(cwd: string): Promise<GitCommitMessageResult> {
  try {
    const status = await computeGitStatus(cwd);
    if (!status.isRepo) {
      return { ok: false, error: status.error ?? "Not a git repository." };
    }
    if (status.staged.length + status.unstaged.length === 0) {
      return { ok: false, error: "No changes to summarize." };
    }
    const scope: Scope = status.staged.length > 0 ? "staged" : "all";
    const files = commitTargetChanges(status, scope);

    // Recent subjects double as the model's style guide AND, when no model is
    // available, the convention hint for the deterministic fallback. Read it up
    // front so both paths can use it. Best-effort: "" on an unborn branch.
    const recentSubjects = await readGitText(cwd, ["log", "--max-count=12", "--pretty=format:%s"]);

    const settings = await loadSettings();

    const [statusShort, stagedDiff, unstagedDiff, untrackedDiff] = await Promise.all([
      readGitText(cwd, ["status", "--short"]),
      readGitText(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3"]),
      scope === "all"
        ? readGitText(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=3"])
        : Promise.resolve(""),
      scope === "all" ? collectUntrackedDiff(cwd, status) : Promise.resolve(""),
    ]);

    const prompt = buildPrompt({
      scope,
      recentSubjects,
      statusShort,
      changeList: formatChangeList(files),
      stagedDiff,
      unstagedDiff,
      untrackedDiff,
    });

    const generated = await runSessionlessPiCommitMessage({
      cwd,
      modelSelection: settings.commitMessageModel,
      systemPrompt: SYSTEM_PROMPT,
      prompt,
    }).catch(() => null);
    let message = sanitize(generated?.text ?? "");
    if (!message || looksWeak(message)) {
      message = buildFallbackMessage(files, recentSubjects);
    }
    return { ok: true, message };
  } catch (err) {
    const e = err as { message?: unknown };
    return { ok: false, error: typeof e?.message === "string" ? e.message : String(err) };
  }
}
