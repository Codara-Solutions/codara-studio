// User-invoked skills in Cora. Pi expands `/skill:<name> args` into the
// skill's instructions only when the prompt text starts with it, and it does
// so for every loaded skill, including one marked disable-model-invocation
// (hidden from the model's list, meant to run only when the user asks). A
// Cora turn's text is not always the user's words alone: queued messages get
// a numbered header, a Send now or a redelivery gets a label line, and a
// fresh session gets a replay before the new input. This moves the user's
// command to the front so Pi sees it, and accepts the short `/<name>` form
// Claude Code users type.
//
// Pure, so scripts/test-pi-cora-skill-commands.cjs can load it outside Pi.

const NEW_INPUT_MARKER = "[NEW USER INPUT FOR THIS TURN]";
const COMMAND_LINE = /^\/(skill:)?([A-Za-z0-9][A-Za-z0-9._-]*)(?:[ \t]+([\s\S]*))?$/;

/** Lines Studio adds around the user's words (agent-backend.ts). */
function isFramingLine(line: string): boolean {
  return (
    /^\[[^\n]*\]$/.test(line) ||
    /^\d+\. \[[^\]\n]+\]$/.test(line) ||
    line.startsWith("The user sent the following queued messages")
  );
}

/** Skill names from Pi's command list (`skill:<name>` entries). */
export function skillNamesFromCommands(commands: ReadonlyArray<{ name?: unknown; source?: unknown }>): Set<string> {
  const names = new Set<string>();
  for (const command of commands) {
    if (command.source !== "skill" || typeof command.name !== "string") continue;
    if (command.name.startsWith("skill:")) names.add(command.name.slice("skill:".length));
  }
  return names;
}

/**
 * The turn text with the user's skill command first, in the form Pi expands,
 * or null when the user's input does not start with a known skill command.
 * Only the first line of the new input counts, as in Claude Code: a slash
 * later in a message, or in a replayed earlier turn, is just text.
 */
export function rewriteSkillCommand(text: string, skillNames: ReadonlySet<string>): string | null {
  if (skillNames.size === 0) return null;
  const markerAt = text.indexOf(NEW_INPUT_MARKER);
  const inputStart = markerAt >= 0 ? markerAt + NEW_INPUT_MARKER.length : 0;
  const lines = text.slice(inputStart).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || isFramingLine(line)) continue;
    const match = COMMAND_LINE.exec(line);
    if (!match || !skillNames.has(match[2])) return null;
    const args = match[3]?.trim() ?? "";
    const context = [text.slice(0, inputStart), ...lines.slice(0, index), ...lines.slice(index + 1)]
      .join("\n")
      .trim();
    const payload = [args, context].filter(Boolean).join("\n\n");
    const rewritten = payload ? `/skill:${match[2]} ${payload}` : `/skill:${match[2]}`;
    return rewritten === text ? null : rewritten;
  }
  return null;
}
