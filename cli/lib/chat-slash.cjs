"use strict";

// Pure slash-command registry for the full-screen chat. The TUI owns command
// effects; this module owns names, help, parsing, and autocomplete so the menu
// cannot drift away from what Enter actually runs.

const EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MODES = Object.freeze(["auto", "direct", "managed"]);
const FALLBACK_MODELS = Object.freeze([
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-fable-5", label: "Claude Fable 5", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-5", label: "Claude Opus 5", thinkingLevels: EFFORTS },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
]);

const COMMAND_META = Object.freeze([
  { name: "help", description: "Show every command", aliases: ["?"] },
  { name: "new", description: "Start a fresh task" },
  { name: "resume", description: "Open an earlier Cora run", argumentHint: "<run>" },
  { name: "copy-id", description: "Copy this chat's run id", aliases: ["id", "copyid"] },
  { name: "model", description: "Choose model and optional effort", argumentHint: "<model> [effort]", aliases: ["m"] },
  { name: "effort", description: "Set reasoning effort", argumentHint: "<level>", aliases: ["e"] },
  { name: "profile", description: "Choose Cora identity for new tasks", argumentHint: "<profile>", aliases: ["p"] },
  { name: "mode", description: "Choose auto, direct, or managed", argumentHint: "<mode>" },
  { name: "status", description: "Show this chat's configuration" },
  { name: "context", description: "Show context-window usage", aliases: ["usage"] },
  { name: "compact", description: "Summarize history into a fresh context" },
  { name: "agents", description: "Show this run's subagents" },
  { name: "board", description: "Show the current plan and steps" },
  { name: "runs", description: "List recent Cora runs", aliases: ["history", "sessions"] },
  { name: "cwd", description: "Show the active workspace" },
  { name: "rename", description: "Rename the current chat", argumentHint: "<title>" },
  { name: "clear", description: "Clear visible transcript" },
  { name: "cancel", description: "Cancel the current run" },
  { name: "quit", description: "Leave Cora; work continues", aliases: ["exit"] },
]);

const ALIASES = new Map(
  COMMAND_META.flatMap((command) =>
    (command.aliases ?? []).map((alias) => [alias, command.name]),
  ),
);

function parseSlashCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) return null;
  const rawName = match[1].toLowerCase();
  return {
    name: ALIASES.get(rawName) ?? rawName,
    rawName,
    args: (match[2] ?? "").trim(),
  };
}

function completion(value, label = value, description) {
  return { value, label, ...(description ? { description } : {}) };
}

function effortItems(prefix = "") {
  const query = prefix.trim().toLowerCase();
  return EFFORTS.filter((effort) => effort.includes(query)).map((effort) => completion(effort));
}

function modelItems(models, prefix) {
  const normalized = Array.isArray(models) && models.length ? models : FALLBACK_MODELS;
  const exact = normalized.find(
    (model) =>
      prefix.length > model.id.length &&
      prefix.slice(0, model.id.length).toLowerCase() === model.id.toLowerCase() &&
      /^\s/u.test(prefix.slice(model.id.length)),
  );
  if (exact) {
    const effortPrefix = prefix.slice(exact.id.length).trim();
    const levels = exact.thinkingLevels?.length ? exact.thinkingLevels : EFFORTS;
    return levels
      .filter((effort) => effort.toLowerCase().includes(effortPrefix.toLowerCase()))
      .map((effort) => completion(`${exact.id} ${effort}`, effort, exact.label));
  }
  const query = prefix.trim().toLowerCase();
  return normalized
    .filter(
      (model) =>
        model.id.toLowerCase().includes(query) || String(model.label ?? "").toLowerCase().includes(query),
    )
    .map((model) =>
      completion(
        `${model.id}${model.thinkingLevels?.length ? " " : ""}`,
        model.label || model.id,
        model.id,
      ),
    );
}

/** Build Pi-compatible command rows, including lazy argument completion. */
function createSlashCommands({ listModels, listProfiles, listRuns } = {}) {
  return COMMAND_META.map((meta) => {
    let getArgumentCompletions;
    if (meta.name === "model") {
      getArgumentCompletions = async (prefix) => modelItems(await listModels?.(), prefix);
    } else if (meta.name === "effort") {
      getArgumentCompletions = effortItems;
    } else if (meta.name === "mode") {
      getArgumentCompletions = (prefix) =>
        MODES.filter((mode) => mode.includes(prefix.trim().toLowerCase())).map((mode) => completion(mode));
    } else if (meta.name === "profile") {
      getArgumentCompletions = async (prefix) => {
        const query = prefix.trim().toLowerCase();
        return (await listProfiles?.() ?? [])
          .filter((profile) => profile.id.includes(query) || profile.name.toLowerCase().includes(query))
          .map((profile) => completion(profile.id, profile.name, profile.isDefault ? "current" : profile.description));
      };
    } else if (meta.name === "resume") {
      getArgumentCompletions = async (prefix) => {
        const query = prefix.trim().toLowerCase();
        return (await listRuns?.() ?? [])
          .filter((run) => run.id.toLowerCase().includes(query) || String(run.title ?? "").toLowerCase().includes(query))
          .slice(0, 12)
          .map((run) => completion(run.id, run.title || run.id, `${run.status} · ${run.id.slice(0, 12)}`));
      };
    }
    return {
      name: meta.name,
      description: meta.description,
      ...(meta.argumentHint ? { argumentHint: meta.argumentHint } : {}),
      ...(getArgumentCompletions ? { getArgumentCompletions } : {}),
    };
  });
}

function commandHelp() {
  return COMMAND_META.map((command) => ({
    command: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    description: command.description,
  }));
}

module.exports = {
  COMMAND_META,
  EFFORTS,
  FALLBACK_MODELS,
  MODES,
  commandHelp,
  createSlashCommands,
  modelItems,
  parseSlashCommand,
};
