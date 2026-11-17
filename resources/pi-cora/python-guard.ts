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

/** The command without heredoc bodies, which are data, not commands. */
export function withoutHeredocBodies(command: string): string {
  const out: string[] = [];
  const pending: Array<{ tag: string; tabs: boolean }> = [];
  for (const line of command.split(/\r?\n/)) {
    if (pending.length > 0) {
      const { tag, tabs } = pending[0];
      if ((tabs ? line.replace(/^\t+/, "") : line) === tag) pending.shift();
      continue;
    }
    out.push(line);
    for (const match of line.matchAll(/(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      pending.push({ tag: match[3], tabs: match[1] === "-" });
    }
  }
  return out.join("\n");
}

/** Whether a shell command line starts a bare `python` (not python3, py or
 *  an interpreter named by its path, such as .venv/bin/python). */
export function runsBarePython(command: string): boolean {
  const normalized = withoutHeredocBodies(command).replace(/\\\r?\n/g, " ");
  for (const rawSegment of splitShellSegments(normalized)) {
    const segment = rawSegment
      .trim()
      .replace(/^[({]+\s*/, "")
      .replace(/^(?:(?:sudo|nohup|command|exec|time)\s+)+/i, "")
      .replace(/^env(?:\s+-\S+)*(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))*\s+/i, "")
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
    if (/^python(?:\s|$)/.test(segment)) return true;
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
