import { memo, useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { agentSnoozeWakeLabel, type AgentInboxRow as Row } from "@shared/agent-inbox";
import { CodaraMark, RuntimeMark } from "../BrandMarks";
import { WorkspaceIconGlyph } from "../workspace-icons";
import { agentBrandColor } from "../../lib/agent-brand";
import { usePullRequestDiff } from "./agentInboxActions";
import {
  CheckIcon,
  ClockIcon,
  DoneIcon,
  FailedIcon,
  InputIcon,
  PinIcon,
  WorkingIcon,
} from "./agentInboxIcons";

// One agent on the Agents tab, as T3 Code draws a thread: no box, three
// lines (where, what, branch and pull request) and a status word in the top
// right. On hover or focus the status slot gives way to Snooze and Settle.
// A settled agent is one greyed line. The row is a button that opens the
// agent; its actions are siblings, never nested inside it.

export type AgentInboxShelf = "inbox" | "working" | "snoozed" | "settled";

interface Props {
  row: Row;
  shelf: AgentInboxShelf;
  now: number;
  active: boolean;
  focusable: boolean;
  merging: boolean;
  renaming: boolean;
  onOpen: (row: Row) => void;
  onMenu: (row: Row, at: { x: number; y: number } | null) => void;
  onSnooze: (row: Row, anchor: HTMLElement) => void;
  onSettle: (row: Row) => void;
  onRestore: (row: Row) => void;
  onRename: (row: Row, name: string | null) => void;
  onFocusRow: (key: string) => void;
}

const STATUS_ICON = {
  input: InputIcon,
  failed: FailedIcon,
  done: DoneIcon,
  working: WorkingIcon,
} as const;

function StatusSlot({ row, shelf, now, merging }: { row: Row; shelf: AgentInboxShelf; now: number; merging: boolean }) {
  if (merging) {
    return (
      <span className="agent-inbox-row__status is-busy">
        <WorkingIcon />
        Merging…
      </span>
    );
  }
  if (shelf === "snoozed" && row.snoozedUntil !== null) {
    return (
      <span className="agent-inbox-row__status is-snoozed" title="Snoozed until">
        <ClockIcon />
        {agentSnoozeWakeLabel(row.snoozedUntil, now)}
      </span>
    );
  }
  if (shelf === "settled" || row.status === "age" || !row.statusWord) {
    return <span className="agent-inbox-row__age">{row.time}</span>;
  }
  const Icon = STATUS_ICON[row.status as keyof typeof STATUS_ICON];
  return (
    <span className={`agent-inbox-row__status is-${row.status}`}>
      <Icon />
      {row.statusWord}
      {row.status === "working" && row.time ? <span className="agent-inbox-row__timer">{row.time}</span> : null}
    </span>
  );
}

function AgentMark({ row }: { row: Row }) {
  if (!row.showAgent) return null;
  const runtime = row.card.runtime;
  return (
    <span
      className="agent-inbox-row__agent"
      role="img"
      aria-label={row.card.agentLabel}
      title={row.card.agentLabel}
      data-agent-runtime={runtime}
      style={{ color: runtime === "cora" ? "var(--ink-dim)" : agentBrandColor(runtime) }}
    >
      {runtime === "cora" ? <CodaraMark size={11} /> : <RuntimeMark runtime={runtime} size={11} />}
    </span>
  );
}

function PullRequestBits({ row, withDiff }: { row: Row; withDiff: boolean }) {
  const pr = row.pullRequest;
  const diff = usePullRequestDiff(row.card.workspaceId, pr, withDiff && row.showDiff);
  if (!pr) return null;
  const phase = pr.phase === "merged" || pr.phase === "closed" || pr.phase === "draft" ? pr.phase : null;
  const checks = pr.phase === "open" || pr.phase === "draft" ? pr.checks : "none";
  return (
    <>
      <span
        className="agent-inbox-row__pr"
        data-testid="agent-inbox-pr"
        data-phase={pr.phase}
        data-checks={pr.checks}
        title={`Pull request #${pr.number}${phase ? ` (${phase})` : ""}: ${pr.title}`}
      >
        #{pr.number}
        {phase && <span className="agent-inbox-row__pr-phase">{phase}</span>}
        {checks === "passing" && <span className="agent-inbox-row__check is-ok" aria-hidden>✓</span>}
        {checks === "failing" && <span className="agent-inbox-row__check is-bad" aria-hidden>✕</span>}
        {checks === "pending" && <span className="agent-inbox-row__check is-pending" aria-hidden />}
      </span>
      {diff && (
        <span className="agent-inbox-row__diff" aria-label={`${diff.additions} lines added, ${diff.deletions} removed`}>
          <span className="is-add">+{diff.additions}</span> <span className="is-del">−{diff.deletions}</span>
        </span>
      )}
    </>
  );
}

function RenameField({ row, onRename }: { row: Row; onRename: (row: Row, name: string | null) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onRename(row, value);
  };
  return (
    <input
      ref={ref}
      className="agent-inbox-row__rename"
      aria-label={`Name for ${row.title}`}
      defaultValue={row.title}
      maxLength={120}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

function spokenStatus(row: Row, shelf: AgentInboxShelf, now: number): string {
  if (shelf === "settled") return "settled";
  if (shelf === "snoozed" && row.snoozedUntil !== null) return `snoozed until ${agentSnoozeWakeLabel(row.snoozedUntil, now)}`;
  if (row.status === "working") return `working ${row.time}`;
  if (row.statusWord) return row.statusWord === "Input" ? "needs your input" : row.statusWord.toLowerCase();
  return row.time ? `${row.time} ago` : "";
}

function AgentInboxRowView({
  row,
  shelf,
  now,
  active,
  focusable,
  merging,
  renaming,
  onOpen,
  onMenu,
  onSnooze,
  onSettle,
  onRestore,
  onRename,
  onFocusRow,
}: Props) {
  const settled = shelf === "settled";
  const third = row.branch ?? row.card.tool ?? row.card.detail ?? row.card.message;
  const spoken = [
    row.title,
    spokenStatus(row, shelf, now),
    `${row.card.agentLabel} in ${row.card.workspaceName}`,
    row.pinned ? "pinned" : null,
    row.branch ? `branch ${row.branch}` : null,
    row.pullRequest ? `pull request ${row.pullRequest.number}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    // A keyboard's context menu key reports no pointer position.
    onMenu(row, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null);
  };
  // E settles the focused row, as in T3 Code; the menu key and Shift+F10
  // open the menu through onContextMenu.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.toLowerCase() !== "e" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (settled) onRestore(row);
    else onSettle(row);
  };
  const restoreLabel = settled ? "Un-settle" : "Wake";
  return (
    <li
      className={[
        "agent-inbox-row",
        `is-${shelf}`,
        active ? "is-active" : "",
        row.read ? "is-read" : "",
        merging ? "is-merging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-agent-card={row.key}
      data-agent-bucket={row.card.bucket}
      data-agent-shelf={shelf}
      data-agent-status={row.status}
      data-agent-workspace={row.card.workspaceId}
      onFocus={() => onFocusRow(row.key)}
    >
      <button
        type="button"
        className="agent-inbox-row__open"
        data-agent-card-open={row.key}
        tabIndex={focusable ? 0 : -1}
        aria-label={spoken}
        aria-current={active ? "true" : undefined}
        title={row.card.message ?? row.title}
        onClick={() => onOpen(row)}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        {settled ? (
          <span className="agent-inbox-row__line is-one">
            <span className="agent-inbox-row__tile" aria-hidden>
              <WorkspaceIconGlyph icon={row.card.workspaceIcon ?? undefined} size={10} />
            </span>
            <span className="agent-inbox-row__title">{row.title}</span>
            <PullRequestBits row={row} withDiff={false} />
            <StatusSlot row={row} shelf={shelf} now={now} merging={merging} />
          </span>
        ) : (
          <>
            <span className="agent-inbox-row__line is-where">
              <span className="agent-inbox-row__tile" aria-hidden>
                <WorkspaceIconGlyph icon={row.card.workspaceIcon ?? undefined} size={10} />
              </span>
              <span className="agent-inbox-row__ws">{row.card.workspaceName}</span>
              {row.pinned && (
                <span className="agent-inbox-row__pin" title="Pinned" aria-hidden>
                  <PinIcon size={10} />
                </span>
              )}
              <StatusSlot row={row} shelf={shelf} now={now} merging={merging} />
            </span>
            <span className="agent-inbox-row__line is-what">
              {renaming ? <span className="agent-inbox-row__title is-renaming" /> : <span className="agent-inbox-row__title">{row.title}</span>}
            </span>
            <span className="agent-inbox-row__line is-meta">
              <span className="agent-inbox-row__branch">{third ?? ""}</span>
              <PullRequestBits row={row} withDiff />
              <AgentMark row={row} />
            </span>
          </>
        )}
      </button>
      {renaming && (
        <div className="agent-inbox-row__rename-wrap">
          <RenameField row={row} onRename={onRename} />
        </div>
      )}
      {!merging && !renaming && (
        <span className="agent-inbox-row__actions">
          {shelf === "snoozed" || settled ? (
            <button
              type="button"
              className="agent-inbox-row__act is-word"
              tabIndex={-1}
              aria-label={`${restoreLabel} ${row.title}`}
              onClick={() => onRestore(row)}
            >
              {restoreLabel}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="agent-inbox-row__act"
                tabIndex={-1}
                title="Snooze"
                aria-label={`Snooze ${row.title}`}
                aria-haspopup="menu"
                onClick={(event) => onSnooze(row, event.currentTarget)}
              >
                <ClockIcon />
              </button>
              <button
                type="button"
                className="agent-inbox-row__act is-word"
                tabIndex={-1}
                aria-label={`Settle ${row.title}`}
                onClick={() => onSettle(row)}
              >
                <CheckIcon />
                Settle
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}

export default memo(AgentInboxRowView);
