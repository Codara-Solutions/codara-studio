// Worker prompt building.
//
// renderWorkerPrompt is the entry point: it dispatches to the implementation
// or verifier prompt renderer, each of which assembles the markdown launch
// prompt from the task/step/run context plus synced MCP-skill, peer-comms,
// runtime-delegation, and UI-quality guidance blocks. readWorkerPromptForLaunch
// reads the prepared prompt.md back at launch time. shouldUsePeerComms gates
// the peer mailbox both here and at launch/registry sites in run-store.
// Extracted from run-store.ts (move-only).

import { promises as fs } from "node:fs";
import type {
  AppSettings,
  RunState,
  StepState,
  WorkerArtifactPaths,
  WorkerTask,
} from "@shared/types";
import { DEFAULT_MANAGER_PROMPT_PROFILE, loadManagerPromptProfile } from "./prompt-profile";
import { renderAgentSyncPromptLines } from "../agent-sync";
import { isSparkPreviewMcpAvailable } from "../mcp-installer";

function quotePwshString(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}

export async function readWorkerPromptForLaunch(paths: WorkerArtifactPaths): Promise<string> {
  try {
    return await fs.readFile(paths.promptMd, "utf8");
  } catch {
    return [
      "You are a Spark worker. The prepared prompt could not be read at launch.",
      `Read it now: ${paths.promptMd}`,
      `Then complete the task and write the final JSON report to ${paths.finalReportJson}.`,
    ].join("\n");
  }
}

export function renderWorkerPrompt({
  cwd,
  run,
  step,
  task,
  paths,
  settings,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
  settings: AppSettings;
}): string {
  if (task.taskClass === "verifier") {
    return renderVerifierWorkerPrompt({ cwd, run, step, task, paths, settings });
  }
  return renderImplementationWorkerPrompt({ cwd, run, step, task, paths, settings });
}

function taskContextText(step: StepState | undefined, task: WorkerTask): string {
  return [
    task.title,
    task.description,
    task.taskClass ?? "",
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
    ...(task.verificationCommands ?? []),
  ].join("\n");
}

function shouldOfferRuntimeDelegation(step: StepState | undefined, task: WorkerTask): boolean {
  const text = taskContextText(step, task);
  if (/\b(subagent|sub-agent|delegate|delegation|agent team|worktree|parallel probes?|independent probes?)\b/i.test(text)) {
    return true;
  }
  if (/\b(recon|explor|investigat|triage|large files?|logs?|summari[sz]e|second opinion|independent review)\b/i.test(text)) {
    return true;
  }
  if (task.taskClass === "verifier") {
    return task.verificationCommands.length > 2 || /\b(complex|subtle|broad|cross-module|multi-file)\b/i.test(text);
  }
  return false;
}

function shouldRenderAgentSyncPromptLines(step: StepState | undefined, task: WorkerTask): boolean {
  return /\b(mcp|skill|spark[- ]preview|preview|playwright|browser|screenshot|web search|github|figma|notion|railway|runpod|openai docs|image|vision|pdf|spreadsheet|presentation|document)\b/i.test(
    taskContextText(step, task),
  );
}

export function shouldUsePeerComms(
  run: RunState,
  step: StepState | undefined,
  task: WorkerTask,
): boolean {
  if (!step || !task.canRunParallel) return false;
  const peerTasks = run.workerTasks.filter((item) => item.stepId === task.stepId && item.id !== task.id);
  const plannedPeerCount = Math.max(0, (step.plannedAgents?.length ?? 0) - 1);
  if (peerTasks.length + plannedPeerCount <= 0) return false;

  const text = taskContextText(step, task);
  if (task.taskClass === "verifier") {
    return /\b(peer|parallel|disagreement|other runtime|same surface|second verifier)\b/i.test(text);
  }
  return /\b(shared|interface|contract|api|schema|integrat|consume|producer|provider|handoff|merge|combine|staging|coordinate|collision|conflict|depends|dependency|same file|data hook|dom hook)\b/i.test(
    text,
  );
}

function renderRuntimeDelegationGuidance(task: WorkerTask): string[] {
  const isVerifier = task.taskClass === "verifier";

  if (task.runtimePreference === "claude") {
    const lines = [
      "Spark is the top-level orchestrator. You may use Claude Code native subagents, agent teams, or worktrees only when they materially reduce your context load or improve independent checking.",
      "- Good uses: bounded read-heavy exploration, test/log triage, summarizing large files, or independent review probes with a clear return format.",
      "- Do not create a nested implementation team for ordinary write work. Spark owns cross-worker coordination and parallel write planning.",
      "- Keep delegated results compact: ask for distilled findings, file/line references, commands run, and uncertainties. Do not paste raw logs back into your own context.",
      "- If you use subagents, agent teams, or worktrees, your final report must list each one's purpose, scope, and distilled findings.",
    ];
    if (isVerifier) {
      lines.push(
        "- This is a verifier task: every delegated probe must be read-only, and any worktree usage must not edit, commit, merge, or push.",
      );
    } else {
      lines.push(
        "- Use worktrees only for explicitly isolated experiments or disjoint write scopes. Do not merge, commit, push, or overwrite another worker's changes unless this task explicitly requires it.",
      );
    }
    return lines;
  }

  if (task.runtimePreference === "codex") {
    const lines = [
      "Spark explicitly permits Codex subagents for this task when they are bounded, useful, and mostly read-only.",
      "- Good uses: codebase exploration, tests/log triage, independent review, summarizing large files, or checking a narrow hypothesis.",
      "- Give each subagent a concrete job, clear limits, and the exact return format you need. Wait for the result and synthesize disagreements yourself.",
      "- Do not spawn subagents for every small task. Keep the main path local when the next action depends on the answer.",
      "- Avoid write-heavy parallel subagents unless scopes are isolated and disjoint. Spark owns top-level parallelism and cross-worker coordination.",
      "- If you use subagents, your final report must list each subagent's purpose, scope, and distilled findings.",
    ];
    if (isVerifier) {
      lines.push("- This is a verifier task: subagents must be read-only and must not edit files or mutate repository state.");
    }
    return lines;
  }

  return [];
}

function renderPeerCommsGuidance(task: WorkerTask, paths: WorkerArtifactPaths): string[] {
  if (!paths.peerCommsDir || !paths.peerCommsScript) return [];
  const script = quotePwshString(paths.peerCommsScript);
  const dir = quotePwshString(paths.peerCommsDir);
  const self = quotePwshString(task.id);
  return [
    "Spark may be running several Claude/Codex/Cursor workers for this same step. Use this mailbox when direct peer coordination would prevent duplicated work, clarify an interface, share a narrow finding, or ask for a second opinion.",
    "This is a run artifact mailbox, not the project source tree; using it is allowed even for read-only verifier tasks.",
    "If your task defines or consumes a shared interface/contract that another peer may depend on, send one short contract note to `all` before editing and check your inbox once before finalizing.",
    `List peers: node ${script} list --dir ${dir}`,
    `Read your inbox: node ${script} inbox --dir ${dir} --self ${self} --limit 10 --mark-read`,
    "Send a peer message from PowerShell:",
    "```powershell",
    "@'",
    "Short question or finding. Keep it under 300 words. Include exact files/commands when useful.",
    "'@ | node " + script + " send --dir " + dir + " --from " + self + " --to \"<peer_worker_task_id|all>\" --subject \"<topic>\" --stdin",
    "```",
    "Reply to a peer message:",
    "```powershell",
    "@'",
    "Short answer with evidence or uncertainty.",
    "'@ | node " + script + " reply --dir " + dir + " --from " + self + " --to \"<sender_worker_task_id>\" --reply-to \"<msg_id>\" --subject \"Re: <topic>\" --stdin",
    "```",
    `Wait briefly for a reply: node ${script} await --dir ${dir} --self ${self} --reply-to "<msg_id>" --timeout 120`,
    "- Shared contracts must come from the task spec, not from invention. If your contract note conflicts with a peer's note, reconcile the conflict before finalizing or report `partial` with the exact conflict in `risks[]`.",
    "- Before your final report on any shared-interface task, read your inbox with `--mark-read` and include a short `proof[]` entry naming the mailbox command and the contract you accepted.",
    "- If your slice consumes another worker's output, run a small integration probe when possible. If the peer file is not ready yet, wait briefly once; if still unavailable, state that risk instead of claiming the cross-file contract is proven.",
    "- Do not wait indefinitely. If no peer replies within about 2 minutes, continue with the safest explicit assumption and mention it in `risks[]`.",
    "- Summarize any material peer input in `proof[]`, `risks[]`, or `followups[]`; do not paste long mailbox transcripts into the final report.",
  ];
}

function taskLooksLikeVisibleUi(step: StepState | undefined, task: WorkerTask): boolean {
  const text = [
    task.title,
    task.description,
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
  ].join(" ");
  return /\b(ui|ux|frontend|front-end|html|css|page|screen|component|layout|form|button|modal|view|visual|design|calculator|dashboard|professional\s+ui|polished)\b/i.test(
    text,
  );
}

function taskLooksLikeCalculator(step: StepState | undefined, task: WorkerTask): boolean {
  const text = [
    task.title,
    task.description,
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
  ].join(" ");
  return /\b(calculator|calculate|arithmetic|keypad|numeric input)\b/i.test(text);
}

function renderUiQualityGuidance(
  step: StepState | undefined,
  task: WorkerTask,
  opts?: { sparkPreviewMcpAvailable?: boolean },
): string[] {
  if (!taskLooksLikeVisibleUi(step, task)) {
    return [];
  }
  const lines = [
    "- Treat words like `nice`, `polished`, and `professional` as concrete UI requirements: semantic structure, accessible names or live regions for dynamic values, keyboard/focus states, hover/active states, responsive sizing, and no text/layout overlap at mobile or desktop widths.",
    "- For a standalone HTML deliverable, include a viewport meta tag, a `<main>` landmark, self-contained CSS/JS when the task asks for one file, and no external assets unless the task explicitly allows them.",
    "- For calculators or expression-like inputs, use explicit state/event handling. Do not use `eval()` or `new Function()`.",
    "- Do not leave decorative-but-dead UI: every visible control, display region, history strip, tab, toggle, badge, and data-* hook must be wired to real behavior or removed.",
    "- Avoid visible instructional copy that explains basic usage or keyboard shortcuts inside the app; make the interface self-evident through controls, labels, focus, and affordances.",
    "- Include a deliberate empty/loading/error/success state only when it can actually occur; otherwise do not style unreachable states as if they were product features.",
    "- Before reporting `complete`, run or construct a UI smoke probe. At minimum, prove the final file has the expected controls, no accidental external refs, no `eval`/`new Function`, and that the primary user flow updates the visible DOM/state.",
    "- Include file:line evidence for the main markup, core styles, event wiring, and any dynamic display updates in `proof[]`.",
  ];
  if (opts?.sparkPreviewMcpAvailable) {
    lines.push(
      "- The `spark-preview` MCP server is available in this session. It drives the actual <preview> tab inside Spark App — same DOM the user sees, no separate browser window. Call `spark_preview_navigate` with a `file://` URL (for standalone HTML) or your dev-server URL; if no preview tab is open Spark will open one automatically. Capture the final snapshot or `spark_preview_screenshot` evidence in `proof[]`.",
      "- BATCH your interaction probes with `spark_preview_run`: pass an ordered `steps` array (navigate/click/type/press_key/evaluate/wait_for/snapshot/screenshot) to drive a whole flow in ONE call. Each step fires the same real event as the single-shot tool, so you keep full fidelity but pay one round-trip instead of one per keystroke. Probe e.g. `7 / 2 =` plus a display read as a single `spark_preview_run`. A calculator should need only a handful of `spark_preview_run` calls total — NOT 50+ individual `spark_preview_press_key` calls.",
      "- Reserve the single-shot `spark_preview_click` / `spark_preview_type` / `spark_preview_press_key` tools only for probes that must isolate ONE real key/click event (e.g. the focus double-activation guard: focus equals, press Enter once, read the display).",
      "- Do NOT substitute an inline Node VM + JSDOM probe for the spark-preview run. The whole point is that the verifier and the human see the same DOM/CSS the real browser produces.",
      "- If `spark_preview_screenshot` returns an error or a 0-size/blank frame, this preview tab is not in the foreground — do NOT retry the screenshot in a loop. Treat the pixels as unavailable and immediately fall back to `spark_preview_snapshot` + `spark_preview_evaluate` (computed styles, geometry, text content) for your evidence, noting the limitation in proof[]. A failed screenshot is a signal to switch tools, not to keep shooting.",
    );
  }
  if (taskLooksLikeCalculator(step, task)) {
    lines.push(
      "- Calculator quality floor: include visible controls for clear, decimal, the four basic operators, equals, and a correction path such as backspace or CE. For a `professional` calculator, consider percent and sign toggle unless the plan explicitly rules them out.",
      "- Calculator operator labels must be unambiguous and probe-friendly: use `+`, `-`, `×` or `*`, `÷` or `/`, and `=` visibly on the buttons. Do not use a plain `x` as the only multiplication signal.",
      "- Calculator probes must cover: basic arithmetic, decimal arithmetic (`0.1 + 0.2` display), divide-by-zero handling and recovery, repeated equals, chained operations, keyboard input, correction/backspace behavior, and focus double-activation guards.",
      "- Calculator focus probes must include: after pointer-clicking clear, pressing keys `7`, `/`, `2`, `Enter` displays `3.5`; after clicking `2`, `+`, `3`, focusing equals and pressing `Enter` executes exactly once and stays `5`; focusing clear and pressing `Enter` clears to `0`; any focused button activated by `Enter`/Space must run that button's action exactly once instead of the global shortcut; null/undefined/empty key values are ignored.",
      "- A history or expression line is good only if it is updated by the logic; an empty static history strip is a quality failure.",
    );
  }
  return lines;
}

function renderUiVerifierGuidance(
  step: StepState | undefined,
  task: WorkerTask,
  opts?: { sparkPreviewMcpAvailable?: boolean },
): string[] {
  if (!taskLooksLikeVisibleUi(step, task)) return [];
  const lines = [
    "## UI / FRONTEND 10/10 VERIFICATION",
    "- Judge the finished artifact as a product, not as a code sample. A pass requires behavior, accessibility, responsive layout, and visual/interaction polish.",
    "- Inspect the final user-facing files directly. Verify there are no leftover staging directories/files in the user workspace unless the plan explicitly asked for them.",
    "- Verify there are no dead UI affordances: if a control, display region, history line, badge, tab, toggle, or data-* hook exists, prove it is wired to real behavior. If it is not wired, verdict=failed or FEEDBACK.",
    "- Check keyboard reachability, focus-visible states, accessible names/live regions for dynamic values, hover/active/disabled states where relevant, and no text overlap at small and desktop viewport sizes.",
    "- For standalone HTML/CSS/JS, verify viewport meta, semantic landmarks, self-contained assets when required, no accidental external src/href, and no `eval()` or `new Function()`.",
    "- Run deterministic DOM/static probes and behavioral probes. Browser screenshots are ideal when available; if browser/file access is unavailable, state that limitation and compensate with static + runtime probes rather than guessing.",
  ];
  if (opts?.sparkPreviewMcpAvailable) {
    lines.push(
      "- The `spark-preview` MCP server is registered in this session. You MUST use it to verify visible UI claims instead of inline Node VM + JSDOM stubs. The server drives the live <preview> tab inside Spark App — the same pixels the user sees. Call `spark_preview_navigate` with a `file://` URL (standalone HTML) or the served URL; if no preview tab is open Spark will open one automatically. Take a `spark_preview_snapshot` for the accessibility-flavored outline.",
      "- BATCH verification with `spark_preview_run`: pass an ordered `steps` array (navigate/click/type/press_key/evaluate/wait_for/snapshot/screenshot) to exercise a whole flow in ONE round-trip instead of dozens of single calls. Each step fires the identical real event. Reserve single-shot `spark_preview_click` / `spark_preview_press_key` only for probes that must isolate one real key/click (e.g. focus double-activation). Attach the snapshot or `spark_preview_screenshot` evidence in `proof[]` for each behavioral atomic claim.",
      "- Treat the absence of a spark-preview snapshot for any behavioral UI claim as `unsure`, not `verified`. Static DOM grep alone cannot prove rendering, event wiring, or focus behavior.",
      "- If `spark_preview_screenshot` errors or returns a 0-size/blank frame, the preview tab simply isn't foregrounded — do not retry it repeatedly. Base the visual verdict on `spark_preview_snapshot` + `spark_preview_evaluate` (computed styles, geometry, text) and record that pixels were unavailable; do not mark a claim failed solely because a screenshot could not be captured.",
    );
  }
  if (taskLooksLikeCalculator(step, task)) {
    lines.push(
      "- Calculator probes must include: `2 + 3 = 5`, `7 / 2 = 3.5`, `0.1 + 0.2` displays as `0.3`, divide-by-zero shows an error and recovers on next digit, repeated equals continues the prior operation, correction/backspace works, and keyboard Enter/Escape/operator input works.",
      "- Calculator operator labels must be visible as `+`, `-`, `×` or `*`, `÷` or `/`, and `=`. A plain `x` multiplication label is not enough.",
      "- Calculator focus probes must include: after pointer-clicking clear, pressing keys `7`, `/`, `2`, `Enter` displays `3.5`; after clicking `2`, `+`, `3`, focusing equals and pressing `Enter` executes exactly once and stays `5`; focusing clear and pressing `Enter` clears to `0`; any focused button activated by `Enter`/Space must run that button's action exactly once instead of the global shortcut; null/undefined/empty key values are ignored.",
      "- Fail any calculator that contains an expression/history display that never updates, silently accepts impossible operators, or has no visible correction path.",
    );
  }
  return lines;
}

function renderImplementationWorkerPrompt({
  cwd,
  run,
  step,
  task,
  paths,
  settings,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
  settings: AppSettings;
}): string {
  const lines: string[] = [];
  const promptProfile = loadManagerPromptProfile();

  lines.push(
    ...promptProfile.workerPrompt.opening,
    "",
    "## TASK",
    task.title,
    "",
    task.description.trim(),
  );

  if (step) {
    lines.push(
      "",
      "## STEP CONTEXT",
      `Step ${step.index}: ${step.title}`,
      `Goal: ${step.goal}`,
      `Status: ${step.status}`,
    );
  }

  if (step?.acceptanceCriteria?.length) {
    lines.push("", "## ACCEPTANCE", ...step.acceptanceCriteria.map((c) => `- ${c}`));
  }

  lines.push(
    "",
    "## SPEC EXACTNESS",
    "- Treat exact names, exported function shapes, JSON keys, sample output, punctuation, and decimal precision in the task as tests. If the prompt gives an example like `margin 80.0%`, match that formatting exactly unless the task explicitly says the example is illustrative.",
    "- Before reporting `complete`, run or construct a small probe that checks the exact public contract you implemented, and include the command/output in `proof[]`.",
  );

  const sparkPreviewMcpAvailable = isSparkPreviewMcpAvailable({
    cwd,
    autoInstallEnabled: settings.playwrightMcpAutoInstall !== false,
  });
  const uiQualityGuidance = renderUiQualityGuidance(step, task, { sparkPreviewMcpAvailable });
  if (uiQualityGuidance.length) {
    lines.push("", "## UI QUALITY BAR", ...uiQualityGuidance);
  }

  if (task.allowedPaths.length || task.forbiddenPaths.length || task.conflictsWith.length || task.canRunParallel) {
    lines.push("", "## BOUNDARIES");
    if (task.allowedPaths.length) {
      lines.push("Allowed paths:", ...task.allowedPaths.map((p) => `- ${p}`));
    }
    if (task.forbiddenPaths.length) {
      lines.push("Forbidden paths:", ...task.forbiddenPaths.map((p) => `- ${p}`));
    }
    if (task.canRunParallel) {
      lines.push("- This task may be running alongside other workers. Keep your edits inside the assigned scope.");
    }
    if (task.conflictsWith.length) {
      lines.push("Conflicts with:", ...task.conflictsWith.map((id) => `- ${id}`));
    }
  }

  if (task.expectedOutputs.length) {
    lines.push("", "## EXPECTED OUTPUTS", ...task.expectedOutputs.map((output) => `- ${output}`));
  }

  const delegationGuidance = shouldOfferRuntimeDelegation(step, task)
    ? renderRuntimeDelegationGuidance(task)
    : [];
  if (delegationGuidance.length) {
    lines.push("", "## RUNTIME-NATIVE DELEGATION", ...delegationGuidance);
  }

  const syncGuidance = shouldRenderAgentSyncPromptLines(step, task)
    ? renderAgentSyncPromptLines({ cwd, runtime: task.runtimePreference, settings })
    : [];
  if (syncGuidance.length) {
    lines.push("", "## SYNCED MCP / SKILL CONTEXT", ...syncGuidance);
  }

  const peerCommsGuidance = shouldUsePeerComms(run, step, task)
    ? renderPeerCommsGuidance(task, paths)
    : [];
  if (peerCommsGuidance.length) {
    lines.push("", "## PEER WORKER COMMUNICATION", ...peerCommsGuidance);
  }

  if (task.verificationCommands?.length) {
    lines.push(
      "",
      "## VERIFICATION",
      ...task.verificationCommands.map((c) => `- ${c}`),
      "",
      "## SELF-CHECK",
      "Before reporting `complete`, you MUST run each command listed under VERIFICATION in a fresh shell and capture its exit code + first 600 chars of stdout. Include the literal output as one `proof[]` entry per verification command, formatted as:",
      "  $ <command>",
      "  [exit=<code>]",
      "  <stdout truncated to 600 chars>",
      "A `complete` status with empty `proof[]` will be treated as `partial` by the manager review and forced to retry — do not skip this step.",
      "If any verificationCommand fails (non-zero exit, error in output), set status=\"partial\" or \"failed\" and include the failure mode in `risks[]`. Do NOT paper over a failing check by reporting `complete`.",
      "If your task description references atomic claims (sub-claims under acceptanceCriteria), enumerate them in `proof[]` — one entry per claim, citing the file:line or command output that demonstrates each one.",
    );
  }

  lines.push(
    "",
    "## WORKSPACE",
    `Workspace: ${cwd}`,
    "",
    "## FINAL REPORT",
    `When done, write valid JSON to ${paths.finalReportJson}.`,
    ...promptProfile.workerPrompt.finalReportIntro,
    "Use this shape:",
    JSON.stringify(
      {
        status: "complete | partial | blocked | failed",
        summary: "What changed and why.",
        files_changed: [{ path: "path/to/file", reason: "Why it changed." }],
        commands_run: [{ command: "npm run typecheck", exitCode: 0, summary: "What the command proved." }],
        tests: [{ command: "npm run typecheck", result: "passed | failed | not_run", details: "Optional detail." }],
        proof: ["Concrete evidence that the task is done."],
        risks: ["Known risk or empty array."],
        followups: ["Useful next task or empty array."],
      },
      null,
      2,
    ),
  );

  return lines.join("\n");
}

function renderVerifierWorkerPrompt({
  cwd,
  run,
  step,
  task,
  paths,
  settings,
}: {
  cwd: string;
  run: RunState;
  step?: StepState;
  task: WorkerTask;
  paths: WorkerArtifactPaths;
  settings: AppSettings;
}): string {
  const lines: string[] = [];
  const promptProfile = loadManagerPromptProfile();

  const verifierOpening =
    promptProfile.workerPrompt.verifierOpening?.length
      ? promptProfile.workerPrompt.verifierOpening
      : DEFAULT_MANAGER_PROMPT_PROFILE.workerPrompt.verifierOpening ?? [];
  const verifierFinalReportIntro =
    promptProfile.workerPrompt.verifierFinalReportIntro?.length
      ? promptProfile.workerPrompt.verifierFinalReportIntro
      : DEFAULT_MANAGER_PROMPT_PROFILE.workerPrompt.verifierFinalReportIntro ?? [];

  lines.push(
    ...verifierOpening,
    "",
    "## VERIFICATION TASK",
    task.title,
    "",
    task.description.trim(),
  );

  if (step) {
    lines.push(
      "",
      "## STEP CONTEXT (the implementation worker just finished this step)",
      `Step ${step.index}: ${step.title}`,
      `Goal: ${step.goal}`,
      `Status: ${step.status}`,
    );
  }

  if (step?.acceptanceCriteria?.length) {
    lines.push(
      "",
      "## ACCEPTANCE CRITERIA — your ground truth",
      "These are the claims you must independently prove or disprove. Decompose each into atomic sub-claims and verify each one.",
      ...step.acceptanceCriteria.map((c) => `- ${c}`),
    );
  }

  if (task.expectedOutputs.length) {
    lines.push(
      "",
      "## IMPLEMENTATION WORKER'S EXPECTED OUTPUTS — orientation only",
      "These are what the prior worker was supposed to produce. Use them to know WHERE to look — but do NOT trust them as evidence on their own.",
      ...task.expectedOutputs.map((output) => `- ${output}`),
    );
  }

  if (task.verificationCommands?.length) {
    lines.push(
      "",
      "## VERIFICATION COMMANDS — run each one yourself in a fresh shell",
      "Capture exit code + first 600 chars of stdout for each. These are the same commands the implementation worker was supposed to run; you re-run them with no caching, no shortcuts.",
      ...task.verificationCommands.map((c) => `- ${c}`),
    );
  }

  const sparkPreviewMcpAvailable = isSparkPreviewMcpAvailable({
    cwd,
    autoInstallEnabled: settings.playwrightMcpAutoInstall !== false,
  });
  const uiVerifierGuidance = renderUiVerifierGuidance(step, task, { sparkPreviewMcpAvailable });
  if (uiVerifierGuidance.length) {
    lines.push("", ...uiVerifierGuidance);
  }

  const delegationGuidance = shouldOfferRuntimeDelegation(step, task)
    ? renderRuntimeDelegationGuidance(task)
    : [];
  if (delegationGuidance.length) {
    lines.push("", "## RUNTIME-NATIVE DELEGATION", ...delegationGuidance);
  }

  const syncGuidance = shouldRenderAgentSyncPromptLines(step, task)
    ? renderAgentSyncPromptLines({ cwd, runtime: task.runtimePreference, settings })
    : [];
  if (syncGuidance.length) {
    lines.push("", "## SYNCED MCP / SKILL CONTEXT", ...syncGuidance);
  }

  const peerCommsGuidance = shouldUsePeerComms(run, step, task)
    ? renderPeerCommsGuidance(task, paths)
    : [];
  if (peerCommsGuidance.length) {
    lines.push("", "## PEER WORKER COMMUNICATION", ...peerCommsGuidance);
  }

  lines.push(
    "",
    "## WORKSPACE",
    `Workspace: ${cwd}`,
    "Read files directly from this path. Do NOT use the prior worker's narrative as your source of truth.",
    "",
    "## TOOL DISCIPLINE",
    peerCommsGuidance.length
      ? "Read-only tools only. Do not Write, Edit, or run any command that mutates project state (>, >>, tee, rm, mv, chmod, npm install, git commit, git push, destructive SQL). The Spark peer mailbox commands above are the only allowed write outside the project tree."
      : "Read-only tools only. Do not Write, Edit, or run any command that mutates project state (>, >>, tee, rm, mv, chmod, npm install, git commit, git push, destructive SQL).",
    "If you cannot verify a claim because the verification harness or fixture is missing, set verdict=unsure for that claim and explain WHAT is missing in `missing_oracle`. Do NOT create the fixture yourself.",
    "",
    "## FINAL REPORT",
    `When done, write valid JSON to ${paths.finalReportJson}.`,
    ...verifierFinalReportIntro,
    "Use this shape (note: this is the VERIFIER shape, NOT the implementation-worker shape):",
    JSON.stringify(
      {
        status: "complete",
        summary: "One-paragraph overview of what you verified and the headline verdict.",
        verifier: {
          status: "verified | failed | unsure",
          confidence: "PERFECT | VERIFIED | PARTIAL | FEEDBACK | FAILED",
          atomic_claims: [
            {
              claim: "function quoteForShell is exported from src/main/shell-utils.ts",
              verdict: "verified",
              evidence: "src/main/shell-utils.ts:14 — `export function quoteForShell(value: string)`",
            },
            {
              claim: "quoteForShell preserves spaces by quoting (input 'a b' → 'a b' wrapped)",
              verdict: "failed",
              evidence: "$ node --eval ... [exit=0] returned 'a b' (unquoted) — strips spaces",
            },
          ],
          corrective_prompt:
            "Full prompt the manager will use as the next implementation task description. Be specific: exact paths, exact failing assertions, suggested fix. 200-400 words. Set to null when status=verified.",
          missing_oracle: "Describe what fixture/harness/script we need but don't have, or null when not applicable.",
        },
        commands_run: [
          { command: "node --eval \"...\"", exitCode: 0, summary: "Probed quoteForShell with 'a b' input." },
        ],
        proof: ["Mirror the atomic_claims array's evidence here for cross-tool consumption."],
        risks: ["Known risk or empty array."],
        followups: ["Useful next task or empty array."],
      },
      null,
      2,
    ),
    "",
    "Confidence ladder (Spark uses this to decide what to do next):",
    "- PERFECT: every atomic claim verified with strong evidence; no missing oracle. Spark accepts the implementation.",
    "- VERIFIED: every atomic claim verified; minor gaps not load-bearing. Spark accepts.",
    "- PARTIAL: some atomic claims verified, some unverifiable, none failed. Spark may accept-with-risk or queue a follow-up.",
    "- FEEDBACK: at least one atomic claim FAILED with a fixable, specific corrective_prompt. Spark retries the implementation worker with your corrective_prompt.",
    "- FAILED: implementation is broken in ways no narrow corrective prompt fixes (architectural error, wrong file modified, wrong approach). Spark may escalate to the human.",
  );

  return lines.join("\n");
}
