import { guardDraftProblem, normalizeAutomationGuard } from "@shared/automation-guard";
import { Cron } from "croner";
import { parseEurText, usdFromEurField } from "@shared/money";
import type { AutomationLoop, AutomationTrigger, CreateScheduledJobInput, ScheduledJob } from "@shared/types";
import { DEFAULT_WORKER_EFFORT, DEFAULT_WORKER_MODEL } from "../worker-models";

// The New automation screen: one automation written as a sentence. It maps one
// way, sentence to automation, and always to a single worker, so anything with
// branches or steps is the flow editor's. Pure, so
// scripts/test-automation-sentence.cjs can exercise it.

export type WhenKind = "manual" | "daily" | "weekdays" | "every" | "prOpened" | "ciFailed";
export type StopKind = "once" | "tests" | "agent";
export type ThenKind = "folder" | "branch" | "draftPr";

export interface SentenceDraft {
  name: string;
  when: WhenKind;
  time: string;
  everyMin: string;
  onlyIf: string;
  model: string;
  prompt: string;
  stop: StopKind;
  testCommand: string;
  maxTries: string;
  budget: string;
  monthlyCap: string;
  pauseAfter: string;
  then: ThenKind;
}

export function emptySentence(): SentenceDraft {
  return {
    name: "",
    when: "manual",
    time: "02:00",
    everyMin: "60",
    onlyIf: "",
    model: DEFAULT_WORKER_MODEL,
    prompt: "",
    stop: "once",
    testCommand: "npm test",
    maxTries: "15",
    budget: "2",
    monthlyCap: "",
    pauseAfter: "",
    then: "folder",
  };
}

// The longest timer Node keeps: past it setInterval fires at once, over and over.
const MAX_EVERY_MINUTES = Math.floor(2_147_483_647 / 60_000);

function timeParts(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function wholeAboveZero(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() && Number.isInteger(value) && value > 0 ? value : null;
}

export function sentenceTrigger(d: SentenceDraft): AutomationTrigger | null {
  switch (d.when) {
    case "manual":
      return { kind: "manual" };
    case "daily":
    case "weekdays": {
      const at = timeParts(d.time);
      if (!at) return null;
      return { kind: "cron", expr: `${at.minute} ${at.hour} * * ${d.when === "daily" ? "*" : "1-5"}` };
    }
    case "every": {
      const minutes = wholeAboveZero(d.everyMin);
      return minutes && minutes <= MAX_EVERY_MINUTES ? { kind: "interval", everyMs: minutes * 60_000 } : null;
    }
    case "prOpened":
      return { kind: "github", events: ["prOpened"] };
    case "ciFailed":
      return { kind: "github", events: ["ciFailed"] };
  }
}

export function sentenceBudget(d: SentenceDraft): number | undefined {
  return usdFromEurField(d.budget);
}

export function sentenceLoop(d: SentenceDraft): AutomationLoop {
  const budgetUsd = sentenceBudget(d);
  const budget = budgetUsd !== undefined ? { budgetUsd } : {};
  if (d.stop === "once") return { kind: "once", stop: budget };
  const tries = wholeAboveZero(d.maxTries);
  const limits = { ...budget, ...(tries ? { maxIterations: tries } : {}) };
  if (d.stop === "agent") return { kind: "agent", stop: limits };
  return { kind: "until", stop: { ...limits, untilTestsPass: true, testCommand: d.testCommand.trim() || "npm test" } };
}

/** What is wrong with what was written. A limit only goes when its field is blank:
 *  a typo must not read as asking for none. These also stop it being carried to the
 *  flow editor, which would read them as blank or as a different schedule. */
export function sentenceMistake(d: SentenceDraft): string | null {
  if ((d.when === "daily" || d.when === "weekdays") && !timeParts(d.time)) return "Write the time like 02:00.";
  if (d.when === "every" && !sentenceTrigger(d)) return `Say how many minutes between runs, up to ${MAX_EVERY_MINUTES}.`;
  if (d.budget.trim() && parseEurText(d.budget) === undefined) {
    return "The budget must be a number above 0. Leave it blank for no budget.";
  }
  if (d.stop !== "once" && d.maxTries.trim() && !wholeAboveZero(d.maxTries)) {
    return "The number of tries must be a whole number above 0.";
  }
  return guardDraftProblem(d.monthlyCap, d.pauseAfter);
}

/** What stops it being saved, first thing first. */
export function sentenceProblem(d: SentenceDraft): string | null {
  if (!d.name.trim()) return "Name the automation.";
  const mistake = sentenceMistake(d);
  if (mistake) return mistake;
  return d.prompt.trim() ? null : "Say what it should do.";
}

export interface SentenceContext {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
}

export function sentenceToInput(d: SentenceDraft, ctx: SentenceContext): CreateScheduledJobInput | null {
  const trigger = sentenceTrigger(d);
  if (!trigger) return null;
  const prompt = d.prompt.trim();
  const worker = { model: d.model, effort: DEFAULT_WORKER_EFFORT };
  const guard = normalizeAutomationGuard({
    ...(d.monthlyCap.trim() ? { monthlyCapUsd: usdFromEurField(d.monthlyCap) ?? Number.NaN } : {}),
    ...(d.pauseAfter.trim() ? { pauseAfterFailures: Number(d.pauseAfter) } : {}),
  });
  // A check is skipped on Run now, so by-hand automations have nothing to run it.
  const onlyIf = d.when === "manual" ? "" : d.onlyIf.trim();
  return {
    name: d.name.trim(),
    trigger,
    input: {
      workspaceId: ctx.workspaceId,
      workspaceName: ctx.workspaceName,
      cwd: ctx.cwd,
      planTitle: d.name.trim(),
      initialUserNote: prompt,
      chatMode: "execute",
    },
    loop: sentenceLoop(d),
    prompt: { template: prompt },
    worker,
    graph: {
      version: 1,
      nodes: [{ id: "w0", kind: "worker", label: "Worker", prompt, worker }],
      edges: [],
      entryNodeIds: ["w0"],
    },
    enabled: true,
    ...(onlyIf ? { precheck: { command: onlyIf } } : {}),
    ...(guard ? { guard } : {}),
    ...(d.then !== "folder" ? { ownBranch: { draftPr: d.then === "draftPr" } } : {}),
  };
}

/** The sentence as the job the flow editor opens on, for going on from there. */
export function sentenceToSeed(d: SentenceDraft, ctx: SentenceContext): ScheduledJob | null {
  const input = sentenceToInput(d, ctx);
  return input ? ({ ...input, id: "", state: { status: "idle", iteration: 0 }, history: [], createdAt: "" } as ScheduledJob) : null;
}

/** The next times it starts by itself, or nothing when that depends on events. */
export function nextStarts(trigger: AutomationTrigger | null, nowMs: number, count: number): number[] {
  if (trigger?.kind === "interval") {
    return Array.from({ length: count }, (_, i) => nowMs + trigger.everyMs * (i + 1));
  }
  if (trigger?.kind !== "cron") return [];
  try {
    const cron = new Cron(trigger.expr, { paused: true, ...(trigger.tz ? { timezone: trigger.tz } : {}) });
    const starts = cron.nextRuns(count, new Date(nowMs)).map((at) => at.getTime());
    cron.stop();
    return starts;
  } catch {
    return [];
  }
}
