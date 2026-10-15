import type { ClaudePluginSkill, SkillOrigin, SkillOriginStatus } from "@shared/skill-origins";
import { groupItems, type NameGroup } from "./model";

// Pure helpers behind the skill origin line, the update actions and the
// plugin skill list. Nothing here touches the DOM or IPC.

export type GroupOriginState = "update-available" | "error" | "current" | "unchecked";

// The main process keys records by the folder it wrote; the inventory names
// the same folder. Separators and a trailing slash are the only differences
// seen in practice, case on macOS and Windows the other.
export function skillDirKey(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function indexOrigins(statuses: readonly SkillOriginStatus[]): Map<string, SkillOriginStatus> {
  const index = new Map<string, SkillOriginStatus>();
  for (const status of statuses) {
    const key = skillDirKey(status.skillDir);
    index.set(key, status);
    const folded = key.toLowerCase();
    if (!index.has(folded)) index.set(folded, status);
  }
  return index;
}

export function originsForGroup(group: NameGroup, index: ReadonlyMap<string, SkillOriginStatus>): SkillOriginStatus[] {
  const found: SkillOriginStatus[] = [];
  for (const item of groupItems(group)) {
    if (!item.skillDir) continue;
    const key = skillDirKey(item.skillDir);
    const status = index.get(key) ?? index.get(key.toLowerCase());
    if (status && !found.includes(status)) found.push(status);
  }
  return found;
}

export function groupOriginState(statuses: readonly SkillOriginStatus[]): GroupOriginState {
  const git = statuses.filter((status) => status.origin.kind === "git");
  if (git.some((status) => status.state === "update-available")) return "update-available";
  if (git.some((status) => status.state === "error")) return "error";
  if (git.length > 0 && git.every((status) => status.state === "current")) return "current";
  return "unchecked";
}

export function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 7) : "";
}

/** github.com/owner/repo from https://github.com/owner/repo(.git). */
export function repoLabel(url: string | undefined): string {
  if (!url) return "a git repository";
  return url.replace(/^https:\/\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

// Home-relative, as McpSection's shortPath shows paths.
function homeRelative(path: string): string {
  return path.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, "~");
}

/** The one line a row shows about where the skill came from, and its tooltip. */
export function describeOrigin(origin: SkillOrigin): { text: string; title: string } {
  const installed = formatDate(origin.installedAt);
  const updated = origin.updatedAt ? formatDate(origin.updatedAt) : "";
  if (origin.kind === "git") {
    const repo = repoLabel(origin.url);
    const ref = origin.ref ?? origin.branch ?? "";
    const parts = [
      `From ${repo}`,
      ...(origin.subpath ? [origin.subpath] : []),
      [ref, shortCommit(origin.commit)].filter(Boolean).join(" at "),
    ].filter(Boolean);
    const title = [
      `Repository: ${origin.url ?? "unknown"}`,
      `Branch or tag: ${origin.ref ?? (origin.branch ? `${origin.branch} (default branch)` : "default branch")}`,
      ...(origin.subpath ? [`Folder: ${origin.subpath}`] : []),
      ...(origin.commit ? [`Commit: ${origin.commit}`] : []),
      ...(installed ? [`Installed ${installed}`] : []),
      ...(updated ? [`Updated ${updated}`] : []),
    ].join("\n");
    return { text: parts.join(" · "), title };
  }
  const where = origin.sourcePath ? homeRelative(origin.sourcePath) : "";
  const noun = origin.kind === "zip" ? "zip file" : "folder";
  return {
    text: where ? `Imported from the ${noun} ${where}` : `Imported from a ${noun}`,
    title: [
      ...(origin.sourcePath ? [origin.sourcePath] : []),
      ...(installed ? [`Imported ${installed}`] : []),
      "Codara only checks skills imported from git for updates.",
    ].join("\n"),
  };
}

function formatDate(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The most recent check across the records, for the Check button's tooltip. */
export function lastCheckedAt(statuses: readonly SkillOriginStatus[]): string | null {
  let latest: string | null = null;
  for (const status of statuses) {
    if (status.checkedAt && (!latest || Date.parse(status.checkedAt) > Date.parse(latest))) latest = status.checkedAt;
  }
  return latest;
}

/** One line for the footer after a check the user asked for. */
export function checkSummary(statuses: readonly SkillOriginStatus[]): { ok: boolean; text: string } {
  const git = statuses.filter((status) => status.origin.kind === "git");
  const behind = git.filter((status) => status.state === "update-available").length;
  const failed = git.filter((status) => status.state === "error").length;
  if (git.length === 0) return { ok: true, text: "No skill here was installed from git, so there is nothing to check." };
  const parts = [
    behind > 0
      ? `${behind} ${behind === 1 ? "skill has" : "skills have"} an update.`
      : failed === 0
        ? "Every skill installed from git is up to date."
        : "",
    failed > 0 ? `Could not check ${failed} ${failed === 1 ? "skill" : "skills"}; its row says why.` : "",
  ].filter(Boolean);
  return { ok: failed === 0, text: parts.join(" ") };
}

export function filterPluginSkills(skills: readonly ClaudePluginSkill[], search: string): ClaudePluginSkill[] {
  const query = search.trim().toLowerCase();
  if (!query) return [...skills];
  return skills.filter((skill) =>
    [skill.name, skill.description ?? "", skill.plugin, skill.marketplace ?? "", skill.dir].join(" ").toLowerCase().includes(query),
  );
}

export function pluginScopeLabel(scope: ClaudePluginSkill["scope"]): string {
  if (scope === "local") return "this workspace, private";
  return scope === "project" ? "this workspace" : "every workspace";
}
