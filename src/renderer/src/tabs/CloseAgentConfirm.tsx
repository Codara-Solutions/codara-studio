import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { keyBelongsToOtherModal } from "../shortcuts/modal-keys";
import { closeConfirmText, closingAgents, type CloseConfirmText, type CloseTarget } from "./closeConfirm";
import type { Tab } from "./types";
import "./close-agent-confirm.css";

// The question before a user's own close gesture stops a working agent
// (DESIGN.md, "Closing a working agent"). Only user gestures call
// confirmUserClose: closes from agents (codara_tab, codara_terminal_close),
// worktree removal, a clean shell exit and quit go straight to useTabs.

interface Pending {
  text: CloseConfirmText;
  close: () => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
let workingPaneIds: () => Readonly<Record<string, true>> | undefined = () => undefined;

function publish(next: Pending | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** Main's working flags for every pane, the rail's fallback when a pane has no chip state yet. */
export function setCloseConfirmWorkingPanes(read: () => Readonly<Record<string, true>> | undefined): void {
  workingPaneIds = read;
}

/** Runs close now, or once the user confirms when it would stop a working agent. */
export function confirmUserClose(tabs: readonly Tab[], targets: readonly CloseTarget[], close: () => void): void {
  if (pending) return;
  const text = closeConfirmText(closingAgents(tabs, targets, workingPaneIds()));
  if (!text) {
    close();
    return;
  }
  publish({ text, close });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function CloseAgentConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => pending);
  if (!current) return null;
  return <CloseAgentConfirm key={current.text.title} pending={current} />;
}

function CloseAgentConfirm({ pending: request }: { pending: Pending }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);
  const cancelRef = useRef(() => {
    publish(null);
    const target = returnFocus.current;
    if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
  });

  useEffect(() => {
    const cancel = () => cancelRef.current();
    // Capture, so Escape closes only this and no handler behind it. Tab stays
    // on the two buttons.
    const onKey = (event: KeyboardEvent) => {
      if (keyBelongsToOtherModal(event, dialogRef.current)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = [...(dialogRef.current?.querySelectorAll("button") ?? [])];
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
      event.preventDefault();
      event.stopPropagation();
      next.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const { title, text, items } = request.text;
  return createPortal(
    <div
      className="close-agent-confirm-scrim"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        cancelRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby="close-agent-confirm-text"
        data-testid="close-agent-confirm"
        className="close-agent-confirm"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="close-agent-confirm-title">{title}</span>
        <span id="close-agent-confirm-text" className="close-agent-confirm-text">{text}</span>
        {items.length > 0 && (
          <ul className="close-agent-confirm-list">
            {items.map((item, index) => (
              <li key={`${index}:${item}`}>{item}</li>
            ))}
          </ul>
        )}
        <div className="close-agent-confirm-buttons">
          <button type="button" autoFocus className="spark-btn" onClick={() => cancelRef.current()}>
            Cancel
          </button>
          <button
            type="button"
            className="spark-btn is-danger"
            onClick={() => {
              publish(null);
              request.close();
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
