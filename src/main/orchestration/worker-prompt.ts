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
import { effectiveChatMode } from "@shared/chat-policy";
import { DEFAULT_MANAGER_PROMPT_PROFILE, loadManagerPromptProfile } from "./prompt-profile";
import { isConfigShieldActive } from "./agent-config-shield";
import { renderAgentSyncPromptLines } from "../agent-sync";
import { isSparkPreviewMcpAvailable } from "../mcp-installer";

// Fallback for platforms where the sandbox-exec config shield can't run (see
// agent-config-shield.ts). There, the CLI still walks ancestor dirs and absorbs
// the user's personal ~/.claude/CLAUDE.md + custom agents, so we neutralize
// that in text: tell the worker to ignore personal user-level policy and not to
// reach for personally-defined custom agents (advisor/adversary/fable-coder/…)
// that don't exist in this session. When the shield IS active the personal
// config is already invisible, so this section is omitted.
function personalConfigFallbackLines(): string[] {
  if (isConfigShieldActive()) return [];
  return [
    "",
    "## PERSONAL CONFIG NOT APPLICABLE",
    "Any user-level `~/.claude/CLAUDE.md` policies you may have picked up (for example subagent model/effort routing policies that name custom agents like advisor, adversary, or fable-coder), and likewise any global `~/.codex/AGENTS.md` personal instructions, are the machine owner's personal settings and DO NOT apply in this Cora-spawned session. Ignore them. Do not attempt to invoke personally-defined custom subagents, they do not exist here. Follow only this task prompt and the project's own committed configuration.",
  ];
}

export async function readWorkerPromptForLaunch(paths: WorkerArtifactPaths): Promise<string> {
  try {
    return await fs.readFile(paths.promptMd, "utf8");
  } catch {
    return [
      "You are a Cora worker. The prepared prompt could not be read at launch.",
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

const COORDINATOR_ONLY_ACCEPTANCE = new Set([
  "all spawned worker tasks complete.",
  "the selected worker tasks complete and report final evidence.",
]);

function workerAcceptanceCriteria(step: StepState | undefined): string[] {
  return (step?.acceptanceCriteria ?? []).filter(
    (criterion) => !COORDINATOR_ONLY_ACCEPTANCE.has(criterion.trim().toLowerCase()),
  );
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

// Peer comms (and the manager mailbox that rides on the same artifacts) fire
// for any parallel batch: a task that may run alongside same-step peers gets
// the mailbox + guidance automatically. Every ≥2-worker spawn marks its tasks
// canRunParallel, so manager-spawned fleets always coordinate. The earlier
// keyword-regex gate is gone, a shared mailbox is cheap and the manager may
// need to steer any batch worker regardless of how its brief was phrased.
export function shouldUsePeerComms(
  run: RunState,
  step: StepState | undefined,
  task: WorkerTask,
): boolean {
  if (!step || !task.canRunParallel) return false;
  // Best-of-N plan-council candidates are DELIBERATELY independent, their
  // prompt promises N independent planners, so cross-candidate mailbox chatter
  // would converge the drafts and defeat the council. No peer comms for them.
  if (task.councilGroupId !== undefined) return false;
  const peerTasks = run.workerTasks.filter((item) => item.stepId === task.stepId && item.id !== task.id);
  const plannedPeerCount = Math.max(0, (step.plannedAgents?.length ?? 0) - 1);
  return peerTasks.length + plannedPeerCount > 0;
}

// Mirror of run-store's usePiWorkerHarness gate (kept local to avoid an import
// cycle; keep the two predicates in sync). Pi-harness workers load
// resources/pi-cora/worker.ts, which registers the codara-studio bridge tools
// (preview/terminal/whiteboard-read) in-process, no CLI config file involved.
function usesPiWorkerHarness(run: RunState, task: WorkerTask): boolean {
  return (
    process.env.SPARK_E2E_LEGACY_WORKER_HARNESS !== "1" &&
    !(run.executionMode === "direct" && Boolean(run.automationId)) &&
    (task.runtimePreference === "claude" || task.runtimePreference === "codex")
  );
}

// Transport-aware availability of the codara-studio preview/terminal tools.
// The config-file check only describes CLI transports that resolve MCP servers
// from user-scope configs; Pi-harness workers register the tools in-process and
// structured automation workers get the entry at launch, claude via the SDK's
// mcpServers, codex via a forced config install (structured-worker.ts), so
// all of them always have the tools. Promising tools a worker
// does not have, or hiding tools it does, is what makes verifiers hedge.
function sparkPreviewToolsAvailable(
  run: RunState,
  task: WorkerTask,
  cwd: string,
  settings: AppSettings,
): boolean {
  if (usesPiWorkerHarness(run, task)) return true;
  // Structured automation workers always get the tools regardless of config
  // files: claude via the SDK's injected mcpServers entry, codex because
  // runCodexWorker force-installs the codara-studio entry and launches with
  // SPARK_MCP_MODE=worker (structured-worker.ts).
  if (
    run.executionMode === "direct" &&
    Boolean(run.automationId) &&
    (task.runtimePreference === "claude" || task.runtimePreference === "codex")
  ) {
    return true;
  }
  return isSparkPreviewMcpAvailable({
    cwd,
    autoInstallEnabled: settings.playwrightMcpAutoInstall !== false,
  });
}

// Only the Pi harness loads the vendored pi-web-search extension, so only
// those workers are told the tool exists.
function renderWebResearchGuidance(
  run: RunState,
  task: WorkerTask,
  // Search quota is shared across the whole parallel batch, so the 429 heads-up
  // below only makes sense when the mailbox actually exists.
  peerCommsAvailable: boolean,
): string[] {
  if (!usesPiWorkerHarness(run, task)) return [];
  return [
    "- Use the `web_search` tool for anything you need from the open web instead of fetching pages with curl or driving the preview browser, and cite the sources it returns in `proof[]`.",
    "- If `web_search` fails or rate-limits, or the task needs page-level depth, use the bundled `deep_search` tool: free, no API key, backed by DuckDuckGo's public endpoints with a Bing HTML fallback (mode \"deep\" also fetches and digests the top result pages). For structured data, fetch public endpoints (RSS feeds, published APIs) directly rather than waiting for a limit to clear. Never sleep longer than 60 seconds in one command; the wall clock is user-visible.",
    "- If `deep_search` reports that the backends are bot-challenging rather than empty, free scraping is walled for now: do not rephrase and retry it, go straight to `web_search` or a named public feed or API endpoint.",
    ...(peerCommsAvailable
      ? [
          "- `web_search` quota is shared by every worker in this batch, not per worker. The moment you hit a 429 or a rate-limit error on it, `peer_send` a one-line heads-up to `all` (subject like \"web_search 429\") before you do anything else, so peers switch to feeds and `deep_search` instead of each burning their own attempts discovering the same limit. If a peer sends you that heads-up, skip `web_search` and start from feeds or `deep_search`; retry it later only if you have no other source.",
        ]
      : []),
    "- Never open the user's system browser or GUI applications (no `open`, `xdg-open`, `osascript`, `start`). All web access goes through `web_search`, `deep_search`, or direct HTTP fetches.",
  ];
}

function renderRuntimeDelegationGuidance(task: WorkerTask): string[] {
  const isVerifier = task.taskClass === "verifier";

  if (task.runtimePreference === "claude") {
    const lines = [
      "Cora is the top-level orchestrator. You may use Claude Code native subagents, agent teams, or worktrees only when they materially reduce your context load or improve independent checking.",
      "- Good uses: bounded read-heavy exploration, test/log triage, summarizing large files, or independent review probes with a clear return format.",
      "- Do not create a nested implementation team for ordinary write work. Cora owns cross-worker coordination and parallel write planning.",
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
      "Cora explicitly permits Codex subagents for this task when they are bounded, useful, and mostly read-only.",
      "- Good uses: codebase exploration, tests/log triage, independent review, summarizing large files, or checking a narrow hypothesis.",
      "- Give each subagent a concrete job, clear limits, and the exact return format you need. Wait for the result and synthesize disagreements yourself.",
      "- Do not spawn subagents for every small task. Keep the main path local when the next action depends on the answer.",
      "- Avoid write-heavy parallel subagents unless scopes are isolated and disjoint. Cora owns top-level parallelism and cross-worker coordination.",
      "- If you use subagents, your final report must list each subagent's purpose, scope, and distilled findings.",
    ];
    if (isVerifier) {
      lines.push("- This is a verifier task: subagents must be read-only and must not edit files or mutate repository state.");
    }
    return lines;
  }

  return [];
}

function renderPeerCommsGuidance(
  task: WorkerTask,
  paths: WorkerArtifactPaths,
  // Only CC/Codex execute/auto-manager runs ever READ the manager inbox; in
  // every other flow (fan-out, loom, Pi autopilot) advertising a
  // `manager` recipient would leave workers awaiting replies that never come,
  // so the manager mentions are dropped there. See runHasMcpManager.
  managerReachable: boolean,
  // Pi-harness workers get first-class peer_list/peer_send/peer_inbox/
  // peer_await tools (resources/pi-cora/worker-peer-comms.ts) over the same
  // on-disk mailbox; CLI transports keep the node script incantation. The two
  // interoperate file-for-file, so mixed batches still coordinate.
  nativePeerTools: boolean,
): string[] {
  if (!paths.peerCommsDir || !paths.peerCommsScript) return [];
  const opening = [
    managerReachable
      ? "Cora may be running several workers for this same step, plus the `manager` that spawned this batch. Use this mailbox to coordinate: prevent duplicated work, settle a shared interface/contract, share a narrow finding, ask a peer for a second opinion, or reach the manager when blocked or at a milestone."
      : "Cora may be running several workers for this same step. Use this mailbox to coordinate: prevent duplicated work, settle a shared interface/contract, share a narrow finding, or ask a peer for a second opinion.",
    "Peers are teammates, not competitors: share findings early, claim a scope before working in shared territory, and ask before duplicating work another peer may already own. Cora, the orchestrator that spawned this batch, oversees the fleet, and only Cora ends a worker session: finish your task and write your final report; never idle waiting for peers.",
    "This is a run-artifact mailbox, not the project source tree; using it is allowed even for read-only verifier tasks.",
  ];
  const closing = [
    ...(managerReachable
      ? [
          "- Message the `manager` when you are blocked on a peer or a contract question, or when a significant milestone lands. The manager may also message you mid-flight to steer or answer, you will see it next time you read your inbox.",
        ]
      : []),
    "- When your inbox holds a peer question you can answer quickly, reply before resuming your own work, a peer stalled on your answer slows the whole fleet more than the minute your reply costs.",
    "- If your task tells you to settle a contract with a peer before building on it, send the contract note first, then await their agreement briefly before you build on it.",
    "- If your slice defines or consumes a shared interface/contract another peer depends on, send one short contract note to that peer (or `all`) before editing and read your inbox once before finalizing.",
    "- Shared contracts come from the task spec, not from invention. If your note conflicts with a peer's, reconcile before finalizing or report `partial` with the exact conflict in `risks[]`.",
    "- Do not wait indefinitely. If no reply arrives within about 2 minutes, continue with the safest explicit assumption and note it in `risks[]`.",
    "- Summarize any material peer/manager input in `proof[]`, `risks[]`, or `followups[]`; do not paste long mailbox transcripts into the final report.",
  ];

  if (nativePeerTools) {
    return [
      ...opening,
      "Native mailbox tools are registered in this session, use them directly (no shell script needed):",
      "- `peer_list`: see every participant, their status, and path scopes.",
      "- `peer_inbox`: read your messages (defaults to unread only and marks them read). Check at natural checkpoints: after finishing a phase, before starting integration.",
      managerReachable
        ? "- `peer_send`: send a short note (under ~300 words) to a peer task id, `all`, or `manager`; set `replyTo` when answering a specific message."
        : "- `peer_send`: send a short note (under ~300 words) to a peer task id or `all`; set `replyTo` when answering a specific message.",
      "- `peer_await`: block briefly for a specific reply (filter by `from`/`replyTo`; default 120s timeout).",
      ...closing,
    ];
  }

  // Plain double-quoted args work in zsh/bash/pwsh alike; run-dir paths do not
  // contain quote metacharacters, so no shell-specific quoting helper is needed.
  const script = paths.peerCommsScript;
  const dir = paths.peerCommsDir;
  const self = task.id;
  return [
    ...opening,
    managerReachable
      ? "Addressable recipients: any peer worker task id shown by `list`, `all` (every peer), or `manager` (the orchestrator that spawned you)."
      : "Addressable recipients: any peer worker task id shown by `list`, or `all` (every peer).",
    `List participants: node "${script}" list --dir "${dir}"`,
    `Check your inbox at natural checkpoints (after finishing a phase, before starting integration): node "${script}" inbox --dir "${dir}" --self ${self} --unread --mark-read`,
    managerReachable ? "Send a message to a peer, `all`, or `manager`:" : "Send a message to a peer or `all`:",
    `  node "${script}" send --dir "${dir}" --from ${self} --to "${managerReachable ? "<peer_task_id|all|manager>" : "<peer_task_id|all>"}" --subject "<topic>" --body "Short note, under ~300 words; include exact files/commands when useful."`,
    "Reply to a message you received:",
    `  node "${script}" reply --dir "${dir}" --from ${self} --to "<sender_id>" --reply-to "<msg_id>" --subject "Re: <topic>" --body "Short answer with evidence or uncertainty."`,
    `Block briefly for a specific reply: node "${script}" await --dir "${dir}" --self ${self} --reply-to "<msg_id>" --timeout 120`,
    ...closing,
  ];
}

// Mirror of run-store's runHasMcpManager (kept local to avoid an import cycle;
// see that function's comment for WHY the manager is only reachable in CLI/Pi
// execute/auto-manager runs). Keep the two predicates in sync.
function managerInboxIsRead(run: RunState): boolean {
  return (
    run.executionMode !== "direct" &&
    (run.chatBackend === "claude" || run.chatBackend === "codex" || run.chatBackend === "pi") &&
    effectiveChatMode(run.chatMode) === "auto"
  );
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

function renderCodexImageGenerationGuidance(
  step: StepState | undefined,
  task: WorkerTask,
): string[] {
  if (task.runtimePreference !== "codex" || task.taskClass === "verifier") return [];
  const text = [
    task.title,
    task.description,
    step?.title ?? "",
    step?.goal ?? "",
    ...(step?.acceptanceCriteria ?? []),
    ...(task.expectedOutputs ?? []),
  ].join(" ");
  const wouldBenefit = /\b(image|imagery|illustration|hero|banner|background|texture|sprite|game art|custom asset|visual theme|poster|cover|mascot|character art|product art|photo|photograph)\b/i.test(
    text,
  );
  const forbidsAssets = /\b(no images?|without images?|no (?:external )?assets?|pure css|css-only|single self-contained file|single-file only|one file only)\b/i.test(
    text,
  );
  if (!wouldBenefit || forbidsAssets) return [];

  return [
    "- Codex can generate and edit original raster assets with the built-in `$imagegen` skill. Use it when bespoke imagery would materially improve this deliverable instead of settling for emoji, generic gradients, or unrelated placeholders.",
    "- Generate only assets the brief actually benefits from. Prefer existing project assets and code-native CSS/SVG when those better match the established product language.",
    "- Keep every generated file inside this worker's allowed paths. Inspect its dimensions, crop, transparency, and appearance in the real UI before accepting it; reference it with a project-safe relative path.",
    "- List every generated asset in `files_changed[]` and include visual/runtime evidence in `proof[]`. Never generate an asset when the task requires no images, no extra files, or a single self-contained deliverable.",
  ];
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
      "- The `codara-studio` MCP server is available in this session. It drives the actual <preview> tab inside Codara, same DOM the user sees, no separate browser window. Call `codara_preview_navigate` with a `file://` URL (for standalone HTML) or your dev-server URL; if no preview tab is open Codara will open one automatically. Capture the final snapshot or `codara_preview_screenshot` evidence in `proof[]`.",
      "- BATCH your interaction probes with `codara_preview_run`: pass an ordered `steps` array (navigate/click/type/press_key/evaluate/wait_for/snapshot/screenshot) to drive a whole flow in ONE call. Each step fires the same real event as the single-shot tool, so you keep full fidelity but pay one round-trip instead of one per keystroke. Probe e.g. `7 / 2 =` plus a display read as a single `codara_preview_run`. A calculator should need only a handful of `codara_preview_run` calls total, NOT 50+ individual `codara_preview_press_key` calls.",
      "- Reserve the single-shot `codara_preview_click` / `codara_preview_type` / `codara_preview_press_key` tools only for probes that must isolate ONE real key/click event (e.g. the focus double-activation guard: focus equals, press Enter once, read the display).",
      "- Do NOT substitute an inline Node VM + JSDOM probe for the `codara_preview_run` batch. The whole point is that the verifier and the human see the same DOM/CSS the real browser produces.",
      "- If `codara_preview_screenshot` returns an error or a 0-size/blank frame, this preview tab is not in the foreground, do NOT retry the screenshot in a loop. Treat the pixels as unavailable and immediately fall back to `codara_preview_snapshot` + `codara_preview_evaluate` (computed styles, geometry, text content) for your evidence, noting the limitation in proof[]. A failed screenshot is a signal to switch tools, not to keep shooting.",
      "- The same `codara-studio` server also gives you `codara_terminal_create` / `codara_terminal_write` / `codara_terminal_read`: open an agent-owned terminal tab (visually tinted so the user knows an agent is driving it) to run a command the user should SEE, a dev server, a build watcher, a long-running task, then drive it with `codara_terminal_write` and read output with `codara_terminal_read`. Pass an explicit valid `cwd` to `codara_terminal_create` (it defaults to the workspace root, and a non-existent cwd makes the terminal fail to spawn). Prefer your own Bash tool for quick one-shot commands; reach for a terminal tab when the user benefits from watching it run.",
    );
  } else {
    lines.push(
      "- No browser/preview tooling is available in this session. Prove behavior with deterministic DOM/static probes (parse the final HTML, drive handlers in a runtime harness), note the limitation in `proof[]`, and do not claim visual verification you could not perform.",
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
      "- The `codara-studio` MCP server is registered in this session. You MUST use it to verify visible UI claims instead of inline Node VM + JSDOM stubs. The server drives the live <preview> tab inside Codara, the same pixels the user sees. Call `codara_preview_navigate` with a `file://` URL (standalone HTML) or the served URL; if no preview tab is open Codara will open one automatically. Take a `codara_preview_snapshot` for the accessibility-flavored outline.",
      "- BATCH verification with `codara_preview_run`: pass an ordered `steps` array (navigate/click/type/press_key/evaluate/wait_for/snapshot/screenshot) to exercise a whole flow in ONE round-trip instead of dozens of single calls. Each step fires the identical real event. Reserve single-shot `codara_preview_click` / `codara_preview_press_key` only for probes that must isolate one real key/click (e.g. focus double-activation). Attach the snapshot or `codara_preview_screenshot` evidence in `proof[]` for each behavioral atomic claim.",
      "- Treat the absence of a `codara_preview_snapshot` for any behavioral UI claim as `unsure`, not `verified`. Static DOM grep alone cannot prove rendering, event wiring, or focus behavior.",
      "- If `codara_preview_screenshot` errors or returns a 0-size/blank frame, the preview tab simply isn't foregrounded, do not retry it repeatedly. Base the visual verdict on `codara_preview_snapshot` + `codara_preview_evaluate` (computed styles, geometry, text) and record that pixels were unavailable; do not mark a claim failed solely because a screenshot could not be captured.",
      "- The same `codara-studio` server also exposes `codara_terminal_create` / `codara_terminal_write` / `codara_terminal_read`: open an agent-owned terminal tab (visually tinted) to start a dev server or run a check the user should watch, then read its output with `codara_terminal_read`. Pass an explicit valid `cwd` (a non-existent cwd makes the terminal fail to spawn). For quick one-shot verification commands your own Bash tool is simpler.",
    );
  } else {
    lines.push(
      "- The codara-studio preview tools are NOT available in this session, the browser surface cannot be driven from here. Verify visual claims with static DOM analysis plus runtime probes, state that limitation explicitly, and do not downgrade the verdict to FEEDBACK or failed solely because pixels could not be captured.",
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
    ...personalConfigFallbackLines(),
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

  const acceptanceCriteria = workerAcceptanceCriteria(step);
  if (acceptanceCriteria.length) {
    lines.push("", "## ACCEPTANCE", ...acceptanceCriteria.map((c) => `- ${c}`));
  }

  lines.push(
    "",
    "## SPEC EXACTNESS",
    "- Treat exact names, exported function shapes, JSON keys, sample output, punctuation, and decimal precision in the task as tests. If the prompt gives an example like `margin 80.0%`, match that formatting exactly unless the task explicitly says the example is illustrative.",
    "- Before reporting `complete`, run or construct a small probe that checks the exact public contract you implemented, and include the command/output in `proof[]`.",
  );

  const sparkPreviewMcpAvailable = sparkPreviewToolsAvailable(run, task, cwd, settings);
  const uiQualityGuidance = renderUiQualityGuidance(step, task, { sparkPreviewMcpAvailable });
  if (uiQualityGuidance.length) {
    lines.push("", "## UI QUALITY BAR", ...uiQualityGuidance);
  }

  const imageGenerationGuidance = renderCodexImageGenerationGuidance(step, task);
  if (imageGenerationGuidance.length) {
    lines.push("", "## ORIGINAL IMAGE ASSETS", ...imageGenerationGuidance);
  }

  const webResearchGuidance = renderWebResearchGuidance(
    run,
    task,
    shouldUsePeerComms(run, step, task) && Boolean(paths.peerCommsDir && paths.peerCommsScript),
  );
  if (webResearchGuidance.length) {
    lines.push("", "## WEB RESEARCH", ...webResearchGuidance);
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
    ? renderPeerCommsGuidance(task, paths, managerInboxIsRead(run), usesPiWorkerHarness(run, task))
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
      "A `complete` status with empty `proof[]` will be treated as `partial` by the manager review and forced to retry, do not skip this step.",
      "If any verificationCommand fails (non-zero exit, error in output), set status=\"partial\" or \"failed\" and include the failure mode in `risks[]`. Do NOT paper over a failing check by reporting `complete`.",
      "If your task description references atomic claims (sub-claims under acceptanceCriteria), enumerate them in `proof[]`: one entry per claim, citing the file:line or command output that demonstrates each one.",
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
        files_changed: [{ path: "path/to/file", reason: "Why it changed. Workspace files only: never list this report file or anything under the run's artifact directory." }],
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
    ...personalConfigFallbackLines(),
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

  const acceptanceCriteria = workerAcceptanceCriteria(step);
  if (acceptanceCriteria.length) {
    lines.push(
      "",
      "## ACCEPTANCE CRITERIA, your ground truth",
      "These are the claims you must independently prove or disprove. Decompose each into atomic sub-claims and verify each one.",
      ...acceptanceCriteria.map((c) => `- ${c}`),
    );
  }

  if (task.expectedOutputs.length) {
    lines.push(
      "",
      "## IMPLEMENTATION WORKER'S EXPECTED OUTPUTS, orientation only",
      "These are what the prior worker was supposed to produce. Use them to know WHERE to look, but do NOT trust them as evidence on their own.",
      ...task.expectedOutputs.map((output) => `- ${output}`),
    );
  }

  if (task.verificationCommands?.length) {
    lines.push(
      "",
      "## VERIFICATION COMMANDS, run each one yourself in a fresh shell",
      "Capture exit code + first 600 chars of stdout for each. These are the same commands the implementation worker was supposed to run; you re-run them with no caching, no shortcuts.",
      ...task.verificationCommands.map((c) => `- ${c}`),
    );
  }

  const sparkPreviewMcpAvailable = sparkPreviewToolsAvailable(run, task, cwd, settings);
  const uiVerifierGuidance = renderUiVerifierGuidance(step, task, { sparkPreviewMcpAvailable });
  if (uiVerifierGuidance.length) {
    lines.push("", ...uiVerifierGuidance);
  }

  const webResearchGuidance = renderWebResearchGuidance(
    run,
    task,
    shouldUsePeerComms(run, step, task) && Boolean(paths.peerCommsDir && paths.peerCommsScript),
  );
  if (webResearchGuidance.length) {
    lines.push("", "## WEB RESEARCH", ...webResearchGuidance);
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
    ? renderPeerCommsGuidance(task, paths, managerInboxIsRead(run), usesPiWorkerHarness(run, task))
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
      ? "Read-only tools only. Do not Write, Edit, or run any command that mutates project state (>, >>, tee, rm, mv, chmod, npm install, git commit, git push, destructive SQL). The Cora peer mailbox above (the peer_* tools or the mailbox commands) is the only allowed write outside the project tree."
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
              evidence: "src/main/shell-utils.ts:14, `export function quoteForShell(value: string)`",
            },
            {
              claim: "quoteForShell preserves spaces by quoting (input 'a b' → 'a b' wrapped)",
              verdict: "failed",
              evidence: "$ node --eval ... [exit=0] returned 'a b' (unquoted), strips spaces",
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
    "Confidence ladder (Cora uses this to decide what to do next):",
    "- PERFECT: every atomic claim verified with strong evidence; no missing oracle. Cora accepts the implementation.",
    "- VERIFIED: every atomic claim verified; minor gaps not load-bearing. Cora accepts.",
    "- PARTIAL: some atomic claims verified, some unverifiable, none failed. Cora may accept-with-risk or queue a follow-up.",
    "- FEEDBACK: at least one atomic claim FAILED with a fixable, specific corrective_prompt. Cora retries the implementation worker with your corrective_prompt.",
    "- FAILED: implementation is broken in ways no narrow corrective prompt fixes (architectural error, wrong file modified, wrong approach). Cora may escalate to the human.",
  );

  return lines.join("\n");
}
