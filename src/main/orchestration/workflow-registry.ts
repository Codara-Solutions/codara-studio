// Saved workflows: `.js` files with a literal `meta` header from three
// sources. Built-in ones ship with the app, the user's live in Codara's own
// home, and a project's in `<repo>/.codara/workflows` (versioned with the
// repository). On a name clash project wins over user and user over
// built-in. Listing only parses `meta`, never runs a script, and an invalid
// file is listed with its error instead of disappearing.
//
// No Electron import: the directories are passed in.

import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { SavedWorkflow, SavedWorkflowSummary } from "@shared/workflow";

import { WorkflowSourceError, parseWorkflowSource } from "./workflow-meta";

export interface WorkflowRegistryDirs {
  builtinDir: string;
  userDir: string;
}

export type SavedWorkflowSource = SavedWorkflowSummary["source"];

const PRECEDENCE: Record<SavedWorkflowSource, number> = { project: 0, user: 1, builtin: 2 };
const MAX_FILES_PER_SOURCE = 200;
const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.js$/;

export function projectWorkflowsDir(cwd: string): string {
  return join(resolve(cwd), ".codara", "workflows");
}

async function readSource(dir: string, source: SavedWorkflowSource): Promise<SavedWorkflow[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: SavedWorkflow[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".js")).sort().slice(0, MAX_FILES_PER_SOURCE)) {
    const path = join(dir, name);
    const text = await fs.readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const fileName = basename(name, ".js");
    try {
      const { meta } = parseWorkflowSource(text);
      out.push({ id: `${source}:${meta.name}`, name: meta.name, source, path, meta, source_text: text });
    } catch (err) {
      out.push({
        id: `${source}:${fileName}`,
        name: fileName,
        source,
        path,
        error: err instanceof WorkflowSourceError || err instanceof Error ? err.message : String(err),
        source_text: text,
      });
    }
  }
  return out;
}

async function readAll(dirs: WorkflowRegistryDirs, cwd?: string): Promise<SavedWorkflow[]> {
  const [project, user, builtin] = await Promise.all([
    cwd ? readSource(projectWorkflowsDir(cwd), "project") : Promise.resolve([]),
    readSource(dirs.userDir, "user"),
    readSource(dirs.builtinDir, "builtin"),
  ]);
  const all = [...project, ...user, ...builtin];
  const winner = new Map<string, SavedWorkflow>();
  for (const entry of all) {
    const current = winner.get(entry.name);
    if (!current || PRECEDENCE[entry.source] < PRECEDENCE[current.source]) winner.set(entry.name, entry);
  }
  return all.map((entry) => (winner.get(entry.name) === entry ? entry : { ...entry, shadowed: true }));
}

export async function listSavedWorkflows(dirs: WorkflowRegistryDirs, cwd?: string): Promise<SavedWorkflowSummary[]> {
  return (await readAll(dirs, cwd)).map(({ source_text: _text, ...summary }) => summary);
}

/** By `name` (the winning source) or `source:name`. */
export async function getSavedWorkflow(
  dirs: WorkflowRegistryDirs,
  ref: string,
  cwd?: string,
): Promise<SavedWorkflow | null> {
  const all = await readAll(dirs, cwd);
  const wanted = ref.trim();
  const qualified = /^(builtin|user|project):(.+)$/.exec(wanted);
  if (qualified) return all.find((entry) => entry.source === qualified[1] && entry.name === qualified[2]) ?? null;
  return all.find((entry) => entry.name === wanted && !entry.shadowed) ?? null;
}

/** Workflows a script may run with workflow(name): every valid winner. */
export async function nestedWorkflowScripts(
  dirs: WorkflowRegistryDirs,
  cwd: string | undefined,
): Promise<Record<string, { name: string; body: string }>> {
  const out: Record<string, { name: string; body: string }> = {};
  for (const entry of await readAll(dirs, cwd)) {
    if (entry.shadowed || entry.error || !entry.meta) continue;
    try {
      out[entry.name] = { name: entry.name, body: parseWorkflowSource(entry.source_text).body };
    } catch {
      // Listed with its error; not runnable.
    }
  }
  return out;
}

export async function saveWorkflowFile(
  dirs: WorkflowRegistryDirs,
  input: { sourceText: string; scope: "user" | "project"; cwd?: string; overwrite?: boolean },
): Promise<SavedWorkflowSummary> {
  const { meta } = parseWorkflowSource(input.sourceText);
  const fileName = `${meta.name}.js`;
  if (!FILE_NAME_PATTERN.test(fileName)) throw new Error(`Invalid workflow name: ${meta.name}`);
  if (input.scope === "project" && !input.cwd) throw new Error("A project workflow needs a workspace folder.");
  const dir = input.scope === "project" ? projectWorkflowsDir(input.cwd!) : dirs.userDir;
  const path = join(dir, fileName);
  await fs.mkdir(dir, { recursive: true });
  if (!input.overwrite) {
    const exists = await fs.stat(path).then(() => true, () => false);
    if (exists) throw new Error(`A ${input.scope} workflow named ${meta.name} already exists.`);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, input.sourceText, "utf8");
  await fs.rename(tmp, path);
  return { id: `${input.scope}:${meta.name}`, name: meta.name, source: input.scope, path, meta };
}

export async function deleteWorkflowFile(
  dirs: WorkflowRegistryDirs,
  ref: string,
  cwd?: string,
): Promise<boolean> {
  const entry = await getSavedWorkflow(dirs, ref, cwd);
  if (!entry) return false;
  if (entry.source === "builtin") throw new Error("Built-in workflows cannot be deleted.");
  await fs.rm(entry.path, { force: true });
  return true;
}
