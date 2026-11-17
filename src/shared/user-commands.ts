// Slash commands the user typed at the start of a message, such as `/ship`
// or `/skill:verify the parser`. A Cora turn's text wraps the user's
// messages in Studio's framing (a replay, a Send now label, a numbered queue),
// and any message may quote that framing, so the text alone cannot say where
// a message starts. Studio knows, so it lists the commands in one header line
// at the very start of the turn (buildManagerTurnPrompt), before any user
// text. The manager extension (resources/pi-cora/skill-commands.ts) strips
// the header and runs the commands that name a skill.
//
// Pure, so the main process and the unit suite share it.

/** The header line starts with this and ends with `]`; JSON sits between. */
export const USER_COMMANDS_HEADER_PREFIX = "[CODARA USER COMMANDS ";

const COMMAND_LINE = /^\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9._-]*)(?:[ \t]+(.*))?$/;

export interface UserCommand {
  name: string;
  /** The rest of the command's line. */
  args: string;
}

/** The command opening `message`, or null. Only the first line counts, as
 *  in Claude Code: a slash later in a message is text. */
export function userCommandOf(message: string): UserCommand | null {
  const first = message.trim().split("\n", 1)[0]?.trim() ?? "";
  const match = COMMAND_LINE.exec(first);
  return match ? { name: match[1], args: match[2]?.trim() ?? "" } : null;
}

/** The header for a turn's messages, in order, or "" when none opens with a
 *  command. */
export function userCommandsHeader(messages: readonly string[]): string {
  const commands = messages.map(userCommandOf).filter((command): command is UserCommand => command !== null);
  return commands.length === 0 ? "" : `${USER_COMMANDS_HEADER_PREFIX}${JSON.stringify(commands)}]`;
}
