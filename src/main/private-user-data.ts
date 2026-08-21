import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Chromium profiles contain browser cookies, local storage, and login state.
// Test/dev builds may override Electron's userData path, but never allow that
// override to land inside a Git repository where it could be committed.
export function isInsideGitRepository(candidate: string): boolean {
  let cursor = physicalPath(candidate);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

// Resolve symlinked existing ancestors too. The final profile directory may
// not exist yet, so retain its missing tail after resolving the nearest parent.
function physicalPath(candidate: string): string {
  let cursor = resolve(candidate);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const ancestor = existsSync(cursor) ? realpathSync.native(cursor) : cursor;
  return resolve(ancestor, ...missing);
}

export function safeUserDataOverride(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const absolute = resolve(candidate);
  return isInsideGitRepository(absolute) ? undefined : absolute;
}
