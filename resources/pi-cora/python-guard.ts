// Many Linux and macOS machines ship python3 with no `python` on PATH. A
// worker that runs `python script.py` there fails with "command not found",
// and a run once stalled on exactly that. The prompt says to use python3;
// this adds the fix to the failed call's own output, so the next call gets it
// right. It reads the shell's error rather than parsing the command: heredocs,
// quotes and comments make a parse guess wrong, and a wrong guess would block
// a command that works.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** True when `name` resolves to a file in one of PATH's directories. */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return dirs.some((dir) => suffixes.some((suffix) => existsSync(join(dir, `${name}${suffix}`))));
}

export const PYTHON3_HINT =
  "This machine has no `python` command, only `python3`. Rerun only the python step with python3; anything before it in the same command already ran.";

/** bash (`python: command not found`), dash (`python: not found`), zsh
 *  (`command not found: python`) and env (`env: 'python': No such file or
 *  directory`), never python3 or python3.12. */
const MISSING_PYTHON =
  /(?:^|[\s:])python: (?:command )?not found\b|command not found: python(?![\w.])|env: '?python'?: No such file or directory/m;

/** Whether a shell tool's output says a bare `python` was not found. */
export function saysPythonMissing(content: ReadonlyArray<{ type?: unknown; text?: unknown }>): boolean {
  return content.some((part) => part.type === "text" && typeof part.text === "string" && MISSING_PYTHON.test(part.text));
}

/**
 * The bash result with the python3 hint added, when the call failed for want
 * of `python` on a machine that has python3. `available` is looked up once
 * per Pi process by the caller.
 */
export function barePythonHint<Part extends { type: string }>(
  event: { toolName?: unknown; isError?: unknown; content: readonly Part[] },
  available: { hasPython: boolean; hasPython3: boolean },
): { content: Array<Part | { type: "text"; text: string }> } | undefined {
  if (available.hasPython || !available.hasPython3) return undefined;
  if (String(event.toolName ?? "").toLowerCase() !== "bash") return undefined;
  // Only a failed call: a successful one that printed the message (a log, a
  // doc, an echo) did not fail for want of python.
  if (event.isError !== true) return undefined;
  if (!saysPythonMissing(event.content as ReadonlyArray<{ type?: unknown; text?: unknown }>)) return undefined;
  return { content: [...event.content, { type: "text", text: PYTHON3_HINT }] };
}

/** The PATH lookup the extensions use, done once per Pi process. */
export function pythonAvailability(env: NodeJS.ProcessEnv = process.env): {
  hasPython: boolean;
  hasPython3: boolean;
} {
  return { hasPython: commandOnPath("python", env), hasPython3: commandOnPath("python3", env) };
}
