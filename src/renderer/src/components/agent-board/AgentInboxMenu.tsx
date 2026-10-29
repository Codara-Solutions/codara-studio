import { useMemo } from "react";
import type { ReactNode, RefObject } from "react";
import { agentSnoozePresets, type AgentInboxRow } from "@shared/agent-inbox";
import AnchoredMenu from "../chat/composer/AnchoredMenu";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  MergeIcon,
  OpenIcon,
  PinIcon,
  RenameIcon,
  TrashIcon,
  UnreadIcon,
} from "./agentInboxIcons";

// The Agents tab's right-click menu: T3 Code's thread menu, trimmed to Open,
// Merge PR (ours, only while the pull request is ready), Settle, Snooze ›,
// Pin, Rename, Mark unread, Copy link and Delete. Snooze's times and
// Delete's confirmation replace the list in place, so the menu never opens a
// second floating panel.

export type AgentInboxMenuView = "main" | "snooze" | "delete";

export interface AgentInboxMenuActions {
  open: (row: AgentInboxRow) => void;
  merge: (row: AgentInboxRow) => void;
  settle: (row: AgentInboxRow) => void;
  restore: (row: AgentInboxRow) => void;
  snooze: (row: AgentInboxRow, until: number) => void;
  pin: (row: AgentInboxRow, pinned: boolean) => void;
  rename: (row: AgentInboxRow) => void;
  unread: (row: AgentInboxRow, unread: boolean) => void;
  copyLink: (row: AgentInboxRow) => void;
  remove: (row: AgentInboxRow) => void;
}

interface Props {
  row: AgentInboxRow | null;
  /** Where the menu opens: the right-click point or the clicked control. */
  anchorRef: RefObject<HTMLElement | null>;
  view: AgentInboxMenuView;
  onView: (view: AgentInboxMenuView) => void;
  settled: boolean;
  snoozed: boolean;
  unread: boolean;
  onClose: () => void;
  /** When this menu was opened; the snooze times are read from it. */
  openedAt: number;
  actions: AgentInboxMenuActions;
}

function Item({
  icon,
  label,
  hint,
  danger,
  onSelect,
}: {
  icon?: ReactNode;
  label: string;
  hint?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`spark-menu-item agent-inbox-menu__item${danger ? " is-danger" : ""}`}
      onClick={onSelect}
    >
      <span className="agent-inbox-menu__icon" aria-hidden>
        {icon}
      </span>
      <span className="agent-inbox-menu__label">{label}</span>
      {hint ? <span className="agent-inbox-menu__hint">{hint}</span> : null}
    </button>
  );
}

const Separator = () => <div className="agent-inbox-menu__sep" role="separator" />;

export default function AgentInboxMenu({
  row,
  anchorRef,
  view,
  onView,
  settled,
  snoozed,
  unread,
  onClose,
  openedAt,
  actions,
}: Props) {
  // Read when the menu opens, so "this evening" goes once it has passed.
  const presets = useMemo(() => agentSnoozePresets(openedAt), [openedAt]);
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  let body: ReactNode = null;
  if (row && view === "snooze") {
    body = (
      <>
        <Item icon={<ChevronLeftIcon />} label="Snooze" onSelect={() => onView("main")} />
        <Separator />
        {presets.map((preset) => (
          <Item
            key={preset.id}
            label={preset.label}
            hint={preset.when}
            onSelect={run(() => actions.snooze(row, preset.until))}
          />
        ))}
      </>
    );
  } else if (row && view === "delete") {
    const terminal = row.card.source === "terminal";
    body = (
      <div className="agent-inbox-menu__confirm">
        <p className="agent-inbox-menu__question">
          {terminal
            ? `Close ${row.card.agentLabel}'s terminal in ${row.card.workspaceName}? The agent stops.`
            : `Delete the chat “${row.title}”? This cannot be undone.`}
        </p>
        <Item label="Cancel" onSelect={() => onView("main")} />
        <Item icon={<TrashIcon />} label={terminal ? "Close terminal" : "Delete chat"} danger onSelect={run(() => actions.remove(row))} />
      </div>
    );
  } else if (row) {
    const pr = row.pullRequest;
    body = (
      <>
        <Item icon={<OpenIcon />} label="Open" onSelect={run(() => actions.open(row))} />
        {row.mergeReady && pr ? (
          <Item icon={<MergeIcon />} label={`Merge PR #${pr.number}`} onSelect={run(() => actions.merge(row))} />
        ) : null}
        <Separator />
        {settled ? (
          <Item icon={<CheckIcon />} label="Un-settle" hint="E" onSelect={run(() => actions.restore(row))} />
        ) : (
          <Item icon={<CheckIcon />} label="Settle" hint="E" onSelect={run(() => actions.settle(row))} />
        )}
        {snoozed ? (
          <Item icon={<ClockIcon />} label="Wake" onSelect={run(() => actions.restore(row))} />
        ) : (
          <Item icon={<ClockIcon />} label="Snooze" hint={<ChevronRightIcon />} onSelect={() => onView("snooze")} />
        )}
        <Item icon={<PinIcon />} label={row.pinned ? "Unpin" : "Pin"} onSelect={run(() => actions.pin(row, !row.pinned))} />
        <Separator />
        <Item icon={<RenameIcon />} label="Rename" onSelect={run(() => actions.rename(row))} />
        <Item
          icon={<UnreadIcon />}
          label={unread ? "Mark read" : "Mark unread"}
          onSelect={run(() => actions.unread(row, !unread))}
        />
        {pr ? <Item icon={<CopyIcon />} label="Copy link" onSelect={run(() => actions.copyLink(row))} /> : null}
        <Separator />
        <Item icon={<TrashIcon />} label="Delete" danger onSelect={() => onView("delete")} />
      </>
    );
  }
  return (
    <AnchoredMenu
      anchorRef={anchorRef}
      open={row !== null}
      onClose={onClose}
      className="spark-menu agent-inbox-menu"
      role="menu"
      ariaLabel={row ? `Actions for ${row.title}` : "Agent actions"}
      placement="below"
      align="start"
      menuItems
      focusSignal={view}
    >
      {body}
    </AnchoredMenu>
  );
}
