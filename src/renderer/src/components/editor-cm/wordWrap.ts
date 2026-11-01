import type { EditorWordWrap } from "@shared/types";

// Prose and plain files read better wrapped; code keeps its lines as written.
const PLAIN_EXTENSIONS = new Set(["txt", "text", "md", "markdown", "mdown", "mkd", "mkdn", "log"]);

/** Whether "auto" wraps this file: prose and plain files, and files with no extension. */
export function wrapsByDefault(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  // `.env` and `.gitignore` have no extension, they are all name.
  if (dot <= 0) return true;
  return PLAIN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Whether the file wraps, given the saved preference. */
export function resolveWordWrap(pref: EditorWordWrap, path: string): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  return wrapsByDefault(path);
}
