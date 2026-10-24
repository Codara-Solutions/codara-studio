// Skills the user adds in the Capability Center: written there, or imported
// from a folder, a zip archive or a git repository. Everything lands in
// Codara's own skill folder (codaraSkillsDir in agent-sync.ts), which Cora and
// her workers load per launch; no CLI's skill folder is ever written. Where an
// import came from is recorded beside it (skill-origin-store.ts), so a skill
// from git can be checked and updated later (skill-updates.ts).
//
// Imported content is untrusted. An archive entry or a repository file may
// try to escape the destination (`../`, an absolute path, a symlink), so
// every path is checked before it is written, symlinks are never followed or
// recreated, and the copy is bounded in files and bytes.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { AgentSkillCreateInput, AgentSkillImportSource, AgentSkillWriteResult } from "@shared/types";
import type { SkillOrigin } from "@shared/skill-origins";
import { gitChildEnv } from "./git-env";
import { forgetSkillOrigin, recordSkillOrigin } from "./skill-origin-store";

// The Agent Skills naming rule, which Pi enforces when it loads a skill.
export const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_DEPTH = 12;
const SKILL_SEARCH_DEPTH = 4;
const MAX_CANDIDATES = 50;
const GIT_TIMEOUT_MS = 90_000;
const SKIPPED_NAMES = new Set([".git", "node_modules", "__MACOSX", ".DS_Store"]);

/** Runs git and resolves to its stdout; a fake may resolve to nothing. */
export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<string | void>;

export interface SkillImportOptions {
  skillsDir: string;
  /** Replaces the real git, for tests. */
  runGit?: GitRunner;
  /** Where clones and extracted archives are staged; defaults to the OS temp dir. */
  stagingDir?: string;
  /** Codara's record of where skills came from; nothing is recorded without it. */
  originsDir?: string;
}

class SkillImportError extends Error {
  constructor(
    message: string,
    readonly candidates?: string[],
  ) {
    super(message);
  }
}

function failure(err: unknown): AgentSkillWriteResult {
  if (err instanceof SkillImportError) {
    return { ok: false, error: err.message, ...(err.candidates ? { candidates: err.candidates } : {}) };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function validateSkillName(name: string): string | null {
  if (!name) return "Name is required.";
  if (!SKILL_NAME_PATTERN.test(name)) {
    return "Name may use lowercase letters, digits and hyphens (up to 64), and must start and end with a letter or digit.";
  }
  return null;
}

/** A folder or repository name turned into a valid skill name, or null. */
export function skillNameFrom(raw: string): string | null {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return SKILL_NAME_PATTERN.test(name) ? name : null;
}

function yamlString(value: string): string {
  // JSON's double-quoted string is valid YAML and escapes everything that
  // could end the scalar early.
  return JSON.stringify(value);
}

export function renderSkillDocument(input: AgentSkillCreateInput): string {
  const description = input.description.replace(/\s+/g, " ").trim();
  const body = input.instructions.replace(/\r\n/g, "\n").trimEnd();
  return `---\nname: ${input.name}\ndescription: ${yamlString(description)}\n---\n\n${body}\n`;
}

export async function createCodaraSkill(
  input: AgentSkillCreateInput,
  options: { skillsDir: string; originsDir?: string },
): Promise<AgentSkillWriteResult> {
  const name = (input.name ?? "").trim();
  const problem = validateSkillName(name);
  if (problem) return { ok: false, error: problem };
  const description = (input.description ?? "").replace(/\s+/g, " ").trim();
  if (!description) return { ok: false, error: "A description is required: it is how Cora decides when to load the skill." };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.` };
  }
  const instructions = input.instructions ?? "";
  if (!instructions.trim()) return { ok: false, error: "Write the instructions the agent should follow." };
  if (Buffer.byteLength(instructions, "utf8") > MAX_INSTRUCTIONS_BYTES) {
    return { ok: false, error: "The instructions are too long. Move reference material into separate files." };
  }
  const dest = join(options.skillsDir, name);
  try {
    await fs.mkdir(options.skillsDir, { recursive: true, mode: 0o700 });
    // mkdir without recursive fails on an existing folder, which is the
    // collision check without a race between test and create.
    await fs.mkdir(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, error: `A skill named ${name} is already in Codara.` };
    }
    return failure(err);
  }
  try {
    await fs.writeFile(join(dest, "SKILL.md"), renderSkillDocument({ name, description, instructions }), { flag: "wx" });
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    return failure(err);
  }
  // A skill written here has no source to update from, whatever a record
  // left by an earlier skill of the same name says.
  if (options.originsDir) await forgetSkillOrigin(options.originsDir, dest).catch(() => undefined);
  return { ok: true, name, path: dest };
}

// ── Import ───────────────────────────────────────────────────────────────────

export async function importCodaraSkill(
  source: AgentSkillImportSource,
  options: SkillImportOptions,
): Promise<AgentSkillWriteResult> {
  const staging = join(options.stagingDir ?? tmpdir(), `codara-skill-import-${randomUUID()}`);
  try {
    let root: string;
    // What to call a skill whose SKILL.md sits at the top of the source and
    // names no valid skill: the folder, archive or repository name.
    let rootName: string;
    let origin: (skillDir: string) => Promise<SkillOrigin>;
    const installedAt = new Date().toISOString();
    if (source.kind === "folder") {
      root = await requireDirectory(source.path, "folder");
      rootName = basename(root);
      origin = async (skillDir) => ({ kind: "folder", sourcePath: skillDir, installedAt });
    } else if (source.kind === "zip") {
      const archive = await requireFile(source.path);
      await fs.mkdir(staging, { recursive: true, mode: 0o700 });
      await extractZipSafely(await fs.readFile(archive), staging);
      root = staging;
      rootName = basename(archive).replace(/\.zip$/i, "");
      origin = async () => ({ kind: "zip", sourcePath: archive, installedAt });
    } else {
      const parsed = parseGitSkillUrl(source.url);
      if ("error" in parsed) throw new SkillImportError(parsed.error);
      await fs.mkdir(staging, { recursive: true, mode: 0o700 });
      const clone = join(staging, "repo");
      const run = options.runGit ?? runGit;
      await cloneRepository(parsed, clone, run);
      root = parsed.subdir ? await confinedDir(clone, join(clone, ...parsed.subdir.split("/"))) : clone;
      rootName = (parsed.subdir ?? parsed.cloneUrl).split("/").pop()!.replace(/\.git$/i, "");
      origin = async (skillDir) => ({
        kind: "git",
        url: parsed.cloneUrl,
        ...(parsed.ref ? { ref: parsed.ref } : {}),
        ...(await describeClone(clone, skillDir, run, parsed.ref === undefined)),
        installedAt,
      });
    }
    const skillDir = await chooseSkillDir(root, source.subdir);
    const result = await installSkillFolder(skillDir, options.skillsDir, resolve(skillDir) === resolve(root) ? rootName : basename(skillDir));
    if (result.ok && result.path && result.name && options.originsDir) {
      // The skill is in place either way; a record that cannot be written
      // only means Codara cannot offer updates for it.
      await recordSkillOrigin(options.originsDir, { skillDir: result.path, name: result.name, origin: await origin(skillDir) }).catch(
        () => undefined,
      );
    }
    return result;
  } catch (err) {
    return failure(err);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function firstLine(output: string | void): string {
  return typeof output === "string" ? output.trim().split(/\r?\n/)[0]?.trim() ?? "" : "";
}

/** The skill's folder inside a clone, as git names it ("" for the root). */
export async function repoSubpath(clone: string, skillDir: string): Promise<string | null> {
  const [realClone, realSkill] = await Promise.all([fs.realpath(clone), fs.realpath(skillDir)]);
  if (!insideRoot(realClone, realSkill)) return null;
  return relative(realClone, realSkill).split(sep).join("/");
}

/**
 * The commit a clone holds, the skill folder's path and git tree in it, and
 * the default branch a clone without --branch landed on. Each part is left
 * out when git cannot say: the skill is installed either way.
 */
export async function describeClone(
  clone: string,
  skillDir: string,
  run: GitRunner,
  wantBranch: boolean,
): Promise<Pick<SkillOrigin, "commit" | "subpath" | "tree" | "branch">> {
  const out: Pick<SkillOrigin, "commit" | "subpath" | "tree" | "branch"> = {};
  const subpath = await repoSubpath(clone, skillDir).catch(() => null);
  if (subpath !== null) out.subpath = subpath;
  const git = (args: string[]) =>
    run(["-C", clone, ...args], { cwd: clone, timeoutMs: 15_000 }).then(firstLine, () => "");
  const commit = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (OBJECT_ID.test(commit)) out.commit = commit;
  if (subpath !== null) {
    const tree = await git(["rev-parse", "--verify", subpath ? `HEAD:${subpath}` : "HEAD^{tree}"]);
    if (OBJECT_ID.test(tree)) out.tree = tree;
  }
  if (wantBranch) {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && branch !== "HEAD" && REF_PATTERN.test(branch)) out.branch = branch;
  }
  return out;
}

async function requireDirectory(path: string, noun: string): Promise<string> {
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path.trim())) {
    throw new SkillImportError(`Choose a ${noun} by its full path.`);
  }
  const resolved = resolve(path.trim());
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new SkillImportError(`${resolved} is not a folder.`);
  return resolved;
}

async function requireFile(path: string): Promise<string> {
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path.trim())) {
    throw new SkillImportError("Choose the zip file by its full path.");
  }
  const resolved = resolve(path.trim());
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new SkillImportError(`${resolved} is not a file.`);
  if (stat.size > MAX_ARCHIVE_BYTES) throw new SkillImportError("The archive is larger than 50 MB.");
  return resolved;
}

/** A relative path inside an import source, refused when it could leave it. */
export function safeRelativePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

export function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// The lexical check above cannot see a symlinked folder on the way to `dir`,
// which would point the copy at any folder on the machine.
export async function confinedDir(root: string, dir: string): Promise<string> {
  const [realRoot, realDir] = await Promise.all([fs.realpath(root), fs.realpath(dir).catch(() => null)]);
  if (realDir === null) return dir;
  if (!insideRoot(realRoot, realDir)) throw new SkillImportError("That folder is outside the import source.");
  return realDir;
}

async function chooseSkillDir(root: string, subdir: string | undefined): Promise<string> {
  if (subdir !== undefined && subdir !== "") {
    const rel = safeRelativePath(subdir);
    if (!rel) throw new SkillImportError("That folder is outside the import source.");
    const lexical = join(root, ...rel.split("/"));
    if (!insideRoot(root, lexical)) throw new SkillImportError("That folder is outside the import source.");
    const dir = await confinedDir(root, lexical);
    if (!(await hasSkillFile(dir))) throw new SkillImportError(`${rel} has no SKILL.md.`);
    return dir;
  }
  if (await hasSkillFile(root)) return root;
  const found: string[] = [];
  await collectSkillDirs(root, root, 0, found);
  if (found.length === 0) {
    throw new SkillImportError("No SKILL.md was found. A skill is a folder with a SKILL.md file in it.");
  }
  if (found.length === 1) return join(root, ...found[0].split("/"));
  throw new SkillImportError(
    `This source holds ${found.length >= MAX_CANDIDATES ? `${MAX_CANDIDATES} or more` : found.length} skills. Pick the one to import.`,
    found.slice(0, MAX_CANDIDATES),
  );
}

export async function hasSkillFile(dir: string): Promise<boolean> {
  const stat = await fs.lstat(join(dir, "SKILL.md")).catch(() => null);
  return Boolean(stat?.isFile());
}

async function collectSkillDirs(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  if (depth >= SKILL_SEARCH_DEPTH || out.length >= MAX_CANDIDATES) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SKIPPED_NAMES.has(entry.name)) continue;
    const child = join(dir, entry.name);
    if (await hasSkillFile(child)) {
      out.push(relative(root, child).split(sep).join("/"));
      if (out.length >= MAX_CANDIDATES) return;
      continue;
    }
    await collectSkillDirs(root, child, depth + 1, out);
  }
}

/** name and description from a SKILL.md's frontmatter. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(name|description)\s*:\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    let value = field[2].trim();
    if (["|", ">", "|-", ">-", ""].includes(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      value = block.join(" ");
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    value = value.replace(/\s+/g, " ").trim();
    if (value) out[field[1] as "name" | "description"] = value;
  }
  return out;
}

/** The SKILL.md with every frontmatter `name:` replaced by one `name: <name>`. */
export function withSkillName(document: string, name: string): string {
  const match = /^(﻿?---(\r?\n))([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/.exec(document);
  if (!match) return `---\nname: ${name}\n---\n\n${document}`;
  const eol = match[2];
  const lines = match[3].split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^name\s*:/.test(lines[index])) {
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) index += 1;
      continue;
    }
    kept.push(lines[index]);
  }
  return `${match[1]}name: ${name}${kept.length > 0 ? eol + kept.join(eol) : ""}${match[4]}${document.slice(match[0].length)}`;
}

async function installSkillFolder(
  skillDir: string,
  skillsDir: string,
  folderName: string,
): Promise<AgentSkillWriteResult> {
  const document = await fs.readFile(join(skillDir, "SKILL.md"), "utf8");
  const frontmatter = parseSkillFrontmatter(document);
  if (!frontmatter.description) {
    throw new SkillImportError("SKILL.md has no description in its frontmatter, so Cora would never know when to load it.");
  }
  const name = skillNameFrom(frontmatter.name ?? "") ?? skillNameFrom(folderName);
  if (!name) throw new SkillImportError("Could not derive a skill name. Give the skill a name in its SKILL.md frontmatter.");
  if (insideRoot(skillsDir, skillDir)) throw new SkillImportError(`${name} is already in Codara's skill folder.`);
  await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });
  const dest = join(skillsDir, name);
  try {
    await fs.mkdir(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SkillImportError(`A skill named ${name} is already in Codara. Remove it first to import this one.`);
    }
    throw err;
  }
  try {
    await copyTreeSafely(skillDir, dest, { files: 0, bytes: 0 }, 0);
    // Pi and the Capability Center key a skill by its frontmatter name, not
    // its folder, so the installed copy carries the validated name: a raw
    // name would reach Cora's prompt and dodge the collision check above.
    if (frontmatter.name !== name) {
      await fs.writeFile(join(dest, "SKILL.md"), withSkillName(document, name));
    }
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { ok: true, name, path: dest };
}

// Regular files and folders only. A symlink is skipped rather than copied:
// recreated, it could point the installed skill at any file on the machine.
export async function copyTreeSafely(
  source: string,
  dest: string,
  budget: { files: number; bytes: number },
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) throw new SkillImportError("The skill's folders nest too deeply.");
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    if (!insideRoot(dest, to)) throw new SkillImportError(`Refused ${entry.name}: it would land outside the skill folder.`);
    if (entry.isDirectory()) {
      await fs.mkdir(to);
      await copyTreeSafely(from, to, budget, depth + 1);
    } else if (entry.isFile()) {
      const stat = await fs.stat(from);
      budget.files += 1;
      budget.bytes += stat.size;
      if (budget.files > MAX_FILES) throw new SkillImportError(`The skill has more than ${MAX_FILES} files.`);
      if (budget.bytes > MAX_TOTAL_BYTES) throw new SkillImportError("The skill is larger than 50 MB.");
      await fs.copyFile(from, to);
    }
  }
}

// ── Zip ──────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  directory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * The entries of a zip archive, each name checked for zip slip. The whole
 * archive is refused when any entry is unsafe, encrypted, a symlink, or uses
 * a compression method other than store or deflate.
 */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  const minEocd = Math.max(0, archive.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minEocd; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new SkillImportError("That file is not a zip archive.");
  const count = archive.readUInt16LE(eocd + 10);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new SkillImportError("Zip64 archives are not supported. Re-create the zip without Zip64.");
  }
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new SkillImportError("The zip archive is damaged.");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = (flags & 0x800) !== 0 ? rawName.toString("utf8") : rawName.toString("latin1");
    offset += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0) throw new SkillImportError("The zip archive is encrypted.");
    if (name.startsWith("__MACOSX/")) continue;
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new SkillImportError(`Refused the archive: ${name} is a symbolic link.`);
    }
    const directory = name.endsWith("/") || name.endsWith("\\");
    const safe = safeRelativePath(name);
    if (!safe) throw new SkillImportError(`Refused the archive: ${name} would land outside the skill folder.`);
    if (!directory && method !== 0 && method !== 8) {
      throw new SkillImportError(`${name} uses a compression method Codara cannot read.`);
    }
    entries.push({ name: safe, directory, method, compressedSize, size, localHeaderOffset });
  }
  return entries;
}

export async function extractZipSafely(archive: Buffer, dest: string): Promise<void> {
  const entries = readZipEntries(archive);
  if (entries.filter((entry) => !entry.directory).length > MAX_FILES) {
    throw new SkillImportError(`The archive has more than ${MAX_FILES} files.`);
  }
  let total = 0;
  for (const entry of entries) {
    const target = join(dest, ...entry.name.split("/"));
    if (!insideRoot(dest, target)) throw new SkillImportError(`Refused the archive: ${entry.name} would land outside the skill folder.`);
    if (entry.directory) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new SkillImportError("The archive unpacks to more than 50 MB.");
    const local = entry.localHeaderOffset;
    if (local + 30 > archive.length || archive.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new SkillImportError("The zip archive is damaged.");
    }
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const compressed = archive.subarray(dataStart, dataStart + entry.compressedSize);
    if (compressed.length !== entry.compressedSize) throw new SkillImportError("The zip archive is damaged.");
    const data = entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    if (data.length !== entry.size) throw new SkillImportError(`${entry.name} did not unpack to its recorded size.`);
    await fs.mkdir(dirname(target), { recursive: true });
    // wx: a second entry with the same name never overwrites the first.
    await fs.writeFile(target, data, { flag: "wx" });
  }
}

// ── Git ──────────────────────────────────────────────────────────────────────

export interface ParsedGitSkillUrl {
  cloneUrl: string;
  ref?: string;
  subdir?: string;
}

const REF_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;

/**
 * Only https remotes, without credentials in the URL. A GitHub or GitLab
 * "tree" or "blob" link is split into the repository, the branch and the
 * folder it points at, so a link copied from the browser imports that skill.
 */
export function parseGitSkillUrl(raw: string): ParsedGitSkillUrl | { error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { error: "Paste the repository's https:// address." };
  if (/[\s\0]/.test(text) || text.startsWith("-")) return { error: "That is not a repository address." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "Use the repository's https:// address." };
  }
  if (url.protocol !== "https:") return { error: "Only https:// repository addresses can be imported." };
  if (url.username || url.password) return { error: "Remove the user name and password from the address." };
  if (!url.hostname || url.hostname.startsWith("-")) return { error: "That is not a repository address." };
  if (url.search || url.hash) return { error: "Remove the ?query or #fragment from the address." };
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  // A lone "-" is GitLab's route separator; anything else starting with "-"
  // is refused so no segment can read as a git option.
  if (segments.some((segment) => segment === ".." || segment === "." || (segment.startsWith("-") && segment !== "-"))) {
    return { error: "That is not a repository address." };
  }
  let repoSegments = segments;
  let ref: string | undefined;
  let subdir: string | undefined;
  // GitHub: owner/repo/tree/<ref>/<path>. GitLab: group/repo/-/tree/<ref>/<path>.
  let marker = -1;
  let markerLength = 0;
  for (let index = 2; index < segments.length; index += 1) {
    if (segments[index] === "-" && (segments[index + 1] === "tree" || segments[index + 1] === "blob")) {
      marker = index;
      markerLength = 2;
      break;
    }
    if (segments[index] === "tree" || segments[index] === "blob") {
      marker = index;
      markerLength = 1;
      break;
    }
  }
  if (marker >= 0) {
    repoSegments = segments.slice(0, marker);
    ref = segments[marker + markerLength];
    if (!ref) return { error: "That address names no branch." };
    const rest = segments.slice(marker + markerLength + 1);
    const folder = segments[marker + markerLength - 1] === "blob" ? rest.slice(0, -1) : rest;
    if (folder.length > 0) subdir = folder.join("/");
  }
  if (repoSegments.length < 1) return { error: "That address does not name a repository." };
  if (ref !== undefined && (!REF_PATTERN.test(ref) || ref.includes(".."))) return { error: "That branch name is not valid." };
  if (subdir !== undefined && !safeRelativePath(subdir)) return { error: "That folder is outside the repository." };
  const repoPath = repoSegments.map((segment) => encodeURIComponent(segment)).join("/");
  return {
    cloneUrl: `https://${url.host}/${repoPath}`,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir: safeRelativePath(subdir)! } : {}),
  };
}

export async function cloneRepository(parsed: ParsedGitSkillUrl, dest: string, run: GitRunner): Promise<void> {
  const args = [
    // https only, whatever the repository's own config or submodules ask for.
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "core.symlinks=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "clone",
    "--depth", "1",
    "--single-branch",
    "--no-tags",
    ...(parsed.ref ? ["--branch", parsed.ref] : []),
    "--",
    parsed.cloneUrl,
    dest,
  ];
  try {
    await run(args, { cwd: dirname(dest), timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n").filter(Boolean).slice(-2).join(" ") : String(err);
    throw new SkillImportError(`Could not clone ${parsed.cloneUrl}${parsed.ref ? ` at ${parsed.ref}` : ""}: ${detail}`);
  }
}

/** The real git. `extraEnv` adds to the environment every run gets. */
export function makeGitRunner(extraEnv: NodeJS.ProcessEnv = {}): GitRunner {
  return (args, options) =>
    new Promise((resolvePromise, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...gitChildEnv(), GIT_LFS_SKIP_SMUDGE: "1", GIT_ASKPASS: "", SSH_ASKPASS: "", ...extraEnv },
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message).trim()));
          else resolvePromise(String(stdout));
        },
      );
    });
}

const runGit: GitRunner = makeGitRunner();
