import { promises as fs } from "node:fs";
import { delimiter, join } from "node:path";

import { agentArgsDir } from "./agent-launch-integration";
import { resolveBundledResourcePath } from "./bundled-resources";
import { writeFileAtomic } from "./fs-atomic";

/**
 * `codara-pane`, the command a program in a Codara terminal runs to open a
 * terminal over its own pane or in a new tab of its workspace. It lives in
 * <codaraHome>/integrations/bin, which only Codara's own panes get on PATH,
 * so nothing is installed into the user's shell setup. The wrappers are
 * rewritten at every boot because they name the running Electron binary
 * (an AppImage mount or a moved app changes it); the logic is the bundled
 * resources/shell-integration/codara-pane.cjs.
 */

export const PANE_HELPER_NAME = "codara-pane";

export function paneHelperBinDir(integrations: string = agentArgsDir()): string {
  return join(integrations, "bin");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function posixPaneHelperWrapper(nodePath: string, scriptPath: string): string {
  return [
    "#!/bin/sh",
    "# Written by Codara Studio at every start; only Codara panes have it on PATH.",
    "ELECTRON_RUN_AS_NODE=1",
    "export ELECTRON_RUN_AS_NODE",
    `exec ${shQuote(nodePath)} ${shQuote(scriptPath)} "$@"`,
    "",
  ].join("\n");
}

export function windowsPaneHelperWrapper(nodePath: string, scriptPath: string): string {
  return [
    "@echo off",
    "rem Written by Codara Studio at every start; only Codara panes have it on PATH.",
    "setlocal",
    "set ELECTRON_RUN_AS_NODE=1",
    `"${nodePath}" "${scriptPath}" %*`,
    "",
  ].join("\r\n");
}

/** Boot: write the wrappers for this Codara's binary. Returns their folder. */
export async function writePaneHelperFiles(
  options: { dir?: string; nodePath?: string; scriptPath?: string; platform?: NodeJS.Platform } = {},
): Promise<string> {
  const dir = options.dir ?? paneHelperBinDir();
  const nodePath = options.nodePath ?? process.execPath;
  const scriptPath =
    options.scriptPath ?? resolveBundledResourcePath("shell-integration", `${PANE_HELPER_NAME}.cjs`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if ((options.platform ?? process.platform) === "win32") {
    await writeIfChanged(
      join(dir, `${PANE_HELPER_NAME}.cmd`),
      windowsPaneHelperWrapper(nodePath, scriptPath),
      0o600,
    );
  } else {
    await writeIfChanged(join(dir, PANE_HELPER_NAME), posixPaneHelperWrapper(nodePath, scriptPath), 0o755);
  }
  return dir;
}

async function writeIfChanged(path: string, content: string, mode: number): Promise<void> {
  const current = await fs.readFile(path, "utf8").catch(() => null);
  if (current === content) return;
  await writeFileAtomic(path, content, { mode });
}

/** PATH with the helper folder first, listed once, under the env's own key. */
export function withPaneHelperOnPath(env: Record<string, string>, binDir: string): void {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? (process.platform === "win32" ? "Path" : "PATH");
  const rest = (env[key] ?? "").split(delimiter).filter((entry) => entry && entry !== binDir);
  env[key] = [binDir, ...rest].join(delimiter);
}
