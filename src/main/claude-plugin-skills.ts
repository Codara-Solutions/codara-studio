// The skills that come with Claude Code plugins. Claude Code records each
// installed plugin in <claude dir>/plugins/installed_plugins.json and turns
// it on with `enabledPlugins` in the user, project and project-local
// settings.json (later files win). A plugin's skills are folders with a
// SKILL.md under its `skills/` folder, or under the paths its
// .claude-plugin/plugin.json declares. Claude Code installs, updates and
// removes them; Codara only reads, so these are listed as read-only.
//
// Choosing the applicable install is adapted from Orca's
// claude-plugin-skill-sources.ts (MIT, see THIRD_PARTY_NOTICES).

import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ClaudePluginSkill, ClaudePluginSkillList } from "@shared/skill-origins";
import { parseSkillFrontmatter } from "./skill-import";

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SKILL_DOC_BYTES = 64 * 1024;
const MAX_PLUGINS = 64;
const MAX_ROOTS_PER_PLUGIN = 16;
const MAX_SKILLS_PER_PLUGIN = 100;
const MAX_SKILLS = 500;

type InstallScope = ClaudePluginSkill["scope"];

interface PluginInstall {
  scope: InstallScope;
  installPath: string;
  projectPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}

export interface ClaudePluginMetadata {
  installedPlugins: string | null;
  // User, project and project-local settings.json, in that order.
  settings: Array<string | null>;
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function enabledPluginIds(settings: Array<string | null>): Map<string, boolean> {
  const enabled = new Map<string, boolean>();
  for (const text of settings) {
    const configured = parseObject(text)?.enabledPlugins;
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) continue;
    for (const [id, value] of Object.entries(configured)) {
      if (typeof value === "boolean") enabled.set(id, value);
    }
  }
  return enabled;
}

function parseInstall(value: unknown, fallbackScope: InstallScope | null): PluginInstall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scope = record.scope === "user" || record.scope === "project" || record.scope === "local"
    ? record.scope
    : fallbackScope;
  if (!scope || typeof record.installPath !== "string" || !isAbsolute(record.installPath)) return null;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  return {
    scope,
    installPath: record.installPath,
    ...(text("projectPath") ? { projectPath: text("projectPath") } : {}),
    ...(text("version") ? { version: text("version") } : {}),
    ...(text("installedAt") ? { installedAt: text("installedAt") } : {}),
    ...(text("lastUpdated") ? { lastUpdated: text("lastUpdated") } : {}),
  };
}

function appliesTo(install: PluginInstall, cwd: string | null): boolean {
  if (install.scope === "user") return true;
  if (!cwd || !install.projectPath || !isAbsolute(install.projectPath)) return false;
  const rel = relative(resolve(install.projectPath), resolve(cwd));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const SCOPE_RANK: Record<InstallScope, number> = { local: 2, project: 1, user: 0 };

function installTime(install: PluginInstall): number {
  const at = Date.parse(install.lastUpdated ?? install.installedAt ?? "");
  return Number.isFinite(at) ? at : 0;
}

/**
 * The plugin copies Claude Code loads in `cwd`: for each enabled plugin, its
 * most specific applicable install (local, then project, then user), the
 * newest when a scope holds several. Version 1 of the file kept one install
 * per plugin as an object; version 2 keeps a list.
 */
export function resolveEnabledPluginInstalls(
  metadata: ClaudePluginMetadata,
  cwd: string | null,
): Array<{ pluginId: string; install: PluginInstall }> {
  const plugins = parseObject(metadata.installedPlugins)?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  const enabled = enabledPluginIds(metadata.settings);
  const out: Array<{ pluginId: string; install: PluginInstall }> = [];
  for (const [pluginId, raw] of Object.entries(plugins)) {
    if (enabled.get(pluginId) !== true) continue;
    const installs = (Array.isArray(raw) ? raw.map((value) => parseInstall(value, null)) : [parseInstall(raw, "user")])
      .filter((install): install is PluginInstall => install !== null && appliesTo(install, cwd))
      .sort(
        (a, b) =>
          SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] ||
          (b.projectPath?.length ?? 0) - (a.projectPath?.length ?? 0) ||
          installTime(b) - installTime(a),
      );
    if (installs[0]) out.push({ pluginId, install: installs[0] });
    if (out.length >= MAX_PLUGINS) break;
  }
  return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

async function readSmall(path: string, limit: number): Promise<string | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > limit) return null;
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The plugin's skill folders: `skills/` and what its manifest declares, never outside the plugin. */
async function pluginSkillRoots(installPath: string): Promise<string[]> {
  const realInstall = await fs.realpath(installPath).catch(() => null);
  if (!realInstall) return [];
  const candidates = [join(installPath, "skills")];
  const manifest = parseObject(await readSmall(join(installPath, ".claude-plugin", "plugin.json"), MAX_MANIFEST_BYTES));
  const declared = manifest?.skills;
  for (const value of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
    if (typeof value !== "string" || !value.startsWith("./")) continue;
    const rel = value.slice(2).replace(/\\/g, "/");
    if (!rel || rel.split("/").includes("..")) continue;
    candidates.push(join(installPath, ...rel.split("/").filter(Boolean)));
  }
  const roots: string[] = [];
  for (const candidate of [...new Set(candidates)].slice(0, MAX_ROOTS_PER_PLUGIN)) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (real && inside(realInstall, real) && !roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** A root that is itself a skill, or the skill folders directly inside it. */
async function skillDirsIn(root: string): Promise<string[]> {
  const hasSkill = async (dir: string) => (await fs.lstat(join(dir, "SKILL.md")).catch(() => null))?.isFile() === true;
  if (await hasSkill(root)) return [root];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    if (await hasSkill(dir)) dirs.push(dir);
  }
  return dirs;
}

export async function listClaudePluginSkillsFrom(
  metadata: ClaudePluginMetadata,
  cwd: string | null,
): Promise<ClaudePluginSkillList> {
  const skills: ClaudePluginSkill[] = [];
  let truncated = false;
  for (const { pluginId, install } of resolveEnabledPluginInstalls(metadata, cwd)) {
    const at = pluginId.lastIndexOf("@");
    const plugin = (at > 0 ? pluginId.slice(0, at) : pluginId) || basename(install.installPath);
    const marketplace = at > 0 ? pluginId.slice(at + 1) : undefined;
    let count = 0;
    for (const root of await pluginSkillRoots(install.installPath)) {
      for (const dir of await skillDirsIn(root)) {
        if (count >= MAX_SKILLS_PER_PLUGIN || skills.length >= MAX_SKILLS) {
          truncated = true;
          break;
        }
        const frontmatter = parseSkillFrontmatter((await readSmall(join(dir, "SKILL.md"), MAX_SKILL_DOC_BYTES)) ?? "");
        skills.push({
          name: (frontmatter.name ?? basename(dir)).slice(0, 80),
          ...(frontmatter.description ? { description: frontmatter.description.slice(0, 400) } : {}),
          dir,
          pluginId,
          plugin,
          ...(marketplace ? { marketplace } : {}),
          ...(install.version ? { version: install.version } : {}),
          scope: install.scope,
        });
        count += 1;
      }
    }
  }
  return { skills, ...(truncated ? { truncated: true } : {}) };
}

/** Reads Claude Code's plugin records from `claudeDir` (CLAUDE_CONFIG_DIR or ~/.claude). */
export async function listClaudePluginSkills(input: { claudeDir: string; cwd?: string | null }): Promise<ClaudePluginSkillList> {
  const cwd = input.cwd?.trim() || null;
  const [installedPlugins, ...settings] = await Promise.all([
    readSmall(join(input.claudeDir, "plugins", "installed_plugins.json"), MAX_METADATA_BYTES),
    readSmall(join(input.claudeDir, "settings.json"), MAX_METADATA_BYTES),
    ...(cwd
      ? [
          readSmall(join(cwd, ".claude", "settings.json"), MAX_METADATA_BYTES),
          readSmall(join(cwd, ".claude", "settings.local.json"), MAX_METADATA_BYTES),
        ]
      : []),
  ]);
  return listClaudePluginSkillsFrom({ installedPlugins, settings }, cwd);
}
