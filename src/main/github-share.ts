import {
  GITHUB_PUBLISH_MAX_BODY_LENGTH,
  GITHUB_PUBLISH_MAX_TITLE_LENGTH,
  isValidShareBranchName,
  type GitHubShareDraft,
  type GitHubShareInput,
  type GitHubShareResult,
} from "@shared/github";
import type { GitStatus } from "@shared/types";
import { computeGitStatus } from "./git-ops";
import { createBranch } from "./git-branches";
import { readGitText } from "./git-exec";
import { createGitHubCliAdapter } from "./github-cli";
import { publishGitHubWorktree, parsePublishInput } from "./github-publish";
import { runSessionlessPiCommitMessage } from "./orchestration/pi-commit-one-shot";
import { loadSettings } from "./storage";
import { runInlineAiChatCompletion } from "./inline-ai";
import { randomUUID } from "node:crypto";

// "Share for review" — the one-button flow that turns whatever the user (or
// Cora) changed into a pull request without asking them to learn Git ceremony.
//
// Two halves, both invoked over IPC:
//
//   draftGitHubShare   — read-only. Gathers the branch's diff/commits and asks
//                        the configured commit-message model for a branch name,
//                        PR title, commit message, and description in one call.
//                        Falls back to deterministic drafts so the dialog is
//                        never blocked on a model.
//   shareGitHubWorktree — the write path. When the workspace sits on the
//                        repository's default branch, creates + checks out the
//                        approved topic branch first (the one thing publish
//                        refuses to do), then delegates every remaining phase
//                        to publishGitHubWorktree, which stays the single
//                        reviewed commit/push/create transaction.

const MAX_DIFF_CHARS = 24_000;
const MAX_PROMPT_CHARS = 60_000;
const MAX_LOG_SUBJECTS = 30;

const DRAFT_SYSTEM_PROMPT = `You prepare a GitHub pull request from a Git diff. Reply with STRICT JSON — one object, no markdown fences, no commentary — with exactly these keys:
{"branch": string, "title": string, "commit": string, "description": string}

branch: a short kebab-case topic branch name (2-4 words, optionally "feat/"- or "fix/"-prefixed to match the repository's history). Lowercase letters, digits, dashes and at most one slash.
title: the pull request title — one line, imperative, specific, under 70 characters, no trailing period.
commit: a commit message for the working-tree changes. Subject line under 72 characters matching the repository's convention (shown in RECENT COMMIT SUBJECTS); add 2-5 "- " bullets after a blank line when the diff spans several areas.
description: the pull request body in GitHub Markdown. Open with one short plain-language paragraph a non-programmer can understand (what changed and why it matters). Then a "## Changes" section with concise bullets naming the concrete parts. Do not invent testing you cannot see; if the diff contains tests, mention them.

Ground every field in the diff. Never return empty strings.`;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
}

function fallbackDraft(status: GitStatus, recentSubjects: string): GitHubShareDraft {
  const files = [...status.staged, ...status.unstaged];
  const first = files[0]?.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "changes";
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const area = slugify(first) || "changes";
  const conventional = /^[a-z]+(\([^)]*\))?!?:\s/m.test(recentSubjects);
  const subject = files.length === 1 ? `Update ${first}` : `Update ${files.length} files`;
  return {
    branch: `share/${area}-${stamp}`,
    title: subject,
    commitMessage: conventional ? `chore: ${subject.toLowerCase()}` : subject,
    description: `Changes shared for review from Codara Studio.\n\n## Changes\n${files
      .slice(0, 10)
      .map((f) => `- \`${f.path}\``)
      .join("\n")}${files.length > 10 ? `\n- …and ${files.length - 10} more files` : ""}`,
    source: "fallback",
  };
}

// Extract the first JSON object from a model reply that may carry fences or
// stray prose despite the instructions.
function parseDraftJson(raw: string): {
  branch?: string;
  title?: string;
  commit?: string;
  description?: string;
} | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const field = (key: string): string | undefined =>
      typeof record[key] === "string" && (record[key] as string).trim()
        ? (record[key] as string).trim()
        : undefined;
    return {
      branch: field("branch"),
      title: field("title"),
      commit: field("commit"),
      description: field("description"),
    };
  } catch {
    return null;
  }
}

async function collectShareContext(cwd: string, base: string | null) {
  const [recentSubjects, statusShort, workingDiff, stagedDiff, branchDiff, branchLog] =
    await Promise.all([
      readGitText(cwd, ["log", `--max-count=${MAX_LOG_SUBJECTS}`, "--pretty=format:%s"]),
      readGitText(cwd, ["status", "--short"]),
      readGitText(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=3"]),
      readGitText(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3"]),
      base
        ? readGitText(cwd, [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=3",
            `origin/${base}...HEAD`,
          ])
        : Promise.resolve(""),
      base
        ? readGitText(cwd, ["log", "--pretty=format:%s%n%b", `origin/${base}..HEAD`])
        : Promise.resolve(""),
    ]);
  return { recentSubjects, statusShort, workingDiff, stagedDiff, branchDiff, branchLog };
}

/**
 * Read-only: draft branch/title/commit/description for the current workspace.
 * Uses the user's configured commit-message model (Settings → Git commit
 * messages); a model failure degrades to a deterministic draft, never an error.
 */
export async function draftGitHubShare(cwd: string): Promise<GitHubShareDraft> {
  const status = await computeGitStatus(cwd);
  if (!status.isRepo) throw new Error("This workspace is not a Git repository.");

  let base: string | null = null;
  try {
    base = (await createGitHubCliAdapter().resolveRepository(cwd)).defaultBranch ?? null;
  } catch {
    // GitHub being unreachable must not block drafting: the diff still exists.
  }

  const context = await collectShareContext(cwd, base);
  const fallback = fallbackDraft(status, context.recentSubjects);

  const prompt = truncate(
    `RECENT COMMIT SUBJECTS (style reference):
${context.recentSubjects || "(no previous commits)"}

GIT STATUS:
${context.statusShort || "(clean)"}

COMMITS ALREADY ON THIS BRANCH (not yet on ${base ?? "the default branch"}):
${truncate(context.branchLog || "(none)", 6_000)}

BRANCH DIFF AGAINST ${base ? `origin/${base}` : "the base"}:
${truncate(context.branchDiff || "(none)", MAX_DIFF_CHARS)}

STAGED DIFF:
${truncate(context.stagedDiff || "(none)", MAX_DIFF_CHARS / 2)}

UNSTAGED DIFF:
${truncate(context.workingDiff || "(none)", MAX_DIFF_CHARS / 2)}

Draft the pull request JSON now.`,
    MAX_PROMPT_CHARS,
  );

  const settings = await loadSettings();
  const generated =
    settings.commitMessageModel === "openrouter"
      ? await runInlineAiChatCompletion({
          modelId: settings.openRouterModel,
          requestId: `github-share-${randomUUID()}`,
          maxTokens: 1400,
          temperature: 0.3,
          reasoningEffort: "low",
          messages: [
            { role: "system", content: DRAFT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        })
          .then((result) => (result.error ? null : result))
          .catch(() => null)
      : await runSessionlessPiCommitMessage({
          cwd,
          modelSelection: settings.commitMessageModel,
          systemPrompt: DRAFT_SYSTEM_PROMPT,
          prompt,
        }).catch(() => null);

  const parsed = generated?.text ? parseDraftJson(generated.text) : null;
  if (!parsed) return fallback;

  const branch =
    parsed.branch && isValidShareBranchName(parsed.branch) ? parsed.branch : fallback.branch;
  return {
    branch,
    title: (parsed.title ?? fallback.title).slice(0, GITHUB_PUBLISH_MAX_TITLE_LENGTH),
    commitMessage: parsed.commit ?? fallback.commitMessage,
    description: (parsed.description ?? fallback.description).slice(
      0,
      GITHUB_PUBLISH_MAX_BODY_LENGTH,
    ),
    source: "ai",
  };
}

/**
 * The write path behind the Share dialog's confirm button.
 *
 * Creates + checks out `input.branch` first when (and only when) the workspace
 * sits on the repository's default branch — the explicit branch name in the
 * input is the authorization for that step, mirroring how `commitMessage`
 * authorizes committing dirty files. Everything else (fetch, preflight, stage,
 * commit, push, create, verify) is publishGitHubWorktree, unchanged.
 */
export async function shareGitHubWorktree(
  cwd: string,
  rawInput: unknown,
): Promise<GitHubShareResult> {
  const record =
    typeof rawInput === "object" && rawInput !== null
      ? (rawInput as Record<string, unknown>)
      : {};
  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  // Validate the publish fields up front so a bad title fails before we create
  // any branch. parsePublishInput throws with a bounded, readable message.
  const publishInput: GitHubShareInput = parsePublishInput({ ...record, branch: undefined });

  let createdBranch: string | undefined;
  if (branch) {
    if (!isValidShareBranchName(branch)) {
      throw new Error("The topic branch name is not valid.");
    }
    const status = await computeGitStatus(cwd);
    if (!status.isRepo) throw new Error("This workspace is not a Git repository.");
    let defaultBranch: string | undefined;
    try {
      defaultBranch = (await createGitHubCliAdapter().resolveRepository(cwd)).defaultBranch;
    } catch (cause) {
      throw new Error(
        cause instanceof Error ? cause.message : "GitHub repository details could not be loaded.",
      );
    }
    // Only branch away from the DEFAULT branch. On a topic branch the name is
    // ignored — publish continues on the branch the user is already on.
    if (!status.detached && status.branch && status.branch === defaultBranch) {
      const created = await createBranch(cwd, branch, { checkout: true });
      if (!created.ok) {
        throw new Error(created.error ?? "The topic branch could not be created.");
      }
      createdBranch = branch;
    }
  }

  const result = await publishGitHubWorktree(cwd, publishInput);
  return createdBranch ? { ...result, createdBranch } : result;
}
