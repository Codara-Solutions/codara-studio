// User-invoked skills in Cora. Pi expands `/skill:<name> args` into the
// skill's instructions only when the prompt text starts with it, and it does
// so for every loaded skill, including one marked disable-model-invocation
// (hidden from the model's list, meant to run only when the user asks).
//
// A Cora turn's text is Studio's framing around the user's messages, and a
// message may quote that framing, so the text cannot be trusted to say where
// a message starts. Studio lists the commands that open a message in one
// header line at the very start of the turn (src/shared/user-commands.ts);
// this strips it and puts the first command that names a skill in front, in
// the form Pi expands. Each further skill gets a pointer to its file.
//
// Pure, so scripts/test-pi-cora-skill-commands.cjs can load it outside Pi.

/** Same as USER_COMMANDS_HEADER_PREFIX in src/shared/user-commands.ts. */
const HEADER_PREFIX = "[CODARA USER COMMANDS ";

interface UserCommand {
  name: string;
  args: string;
}

/** Skill names from Pi's command list (`skill:<name>` entries), each with
 *  its SKILL.md path when Pi reports one. */
export function skillNamesFromCommands(
  commands: ReadonlyArray<{ name?: unknown; source?: unknown; sourceInfo?: unknown }>,
): Map<string, string | undefined> {
  const names = new Map<string, string | undefined>();
  for (const command of commands) {
    if (command.source !== "skill" || typeof command.name !== "string") continue;
    if (!command.name.startsWith("skill:")) continue;
    const info = command.sourceInfo as { path?: unknown } | undefined;
    names.set(command.name.slice("skill:".length), typeof info?.path === "string" ? info.path : undefined);
  }
  return names;
}

/** Studio's command header and the turn text after it, or null. */
export function splitUserCommandsHeader(text: string): { commands: UserCommand[]; rest: string } | null {
  if (typeof text !== "string" || !text.startsWith(HEADER_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const line = newline < 0 ? text : text.slice(0, newline);
  if (!line.endsWith("]")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(HEADER_PREFIX.length, -1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const commands: UserCommand[] = [];
  for (const item of parsed) {
    const { name, args } = (item ?? {}) as { name?: unknown; args?: unknown };
    if (typeof name !== "string" || typeof args !== "string") return null;
    commands.push({ name, args });
  }
  return { commands, rest: newline < 0 ? "" : text.slice(newline + 1) };
}

/**
 * The turn text without Studio's header and with the first skill command in
 * front, or null when the text carries no header. With `skills` empty (an
 * imported pull request) the header is only removed.
 */
export function rewriteSkillCommand(
  text: string,
  skills: ReadonlyMap<string, string | undefined>,
): string | null {
  const header = splitUserCommandsHeader(text);
  if (!header) return null;
  const found = header.commands.filter((command) => skills.has(command.name));
  if (found.length === 0) return header.rest;
  const [first, ...others] = found;
  const pointers = others.map((other) => {
    const path = skills.get(other.name);
    const where = path ? ` Read ${path} and follow it` : " Follow it";
    return `[The user also ran the skill ${other.name}${other.args ? ` (${other.args})` : ""}.${where} for that message.]`;
  });
  const payload = [first.args, ...pointers, header.rest.trim()].filter(Boolean).join("\n\n");
  return payload ? `/skill:${first.name} ${payload}` : `/skill:${first.name}`;
}
