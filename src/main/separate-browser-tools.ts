// Browser tools that start a Chrome of their own, with a separate profile and
// the "controlled by automated test software" bar, instead of the user's own
// Chrome reached through the Codara extension. While "Keep agents in your
// Chrome" is on, the Claude Code and Codex sessions Codara starts get them
// turned off on their command line (agent-launch-integration.ts):
//
// - a Claude Code plugin through `enabledPlugins: { id: false }` in Codara's
//   `--settings` file, which outranks the user's own settings, so its MCP
//   server never starts;
// - a plain Claude Code MCP server through `deniedMcpServers` in that same
//   file, which also keeps the server from starting;
// - a Codex MCP server through `-c mcp_servers.<name>={command=...,
//   enabled=false}`. The inline table merges into the user's entry, and when
//   the entry is gone by the time Codex starts it still forms a valid,
//   disabled server: a bare `enabled=false` for a missing name stops Codex.
//
// The user's configs are only read. A session started outside Codara keeps
// every tool. Tools that drive the user's running Chrome (the browser-use
// plugin, a chrome-devtools-mcp told to attach) are left alone.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { SeparateBrowserTool } from "../shared/chrome-link";
import { parseTomlText } from "./mcp-toml";

export type { SeparateBrowserTool } from "../shared/chrome-link";
export type SeparateBrowserLauncher = SeparateBrowserTool["launcher"];

/** Plugins whose only job is a browser of their own: off even before they are installed. */
export const SEPARATE_BROWSER_PLUGINS: Readonly<Record<string, SeparateBrowserLauncher>> = {
  "chrome-devtools-mcp@claude-plugins-official": "chrome-devtools-mcp",
  "playwright@claude-plugins-official": "playwright",
};

const PLUGIN_NAMES: Readonly<Record<string, SeparateBrowserLauncher>> = {
  "chrome-devtools-mcp": "chrome-devtools-mcp",
  playwright: "playwright",
  puppeteer: "puppeteer",
};

// Flags that point these servers at a browser that is already running
// (chrome-devtools-mcp --browserUrl / --wsEndpoint / --autoConnect,
// @playwright/mcp --cdp-endpoint / --extension): no new window.
const ATTACH_FLAG = /^--(browser-?url|ws-?endpoint|auto-?connect|cdp-?endpoint|extension)(=|$)/i;

// A Codex `-c` key segment cannot be quoted, so only these names can be
// addressed.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Which browser launcher a server's command line runs, matched on the
 * command and its arguments (a package spec, a bin name or a path), or null.
 * A command run through a shell (`zsh -lc "npx chrome-devtools-mcp"`) counts.
 */
export function separateBrowserLauncher(command: unknown, args: unknown): SeparateBrowserLauncher | null {
  const words = [command, ...(Array.isArray(args) ? args : [])].filter(
    (word): word is string => typeof word === "string" && word.length > 0,
  );
  if (words.some((word) => word.split(/\s+/).some((part) => ATTACH_FLAG.test(part.replace(/^["']/, ""))))) {
    return null;
  }
  for (const raw of words) {
    const word = raw.toLowerCase().replace(/\\/g, "/");
    if (word.includes("chrome-devtools-mcp")) return "chrome-devtools-mcp";
    if (word.includes("@playwright/mcp") || /playwright[-_]?mcp|mcp[-_]server[-_]playwright/.test(word)) return "playwright";
    if (word.includes("puppeteer") && /mcp|server-puppeteer/.test(word)) return "puppeteer";
  }
  return null;
}

export interface SeparateBrowserToolSources {
  /** Claude Code config folders: settings.json and plugins/installed_plugins.json. */
  claudeConfigDirs: readonly string[];
  /** Claude Code's .claude.json files (user and per-project servers). */
  claudeUserConfigFiles: readonly string[];
  /** Codex config.toml files. */
  codexConfigFiles: readonly string[];
  /** Workspace folders: their .mcp.json, .claude/settings*.json and .codex/config.toml. */
  workspaceDirs?: readonly string[];
}

export interface DetectedSeparateBrowserTool extends SeparateBrowserTool {
  /** Codex servers: the command, so the disabling override stays a valid server. */
  command?: string;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function readJson(path: string): Json | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function readToml(path: string): Json | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseTomlText(text);
  return parsed.ok ? parsed.value : null;
}

/** The plugin ids a settings file turns on. */
function enabledPluginIds(settings: Json | null): string[] {
  const enabled = settings?.enabledPlugins;
  if (Array.isArray(enabled)) return enabled.filter((id): id is string => typeof id === "string");
  const record = asRecord(enabled);
  return record ? Object.keys(record).filter((id) => record[id] === true) : [];
}

function installPaths(configDirs: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const dir of configDirs) {
    const plugins = asRecord(readJson(join(dir, "plugins", "installed_plugins.json"))?.plugins);
    for (const [id, installs] of Object.entries(plugins ?? {})) {
      for (const install of Array.isArray(installs) ? installs : []) {
        const path = asRecord(install)?.installPath;
        if (typeof path === "string" && path) out.set(id, [...(out.get(id) ?? []), path]);
      }
    }
  }
  return out;
}

/** The server definitions a plugin ships: its .mcp.json and the mcpServers of its manifest. */
function pluginServers(installPath: string): Json[] {
  const servers: Json[] = [];
  const addMap = (value: unknown) => {
    const record = asRecord(value);
    if (!record) return;
    const map = asRecord(record.mcpServers) ?? record;
    for (const server of Object.values(map)) {
      const entry = asRecord(server);
      if (entry) servers.push(entry);
    }
  };
  addMap(readJson(join(installPath, ".mcp.json")));
  const declared = readJson(join(installPath, ".claude-plugin", "plugin.json"))?.mcpServers;
  for (const item of Array.isArray(declared) ? declared : [declared]) {
    if (typeof item === "string") addMap(readJson(isAbsolute(item) ? item : resolve(installPath, item)));
    else addMap(asRecord(item) ? { mcpServers: item } : null);
  }
  return servers;
}

function launcherOf(server: Json): SeparateBrowserLauncher | null {
  return typeof server.command === "string" ? separateBrowserLauncher(server.command, server.args) : null;
}

/** What in the user's own configs opens a separate Chrome. Read only; never throws. */
export function detectSeparateBrowserTools(sources: SeparateBrowserToolSources): DetectedSeparateBrowserTool[] {
  const found = new Map<string, DetectedSeparateBrowserTool>();
  const add = (tool: DetectedSeparateBrowserTool) => {
    const key = `${tool.kind}:${tool.name.toLowerCase()}`;
    if (!found.has(key)) found.set(key, tool);
  };
  const workspaces = sources.workspaceDirs ?? [];

  const installs = installPaths(sources.claudeConfigDirs);
  const settingsFiles = [
    ...sources.claudeConfigDirs.map((dir) => join(dir, "settings.json")),
    ...workspaces.flatMap((dir) => [join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json")]),
  ];
  for (const file of settingsFiles) {
    for (const id of enabledPluginIds(readJson(file))) {
      let launcher: SeparateBrowserLauncher | null =
        SEPARATE_BROWSER_PLUGINS[id] ?? PLUGIN_NAMES[id.split("@")[0].toLowerCase()] ?? null;
      for (const path of launcher ? [] : installs.get(id) ?? []) {
        launcher = pluginServers(path).map(launcherOf).find(Boolean) ?? null;
        if (launcher) break;
      }
      if (launcher) add({ kind: "claude-plugin", name: id, launcher, source: file });
    }
  }

  const claudeServers = (map: unknown, source: string) => {
    for (const [name, value] of Object.entries(asRecord(map) ?? {})) {
      const server = asRecord(value);
      const launcher = server && name.trim() ? launcherOf(server) : null;
      if (launcher) add({ kind: "claude-mcp", name: name.trim(), launcher, source });
    }
  };
  for (const file of sources.claudeUserConfigFiles) {
    const config = readJson(file);
    if (!config) continue;
    claudeServers(config.mcpServers, file);
    for (const project of Object.values(asRecord(config.projects) ?? {})) {
      claudeServers(asRecord(project)?.mcpServers, file);
    }
  }
  for (const dir of workspaces) {
    const file = join(dir, ".mcp.json");
    claudeServers(readJson(file)?.mcpServers, file);
  }

  const codexFiles = [...sources.codexConfigFiles, ...workspaces.map((dir) => join(dir, ".codex", "config.toml"))];
  for (const file of codexFiles) {
    for (const [name, value] of Object.entries(asRecord(readToml(file)?.mcp_servers) ?? {})) {
      const server = asRecord(value);
      if (!server || server.enabled === false || !BARE_KEY.test(name)) continue;
      const launcher = launcherOf(server);
      if (launcher) add({ kind: "codex-mcp", name, launcher, source: file, command: server.command as string });
    }
  }

  const order = { "claude-plugin": 0, "claude-mcp": 1, "codex-mcp": 2 } as const;
  return [...found.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** What every session Codara starts gets while the switch is on. */
export interface SeparateBrowserToolsGuard {
  tools: DetectedSeparateBrowserTool[];
  /** Merged into the `--settings` file of each Claude Code session. */
  claudeSettings: {
    enabledPlugins: Record<string, false>;
    deniedMcpServers?: Array<{ serverName: string }>;
  };
  /** Codex servers to start disabled, rendered as `-c` values at launch. */
  codexServers: Array<{ name: string; command: string }>;
}

export function separateBrowserToolsGuard(tools: readonly DetectedSeparateBrowserTool[]): SeparateBrowserToolsGuard {
  const plugins = new Set(Object.keys(SEPARATE_BROWSER_PLUGINS));
  for (const tool of tools) if (tool.kind === "claude-plugin") plugins.add(tool.name);
  const denied = [...new Set(tools.filter((tool) => tool.kind === "claude-mcp").map((tool) => tool.name))].sort();
  return {
    tools: [...tools],
    claudeSettings: {
      enabledPlugins: Object.fromEntries([...plugins].sort().map((id) => [id, false])) as Record<string, false>,
      ...(denied.length > 0 ? { deniedMcpServers: denied.map((serverName) => ({ serverName })) } : {}),
    },
    codexServers: tools
      .filter((tool) => tool.kind === "codex-mcp" && tool.command)
      .map((tool) => ({ name: tool.name, command: tool.command! })),
  };
}
