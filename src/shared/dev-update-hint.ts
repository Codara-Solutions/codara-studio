// A dev build (`npm run dev` from a checkout) has no auto-updater: merged
// fixes reach it only when the user pulls and restarts. The status bar says
// when the folder the app runs from is behind its upstream, or was updated
// after the app started. It never pulls or restarts by itself: new main,
// preload or shared code under a running window breaks it, so an update
// lands at a restart. Never shown in a packaged build.

/** What main read about the folder the app runs from. */
export interface DevUpdateFacts {
  /** A packaged build: it has the auto-updater, and nothing is shown. */
  packaged: boolean;
  appDir: string;
  /** The upstream's branch name without its remote ("main"); null when there is none. */
  upstreamBranch: string | null;
  /** Commits in the upstream that HEAD lacks; null when git could not say. */
  behind: number | null;
  /** HEAD when the main process started, and now. */
  headAtStart: string | null;
  headNow: string | null;
  /** Subjects of the newest commits it lacks, newest first. */
  missing: readonly string[];
}

export interface DevUpdateHint {
  kind: "behind" | "restart";
  /** The status bar's one line. */
  text: string;
  /** The tooltip: what to run, and what is missing. */
  detail: string;
}

export const DEV_UPDATE_MISSING_SHOWN = 5;

/** The folder as a shell argument, quoted only when it needs it. */
export function shellPath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The status bar's dev update line, or null when there is nothing to say. */
export function devUpdateHint(facts: DevUpdateFacts): DevUpdateHint | null {
  if (facts.packaged || !facts.appDir || !facts.headNow || !facts.upstreamBranch) return null;
  const behind = facts.behind ?? 0;
  if (behind > 0) {
    const missing = facts.missing.slice(0, DEV_UPDATE_MISSING_SHOWN);
    const more = behind - missing.length;
    return {
      kind: "behind",
      text: `Studio is ${behind} change${behind === 1 ? "" : "s"} behind ${facts.upstreamBranch} · restart to update`,
      detail: [
        `Update with: git -C ${shellPath(facts.appDir)} pull --ff-only`,
        "Then restart Studio. It never updates itself: new main-process code under a running window breaks it.",
        ...(missing.length ? ["", "Missing, newest first:", ...missing.map((subject) => `• ${subject}`)] : []),
        ...(missing.length && more > 0 ? [`and ${more} more`] : []),
      ].join("\n"),
    };
  }
  if (facts.headAtStart && facts.headAtStart !== facts.headNow) {
    return {
      kind: "restart",
      text: "Restart to load the update",
      detail: `${shellPath(facts.appDir)} moved from ${facts.headAtStart.slice(0, 8)} to ${facts.headNow.slice(0, 8)} after Studio started. Restart Studio to run it.`,
    };
  }
  return null;
}
