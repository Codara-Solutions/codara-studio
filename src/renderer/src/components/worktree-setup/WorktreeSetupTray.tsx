import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  isWorktreeSetupFinished,
  isWorktreeSetupStartError,
  terminalsWithCommands,
  type WorktreeSetupStatus,
} from "@shared/worktree-setup";
import { emitLocalToast } from "../../notifications/local-toast";
import { setupName, setupStateLabel } from "./labels";
import "./worktree-setup.css";

const WorktreeSetupLogDialog = lazy(() => import("./WorktreeSetupLogDialog"));

// A small floating list of the worktree setups of this session: the ones
// still running, and the ones that failed or were stopped until dismissed.
// A finished one shows "Ready" for a moment and leaves. Every setup Codara
// starts lands here, whoever made the worktree (you, an agent, an issue or a
// Cora worker), and a failure also raises a toast. A repository command that
// is new or changed for its repository waits here, with the exact command,
// until the user runs it, allows it for good or declines it; main raises
// the notification for that.

const READY_LINGER_MS = 4_000;

export default function WorktreeSetupTray(): React.ReactElement | null {
  const [statuses, setStatuses] = useState<WorktreeSetupStatus[]>([]);
  const [logId, setLogId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const toasted = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());

  const forget = useCallback((id: string) => {
    setStatuses((current) => current.filter((status) => status.id !== id));
  }, []);

  const upsert = useCallback(
    (status: WorktreeSetupStatus) => {
      setStatuses((current) => {
        const rest = current.filter((item) => item.id !== status.id);
        return [status, ...rest].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      });
      const pending = timers.current.get(status.id);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        timers.current.delete(status.id);
      }
      if (status.state === "succeeded") {
        timers.current.set(
          status.id,
          window.setTimeout(() => {
            timers.current.delete(status.id);
            forget(status.id);
            void window.spark.worktreeSetup.dismiss(status.id).catch(() => undefined);
          }, READY_LINGER_MS),
        );
      }
      const key = `${status.id}:${status.startedAt}`;
      if (status.state === "failed" && !toasted.current.has(key)) {
        toasted.current.add(key);
        emitLocalToast(
          "Worktree setup failed",
          `${setupName(status)}: ${status.error ?? "see its log"}`,
          "danger",
          status.workspaceId ? { type: "workspace", workspaceId: status.workspaceId } : undefined,
        );
      }
    },
    [forget],
  );

  useEffect(() => {
    let cancelled = false;
    void window.spark.worktreeSetup
      .list()
      .then((list) => {
        if (cancelled) return;
        // Only what is still worth seeing after a reload.
        for (const status of list) if (status.state !== "succeeded") upsert(status);
      })
      .catch(() => undefined);
    const off = window.spark.worktreeSetup.onChanged(upsert);
    const pending = timers.current;
    return () => {
      cancelled = true;
      off();
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, [upsert]);

  const act = useCallback(async (id: string, action: () => Promise<unknown>) => {
    setBusyIds((current) => new Set(current).add(id));
    try {
      await action();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      forget(id);
      void window.spark.worktreeSetup.dismiss(id).catch(() => undefined);
    },
    [forget],
  );

  const visible = statuses;
  return (
    <>
      {visible.length > 0 ? (
        <section className="spark-glass wts-tray" aria-label="Worktree setup" data-testid="worktree-setup-tray">
          {visible.map((status) => {
            const finished = isWorktreeSetupFinished(status.state);
            const busy = busyIds.has(status.id);
            return (
              <div key={status.id} className="wts-tray__row" data-state={status.state}>
                <span className="wts-mark" data-state={status.state} aria-hidden />
                <div className="wts-tray__text">
                  <span className="wts-tray__name" title={status.worktreePath}>
                    {setupName(status)}
                  </span>
                  <span className="wts-tray__label" aria-live="polite" title={setupStateLabel(status)}>
                    {setupStateLabel(status)}
                  </span>
                </div>
                <div className="wts-tray__actions">
                  <button type="button" className="spark-btn" onClick={() => setLogId(status.id)}>
                    Log
                  </button>
                  {!finished && status.state !== "awaiting-approval" ? (
                    <button
                      type="button"
                      className="spark-btn"
                      disabled={busy}
                      onClick={() => void act(status.id, () => window.spark.worktreeSetup.stop(status.id))}
                    >
                      Stop
                    </button>
                  ) : null}
                  {status.state === "failed" || status.state === "stopped" ? (
                    <>
                      <button
                        type="button"
                        className="spark-btn"
                        disabled={busy}
                        onClick={() =>
                          void act(status.id, async () => {
                            const reply = await window.spark.worktreeSetup.rerun(status.id);
                            if (reply && !isWorktreeSetupStartError(reply) && reply.id !== status.id) forget(status.id);
                            if (reply && isWorktreeSetupStartError(reply)) {
                              emitLocalToast("Could not run setup again", reply.error, "danger");
                            }
                          })
                        }
                      >
                        Run again
                      </button>
                      <button
                        type="button"
                        className="spark-btn"
                        aria-label={`Dismiss setup of ${setupName(status)}`}
                        onClick={() => dismiss(status.id)}
                      >
                        Dismiss
                      </button>
                    </>
                  ) : null}
                </div>
                {status.state === "awaiting-approval" && status.approval ? (
                  <ApprovalBanner
                    status={status}
                    busy={busy}
                    onRun={(always) =>
                      void act(status.id, async () => {
                        const reply = await window.spark.worktreeSetup.approve(
                          status.id,
                          status.approval?.fingerprint ?? "",
                          always,
                        );
                        if (isWorktreeSetupStartError(reply)) {
                          emitLocalToast("Setup did not run", reply.error, "danger");
                        }
                      })
                    }
                    onDecline={() => void act(status.id, () => window.spark.worktreeSetup.stop(status.id))}
                  />
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
      {logId ? (
        <Suspense fallback={null}>
          <WorktreeSetupLogDialog setupId={logId} onClose={() => setLogId(null)} />
        </Suspense>
      ) : null}
    </>
  );
}

function ApprovalBanner({
  status,
  busy,
  onRun,
  onDecline,
}: {
  status: WorktreeSetupStatus;
  busy: boolean;
  onRun: (always: boolean) => void;
  onDecline: () => void;
}): React.ReactElement {
  const command = status.commands.find((entry) => entry.kind === "repo")?.command ?? "";
  const terminals = terminalsWithCommands(status.terminals);
  const repoName = status.approval?.repoName ?? "this repository";
  const several = terminals.length > 0;
  const what = command && several ? "setup and terminal commands" : command ? "setup command" : "terminal commands";
  return (
    <div className="wts-approval" role="group" aria-label={`Approve the setup commands of ${setupName(status)}`} data-testid="worktree-setup-approval">
      <div className="wts-approval__text">
        The {what} from <code>.codara/worktree.json</code> {several ? "are" : "is"} new or changed for {repoName}, so
        nothing has run. Run {several ? "them" : "it"} only if you trust {several ? "them" : "it"}.
      </div>
      {command ? (
        <pre className="wts-approval__command" tabIndex={0} aria-label="Setup command">
          {command}
        </pre>
      ) : null}
      {terminals.length ? (
        <ul className="wts-approval__terminals" aria-label="Terminal commands" data-testid="worktree-setup-approval-terminals">
          {terminals.map((terminal, index) => (
            <li key={`${index}:${terminal.name}`}>
              <span className="wts-approval__terminal-name">Terminal {terminal.name}</span>
              <pre className="wts-approval__command" tabIndex={0} aria-label={`Command of terminal ${terminal.name}`}>
                {terminal.command}
              </pre>
            </li>
          ))}
        </ul>
      ) : null}
      {several && status.trigger === "ui" ? (
        <div className="wts-approval__text">Its terminals then open as plain shells, without their commands.</div>
      ) : null}
      <div className="wts-approval__actions">
        <button type="button" className="spark-btn is-primary" disabled={busy} onClick={() => onRun(false)}>
          Run setup
        </button>
        <button type="button" className="spark-btn" disabled={busy} onClick={() => onRun(true)}>
          Always allow {several ? "these commands" : "this command"} for {repoName}
        </button>
        <button type="button" className="spark-btn" disabled={busy} onClick={onDecline}>
          Don&apos;t run
        </button>
      </div>
    </div>
  );
}
