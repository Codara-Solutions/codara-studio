import React, { useEffect, useId, useRef, useState } from "react";
import { unwrapIpcError } from "../../../lib/ipc-error";
import { emitLocalToast } from "../../../notifications/local-toast";

// "New agent" in Source Control: type a task, pick the agent and the branch to
// start from, and it runs in a new worktree through the same session start
// agents use, so it gets its own lane at once.

const RUNTIME_KEY = "codara.sourceControl.newAgentRuntime";
type Runtime = "claude" | "codex";
const RUNTIME_NAMES: Record<Runtime, string> = { claude: "Claude Code", codex: "Codex" };

function rememberedRuntime(): Runtime {
  try {
    return window.localStorage.getItem(RUNTIME_KEY) === "codex" ? "codex" : "claude";
  } catch {
    return "claude";
  }
}

export default function NewAgentDialog({
  workspaceId,
  cwd,
  defaultBase,
  onClose,
}: {
  workspaceId: string;
  cwd: string;
  defaultBase: string | null;
  onClose: () => void;
}): React.ReactElement {
  const titleId = useId();
  const taskRef = useRef<HTMLTextAreaElement | null>(null);
  const [task, setTask] = useState("");
  const [runtime, setRuntime] = useState<Runtime>(rememberedRuntime);
  const [worktree, setWorktree] = useState(true);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState(defaultBase ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    taskRef.current?.focus();
    let cancelled = false;
    void window.spark.git.branches(cwd).then(
      (list) => {
        if (cancelled) return;
        setBranches([...list.local, ...list.remote].map((branch) => branch.name));
        setBase((value) => value || (list.current ?? ""));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !starting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, starting]);

  const canStart = task.trim().length > 0 && !starting;
  const start = () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      window.localStorage.setItem(RUNTIME_KEY, runtime);
    } catch {
      // Storage can be unavailable; the choice just is not remembered.
    }
    window.spark.review
      .startAgent({
        brief: task.trim(),
        runtime,
        workspace: workspaceId,
        ...(worktree ? { worktree: { ...(base ? { base } : {}), purpose: task.trim().slice(0, 120) } } : {}),
      })
      .then((session) => {
        emitLocalToast(
          `${RUNTIME_NAMES[runtime]} started`,
          session.branch ? `It works on ${session.branch} in its own worktree.` : "It works in this checkout.",
        );
        onClose();
      })
      .catch((cause: unknown) => {
        setError(unwrapIpcError(cause));
        setStarting(false);
      });
  };

  return (
    <div
      className="lane-dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !starting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="spark-glass--strong spark-overlay-surface lane-dialog"
        data-testid="new-agent-dialog"
      >
        <div id={titleId} className="lane-dialog-title">
          New agent
        </div>
        <textarea
          ref={taskRef}
          className="lane-dialog-task"
          aria-label="Task"
          placeholder="What should it do?  (Ctrl+Enter to start)"
          value={task}
          spellCheck={false}
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              start();
            }
          }}
        />
        <div role="radiogroup" aria-label="Agent" className="lane-dialog-row">
          {(["claude", "codex"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={runtime === item}
              className={runtime === item ? "lane-action is-primary" : "lane-action"}
              onClick={() => setRuntime(item)}
            >
              {RUNTIME_NAMES[item]}
            </button>
          ))}
        </div>
        <label className="lane-dialog-row lane-dialog-check">
          <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />
          In a new worktree
        </label>
        {worktree ? (
          <label className="lane-dialog-row">
            <span className="lane-dialog-label">Start from</span>
            <select className="lane-dialog-select" value={base} onChange={(event) => setBase(event.target.value)}>
              {base && !branches.includes(base) ? <option value={base}>{base}</option> : null}
              {branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? (
          <div role="alert" className="lane-dialog-error">
            {error}
          </div>
        ) : null}
        <div className="lane-dialog-foot">
          <span className="lane-dialog-note">Spends that agent's usage.</span>
          <button type="button" className="lane-action" disabled={starting} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="lane-action is-primary"
            data-testid="new-agent-start"
            disabled={!canStart}
            onClick={start}
          >
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
