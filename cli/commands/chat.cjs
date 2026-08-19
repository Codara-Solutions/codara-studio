"use strict";

// Full-screen terminal chat for Cora. Pi supplies the terminal primitives;
// Cora's durable run store and authenticated socket remain the source of truth.

const os = require("node:os");
const path = require("node:path");

const { rpcRaw } = require("../lib/rpc.cjs");
const { blockedQuestion, findRun, readRun } = require("../lib/store.cjs");
const { c, duration, fail } = require("../lib/ui.cjs");

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

function latestModel(run, fallback = "auto") {
  return [...(run?.sparkCalls ?? [])].reverse().find((call) => call.model)?.model || fallback;
}

function runStats(run) {
  const attempts = run?.workerAttempts ?? [];
  const activeAgents = attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status)).length;
  const steps = run?.steps ?? [];
  const finishedSteps = steps.filter((step) => FINISHED_STEP_STATUSES.has(step.status)).length;
  return { activeAgents, finishedSteps, totalSteps: steps.length };
}

function activityText(run, frame = 0) {
  if (!run) return `${c.violet("◆")} Ready for a new task`;
  const { activeAgents, finishedSteps, totalSteps } = runStats(run);
  const labels = {
    blocked: "Cora needs your answer",
    cancelled: "Run cancelled",
    complete: "Cora finished",
    failed: "Run failed",
    idle: "Ready",
    paused: "Run paused",
    planning: "Cora is planning",
    reviewing: "Cora is reviewing",
    running: "Cora is working",
    working: "Cora is working",
  };
  const busy = BUSY_RUN_STATUSES.has(run.status);
  const icon = busy ? (frame % 2 === 0 ? "✦" : "✧") : run.status === "complete" ? "✓" : "◆";
  const parts = [`${busy ? c.cyan(icon) : c.violet(icon)} ${labels[run.status] ?? run.status}`];
  if (activeAgents) parts.push(`${activeAgents} agent${activeAgents === 1 ? "" : "s"}`);
  if (totalSteps) parts.push(`${finishedSteps}/${totalSteps} steps`);
  const elapsed = duration(run.createdAt, run.completedAt);
  if (elapsed) parts.push(elapsed);
  return parts.join(c.dim("  ·  "));
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

function addWelcome(transcript, Text, cwd) {
  transcript.addChild(new Text("", 0, 1));
  transcript.addChild(new Text(`  ${c.violet("◆")} ${c.bold("CORA")}`));
  transcript.addChild(new Text(c.dim("  Your Codara Studio agent, in the terminal.")));
  transcript.addChild(new Text(c.dim(`  Start a task in ${displayPath(cwd)}`), 0, 1));
}

function addConversation(transcript, run, ui) {
  const { Container, Markdown, Text } = ui;
  transcript.addChild(new Text(c.dim(`  ${run.title || "Cora run"}  ·  ${run.id.slice(0, 12)}`), 0, 1));
  const messages = conversationMessages(run);
  if (messages.length === 0) {
    transcript.addChild(new Text(c.dim("  Waiting for the first message…")));
    return;
  }

  for (const message of messages) {
    const group = new Container();
    const user = message.author === "user";
    const streaming = message.kind === "assistant_stream";
    const queued = user && message.deliveryState === "queued";
    const suffix = streaming ? c.dim("  writing…") : queued ? c.dim("  queued") : "";
    const name = user
      ? c.violet(c.bold("You"))
      : message.author === "system"
        ? c.dim(c.bold("System"))
        : c.cyan(c.bold("Cora"));
    group.addChild(new Text(`  ${name}${suffix}`, 0, 1));
    group.addChild(new Markdown(message.message, 2, 0, markdownTheme()));
    if (message.kind === "question" && message.questionOptions?.length) {
      const options = message.questionOptions
        .map((option, index) => `  ${index + 1}. ${option.label}${option.recommended ? "  (recommended)" : ""}`)
        .join("\n");
      group.addChild(new Text(c.yellow(options), 0, 1));
    }
    transcript.addChild(group);
  }
}

async function callRpc(flags, method, params) {
  const response = await rpcRaw(flags, method, params);
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  return response.result;
}

async function chat(args, flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("`cora chat` needs an interactive terminal");
  }
  if (args.length > 1) fail("usage: cora chat [run] [--cwd DIR --model M --effort E --direct]");
  if (flags.direct && flags.managed) fail("choose only one of --direct or --managed");

  const ui = await import("@earendil-works/pi-tui");
  const {
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

  class AlignedLine {
    constructor(left = "", right = "") {
      this.left = left;
      this.right = right;
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
      return [`  ${left}${gap}${right}  `];
    }
  }

  const cwd = path.resolve(flags.cwd || process.cwd());
  let run = args[0] ? findRun(flags, args[0]) : null;
  let renderedSignature = "";
  let frame = 0;
  let helpVisible = false;
  let notice = null;
  let stopped = false;
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
  const header = new AlignedLine();
  const activity = new Text();
  const editor = new Editor(tui, editorTheme(), { paddingX: 2, autocompleteMaxVisible: 6 });
  const footer = new AlignedLine();

  function refreshTranscript(force = false) {
    const signature = `${runSignature(run)}:${helpVisible}`;
    if (!force && signature === renderedSignature) return;
    renderedSignature = signature;
    transcript.clear();
    if (run) addConversation(transcript, run, ui);
    else addWelcome(transcript, Text, cwd);
    if (helpVisible) {
      transcript.addChild(
        new Text(
          `${c.bold("  Commands")}\n` +
            `  ${c.cyan("/new")}     leave this run and compose a new task\n` +
            `  ${c.cyan("/cancel")}  stop the current run\n` +
            `  ${c.cyan("/help")}    show this help\n` +
            `  ${c.cyan("/quit")}    leave Cora (the run keeps going)`,
          0,
          1,
        ),
      );
    }
  }

  function refreshChrome(nextNotice) {
    if (nextNotice === null) notice = null;
    else if (nextNotice !== undefined) notice = { text: nextNotice, until: Date.now() + 5_000 };
    if (notice && notice.until <= Date.now()) notice = null;
    frame += 1;
    const usage = latestUsage(run);
    const context = usage?.contextWindowTokens
      ? `${compactTokens(usage.promptTokens ?? 0)} / ${compactTokens(usage.contextWindowTokens)} context`
      : "";
    header.set(c.bold(displayPath(cwd)), c.dim(context));
    activity.setText(`  ${notice?.text || activityText(run, frame)}`);
    const shortcuts = `${c.bold("enter")} send  ${c.bold("shift+enter")} newline  ${c.bold("ctrl+c")} leave  ${c.bold("/help")} commands`;
    const identity = `${latestModel(run, flags.model)}${run ? `  ·  ${run.id.slice(0, 8)}` : ""}`;
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
    clearInterval(pollTimer);
    process.off("SIGTERM", onSigterm);
    tui.stop({ preserveScreen: true });
    await terminal.drainInput(200, 30).catch(() => {});
    finish();
  }

  const onSigterm = () => void stop();

  async function handleCommand(text) {
    const command = text.trim().toLowerCase();
    if (command === "/quit" || command === "/exit") {
      await stop();
      return true;
    }
    if (command === "/help") {
      helpVisible = true;
      refreshTranscript(true);
      refreshChrome();
      return true;
    }
    if (command === "/new") {
      run = null;
      helpVisible = false;
      renderedSignature = "";
      refreshTranscript(true);
      refreshChrome("◆ Ready for a new task");
      return true;
    }
    if (command === "/cancel") {
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
    if (command.startsWith("/")) {
      refreshChrome(c.yellow(`Unknown command ${text.trim()} — try /help`));
      return true;
    }
    return false;
  }

  editor.onSubmit = (text) => {
    void (async () => {
      if (!text.trim() || stopped) return;
      editor.disableSubmit = true;
      try {
        if (await handleCommand(text)) return;
        helpVisible = false;
        refreshChrome(c.dim("Sending…"));
        let confirmation = null;
        if (!run) {
          const params = { cwd, prompt: text, backend: "pi" };
          for (const key of ["model", "effort"]) if (flags[key]) params[key] = flags[key];
          if (flags.direct || flags.managed) params.execution = flags.direct ? "direct" : "managed";
          const started = await callRpc(flags, "chat.create", params);
          run = started.run;
        } else {
          const reply = resolveReplyContent(text, run);
          const sent = await callRpc(flags, "chat.send", { runId: run.id, content: reply.content });
          run = sent.run ?? run;
          if (reply.label) confirmation = c.dim(`Answered: ${reply.label}`);
        }
        editor.addToHistory(text);
        renderedSignature = "";
        refreshTranscript();
        refreshChrome(confirmation);
      } catch (error) {
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
  activityText,
  chat,
  compactTokens,
  conversationMessages,
  resolveReplyContent,
  runStats,
};
