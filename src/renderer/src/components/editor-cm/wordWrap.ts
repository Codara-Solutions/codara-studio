import type { EditorWordWrap } from "@shared/types";
import { hasLanguage } from "./languageResolver";

// Prose and plain files read better wrapped; code keeps its lines as written.
const PROSE_EXTENSIONS = new Set(["txt", "text", "md", "markdown", "mdown", "mkd", "mkdn", "log"]);

// Extensionless build files the language resolver has no name for.
const CODE_NAMES = new Set([
  "makefile", "gnumakefile", "gemfile", "rakefile", "procfile", "vagrantfile", "jenkinsfile", "cmakelists.txt",
]);

/**
 * Whether "auto" wraps this file: prose and plain files, README-style names
 * with no extension, and rotated logs (server.log.1). Anything with a known
 * language, build files and dotfiles (.bashrc, .env, .env.local) stay unwrapped.
 */
export function wrapsByDefault(path: string): boolean {
  // A trailing dot is no extension ("notes." is "notes").
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.+$/, "").toLowerCase();
  if (CODE_NAMES.has(name)) return false;
  if (/\.log\.\d+$/.test(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return !hasLanguage(name);
  // Dotfiles are configuration, whatever follows the first dot.
  if (dot === 0) return false;
  return PROSE_EXTENSIONS.has(name.slice(dot + 1));
}

/** Whether the file wraps, given the saved preference. */
export function resolveWordWrap(pref: EditorWordWrap, path: string): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  return wrapsByDefault(path);
}
