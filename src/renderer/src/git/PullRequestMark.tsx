import type { PullRequestWatchEntry } from "@shared/pull-request-watch";

// A workspace's pull request in a rail row: its number, its phase when it is
// not plainly open, and its checks as one glyph. It is not a button: a click
// on the row always opens the row, and the details are in the tooltip.

const CHECK_WORDS = { failing: "failing", passing: "passing", pending: "running", none: "not reported" } as const;

export function pullRequestDescription(entry: Extract<PullRequestWatchEntry, { watching: true }>): string {
  const pr = entry.pullRequest;
  const phase = pr.phase === "open" ? "" : ` (${pr.phase})`;
  const checks =
    pr.phase === "open" || pr.phase === "draft"
      ? ` Checks ${CHECK_WORDS[pr.checks]}${pr.failed.length ? `: ${pr.failed.join(", ")}` : ""}.`
      : "";
  return `Pull request #${pr.number}${phase}: ${pr.title}.${checks}`;
}

export function PullRequestMark({ entry, hideMerged = false }: { entry: PullRequestWatchEntry | null; hideMerged?: boolean }) {
  if (!entry?.watching) return null;
  const pr = entry.pullRequest;
  const description = pullRequestDescription(entry);
  const phaseWord = pr.phase === "draft" || pr.phase === "closed" || (pr.phase === "merged" && !hideMerged) ? pr.phase : null;
  return (
    <span
      data-testid="workspace-pull-request"
      data-phase={pr.phase}
      data-checks={pr.checks}
      title={description}
      aria-label={description}
      style={{ marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 3, verticalAlign: "0px", fontVariantNumeric: "tabular-nums" }}
    >
      <span>#{pr.number}</span>
      {phaseWord && <span>{phaseWord}</span>}
      {pr.checks === "failing" && <span aria-hidden="true" style={{ color: "var(--danger)", fontWeight: 700 }}>✕</span>}
      {pr.checks === "passing" && <span aria-hidden="true" style={{ color: "var(--ok)", fontWeight: 700 }}>✓</span>}
      {pr.checks === "pending" && (
        <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: "var(--warn)", display: "inline-block" }} />
      )}
    </span>
  );
}
