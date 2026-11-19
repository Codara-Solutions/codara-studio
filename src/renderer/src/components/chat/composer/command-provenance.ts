// Only a slash command the user typed in the composer may run a skill
// (src/shared/user-commands.ts). Text can also land in the composer from
// elsewhere: Unqueue restores a queued message an agent may have sent, Undo
// restores an earlier one, and the whiteboard and a worker's view hand over
// text a model wrote. A command that arrived that way stays text when it is
// sent unchanged; the user has to retype it (or remove and type it again)
// for it to count as theirs.
//
// Pure, so the unit suite can drive it (scripts/test-composer-command-provenance.cjs).

import { userCommandOf } from "@shared/user-commands";

const firstLine = (text: string): string => text.trim().split("\n", 1)[0]?.trim() ?? "";

/** The prefilled command after text was put into the composer by another
 *  surface: the command now opening the draft when that text changed the
 *  draft's first line, else what was recorded before. */
export function prefilledCommandAfter(
  previousDraft: string,
  nextDraft: string,
  recorded: string | null,
): string | null {
  if (firstLine(previousDraft) === firstLine(nextDraft)) return recorded;
  return userCommandOf(nextDraft)?.name ?? null;
}

/** After the user edits the draft: the record holds only while the draft
 *  still opens with that same command. */
export function prefilledCommandAfterEdit(recorded: string | null, nextDraft: string): string | null {
  if (!recorded) return null;
  return userCommandOf(nextDraft)?.name === recorded ? recorded : null;
}

/** Whether a sent message may count as typed by the user: not when it opens
 *  with a command that came from another surface unchanged. */
export function sentAsTyped(recorded: string | null, message: string): boolean {
  return !(recorded && userCommandOf(message)?.name === recorded);
}
