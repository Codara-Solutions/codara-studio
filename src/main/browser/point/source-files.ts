// Turns the page's idea of a source file (an absolute path from a dev
// build, a served URL, a bundler URL from a source map) into a path in the
// workspace, and, when the page gave nothing usable, proposes candidate
// files by searching the workspace for the component name, ids, test ids,
// class names and visible text. Reads only; nothing here writes or runs
// project code.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface SourceFileLocation {
  /** Workspace-relative when it is inside the workspace, else as the page named it. */
  file: string;
  absolute: string | null;
  exists: boolean;
}

/** Strips bundler schemes and queries down to a path, or null for a remote URL that maps nowhere. */
export function sourcePathFromUrl(raw: string, sourceRoot = "", mapUrl = ""): string {
  let value = raw.trim().replace(/[?#].*$/, "");
  if (sourceRoot && !/^[a-z][\w+.-]*:/i.test(value) && !value.startsWith("/")) {
    value = sourceRoot.replace(/\/?$/, "/") + value;
  }
  if (/^file:\/\//i.test(value)) {
    try {
      return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
    } catch {
      return value.slice("file://".length);
    }
  }
  const webpack = /^webpack(?:-internal)?:\/\/\/?(?:\([^)]*\)\/)?(?:[^/]*\/)?(\.\/.*|\/.*)$/i.exec(value);
  if (webpack) return webpack[1].replace(/^\.\//, "");
  const turbopack = /^turbopack:\/\/\/?(?:\[project\]\/)?(.*)$/i.exec(value);
  if (turbopack) return turbopack[1];
  if (/^https?:\/\//i.test(value)) {
    try {
      const path = decodeURIComponent(new URL(value).pathname);
      // Vite serves files outside its root as /@fs/<absolute path>.
      return path.startsWith("/@fs/") ? path.slice(4) : path;
    } catch {
      return value;
    }
  }
  if (mapUrl && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) {
    try {
      const resolved = new URL(value, mapUrl);
      if (/^https?:$/.test(resolved.protocol)) return decodeURIComponent(resolved.pathname);
      if (resolved.protocol === "file:") return decodeURIComponent(resolved.pathname);
    } catch {
      /* keep the relative path */
    }
  }
  return value;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function isFile(path: string): Promise<boolean> {
  return fs.stat(path).then((stat) => stat.isFile()).catch(() => false);
}

/**
 * Where a page-named file is in the workspace. An absolute path is taken as
 * is; a served path ("/src/App.tsx") or a relative one is tried against the
 * workspace root.
 */
export async function locateSourceFile(path: string, root: string | null): Promise<SourceFileLocation> {
  const cleaned = path.replace(/\\/g, "/");
  const candidates: string[] = [];
  if (isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) candidates.push(normalize(cleaned));
  if (root) {
    const trimmed = cleaned.replace(/^\/+/, "").replace(/^\.\//, "");
    candidates.push(resolve(root, trimmed));
  }
  for (const candidate of candidates) {
    if (root && !inside(root, candidate) && candidate !== normalize(cleaned)) continue;
    if (await isFile(candidate)) {
      return { file: root && inside(root, candidate) ? relative(root, candidate).split(sep).join("/") : candidate, absolute: candidate, exists: true };
    }
  }
  return { file: cleaned, absolute: null, exists: false };
}

export interface SearchHints {
  components: string[];
  classes: string[];
  text: string;
  id?: string;
  testId?: string;
  label?: string;
}

export interface SourceCandidate {
  file: string;
  line: number;
  reason: string;
  score: number;
}

const SEARCH_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ".html", ".htm", ".mdx",
  ".css", ".scss", ".sass", ".less", ".php", ".erb", ".hbs", ".liquid", ".twig", ".njk",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "coverage", "vendor", ".output", "target", ".vercel"]);
const MAX_FILES = 6_000;
const MAX_FILE_BYTES = 400_000;

export interface WorkspaceFiles {
  list(root: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
}

function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((done) => {
    execFile("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { timeout: 4_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) done(null);
      else done(stdout.split("\n").filter(Boolean));
    });
  });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [""];
  while (queue.length && out.length < MAX_FILES * 3) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".storybook") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

export const nodeWorkspaceFiles: WorkspaceFiles = {
  async list(root) {
    return (await gitListFiles(root)) ?? (await walk(root));
  },
  async read(path) {
    const stat = await fs.stat(path).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFile(path, "utf8").catch(() => null);
  },
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Files in the workspace that likely render the element, best first. A
 * component definition outranks a file named after the component, which
 * outranks literal ids, labels, text and class names.
 */
export async function searchWorkspaceSources(
  root: string,
  hints: SearchHints,
  files: WorkspaceFiles = nodeWorkspaceFiles,
  options: { limit?: number; budgetMs?: number } = {},
): Promise<SourceCandidate[]> {
  const started = Date.now();
  const budget = options.budgetMs ?? 2_500;
  const components = [...new Set(hints.components.filter((name) => /^[A-Za-z_$][\w$]{1,60}$/.test(name)))].slice(-4).reverse();
  const literals: Array<{ value: string; weight: number; reason: string }> = [];
  if (hints.id) literals.push({ value: hints.id, weight: 6, reason: `id "${hints.id}"` });
  if (hints.testId) literals.push({ value: hints.testId, weight: 7, reason: `test id "${hints.testId}"` });
  if (hints.label && hints.label.length >= 3) literals.push({ value: hints.label, weight: 5, reason: `label "${hints.label}"` });
  const text = hints.text.trim();
  if (text.length >= 3) literals.push({ value: text.slice(0, 60), weight: 5, reason: `text "${text.slice(0, 40)}"` });
  const classes = hints.classes.filter((name) => name.length >= 3).slice(0, 5);
  if (!components.length && !literals.length && !classes.length) return [];

  const listed = await files.list(root).catch(() => [] as string[]);
  const candidates = listed
    .filter((file) => SEARCH_EXTENSIONS.has(extname(file).toLowerCase()) && !file.split("/").some((part) => SKIP_DIRS.has(part)))
    .slice(0, MAX_FILES);
  // Files named after a component first, then source before styles.
  const rank = (file: string) => {
    const base = file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    if (components.includes(base)) return 0;
    return /\.(css|scss|sass|less)$/i.test(file) ? 2 : 1;
  };
  candidates.sort((a, b) => rank(a) - rank(b));

  const definitions = components.map((name) => ({
    name,
    pattern: new RegExp(`(?:function\\s+${escapeRegExp(name)}\\b|(?:const|let|var|class)\\s+${escapeRegExp(name)}\\b|export\\s+default\\s+(?:function|class)\\s+${escapeRegExp(name)}\\b|name:\\s*["']${escapeRegExp(name)}["'])`),
  }));
  const results: SourceCandidate[] = [];
  for (const file of candidates) {
    if (Date.now() - started > budget) break;
    const content = await files.read(join(root, file));
    if (!content) continue;
    let score = 0;
    let line = 0;
    const reasons: string[] = [];
    const base = file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    for (const [i, { name, pattern }] of definitions.entries()) {
      const match = pattern.exec(content);
      if (match) {
        score += 12 - i * 2;
        line ||= lineOf(content, match.index);
        reasons.push(`defines ${name}`);
      } else if (base === name) {
        score += 6;
        reasons.push(`named ${name}`);
      }
    }
    for (const literal of literals) {
      const index = content.indexOf(literal.value);
      if (index >= 0) {
        score += literal.weight;
        line ||= lineOf(content, index);
        reasons.push(literal.reason);
      }
    }
    let classHits = 0;
    for (const name of classes) {
      const match = new RegExp(`(?:^|[\\s"'\`.{])${escapeRegExp(name)}(?=[\\s"'\`{,:]|$)`, "m").exec(content);
      if (match && classHits < 3) {
        classHits++;
        score += 2;
        line ||= lineOf(content, match.index + 1);
        reasons.push(`class ${name}`);
      }
    }
    if (score >= 4) results.push({ file, line: line || 1, reason: reasons.join(", "), score });
  }
  results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return results.slice(0, options.limit ?? 5);
}
