"use strict";

// Full-screen terminal chat for Cora. Pi supplies the terminal primitives;
// Cora's durable run store and authenticated socket remain the source of truth.

const os = require("node:os");
const path = require("node:path");

const { rpcRaw } = require("../lib/rpc.cjs");
const { blockedQuestion, findRun, listRuns, readRun } = require("../lib/store.cjs");
const { copyText } = require("../lib/clipboard.cjs");
const {
  EFFORTS,
  FALLBACK_MODELS,
  MODES,
  commandHelp,
  createSlashCommands,
  parseSlashCommand,
} = require("../lib/chat-slash.cjs");
const { createModelEffortPicker } = require("../lib/model-picker.cjs");
const { createRunPicker } = require("../lib/run-picker.cjs");
const { createCommandEditor } = require("../lib/command-editor.cjs");
const {
  ANIMATION_TICK_MS,
  SPINNER_DIVISOR,
  motionDuration,
  spinnerFrame,
} = require("../lib/chat-motion.cjs");
const { c, duration, fail, logo } = require("../lib/ui.cjs");

const ACTIVE_ATTEMPT_STATUSES = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);
const FINISHED_STEP_STATUSES = new Set(["complete", "completed_unverified", "skipped"]);
const BUSY_RUN_STATUSES = new Set(["planning", "running", "reviewing", "working"]);

function compactTokens(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

function displayPath(cwd) {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Only real conversation turns belong in chat; maintenance stays in status UI. */
function conversationMessages(run) {
  const visible = (run?.humanMessages ?? []).filter(
    (message) =>
      typeof message.message === "string" &&
      message.message.trim() &&
      !message.compaction &&
      !message.boardNote &&
      !message.resumeNote,
  );
  return visible.filter((message, index) => {
    const previous = visible[index - 1];
    return !previous || previous.author !== message.author || previous.message !== message.message;
  });
}

function resolveReplyContent(input, run) {
  const trimmed = input.trim();
  if (!/^\d+$/u.test(trimmed)) return { content: input };
  const option = blockedQuestion(run)?.questionOptions?.[Number(trimmed) - 1];
  return option
    ? { content: option.answer || option.label, label: option.label }
    : { content: input };
}

function latestUsage(run) {
  return [...(run?.sparkCalls ?? [])]
    .reverse()
    .find((call) => call.promptTokens || call.contextWindowTokens);
}

const CORA_COMPACT_TARGET_TOKENS = 256_000;
const PI_COMPACT_HEADROOM_TOKENS = 16_384;

function contextReadout(usage) {
  if (!usage?.contextWindowTokens) return null;
  const providerSafe = Math.max(1, usage.contextWindowTokens - PI_COMPACT_HEADROOM_TOKENS);
  const effective = Math.min(CORA_COMPACT_TARGET_TOKENS, providerSafe);
  return {
    used: usage.promptTokens ?? 0,
    target: CORA_COMPACT_TARGET_TOKENS,
    effective,
    earlier: effective < CORA_COMPACT_TARGET_TOKENS,
  };
}

function latestModel(run, fallback = "auto") {
  return run?.chatModel || [...(run?.sparkCalls ?? [])].reverse().find((call) => call.model)?.model || fallback;
}

function selectedMode(flags) {
  if (flags.direct) return "direct";
  if (flags.managed) return "managed";
  return "auto";
}

function runStats(run) {
  const attempts = run?.workerAttempts ?? [];
  const activeAgents = attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status)).length;
  const steps = run?.steps ?? [];
  const finishedSteps = steps.filter((step) => FINISHED_STEP_STATUSES.has(step.status)).length;
  return { activeAgents, finishedSteps, totalSteps: steps.length };
}

function directMessageWasDispatched(run, message) {
  if (run?.executionMode !== "direct" || message?.author !== "user") return false;
  const sentAt = Date.parse(message.createdAt ?? "");
  const text = String(message.message ?? "").trim();
  return (run.workerTasks ?? []).some((task) => {
    const taskAt = Date.parse(task.createdAt ?? "");
    const description = String(task.description ?? "").trim();
    return Number.isFinite(sentAt) && Number.isFinite(taskAt) && taskAt >= sentAt &&
      (description === text || description.startsWith(`${text}\n`));
  });
}

function messageIsQueued(messages, index, run) {
  const message = messages[index];
  if (message?.author !== "user" || message.deliveryState !== "queued") return false;
  return !directMessageWasDispatched(run, message);
}

function latestActiveAttempt(run) {
  return [...(run?.workerAttempts ?? [])]
    .filter((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status))
    .sort((left, right) => Date.parse(right.startedAt ?? "") - Date.parse(left.startedAt ?? ""))[0];
}

function activeWork(run) {
  const attempt = latestActiveAttempt(run);
  const task = attempt
    ? run?.workerTasks?.find((candidate) => candidate.id === attempt.workerTaskId)
    : null;
  const step = task?.stepId
    ? run?.steps?.find((candidate) => candidate.id === task.stepId)
    : run?.steps?.find((candidate) => !FINISHED_STEP_STATUSES.has(candidate.status));
  return {
    activity: attempt?.runtimeActivity,
    attempt,
    step,
    task,
  };
}

function turnDuration(messages, index) {
  const message = messages[index];
  if (!message || message.author === "user" || !message.createdAt) return "";
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = messages[cursor];
    if (previous.author !== "user" || !previous.createdAt) continue;
    return duration(previous.createdAt, message.createdAt);
  }
  return "";
}

function latestTurnStart(run) {
  const activeCall = [...(run?.sparkCalls ?? [])]
    .reverse()
    .find((call) => call.status === "started" && call.purpose !== "compaction");
  if (activeCall?.createdAt) return activeCall.createdAt;
  const activeMessage = [...conversationMessages(run)]
    .reverse()
    .find(
      (message) =>
        message.author === "user" &&
        message.deliveryState !== "queued" &&
        message.deliveryState !== "cancelled",
    );
  return activeMessage?.createdAt || run?.createdAt;
}

function activePhase(run, work) {
  if (run.status === "reviewing") return { label: "Verifying…", tool: false };
  if (work.activity) return { label: work.activity, tool: true };
  if (work.task?.title || work.step?.title) {
    return { label: `Run ${work.task?.title || work.step?.title}`, tool: true };
  }
  if ((run.humanMessages ?? []).some((message) => message.kind === "assistant_stream")) {
    return { label: "Responding…", tool: false };
  }
  return { label: run.status === "planning" ? "Thinking…" : "Working…", tool: false };
}

function turnStatus(run, tick = 0, pendingSince) {
  if (!run && pendingSince) {
    const elapsed = motionDuration(pendingSince);
    return {
      left: `${c.gray(spinnerFrame(tick))} ${c.gray("Starting…")} ${c.dim(elapsed)}`,
      right: c.dim(elapsed),
    };
  }
  if (!run) return { left: `${c.violet("◆")} Ready for a new task`, right: "" };
  const busy = BUSY_RUN_STATUSES.has(run.status);
  const stats = runStats(run);
  const work = activeWork(run);
  if (busy) {
    const phase = activePhase(run, work);
    const turnStartedAt = latestTurnStart(run);
    const phaseStartedAt = work.attempt?.runtimeActivityAt || work.attempt?.startedAt || turnStartedAt;
    const phaseElapsed = motionDuration(phaseStartedAt);
    const turnElapsed = motionDuration(turnStartedAt);
    const tokens = latestUsage(run)?.promptTokens;
    const paint = phase.tool ? c.green : c.gray;
    return {
      left: `${paint(spinnerFrame(tick))} ${paint(phase.label)}${phaseElapsed ? ` ${c.dim(phaseElapsed)}` : ""}`,
      right: c.dim(`${turnElapsed}${tokens ? ` ⇣${compactTokens(tokens)}` : ""}  [stop: /cancel]`),
    };
  }
  const labels = {
    blocked: `${c.yellow("◆")} Cora needs your answer`,
    cancelled: `${c.red("×")} Run cancelled`,
    complete: `${c.green("✓")} Worked for ${duration(run.createdAt, run.completedAt) || "a moment"}`,
    failed: `${c.red("×")} Run failed`,
    idle: `${c.violet("◆")} Ready`,
    paused: `${c.yellow("◆")} Run paused`,
  };
  const detail = stats.totalSteps ? `${stats.finishedSteps}/${stats.totalSteps} steps` : "";
  return { left: labels[run.status] ?? `${c.violet("◆")} ${run.status}`, right: c.dim(detail) };
}

function runSignature(run) {
  if (!run) return "new";
  return JSON.stringify({
    id: run.id,
    status: run.status,
    messages: conversationMessages(run).map((message) => [
      message.id,
      message.author,
      message.kind,
      message.message,
      message.deliveryState,
      message.questionOptions,
    ]),
    steps: (run.steps ?? []).map((step) => [step.id, step.status, step.title]),
    tasks: (run.workerTasks ?? []).map((task) => [task.id, task.status, task.title]),
    attempts: (run.workerAttempts ?? []).map((attempt) => [
      attempt.id,
      attempt.status,
      attempt.runtimeState,
      attempt.runtimeActivity,
      attempt.runtimeActivityAt,
    ]),
  });
}

function markdownTheme() {
  return {
    heading: c.bold,
    link: c.cyan,
    linkUrl: c.dim,
    code: c.yellow,
    codeBlock: (text) => text,
    codeBlockBorder: c.dim,
    quote: c.gray,
    quoteBorder: c.violet,
    hr: c.dim,
    listBullet: c.cyan,
    bold: c.bold,
    italic: (text) => text,
    strikethrough: c.dim,
    underline: c.cyan,
  };
}

function editorTheme() {
  return {
    borderColor: c.violet,
    selectList: {
      selectedPrefix: c.cyan,
      selectedText: c.bold,
      description: c.dim,
      scrollInfo: c.dim,
      noMatch: c.dim,
    },
  };
}

function addWelcome(transcript, Text, CenteredBlock, cwd, profileId) {
  const profile = profileId && profileId !== "default" ? profileId : "default";
  transcript.addChild(new CenteredBlock(logo(), 1, 0));
  transcript.addChild(
    new CenteredBlock(
      `${c.bold("YOUR PROJECT AGENT")}  ${c.dim("· built into Codara Studio")}`,
      0,
      1,
    ),
  );
  transcript.addChild(
    new Text(
      [
        `  ${c.violet("╭─")} ${c.bold("Start here")}`,
        `  ${c.violet("│")} ${c.dim(displayPath(cwd))}`,
        `  ${c.violet("│")} ${c.dim(`profile ${profile} · model and reasoning open together`)}`,
        `  ${c.violet("╰─")} ${c.cyan("/model")}  ${c.dim("choose setup")}   ${c.cyan("/resume")}  ${c.dim("continue work")}   ${c.cyan("/")}  ${c.dim("all commands")}`,
      ].join("\n"),
      0,
      1,
    ),
  );
}

function addConversation(transcript, run, ui, hiddenMessageCount = 0) {
  const { Container, Markdown, Text } = ui;
  transcript.addChild(
    new Text(
      `  ${c.violet("◆")} ${c.bold(run.title || "Cora run")}  ${c.dim(run.id.slice(0, 12))}`,
      0,
      1,
    ),
  );
  const allMessages = conversationMessages(run);
  const messages = allMessages.slice(hiddenMessageCount);
  if (messages.length === 0) {
    transcript.addChild(new Text(c.dim(hiddenMessageCount ? "  Transcript cleared. New messages appear here." : "  Waiting for the first message…")));
    return;
  }

  for (const [visibleIndex, message] of messages.entries()) {
    const group = new Container();
    const user = message.author === "user";
    const streaming = message.kind === "assistant_stream";
    const messageIndex = hiddenMessageCount + visibleIndex;
    const queued = messageIsQueued(allMessages, messageIndex, run);
    const suffix = streaming ? c.dim("  writing…") : queued ? c.dim("  queued") : "";
    if (user) {
      group.addChild(
        new Text(`${c.violet("›")} ${message.message}${suffix}`, 2, 0, c.surfaceStrong),
      );
    } else {
      const name = message.author === "system"
        ? c.dim(c.bold("SYSTEM"))
        : c.cyan(c.bold("◆ CORA"));
      const workedFor = turnDuration(allMessages, messageIndex);
      const timing = workedFor ? c.dim(`  ·  worked for ${workedFor}`) : "";
      group.addChild(new Text(`  ${name}${timing}${suffix}`, 0, 1));
      group.addChild(new Markdown(message.message, 2, 0, markdownTheme()));
    }
    if (message.kind === "question" && message.questionOptions?.length) {
      const options = message.questionOptions
        .map((option, index) => `  ${index + 1}. ${option.label}${option.recommended ? "  (recommended)" : ""}`)
        .join("\n");
      group.addChild(new Text(c.yellow(options), 0, 1));
    }
    transcript.addChild(group);
  }

}

function addLocalOutput(transcript, Text, output) {
  transcript.addChild(
    new Text(
      [`  ${c.yellow("◇")} ${c.bold(output.title)}`, ...output.body.split("\n").map((line) => `  ${c.dim("│")} ${line}`)].join("\n"),
      0,
      1,
    ),
  );
}

function formatHelp() {
  const rows = commandHelp();
  const width = Math.max(...rows.map((row) => row.command.length));
  return rows
    .map((row) => `${row.command.padEnd(width)}  ${row.description}`)
    .join("\n");
}

async function callRpc(flags, method, params) {
  const response = await rpcRaw(flags, method, params);
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  return response.result;
}

/**
 * Delete through the dedicated socket method. An already-running development
 * build may predate that method even though its renderer has always exposed
 * the same guarded run-store deletion; use that bridge only for this exact
 * version-skew case so contributors do not have to kill active Studio work.
 */
async function deleteRunRpc(flags, runId, request = rpcRaw) {
  const response = await request(flags, "chat.delete", { runId });
  if (!response.error) return response.result;
  if (response.error.code !== -32601) {
    throw new Error(response.error.message ?? JSON.stringify(response.error));
  }

  const code =
    `Promise.resolve(window.spark.orchestration.deleteRun(${JSON.stringify(runId)}))` +
    ".then(() => ({ ok: true }))";
  const legacy = await request(flags, "app.evaluate", { code });
  if (legacy.error) {
    throw new Error(
      `${response.error.message}. Restart Codara Studio to load the updated session API.`,
    );
  }
  return { ok: true, runId };
}

async function chat(args, flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("`cora chat` needs an interactive terminal");
  }
  if (args.length > 1) fail("usage: cora chat [run] [--cwd DIR --model M --effort E --direct]");
  if (flags.direct && flags.managed) fail("choose only one of --direct or --managed");

  const ui = await import("@earendil-works/pi-tui");
  const {
    CombinedAutocompleteProvider,
    Container,
    Editor,
    ProcessTerminal,
    ScrollView,
    Text,
    TuiAltScreen,
    VStack,
    matchesKey,
    truncateToWidth,
    visibleWidth,
  } = ui;

  const CommandEditor = createCommandEditor({
    Editor,
    matchesKey,
    visibleWidth,
    truncateToWidth,
    ghostStyle: c.dim,
  });

  class AlignedLine {
    constructor(left = "", right = "", style) {
      this.left = left;
      this.right = right;
      this.style = style;
    }

    set(left, right = "") {
      this.left = left;
      this.right = right;
    }

    invalidate() {}

    render(width) {
      const innerWidth = Math.max(1, width - 4);
      const right = truncateToWidth(this.right, innerWidth);
      const rightWidth = visibleWidth(right);
      const leftWidth = Math.max(0, innerWidth - rightWidth - (rightWidth ? 1 : 0));
      const left = truncateToWidth(this.left, leftWidth);
      const gap = " ".repeat(Math.max(0, innerWidth - visibleWidth(left) - rightWidth));
      const line = `  ${left}${gap}${right}  `;
      return [this.style ? this.style(line) : line];
    }
  }

  class CenteredBlock {
    constructor(text, paddingTop = 0, paddingBottom = 0) {
      this.lines = String(text).split("\n");
      this.paddingTop = paddingTop;
      this.paddingBottom = paddingBottom;
    }

    invalidate() {}

    render(width) {
      const lines = this.lines.map((raw) => {
        const clipped = truncateToWidth(raw, width, "");
        return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2)))}${clipped}`;
      });
      return [
        ...Array.from({ length: this.paddingTop }, () => ""),
        ...lines,
        ...Array.from({ length: this.paddingBottom }, () => ""),
      ];
    }
  }

  const cwd = path.resolve(flags.cwd || process.cwd());
  let run = args[0] ? findRun(flags, args[0]) : null;
  let renderedSignature = "";
  let frame = 0;
  let notice = null;
  let hiddenMessageCount = 0;
  let localRevision = 0;
  let localOutputs = [];
  let modelCatalog = null;
  let profileCatalog = null;
  let modelPickerOverlay = null;
  let runPickerOverlay = null;
  let pendingSendAt = null;
  let stopped = false;
  let animationTimer;
  let pollTimer;
  let finish = () => {};

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, {
    mouse: true,
    searchMatchStyle: c.yellow,
    searchCurrentMatchStyle: c.bold,
  });
  const transcript = new Container();
  const scroll = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    overscroll: "contain",
    scrollbar: "auto",
    scrollbarStyle: c.dim,
  });
  const header = new AlignedLine("", "", c.surface);
  const activity = new AlignedLine();
  const editor = new CommandEditor(tui, editorTheme(), { paddingX: 2, autocompleteMaxVisible: 6 });
  const footer = new AlignedLine();

  function workspaceRuns() {
    return listRuns(flags).filter((candidate) => {
      const candidateCwd = candidate.settingsSnapshot?.workspaceCwd || candidate.cwd;
      return typeof candidateCwd === "string" && path.resolve(candidateCwd) === cwd;
    });
  }

  function pushOutput(title, body) {
    localOutputs = [
      ...localOutputs.filter((output) => output.title !== title).slice(-4),
      { title, body: String(body) },
    ];
    localRevision += 1;
    renderedSignature = "";
  }

  async function availableModels() {
    if (modelCatalog) return modelCatalog;
    try {
      const result = await callRpc(flags, "models.list", {});
      modelCatalog = result.models?.length ? result.models : [...FALLBACK_MODELS];
    } catch {
      modelCatalog = [...FALLBACK_MODELS];
    }
    return modelCatalog;
  }

  async function availableProfiles() {
    try {
      const result = await callRpc(flags, "profiles.list", {});
      profileCatalog = result.profiles ?? [];
    } catch {
      profileCatalog ??= [];
    }
    return profileCatalog;
  }

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      createSlashCommands({
        listModels: availableModels,
        listProfiles: availableProfiles,
        listRuns: async () => workspaceRuns(),
      }),
      cwd,
    ),
  );

  function refreshTranscript(force = false) {
    const signature = `${runSignature(run)}:${hiddenMessageCount}:${localRevision}`;
    if (!force && signature === renderedSignature) return;
    renderedSignature = signature;
    transcript.clear();
    if (run) addConversation(transcript, run, ui, hiddenMessageCount);
    else addWelcome(transcript, Text, CenteredBlock, cwd, flags.profile);
    for (const output of localOutputs) addLocalOutput(transcript, Text, output);
  }

  function refreshChrome(nextNotice) {
    if (nextNotice === null) notice = null;
    else if (nextNotice !== undefined) notice = { text: nextNotice, until: Date.now() + 5_000 };
    if (notice && notice.until <= Date.now()) notice = null;
    const usage = latestUsage(run);
    const contextGauge = contextReadout(usage);
    const context = contextGauge
      ? `${compactTokens(contextGauge.used)} / ${compactTokens(contextGauge.target)} context`
      : "";
    header.set(`${c.violet("◆")} ${c.bold("CORA")}`, c.dim(`${displayPath(cwd)}${context ? `  ·  ${context}` : ""}`));
    const moving = Boolean(pendingSendAt) || BUSY_RUN_STATUSES.has(run?.status);
    const status = notice && !moving
      ? { left: notice.text, right: "" }
      : turnStatus(run, frame, pendingSendAt);
    activity.set(status.left, status.right);
    editor.borderColor = BUSY_RUN_STATUSES.has(run?.status) ? c.cyan : c.violet;
    const shortcuts = `${c.bold("enter")} send  ${c.bold("shift+enter")} newline  ${c.bold("/")} commands  ${c.bold("ctrl+c")} leave`;
    const profileId = run?.coraProfileId || flags.profile;
    const modelId = latestModel(run, flags.model);
    const model = modelCatalog?.find((candidate) => candidate.id === modelId);
    const effort = model && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length === 0
      ? "fixed"
      : run?.chatEffort || flags.effort || "medium";
    const identity = `${modelId}  ·  ${effort}  ·  ${profileId || "default"}  ·  ${selectedMode(flags)}`;
    footer.set(c.dim(shortcuts), c.dim(identity));
    tui.requestRender();
  }

  async function poll() {
    if (stopped) return;
    if (run?.id) run = readRun(flags, run.id) ?? run;
    refreshTranscript();
    refreshChrome();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(animationTimer);
    clearInterval(pollTimer);
    process.off("SIGTERM", onSigterm);
    tui.stop({ preserveScreen: true });
    await terminal.drainInput(200, 30).catch(() => {});
    finish();
  }

  const onSigterm = () => void stop();

  function showOutput(title, body, nextNotice) {
    pushOutput(title, body);
    refreshTranscript(true);
    refreshChrome(nextNotice);
  }

  function resolveRecentRun(reference) {
    const candidates = workspaceRuns();
    const exact = candidates.find((candidate) => candidate.id === reference);
    if (exact) return exact;
    const matches = candidates.filter((candidate) => candidate.id.startsWith(reference));
    return matches.length === 1 ? matches[0] : null;
  }

  function closeModelPicker() {
    if (!modelPickerOverlay) return;
    modelPickerOverlay.hide();
    modelPickerOverlay = null;
    tui.requestRender();
  }

  function closeRunPicker() {
    if (!runPickerOverlay) return;
    runPickerOverlay.hide();
    runPickerOverlay = null;
    tui.requestRender();
  }

  function resumeRun(nextRun) {
    run = nextRun;
    hiddenMessageCount = 0;
    localOutputs = [];
    localRevision += 1;
    renderedSignature = "";
    refreshTranscript(true);
    refreshChrome(`${c.violet("◆")} Resumed ${run.title || run.id.slice(0, 12)}`);
  }

  function openRunPicker() {
    if (runPickerOverlay) return;
    const picker = createRunPicker({
      runs: workspaceRuns(),
      currentRunId: run?.id,
      onCancel: closeRunPicker,
      onApply: (selected) => {
        resumeRun(selected);
        closeRunPicker();
      },
      onCopy: (selected) => copyText(selected.id),
      onDelete: async (selected) => {
        await deleteRunRpc(flags, selected.id);
        if (run?.id === selected.id) {
          run = null;
          hiddenMessageCount = 0;
          localOutputs = [];
          localRevision += 1;
          renderedSignature = "";
          refreshTranscript(true);
          refreshChrome();
        }
      },
      requestRender: () => tui.requestRender(),
      ui,
    });
    runPickerOverlay = tui.showOverlay(picker, {
      width: "64%",
      minWidth: 52,
      maxHeight: "84%",
      anchor: "center",
      margin: 2,
    });
    tui.requestRender();
  }

  async function applyModelChoice(model, effort) {
    flags.model = model.id;
    if (effort) flags.effort = effort;
    if (run) {
      run = (await callRpc(flags, "chat.configure", {
        runId: run.id,
        model: model.id,
        ...(effort ? { effort } : {}),
      })).run ?? run;
    }
    const fixedReasoning = Array.isArray(model.thinkingLevels) && model.thinkingLevels.length === 0;
    const shownEffort = fixedReasoning ? "fixed" : effort || run?.chatEffort || flags.effort || "medium";
    showOutput(
      "MODEL + REASONING",
      `${model.label || model.id}  ·  ${shownEffort}${run ? "\nApplied to this chat and future tasks." : "\nReady for your next task."}`,
      `${c.green("✓")} Model and reasoning updated`,
    );
  }

  async function openModelPicker() {
    if (modelPickerOverlay) {
      modelPickerOverlay.focus();
      return;
    }
    const picker = createModelEffortPicker({
      models: await availableModels(),
      currentModel: latestModel(run, flags.model),
      currentEffort: run?.chatEffort || flags.effort || "medium",
      onCancel: closeModelPicker,
      onApply: async ({ model, effort }) => {
        await applyModelChoice(model, effort);
        closeModelPicker();
      },
      requestRender: () => tui.requestRender(),
      ui,
    });
    modelPickerOverlay = tui.showOverlay(picker, {
      width: 56,
      maxHeight: "80%",
      anchor: "center",
      margin: 2,
    });
    tui.requestRender();
  }

  async function handleCommand(text) {
    const command = parseSlashCommand(text);
    if (!command) return false;

    if (command.name === "quit") {
      await stop();
      return true;
    }
    if (command.name === "help") {
      showOutput("COMMANDS", formatHelp());
      return true;
    }
    if (command.name === "new") {
      run = null;
      hiddenMessageCount = 0;
      localOutputs = [];
      localRevision += 1;
      renderedSignature = "";
      refreshTranscript(true);
      refreshChrome(`${c.violet("◆")} Ready for a new task`);
      return true;
    }
    if (command.name === "resume") {
      if (!command.args) {
        openRunPicker();
        return true;
      }
      const resumed = resolveRecentRun(command.args);
      if (!resumed) {
        showOutput("RESUME", `No unique run matches “${command.args}”.`);
        return true;
      }
      resumeRun(resumed);
      return true;
    }
    if (command.name === "copy-id") {
      if (!run) {
        refreshChrome(c.yellow("Start or resume a chat before copying its run id"));
        return true;
      }
      copyText(run.id);
      refreshChrome(`${c.green("✓")} Copied ${run.id}`);
      return true;
    }
    if (command.name === "cancel") {
      if (!run) {
        refreshChrome(c.yellow("No active run to cancel"));
        return true;
      }
      run = (await callRpc(flags, "chat.cancel", { runId: run.id })).run ?? run;
      renderedSignature = "";
      refreshTranscript();
      refreshChrome(null);
      return true;
    }

    if (command.name === "model") {
      const models = await availableModels();
      if (!command.args) {
        await openModelPicker();
        return true;
      }
      let requested = command.args;
      let effort;
      let model = models.find(
        (candidate) =>
          candidate.id.toLowerCase() === requested.toLowerCase() ||
          candidate.label.toLowerCase() === requested.toLowerCase(),
      );
      if (!model) {
        const split = /^(.*)\s+(\S+)$/u.exec(requested);
        if (split && EFFORTS.includes(split[2].toLowerCase())) {
          requested = split[1].trim();
          effort = split[2].toLowerCase();
          model = models.find(
            (candidate) =>
              candidate.id.toLowerCase() === requested.toLowerCase() ||
              candidate.label.toLowerCase() === requested.toLowerCase(),
          );
        }
      }
      if (!model) {
        showOutput("MODEL", `Unknown model “${command.args}”.\nRun /model to see what Cora can use.`);
        return true;
      }
      if (effort && Array.isArray(model.thinkingLevels) && !model.thinkingLevels.includes(effort)) {
        showOutput(
          "MODEL",
          model.thinkingLevels.length
            ? `${model.label} supports: ${model.thinkingLevels.join(", ")}`
            : `${model.label} does not expose a reasoning-effort control.`,
        );
        return true;
      }
      await applyModelChoice(model, effort);
      return true;
    }

    if (command.name === "effort") {
      if (!command.args) {
        await openModelPicker();
        return true;
      }
      const effort = command.args.toLowerCase();
      if (!EFFORTS.includes(effort)) {
        showOutput("EFFORT", `Usage: /effort <${EFFORTS.join("|")}>`);
        return true;
      }
      flags.effort = effort;
      if (run) {
        run = (await callRpc(flags, "chat.configure", { runId: run.id, effort })).run ?? run;
      }
      showOutput("EFFORT", `${effort}${run ? " · applied to this chat" : " · ready for the next task"}`, `${c.green("✓")} Effort updated`);
      return true;
    }

    if (command.name === "profile") {
      const profiles = await availableProfiles();
      if (!command.args) {
        showOutput(
          "PROFILES",
          profiles.length
            ? profiles.map((profile) => `${profile.isDefault ? "●" : "○"} ${profile.name}  ${profile.id}`).join("\n")
            : "No profiles available. Create one in Codara Studio → Settings → Agents → Memory.",
        );
        return true;
      }
      const profile = profiles.find(
        (candidate) =>
          candidate.id.toLowerCase() === command.args.toLowerCase() ||
          candidate.name.toLowerCase() === command.args.toLowerCase(),
      );
      if (!profile) {
        showOutput("PROFILE", `Unknown profile “${command.args}”. Run /profile to list them.`);
        return true;
      }
      const selected = await callRpc(flags, "profiles.use", { profile: profile.id });
      profileCatalog = selected.profiles ?? null;
      flags.profile = selected.profile.id;
      showOutput(
        "PROFILE",
        `${selected.profile.name} is now the default.${run ? "\nThis run keeps its original memory; /new uses the new profile." : ""}`,
        `${c.green("✓")} Profile updated`,
      );
      return true;
    }

    if (command.name === "mode") {
      const mode = command.args.toLowerCase();
      if (!MODES.includes(mode)) {
        showOutput("MODE", `Usage: /mode <${MODES.join("|")}>`);
        return true;
      }
      flags.direct = mode === "direct";
      flags.managed = mode === "managed";
      showOutput(
        "MODE",
        `${mode}${run ? " · applies after /new (an active run stays frozen)" : " · ready for the next task"}`,
        `${c.green("✓")} Mode updated`,
      );
      return true;
    }

    if (command.name === "status") {
      const profile = run?.coraProfileId || flags.profile || "default";
      showOutput(
        "STATUS",
        [
          `workspace  ${displayPath(cwd)}`,
          `run        ${run ? `${run.id.slice(0, 12)} · ${run.status}` : "new task"}`,
          `model      ${latestModel(run, flags.model)}`,
          `effort     ${run?.chatEffort || flags.effort || "medium"}`,
          `profile    ${profile}`,
          `mode       ${selectedMode(flags)}${run ? " (next task)" : ""}`,
        ].join("\n"),
      );
      return true;
    }

    if (command.name === "context") {
      const usage = latestUsage(run);
      const context = contextReadout(usage);
      showOutput(
        "CONTEXT",
        context
          ? [
              `${compactTokens(context.used)} used · Cora's compact target is ${compactTokens(context.target)} tokens.`,
              ...(context.earlier
                ? [`This model keeps extra safety room, so it may compact around ${compactTokens(context.effective)}.`]
                : []),
              "Run /compact whenever you want a fresh context now.",
            ].join("\n")
          : "No context-window measurement yet for this chat.",
      );
      return true;
    }

    if (command.name === "compact") {
      if (!run) {
        showOutput("COMPACT", "Start a conversation before compacting it.");
        return true;
      }
      refreshChrome(c.cyan("✦ Summarizing this conversation…"));
      run = (await callRpc(flags, "chat.compact", { runId: run.id })).run ?? run;
      renderedSignature = "";
      showOutput(
        "COMPACTED",
        "Older turns are now represented by a durable summary. Your next message starts with fresh context.",
        `${c.green("✓")} Context compacted`,
      );
      return true;
    }

    if (command.name === "agents") {
      const attempts = run?.workerAttempts ?? [];
      const tasks = new Map((run?.workerTasks ?? []).map((task) => [task.id, task]));
      showOutput(
        "AGENTS",
        attempts.length
          ? attempts
              .slice(-12)
              .map((attempt) => {
                const task = tasks.get(attempt.workerTaskId);
                return `${String(attempt.status).padEnd(20)} ${(task?.title || attempt.workerTaskId || attempt.id).slice(0, 54)}${attempt.model ? ` · ${attempt.model}` : ""}`;
              })
              .join("\n")
          : "No subagents on this run yet.",
      );
      return true;
    }

    if (command.name === "board") {
      const steps = run?.steps ?? [];
      showOutput(
        "BOARD",
        steps.length
          ? steps.map((step, index) => `${String(index + 1).padStart(2)}  ${String(step.status).padEnd(22)} ${step.title}`).join("\n")
          : "No plan steps on this run yet.",
      );
      return true;
    }

    if (command.name === "runs") {
      const recent = workspaceRuns().slice(0, 12);
      showOutput(
        "RECENT RUNS",
        recent.length
          ? recent.map((item) => `${item.id.slice(0, 12)}  ${String(item.status).padEnd(10)}  ${item.title || "Untitled"}`).join("\n")
          : "No Cora runs yet.",
      );
      return true;
    }

    if (command.name === "cwd") {
      showOutput("WORKSPACE", cwd);
      return true;
    }

    if (command.name === "rename") {
      if (!run) {
        showOutput("RENAME", "Start a task before renaming its chat.");
        return true;
      }
      if (!command.args) {
        showOutput("RENAME", "Usage: /rename <title>");
        return true;
      }
      run = (await callRpc(flags, "chat.rename", { runId: run.id, title: command.args })).run ?? run;
      showOutput("RENAMED", run.title, `${c.green("✓")} Chat renamed`);
      return true;
    }

    if (command.name === "clear") {
      hiddenMessageCount = conversationMessages(run).length;
      localOutputs = [];
      localRevision += 1;
      renderedSignature = "";
      refreshTranscript(true);
      refreshChrome();
      return true;
    }

    if (command.name) {
      showOutput("UNKNOWN COMMAND", `/${command.rawName}\nType / to browse commands or run /help.`);
      return true;
    }
    return true;
  }

  editor.onSubmit = (text) => {
    void (async () => {
      if (!text.trim() || stopped) return;
      editor.disableSubmit = true;
      try {
        if (await handleCommand(text)) return;
        localOutputs = [];
        localRevision += 1;
        pendingSendAt = new Date().toISOString();
        refreshChrome(null);
        let confirmation = null;
        if (!run) {
          const params = { cwd, prompt: text, backend: "pi" };
          for (const key of ["model", "effort"]) if (flags[key]) params[key] = flags[key];
          if (flags.profile) params.coraProfile = flags.profile;
          if (flags.direct || flags.managed) params.execution = flags.direct ? "direct" : "managed";
          const started = await callRpc(flags, "chat.create", params);
          run = started.run;
        } else {
          const reply = resolveReplyContent(text, run);
          const sent = await callRpc(flags, "chat.send", { runId: run.id, content: reply.content });
          run = sent.run ?? run;
          if (reply.label) confirmation = c.dim(`Answered: ${reply.label}`);
        }
        pendingSendAt = null;
        editor.addToHistory(text);
        renderedSignature = "";
        refreshTranscript();
        refreshChrome(confirmation);
      } catch (error) {
        pendingSendAt = null;
        editor.setText(text);
        refreshChrome(c.red(error instanceof Error ? error.message : String(error)));
      } finally {
        editor.disableSubmit = false;
        tui.requestRender();
      }
    })();
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (modelPickerOverlay) {
        closeModelPicker();
        return { consume: true };
      }
      if (runPickerOverlay) {
        closeRunPicker();
        return { consume: true };
      }
      void stop();
      return { consume: true };
    }
    return undefined;
  });
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto" },
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: activity, basis: "auto" },
      { component: editor, basis: "auto", shrink: 1, minSize: 3 },
      { component: footer, basis: "auto" },
    ]),
  );
  tui.setFocus(editor);
  refreshTranscript(true);
  refreshChrome();
  process.once("SIGTERM", onSigterm);
  animationTimer = setInterval(() => {
    frame = (frame + 1) % (Number.MAX_SAFE_INTEGER - 1);
    if (
      frame % SPINNER_DIVISOR === 0 &&
      (pendingSendAt || BUSY_RUN_STATUSES.has(run?.status))
    ) {
      refreshChrome();
    }
  }, ANIMATION_TICK_MS);
  pollTimer = setInterval(() => void poll(), 700);

  const done = new Promise((resolve) => {
    finish = resolve;
  });
  tui.start();
  try {
    await done;
  } finally {
    if (!stopped) await stop();
  }
}

module.exports = {
  activeWork,
  chat,
  compactTokens,
  contextReadout,
  conversationMessages,
  directMessageWasDispatched,
  deleteRunRpc,
  messageIsQueued,
  resolveReplyContent,
  runStats,
  turnDuration,
  turnStatus,
};
