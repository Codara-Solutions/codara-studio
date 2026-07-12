import { app } from "electron";
import { join } from "node:path";

/**
 * Resolve a file copied from the repository's resources directory.
 *
 * Development and electron-vite preview keep resources under the application
 * root. Packaged builds copy extraResources directly under resourcesPath.
 * Never derive this path from __dirname: code splitting can move the calling
 * module into out/main/chunks, changing how many parent directories it needs.
 */
export function resolveBundledResourcePath(...segments: string[]): string {
  const root = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  return join(root, ...segments);
}
