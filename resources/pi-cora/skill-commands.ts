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

// Studio's own wrappers (agent-backend.ts: buildManagerTurnPrompt,
// renderBundledManagerInput). Only these exact lines, in these positions,
// are skipped; any other text is the user's.
const REPLAY_START = "[CORA CONVERSATION REPLAY";
const REPLAY_END = "[END CORA CONVERSATION REPLAY]\n\n\n\n[NEW USER INPUT FOR THIS TURN]\n\n";
const SEND_NOW_LINE =
  "[The user stopped your previous reply to send this now. What that reply already did stands, and workers it started keep running.]";
const REDELIVERED_LINE =
  "[Already received; your previous reply was interrupted. Do not redo work already started]";
const QUEUED_HEADER =
  "The user sent the following queued messages in this order. Treat all of them as input for this manager turn:";
const QUEUED_SECTION =
  /^\d+\. \[(?:User turn|Queued message|Linked answer|Already received; your previous reply was interrupted\. Do not redo work already started)\]$/;
const COMMAND_LINE = /^\/(skill:)?([A-Za-z0-9][A-Za-z0-9._-]*)(?:[ \t]+(.*))?$/;

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

/** Indexes of the lines that open one of the user's messages. */
function messageFirstLines(lines: readonly string[]): number[] {
  let index = 0;
  if (lines[index] === SEND_NOW_LINE) index += 1;
  if (lines[index] !== QUEUED_HEADER) {
    if (lines[index] === REDELIVERED_LINE) index += 1;
    return [index];
  }
  const firsts: number[] = [];
  for (let at = index + 1; at < lines.length - 1; at += 1) {
    if (QUEUED_SECTION.test(lines[at])) firsts.push(at + 1);
  }
  return firsts;
}

/**
 * The turn text with the user's skill command first, in the form Pi expands,
 * or null when no message of this turn starts with a known skill command.
 * Only the first line of each of the user's messages counts, as in Claude
 * Code: a slash later in a message, or in a replayed earlier turn, is text.
 * When queued messages hold several commands, the first runs through Pi and
 * each other one is replaced by a pointer to its skill file.
 */
export function rewriteSkillCommand(
  text: string,
  skills: ReadonlyMap<string, string | undefined>,
): string | null {
  if (skills.size === 0) return null;
  let inputStart = 0;
  if (text.startsWith(REPLAY_START)) {
    const end = text.lastIndexOf(REPLAY_END);
    if (end < 0) return null;
    inputStart = end + REPLAY_END.length;
  }
  const lines = text.slice(inputStart).split("\n");
  const found: Array<{ index: number; name: string; args: string }> = [];
  for (const index of messageFirstLines(lines)) {
    const match = COMMAND_LINE.exec(lines[index]?.trim() ?? "");
    if (match && skills.has(match[2])) found.push({ index, name: match[2], args: match[3]?.trim() ?? "" });
  }
  if (found.length === 0) return null;
  const [first, ...others] = found;
  const rest = [...lines];
  for (const other of others) {
    const path = skills.get(other.name);
    const pointer = path
      ? `[The user ran the skill ${other.name} here. Read ${path} and follow it for this message.]`
      : `[The user ran the skill ${other.name} here; follow it for this message.]`;
    rest[other.index] = other.args ? `${pointer}\n${other.args}` : pointer;
  }
  rest.splice(first.index, 1);
  const context = [text.slice(0, inputStart), ...rest].join("\n").trim();
  const payload = [first.args, context].filter(Boolean).join("\n\n");
  const rewritten = payload ? `/skill:${first.name} ${payload}` : `/skill:${first.name}`;
  return rewritten === text ? null : rewritten;
}
