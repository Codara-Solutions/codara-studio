import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve a file copied from the repository's resources directory.
 *
 * Development and electron-vite preview keep resources under the application
 * root. Packaged builds copy extraResources directly under resourcesPath.
 * Never derive this path from __dirname: code splitting can move the calling
 * module into out/main/chunks, changing how many parent directories it needs.
 */
export function resolveBundledResourcePath(...segments: string[]): string {
  if (app.isPackaged) return join(process.resourcesPath, ...segments);

  // `electron-vite preview` reports the repository as appPath, while the
  // headless/eval entrypoint (`electron out/main/index.js`) reports out/main.
  // Walk a small, bounded ancestor chain and choose the first real resource.
  // This keeps callers independent of emitted chunk depth and makes the same
  // resolver work for normal development, direct compiled entrypoints, and
  // tests without falling back to process.cwd() (which is the user's project).
  const appPath = app.getAppPath();
  let current = appPath;
  for (let depth = 0; depth <= 4; depth += 1) {
    const candidate = join(current, "resources", ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Preserve the conventional development path in the error message produced
  // by the eventual read/spawn operation when a resource is genuinely absent.
  return join(appPath, "resources", ...segments);
}
