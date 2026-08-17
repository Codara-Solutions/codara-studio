import { readFileSync, statSync } from "node:fs";
import { resolveBundledResourcePath } from "../bundled-resources";

// The prompt profile: the on-disk, hot-reloadable half of Cora's prompts.
//
// Only `workerPrompt` is read at runtime. worker-prompt.ts renders it into
// every worker and verifier brief. The manager's own system prompt lives in
// resources/pi-cora/prompt.ts (built by buildCoraPiSystemPrompt), not here.
//
// The shipped profile is resources/orchestration/manager-profile.json;
// SPARK_MANAGER_PROFILE_PATH overrides it for experiments. Edits to the file
// take effect on the next worker spawn with no app restart (mtime-keyed cache
// below).

export interface ManagerPromptProfile {
  version: number;
  workerPrompt: {
    /** Identity + discipline lines that open every implementation worker's brief. */
    opening: string[];
    /** Lines introducing the implementation worker's final-report block. */
    finalReportIntro: string[];
    /** Identity lines for verifier-class workers (hostile, read-only, evidence-first). */
    verifierOpening: string[];
    /** Lines introducing the verifier's structured-report block. */
    verifierFinalReportIntro: string[];
  };
}

export const DEFAULT_MANAGER_PROMPT_PROFILE: ManagerPromptProfile = {
  version: 1,
  workerPrompt: {
    opening: [
      "You are a Cora worker inside an autonomous coding workbench.",
      "Complete only the assigned task below, keep the change focused, and leave unrelated work alone.",
      "You have a real terminal: inspect the repository, edit files, run commands, and verify your work.",
      "Before changing files, translate the task and acceptance criteria into a tiny observable checklist. If the request has conflicting plausible meanings, stop and report the ambiguity instead of choosing silently.",
      "Match the existing code style. Do not introduce new conventions, formatters, or patterns mid-task; reuse what is already in the codebase.",
      "Smallest cohesive change wins. No speculative abstractions, no dead code, no comments that restate what the code does.",
      "Do not revert user changes or edits made by other workers. Adapt around them.",
      "If the assignment is blocked or unsafe, stop and report the blocker instead of guessing.",
      // Workers write code comments and docs that outlive the run, so the rule
      // has to cover everything they emit, not just the report Cora reads.
      // Keep byte-identical to manager-profile.json's copy.
      "PUNCTUATION: never write an em dash or an en dash in anything you produce: code comments, documentation, commit messages, file contents you create or edit, and every field of your final report. Use a comma, a colon, parentheses, or a second sentence instead. Do not emit the character even when nearby existing text uses it. Do NOT edit unrelated existing lines just to strip em dashes: that is diff noise and violates DIFF HYGIENE.",
    ],
    finalReportIntro: [
      "The report is how Cora decides whether the task is done, so include concrete proof and honest risks.",
    ],
    verifierOpening: [
      "You are a Cora VERIFIER. Your job is to PROVE OR DISPROVE the claims of the implementation worker that just finished.",
      "You do NOT build, you do NOT extend, you do NOT fix. You verify, and if you find problems you produce a CORRECTIVE PROMPT that the manager will use to re-run the implementation worker.",
      "Your tool surface is read-only: read files, grep, list directories, and run read-only shell commands. Do NOT run anything that writes.",
      "DECOMPOSE every acceptanceCriterion and expectedOutput into atomic claims and verify each independently.",
      "EVIDENCE BEATS ASSERTION. Every verified claim must cite deterministic tool output: file:line for source claims, or command + exit code + stdout for runtime claims. Without cited evidence the verdict is `unsure`, not `verified`.",
      "DO NOT TRUST the prior worker's filesChanged list, summary, or proof[]. Treat them as ORIENTATION ONLY. Re-derive ground truth from the filesystem.",
      "PUNCTUATION: never write an em dash or an en dash in anything you produce: code comments, documentation, commit messages, file contents you create or edit, and every field of your final report. Use a comma, a colon, parentheses, or a second sentence instead. Do not emit the character even when nearby existing text uses it. Do NOT edit unrelated existing lines just to strip em dashes: that is diff noise and violates DIFF HYGIENE.",
    ],
    verifierFinalReportIntro: [
      "Your final report MUST be a JSON object with the verifier shape below, not the implementation-worker shape.",
      "Cora uses your `confidence` ladder to decide whether to ACCEPT the implementation, retry it with your corrective_prompt, or escalate to the human.",
    ],
  },
};

let cachedProfile: ManagerPromptProfile | null = null;
// `${path}:${mtimeMs}` of the on-disk profile the cache was parsed from. When
// the file is edited the key changes, so loadManagerPromptProfile re-parses
// it: prompt edits take effect on the next spawn with no app restart.
let cachedProfileKey: string | null = null;

export function loadManagerPromptProfile(): ManagerPromptProfile {
  const disk = loadProfileFromDisk();
  if (disk) {
    cachedProfile = disk.profile;
    cachedProfileKey = disk.key;
    return cachedProfile;
  }
  if (!cachedProfile) {
    cachedProfile = DEFAULT_MANAGER_PROMPT_PROFILE;
    cachedProfileKey = null;
  }
  return cachedProfile;
}

function loadProfileFromDisk(): { profile: ManagerPromptProfile; key: string } | null {
  for (const path of profilePathCandidates()) {
    if (!path) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue; // not found or unreadable, try the next candidate
    }
    const key = `${path}:${mtimeMs}`;
    // Same file, unchanged since the cached parse: reuse it. statSync is
    // cheap; the readFile + JSON.parse only runs when the profile changed.
    if (key === cachedProfileKey && cachedProfile) {
      return { profile: cachedProfile, key };
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return { profile: normalizeManagerPromptProfile(parsed), key };
    } catch (err) {
      console.warn(`[spark] failed to load manager prompt profile at ${path}:`, err);
    }
  }
  return null;
}

function profilePathCandidates(): string[] {
  return [
    process.env.SPARK_MANAGER_PROFILE_PATH,
    resolveBundledResourcePath("orchestration", "manager-profile.json"),
  ].filter((path): path is string => Boolean(path));
}

export function normalizeManagerPromptProfile(value: unknown): ManagerPromptProfile {
  const raw = isRecord(value) ? value : {};
  const workerPrompt = isRecord(raw.workerPrompt) ? raw.workerPrompt : {};
  const fallback = DEFAULT_MANAGER_PROMPT_PROFILE;

  return {
    version: typeof raw.version === "number" ? raw.version : fallback.version,
    workerPrompt: {
      opening: stringList(workerPrompt.opening, fallback.workerPrompt.opening),
      finalReportIntro: stringList(workerPrompt.finalReportIntro, fallback.workerPrompt.finalReportIntro),
      verifierOpening: stringList(workerPrompt.verifierOpening, fallback.workerPrompt.verifierOpening),
      verifierFinalReportIntro: stringList(
        workerPrompt.verifierFinalReportIntro,
        fallback.workerPrompt.verifierFinalReportIntro,
      ),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return normalized.length > 0 ? normalized : fallback;
}
