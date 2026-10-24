// How a link or code span in Cora's markdown is opened. Pure so the rules can
// be tested without a DOM.

export type ChatHrefTarget =
  | { kind: "external"; url: string }
  | { kind: "path"; path: string; line?: number }
  | { kind: "none" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;
const LINE_FRAGMENT = /#L(\d+)(?:-L?\d+)?$/i;

/**
 * Only a scheme-less href is a workspace path. Anything with a scheme keeps
 * the external route it always had (openExternal allows only browser URLs
 * and mailto), so javascript:, vscode: and the like can never reach the file
 * opener.
 */
export function classifyChatHref(href: string | undefined): ChatHrefTarget {
  const raw = (href ?? "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("?")) return { kind: "none" };
  if (raw.startsWith("//")) return { kind: "external", url: raw };
  if (SCHEME.test(raw) && !WINDOWS_DRIVE.test(raw)) return { kind: "external", url: raw };
  let path = raw.replace(/\?.*$/, "");
  let line: number | undefined;
  const fragment = path.match(LINE_FRAGMENT);
  if (fragment) {
    line = Number(fragment[1]);
    path = path.slice(0, fragment.index);
  }
  path = path.replace(/#.*$/, "");
  const suffix = path.match(LINE_SUFFIX);
  if (suffix) {
    line = Number(suffix[1]);
    path = path.slice(0, suffix.index);
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // A literal "%" in a file name is not an escape; keep the text as written.
  }
  if (!path) return { kind: "none" };
  return line && line > 0 ? { kind: "path", path, line } : { kind: "path", path };
}

const CODE_FILE_EXTENSIONS = new Set([
  "c", "cc", "cjs", "cpp", "cs", "css", "cts", "env", "go", "h", "hpp", "html",
  "java", "js", "json", "jsonc", "jsx", "kt", "lock", "md", "mdx", "mjs", "mts",
  "php", "py", "rb", "rs", "scss", "sh", "sql", "svelte", "swift", "toml",
  "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);
const CODE_PATH = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.([a-z][a-z0-9]*)(?::(\d+)(?::\d+)?)?$/i;

/**
 * An inline code span that reads as a file reference (`src/a.ts`,
 * `run-store.ts:120`, `package.json`). Text only: whether the file exists is
 * checked when the span is clicked, never while a streamed answer re-renders.
 */
export function codeSpanFileReference(text: string): { path: string; line?: number } | null {
  const trimmed = text.trim();
  if (trimmed.length > 240) return null;
  const match = trimmed.match(CODE_PATH);
  if (!match) return null;
  const hasDir = trimmed.includes("/");
  const line = match[2] ? Number(match[2]) : undefined;
  if (!hasDir && !line && !CODE_FILE_EXTENSIONS.has(match[1].toLowerCase())) return null;
  const path = line ? trimmed.replace(LINE_SUFFIX, "") : trimmed;
  return line ? { path, line } : { path };
}

export function isAbsoluteChatPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || WINDOWS_DRIVE.test(path) || SCHEME.test(path);
}

/**
 * Resolve a path from Cora's answer against the run's workspace. The
 * workspace's own form is kept (a Windows cwd keeps backslashes, an ssh://
 * cwd keeps its prefix), because the editor opens exactly the string it gets.
 */
export function resolveChatPath(cwd: string, path: string): string {
  if (isAbsoluteChatPath(path)) return path;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  const parts = base.split(/[\\/]/);
  for (const segment of path.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join(sep);
}
