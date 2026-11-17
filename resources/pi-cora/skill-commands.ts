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
  repoSkills: ReadonlyMap<string, string> = new Map(),
): string | null {
  const header = splitUserCommandsHeader(text);
  if (!header) return null;
  const found = header.commands.filter((command) => skillFileOf(command.name, skills, repoSkills) !== null);
  if (found.length === 0) return header.rest;
  // Pi expands only skills it loaded; a repository copy shadowed by a user
  // skill (`repo:<name>`) is always a pointer to its file.
  const expandable = found.find((command) => !command.name.startsWith("repo:"));
  const pointers = found.filter((command) => command !== expandable).map((other) => {
    const path = skillFileOf(other.name, skills, repoSkills);
    const where = path ? ` Read ${path} and follow it` : " Follow it";
    const label = other.name.startsWith("repo:") ? `the repository's skill ${other.name.slice(5)}` : `the skill ${other.name}`;
    return `[The user ${expandable ? "also " : ""}ran ${label}${other.args ? ` (${other.args})` : ""}.${where} for that message.]`;
  });
  const payload = [expandable?.args, ...pointers, header.rest.trim()].filter(Boolean).join("\n\n");
  if (!expandable) return payload;
  return payload ? `/skill:${expandable.name} ${payload}` : `/skill:${expandable.name}`;
}

/** The SKILL.md a command names: "" for a loaded skill whose path Pi did not
 *  report, null when it names no skill. */
function skillFileOf(
  name: string,
  skills: ReadonlyMap<string, string | undefined>,
  repoSkills: ReadonlyMap<string, string>,
): string | null {
  if (name.startsWith("repo:")) return repoSkills.get(name.slice(5)) ?? null;
  return skills.has(name) ? skills.get(name) ?? "" : null;
}

/** The skills a turn's header runs, with their files, for the chat note. */
export function skillsRun(
  text: string,
  skills: ReadonlyMap<string, string | undefined>,
  repoSkills: ReadonlyMap<string, string> = new Map(),
): Array<{ name: string; path: string }> {
  const header = splitUserCommandsHeader(text);
  if (!header) return [];
  return header.commands.flatMap((command) => {
    const path = skillFileOf(command.name, skills, repoSkills);
    return path === null ? [] : [{ name: command.name, path }];
  });
}

/** CODARA_PI_REPO_SKILLS ({name: SKILL.md}) as a map; empty when unset or bad. */
export function repoSkillsFromEnv(value: string | undefined): Map<string, string> {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return new Map();
  }
}

/** The custom entry Studio turns into a chat note naming each skill file. */
export const SKILL_RAN_ENTRY = "codara-skill-ran";
