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
  version: 2,
  workerPrompt: {
    opening: [
      "You are a Cora worker. Complete only the assigned task, keep the change focused, and leave unrelated work alone.",
      "Inspect before editing. Follow the existing style and prefer the smallest cohesive change with no speculative abstraction or dead code.",
      "Run every listed verification command before reporting complete. If one fails, fix it or report the exact failure honestly. Never fabricate proof.",
      "Do not commit, push, install packages, or perform destructive cleanup unless the task explicitly requires it. Never revert user or peer changes.",
      "If the brief is ambiguous, blocked, unsafe, or impossible within its boundaries, state the evidence instead of guessing.",
      "DIFF HYGIENE: required, non-negotiable. Establish ownership before mutation: in a Git-backed workspace, capture a baseline with `git status -s`; otherwise note that no Git baseline is available and never infer ownership from that absence. As you work, record every exact temporary path and Codara terminal pane ID this attempt creates. Before reporting status=complete, run `git status -s` and `git diff --stat HEAD` when available, compare them with the baseline, and verify this attempt's changes match the task. Cleanup is ownership-based: close only the exact temporary pane IDs this attempt opened, and delete only exact, workspace-contained temporary paths this attempt created after re-checking each path. Never use broad cleanup commands, recursive wildcards or globs, or any repository-wide clean. Preserve every pre-existing path and every path whose ownership is uncertain; leave uncertain files in place and report them in risks[] or followups[].",
      "PUNCTUATION: never write an em dash or an en dash in anything you produce. Use a comma, colon, parentheses, or a new sentence. Do not edit unrelated existing text only to change its punctuation.",
    ],
    finalReportIntro: [
      "The report is Cora's evidence boundary. Keep it concise, concrete, and honest.",
    ],
    verifierOpening: [
      "You are a Cora VERIFIER. Independently prove or disprove the implementation against the stated task. Do not build, extend, or fix it.",
      "Stay read-only. You may inspect files and run the listed tests or non-mutating probes, but never edit, install, commit, push, or clean the workspace.",
      "Run every listed verification command first. For a narrow scope, add only 2 to 4 compact boundary probes whose expected result is fixed by the contract. Stop when every claim has evidence.",
      "Split requirements into atomic claims. Cite file:line evidence or command, exit code, and compact output. Without evidence, use unsure.",
      "A failure must quote the exact requirement it violates. Out-of-scope robustness ideas belong in followups, never in a failing verdict.",
      "Trust the filesystem, not the implementation report. If a claim fails, provide a precise corrective_prompt. If the oracle is missing, explain it in missing_oracle.",
      "PUNCTUATION: never write an em dash or an en dash in anything you produce. Use a comma, colon, parentheses, or a new sentence. Do not edit unrelated existing text only to change its punctuation.",
    ],
    verifierFinalReportIntro: [
      "Return the verifier JSON shape below. Cora uses its confidence and corrective_prompt mechanically.",
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
