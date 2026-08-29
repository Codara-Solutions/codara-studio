import type { GitFileChange, GitStatus } from "@shared/types";
import {
  GIT_SPLIT_MAX_GROUPS,
  extractDiffSymbols,
  normalizeSplitGroups,
  orderSplitGroups,
  splitPlanViolation,
  type GitSplitExecuteResult,
  type GitSplitGroup,
  type GitSplitPlanResult,
} from "@shared/git-split";
import {
  computeGitStatus,
  stageFiles,
  unstageAll,
  commitChanges,
  readUntrackedAsDiff,
} from "./git-ops";
import { readGitText } from "./git-exec";
import { runSessionlessPiCommitMessage } from "./orchestration/pi-commit-one-shot";
import { loadSettings } from "./storage";
import { runInlineAiChatCompletion } from "./inline-ai";
import { randomUUID } from "node:crypto";

// "Split into commits": ask a model to group the working tree's changes into
// a few coherent commits, let the user review/edit the plan, then execute it
// with plain `git add <files>` + `git commit` per group — file-level only, no
// hunk splitting, because that is where corruption risk lives.
//
// Model quality degrades gracefully: an unusable plan becomes a single
// "everything" group the user can still commit, never an error dead-end.

const MAX_PROMPT_CHARS = 60_000;
const MAX_DIFF_CHARS = 24_000;
const MAX_UNTRACKED_PREVIEW = 10;

const PLAN_SYSTEM_PROMPT = `You group uncommitted changes into separate, coherent Git commits.

Rules:
- Group by PURPOSE, not by folder: a feature and its tests/docs belong together; an unrelated bugfix or rename belongs apart.
- Every changed file must appear in exactly one group. Never invent paths.
- SHARED PLUMBING: a file whose changes serve several purposes (shared type files, ipc/preload wiring, registries) goes in the FIRST group that needs it. Later groups must not claim it.
- HITCHHIKERS: an unrelated small fix or cleanup (a positioning bug, a typo fix, a stray rename) must be its OWN group with a fix:/chore: style subject, not folded into a feature group. Exception: when one FILE mixes feature work and the fix, the file stays with the feature (files are atomic here) and that group's message must mention the fix.
- Prefer 2-5 groups. If the changes genuinely form one unit of work, return a single group.
- Order groups so earlier commits do not depend on later ones when detectable — a group importing a symbol another group introduces must come AFTER it.
- Each group's "message" is a placeholder subject line under ~72 chars (final messages are written separately from each group's own diff).
- Each group's "reason" is ONE short plain-language sentence a non-programmer understands, e.g. "The new sharing button and its tests".

Output ONLY strict JSON, no fences, in this exact shape:
{"groups":[{"message":"...","reason":"...","files":["path/one","path/two"]}]}`;

// Per-group message pass: each commit's message is written from ONLY that
// group's diff, so it cannot describe work living in another commit — the
// exact failure mode of single-pass splitting (messages claiming ipc wiring
// or types that landed elsewhere).
const MESSAGE_SYSTEM_PROMPT = `You write one Git commit message for exactly the diff you are shown.

Rules:
- Describe ONLY what this diff does. It may be one slice of a larger effort — other commits in the series are listed for context; NEVER claim their work. If wiring or types for a mentioned feature are absent from this diff, do not say they are here.
- Subject line under ~72 chars, matching the style of the recent subjects shown.
- Then a blank line and 2-6 body bullets when the diff spans multiple files/areas: name the concrete modules, functions, and behaviors from the diff, and state intent or invariants when visible. A trivial single-file diff may be subject-only.
- Output ONLY the raw commit message. No fences, no labels, no commentary.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

/** Working tree's changed paths, staged+unstaged deduped, stable order. */
function changedPaths(status: GitStatus): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...status.staged, ...status.unstaged]) {
    if (!seen.has(f.path)) {
      seen.add(f.path);
      out.push(f.path);
    }
  }
  return out;
}

function changeByPath(status: GitStatus): Map<string, GitFileChange> {
  const map = new Map<string, GitFileChange>();
  for (const f of [...status.staged, ...status.unstaged]) {
    if (!map.has(f.path)) map.set(f.path, f);
  }
  return map;
}

async function collectUntrackedDiff(cwd: string, status: GitStatus): Promise<string> {
  const untracked = status.unstaged.filter((f) => f.untracked).slice(0, MAX_UNTRACKED_PREVIEW);
  if (untracked.length === 0) return "";
  const parts = await Promise.all(
    untracked.map(async (f) => {
      const diff = await readUntrackedAsDiff(cwd, f.path).catch(() => null);
      if (!diff || diff.error) return `diff --git a/${f.path} b/${f.path}\n[unreadable]`;
      if (diff.binary) return `diff --git a/${f.path} b/${f.path}\nBinary file`;
      return `diff --git a/${f.path} b/${f.path}\n${diff.lines.map((l) => l.text).join("\n")}`;
    }),
  );
  return truncate(parts.join("\n\n"), MAX_DIFF_CHARS / 2);
}

/** The single-commit degradation: everything in one group, honest label. */
function fallbackPlan(paths: string[]): GitSplitPlanResult {
  return {
    ok: true,
    source: "fallback",
    groups: [
      {
        message: "Update project files",
        reason: "Could not group the changes automatically — this saves everything as one commit.",
        files: paths,
      },
    ],
  };
}

/** Pull the {"groups":[…]} object out of model text that may carry fences or prose. */
export function parsePlanText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { groups?: unknown };
    return parsed?.groups ?? null;
  } catch {
    return null;
  }
}

/** One model call with the configured commit-message model; null on any failure. */
async function runModel(
  cwd: string,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  systemPrompt: string,
  prompt: string,
  maxTokens: number,
): Promise<string | null> {
  const generated = settings.commitMessageModel === "openrouter"
    ? await runInlineAiChatCompletion({
        modelId: settings.openRouterModel,
        requestId: `git-split-${randomUUID()}`,
        maxTokens,
        temperature: 0.2,
        reasoningEffort: "low",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      }).then((r) => (r.error ? null : r)).catch(() => null)
    : await runSessionlessPiCommitMessage({
        cwd,
        modelSelection: settings.commitMessageModel,
        systemPrompt,
        prompt,
      }).catch(() => null);
  return generated?.text ?? null;
}

/** The exact diff of one group's files (staged + unstaged + untracked). */
async function groupDiff(cwd: string, status: GitStatus, files: string[]): Promise<string> {
  const fileSet = new Set(files);
  const untracked = status.unstaged.filter((f) => f.untracked && fileSet.has(f.path));
  const tracked = files.filter((p) => !untracked.some((f) => f.path === p));
  const parts = await Promise.all([
    tracked.length > 0
      ? readGitText(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--unified=3", "--", ...tracked]).catch(() => "")
      : Promise.resolve(""),
    ...untracked.map(async (f) => {
      const diff = await readUntrackedAsDiff(cwd, f.path).catch(() => null);
      if (!diff || diff.error) return `diff --git a/${f.path} b/${f.path}\n[unreadable]`;
      if (diff.binary) return `diff --git a/${f.path} b/${f.path}\nBinary file`;
      return `diff --git a/${f.path} b/${f.path}\n${diff.lines.map((l) => l.text).join("\n")}`;
    }),
  ]);
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Second pass: write each commit's message from ONLY its own diff. The plan
 * pass decides WHAT goes together; this pass decides what to SAY — and since
 * it never sees the other groups' changes, it cannot claim work that lands in
 * a different commit (wiring, types) the way single-pass messages did.
 * Failures keep the placeholder subject — editable in the dialog, never fatal.
 */
async function writeGroupMessages(
  cwd: string,
  status: GitStatus,
  groups: GitSplitGroup[],
  groupDiffs: string[],
  recentSubjects: string,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<GitSplitGroup[]> {
  const seriesOutline = groups
    .map((g, i) => `${i + 1}. ${g.reason ?? g.message} (${g.files.length} files)`)
    .join("\n");
  const perGroupBudget = Math.max(8_000, Math.floor(MAX_DIFF_CHARS / Math.max(1, groups.length / 2)));

  const messages = await Promise.all(
    groups.map(async (group, index) => {
      const diff = groupDiffs[index] ?? (await groupDiff(cwd, status, group.files));
      if (!diff.trim()) return null;
      const prompt = truncate(
        `RECENT COMMIT SUBJECTS (style guide):
${recentSubjects || "(none)"}

THE COMMIT SERIES (context only — you are writing message ${index + 1}; the other commits' work is NOT in your diff):
${seriesOutline}

FILES IN THIS COMMIT:
${group.files.join("\n")}

DIFF OF THIS COMMIT ONLY:
${truncate(diff, perGroupBudget)}

Write the commit message for this diff.`,
        MAX_PROMPT_CHARS,
      );
      const text = await runModel(cwd, settings, MESSAGE_SYSTEM_PROMPT, prompt, 900);
      const cleaned = text?.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
      return cleaned || null;
    }),
  );

  return groups.map((group, index) => ({
    ...group,
    message: messages[index] ?? group.message,
  }));
}

export async function planSplitCommits(cwd: string): Promise<GitSplitPlanResult> {
  try {
    const status = await computeGitStatus(cwd);
    if (!status.isRepo) return { ok: false, error: status.error ?? "Not a git repository." };
    if (status.hasConflicts) return { ok: false, error: "Resolve the merge conflicts first." };
    const paths = changedPaths(status);
    if (paths.length === 0) return { ok: false, error: "No changes to split." };
    if (paths.length === 1) {
      return { ok: false, error: "Only one file changed — a split needs at least two." };
    }

    const [recentSubjects, statusShort, stagedDiff, unstagedDiff, untrackedDiff, settings] =
      await Promise.all([
        readGitText(cwd, ["log", "--max-count=12", "--pretty=format:%s"]).catch(() => ""),
        readGitText(cwd, ["status", "--short"]),
        readGitText(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3"]),
        readGitText(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=3"]),
        collectUntrackedDiff(cwd, status),
        loadSettings(),
      ]);

    const prompt = truncate(
      `RECENT COMMIT SUBJECTS (style guide):
${recentSubjects || "(none)"}

CHANGED FILES (group every one of these, exact paths):
${paths.join("\n")}

GIT STATUS:
${statusShort}

DIFF (staged):
${truncate(stagedDiff, MAX_DIFF_CHARS)}

DIFF (unstaged):
${truncate(unstagedDiff, MAX_DIFF_CHARS)}

NEW FILES:
${untrackedDiff || "(none)"}

Group the changed files into separate commits and answer with the JSON object only.`,
      MAX_PROMPT_CHARS,
    );

    const planText = await runModel(cwd, settings, PLAN_SYSTEM_PROMPT, prompt, 2_400);

    const normalized = normalizeSplitGroups(parsePlanText(planText ?? ""), paths);
    if (!normalized) return fallbackPlan(paths);

    const groups = [...normalized.groups];
    if (normalized.leftover.length > 0) {
      // The model missed some files. They go into a visible catch-all commit
      // rather than being silently dropped — the user can re-home them in the
      // review dialog.
      groups.push({
        message: "Other changes",
        reason: "Files the grouping didn't cover — drag them into another commit or keep them together.",
        files: normalized.leftover,
      });
    }
    if (groups.length > GIT_SPLIT_MAX_GROUPS) return fallbackPlan(paths);

    // Dependency-aware ordering: read each group's exact diff once, extract
    // added exports/imports, and topologically sort so foundations (shared
    // types, plumbing) land before the commits importing them — the model's
    // ordering is a suggestion; the diffs are the truth.
    const diffs = await Promise.all(groups.map((g) => groupDiff(cwd, status, g.files)));
    const order = orderSplitGroups(diffs.map(extractDiffSymbols));
    const orderedGroups = order.map((i) => groups[i]);
    const orderedDiffs = order.map((i) => diffs[i]);

    // Pass 2: honest messages, one per group, each written from only its own
    // diff (runs in parallel; failures keep the pass-1 placeholder subject).
    const withMessages = await writeGroupMessages(
      cwd,
      status,
      orderedGroups,
      orderedDiffs,
      recentSubjects,
      settings,
    );
    return { ok: true, source: "ai", groups: withMessages };
  } catch (err) {
    const e = err as { message?: unknown };
    return { ok: false, error: typeof e?.message === "string" ? e.message : String(err) };
  }
}

/**
 * Execute a reviewed plan. Sequential and honest: groups commit in order; the
 * first failure stops the run and reports exactly what landed. Nothing is ever
 * reset, discarded, or left half-staged (a failed group's staging is undone).
 */
export async function executeSplitCommits(
  cwd: string,
  groups: GitSplitGroup[],
): Promise<GitSplitExecuteResult> {
  const committed: GitSplitExecuteResult["committed"] = [];
  try {
    const status = await computeGitStatus(cwd);
    if (!status.isRepo) {
      return { ok: false, committed, error: status.error ?? "Not a git repository." };
    }
    if (status.hasConflicts) {
      return { ok: false, committed, error: "Resolve the merge conflicts first." };
    }
    const paths = changedPaths(status);
    const violation = splitPlanViolation(groups, paths);
    if (violation) {
      // Covers the workspace-changed race too: files edited between plan and
      // execute make the plan stale, and stale plans must not run.
      return { ok: false, committed, error: `${violation} Generate the plan again.` };
    }

    // Renames: staging only the new path leaves the old path's deletion
    // behind. Stage both sides so the rename travels as one unit.
    const byPath = changeByPath(status);
    const stageTargets = (g: GitSplitGroup): string[] => {
      const targets: string[] = [];
      for (const path of g.files) {
        targets.push(path);
        const oldPath = byPath.get(path)?.oldPath;
        if (oldPath && oldPath !== path) targets.push(oldPath);
      }
      return targets;
    };

    // Start from a clean index so group boundaries are exactly the plan's.
    const unstage = await unstageAll(cwd);
    if (!unstage.ok) return { ok: false, committed, error: unstage.error ?? "Could not reset the staging area." };

    for (const group of groups) {
      const staged = await stageFiles(cwd, stageTargets(group));
      if (!staged.ok) {
        await unstageAll(cwd).catch(() => undefined);
        return {
          ok: false,
          committed,
          error: `Could not stage files for "${group.message.split("\n")[0]}": ${staged.error ?? "unknown error"}. The remaining changes are still in your working tree.`,
        };
      }
      const commit = await commitChanges(cwd, group.message);
      if (!commit.ok) {
        await unstageAll(cwd).catch(() => undefined);
        return {
          ok: false,
          committed,
          error: `Could not create "${group.message.split("\n")[0]}": ${commit.error ?? "unknown error"}. The remaining changes are still in your working tree.`,
        };
      }
      const hash = (await readGitText(cwd, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      committed.push({ hash, message: group.message, files: [...group.files] });
    }
    return { ok: true, committed };
  } catch (err) {
    const e = err as { message?: unknown };
    return {
      ok: false,
      committed,
      error: typeof e?.message === "string" ? e.message : String(err),
    };
  }
}
