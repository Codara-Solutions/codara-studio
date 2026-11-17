// Many Linux and macOS machines ship python3 with no `python` on PATH. A
// worker that runs `python script.py` there fails with "command not found",
// and a run once stalled on exactly that. The prompt says to use python3;
// this pre-tool guard makes it hold where the shell really has no `python`.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { shellCommand, splitShellSegments, type ToolBlockDecision } from "./studio-browser-policy";

/** True when `name` resolves to a file in one of PATH's directories. */
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return dirs.some((dir) => suffixes.some((suffix) => existsSync(join(dir, `${name}${suffix}`))));
}

/** Whether a shell command line starts a bare `python` (not python3 or py). */
export function runsBarePython(command: string): boolean {
  const normalized = command.replace(/\\\r?\n/g, " ");
  for (const rawSegment of splitShellSegments(normalized)) {
    const segment = rawSegment
      .trim()
      .replace(/^[({]+\s*/, "")
      .replace(/^(?:(?:sudo|nohup|command|exec|time)\s+)+/i, "")
      .replace(/^env(?:\s+-\S+)*(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*\s+/i, "")
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
    if (/^(?:\S*\/)?python(?:\s|$)/.test(segment)) return true;
  }
  return false;
}

/**
 * Block a bash call that runs `python` when this machine has none but has
 * python3. `hasPython` and `hasPython3` are looked up once per process by the
 * caller, so a user who installs `python` later is not blocked after restart.
 */
export function barePythonDecision(
  toolName: unknown,
  input: unknown,
  available: { hasPython: boolean; hasPython3: boolean },
): ToolBlockDecision | undefined {
  if (available.hasPython || !available.hasPython3) return undefined;
  if (String(toolName ?? "").toLowerCase() !== "bash") return undefined;
  const command = shellCommand(input);
  if (!command || !runsBarePython(command)) return undefined;
  return {
    block: true,
    reason: "This machine has no `python` command, only `python3`. Run the same command with python3.",
  };
}

/** The PATH lookup the extensions use, done once per Pi process. */
export function pythonAvailability(env: NodeJS.ProcessEnv = process.env): {
  hasPython: boolean;
  hasPython3: boolean;
} {
  return { hasPython: commandOnPath("python", env), hasPython3: commandOnPath("python3", env) };
}
