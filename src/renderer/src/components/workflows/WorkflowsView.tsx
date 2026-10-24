import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState } from "@shared/types";
import type {
  SavedWorkflowSummary,
  WorkflowCheckResult,
  WorkflowRunStatus,
} from "@shared/workflow";
import WorkflowProgressTree from "./WorkflowProgressTree";

// The Workflows sub-tab of the Automations hub: the saved workflows of this
// workspace (project, the user's, built-in), a run form per workflow, and the
// workspace's workflow runs with their progress tree, Stop and Resume. Running
// from here is the user acting, so it shows the estimate but asks nothing.

export interface WorkflowsViewProps {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  visible: boolean;
  /** A run to select, set by a cross-surface jump; consumed once. */
  focusRunId?: string | null;
  onFocusConsumed?: () => void;
}

type Selection = { kind: "workflow"; id: string } | { kind: "run"; runId: string } | null;

const SOURCE_TITLE: Record<SavedWorkflowSummary["source"], string> = {
  project: "This project",
  user: "Yours",
  builtin: "Built-in",
};

const RUN_POLL_MS = 1_000;
const LIST_POLL_MS = 4_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
}

function stateBadge(state: string | undefined): string {
  if (state === "complete") return "spark-badge is-ok";
  if (state === "failed") return "spark-badge is-danger";
  if (state === "running") return "spark-badge is-accent";
  return "spark-badge is-warn";
}

function RunSheet({
  workflow,
  cwd,
  onStart,
}: {
  workflow: SavedWorkflowSummary;
  cwd: string;
  onStart: (input: { args: unknown; maxAgents?: number; concurrency?: number }) => Promise<void>;
}): React.ReactElement {
  const [argsText, setArgsText] = useState("{}");
  const [maxAgents, setMaxAgents] = useState<string>(String(workflow.meta?.caps?.maxAgents ?? ""));
  const [concurrency, setConcurrency] = useState<string>(String(workflow.meta?.caps?.concurrency ?? ""));
  const [check, setCheck] = useState<WorkflowCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setArgsText("{}");
    setMaxAgents(String(workflow.meta?.caps?.maxAgents ?? ""));
    setConcurrency(String(workflow.meta?.caps?.concurrency ?? ""));
    setCheck(null);
    setError(null);
  }, [workflow.id, workflow.meta?.caps?.maxAgents, workflow.meta?.caps?.concurrency]);

  const parsed = (): { args: unknown; caps: { maxAgents?: number; concurrency?: number } } | null => {
    let args: unknown;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch {
      setError("Args must be valid JSON.");
      return null;
    }
    const caps: { maxAgents?: number; concurrency?: number } = {};
    if (maxAgents.trim()) caps.maxAgents = Number(maxAgents);
    if (concurrency.trim()) caps.concurrency = Number(concurrency);
    return { args, caps };
  };

  const runCheck = async () => {
    const input = parsed();
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      setCheck(await window.spark.workflows.check({ workflow: workflow.id, args: input.args, caps: input.caps, cwd }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    const input = parsed();
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      await onStart({ args: input.args, ...input.caps });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const estimate = check?.estimate;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
        <span style={{ color: "var(--muted)" }}>Args (JSON)</span>
        <textarea
          data-testid="workflow-args"
          className="spark-mono"
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
          rows={4}
          spellCheck={false}
          style={{
            resize: "vertical",
            padding: 8,
            fontSize: 11,
            borderRadius: "var(--radius-control)",
            border: "1px solid var(--rule)",
            background: "var(--bg)",
            color: "var(--ink)",
          }}
        />
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11.5 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--muted)" }}>Max agents</span>
          <input
            value={maxAgents}
            onChange={(event) => setMaxAgents(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder="200"
            style={{ width: 64 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--muted)" }}>At once</span>
          <input
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder="4"
            style={{ width: 48 }}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="spark-btn" disabled={busy} onClick={() => void runCheck()}>
          Estimate
        </button>
        <button
          type="button"
          data-testid="workflow-run"
          className="spark-btn is-primary"
          disabled={busy || Boolean(workflow.error)}
          onClick={() => void run()}
        >
          Run
        </button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>
          {error}
        </div>
      )}
      {check && (
        <div style={{ fontSize: 11.5, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 3 }}>
          {check.errors.map((item, index) => (
            <span key={`e${index}`} style={{ color: "var(--danger)" }}>
              {item.line ? `line ${item.line}: ` : ""}
              {item.message}
            </span>
          ))}
          {estimate && (
            <>
              <span>
                About {estimate.agents}
                {estimate.unbounded ? "+" : ""} agents
                {estimate.phases.length > 0
                  ? ` (${estimate.phases.map((phase) => `${phase.title} ${phase.agents}`).join(", ")})`
                  : ""}
              </span>
              <span>
                Rough tokens {Math.round(estimate.tokens.low / 1000)}k to {Math.round(estimate.tokens.high / 1000)}k
                {estimate.isolated ? `, ${estimate.isolated} isolated` : ""}
                {estimate.heavy ? `, ${estimate.heavy} heavy` : ""}
              </span>
            </>
          )}
          {check.warnings.map((warning, index) => (
            <span key={`w${index}`}>{warning}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WorkflowsView({
  workspaceId,
  workspaceName,
  cwd,
  visible,
  focusRunId,
  onFocusConsumed,
}: WorkflowsViewProps): React.ReactElement {
  const [saved, setSaved] = useState<SavedWorkflowSummary[]>([]);
  const [runs, setRuns] = useState<RunState[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [status, setStatus] = useState<WorkflowRunStatus | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const selectionRef = useRef<Selection>(null);
  selectionRef.current = selection;

  const refreshLists = useCallback(async () => {
    try {
      const [list, runList] = await Promise.all([
        window.spark.workflows.list(cwd),
        window.spark.workflows.listRuns(workspaceId),
      ]);
      setSaved(list);
      setRuns(runList.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30));
    } catch {
      /* keep the last good lists */
    }
  }, [cwd, workspaceId]);

  useEffect(() => {
    if (!visible) return undefined;
    void refreshLists();
    const timer = window.setInterval(() => void refreshLists(), LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, refreshLists]);

  useEffect(() => {
    if (!focusRunId) return;
    setSelection({ kind: "run", runId: focusRunId });
    onFocusConsumed?.();
  }, [focusRunId, onFocusConsumed]);

  const selectedRunId = selection?.kind === "run" ? selection.runId : null;
  useEffect(() => {
    if (!selectedRunId || !visible) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await window.spark.workflows.status(selectedRunId);
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), RUN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRunId, visible]);

  const selectedWorkflow = useMemo(
    () => (selection?.kind === "workflow" ? saved.find((entry) => entry.id === selection.id) ?? null : null),
    [saved, selection],
  );

  useEffect(() => {
    setSource(null);
    if (!selectedWorkflow) return;
    let cancelled = false;
    void window.spark.workflows
      .get(selectedWorkflow.id, cwd)
      .then((full) => {
        if (!cancelled) setSource(full?.source_text ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedWorkflow, cwd]);

  const grouped = useMemo(() => {
    const groups: Array<[SavedWorkflowSummary["source"], SavedWorkflowSummary[]]> = [];
    for (const key of ["project", "user", "builtin"] as const) {
      const entries = saved.filter((entry) => entry.source === key);
      if (entries.length > 0) groups.push([key, entries]);
    }
    return groups;
  }, [saved]);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorText(err));
    }
    if (selectedRunId) {
      try {
        setStatus(await window.spark.workflows.status(selectedRunId));
      } catch {
        /* the poll catches up */
      }
    }
    void refreshLists();
  };

  const startRun = async (workflow: SavedWorkflowSummary, input: { args: unknown; maxAgents?: number; concurrency?: number }) => {
    const run = await window.spark.workflows.start({
      workspaceId,
      workspaceName,
      cwd,
      workflow: workflow.id,
      args: input.args,
      caps: {
        ...(input.maxAgents ? { maxAgents: input.maxAgents } : {}),
        ...(input.concurrency ? { concurrency: input.concurrency } : {}),
      },
    });
    setStatus(null);
    setSelection({ kind: "run", runId: run.id });
    void refreshLists();
  };

  const railItem = (key: string, active: boolean, onClick: () => void, children: React.ReactNode, testId?: string) => (
    <button
      key={key}
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{
        appearance: "none",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        width: "100%",
        padding: "6px 8px",
        border: "none",
        borderRadius: "var(--radius-control)",
        background: active ? "color-mix(in oklch, var(--accent) 12%, var(--panel))" : "transparent",
        color: "var(--ink)",
        textAlign: "left",
        cursor: "default",
      }}
    >
      {children}
    </button>
  );

  const runInfo = status?.workflow;
  return (
    <div data-testid="workflows-view" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
      <div
        style={{
          flex: "0 0 260px",
          minWidth: 0,
          overflowY: "auto",
          borderRight: "1px solid var(--rule)",
          padding: "10px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div>
          <div style={{ padding: "0 8px 4px", fontSize: 10.5, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase" }}>
            Runs
          </div>
          {runs.length === 0 && (
            <div style={{ padding: "2px 8px", fontSize: 11, color: "var(--muted-2)" }}>No workflow runs yet.</div>
          )}
          {runs.map((run) =>
            railItem(
              run.id,
              selectedRunId === run.id,
              () => {
                setStatus(null);
                setSelection({ kind: "run", runId: run.id });
              },
              <>
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.workflow?.name ?? run.title}
                  </span>
                  <span className={stateBadge(run.workflow?.state)}>{run.workflow?.state}</span>
                </span>
                <span className="spark-mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>
                  {new Date(run.createdAt).toLocaleString()}
                </span>
              </>,
              "workflow-run-row",
            ),
          )}
        </div>
        {grouped.map(([key, entries]) => (
          <div key={key}>
            <div style={{ padding: "0 8px 4px", fontSize: 10.5, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase" }}>
              {SOURCE_TITLE[key]}
            </div>
            {entries.map((entry) =>
              railItem(
                entry.id,
                selection?.kind === "workflow" && selection.id === entry.id,
                () => setSelection({ kind: "workflow", id: entry.id }),
                <>
                  <span style={{ fontSize: 11.5, color: entry.shadowed ? "var(--muted)" : "var(--ink)" }}>
                    {entry.name}
                    {entry.shadowed ? " (overridden)" : ""}
                  </span>
                  <span style={{ fontSize: 10.5, color: entry.error ? "var(--danger)" : "var(--muted-2)" }}>
                    {entry.error ?? entry.meta?.description}
                  </span>
                </>,
                "workflow-saved-row",
              ),
            )}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {actionError && (
          <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>
            {actionError}
          </div>
        )}
        {!selection && (
          <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--muted)", maxWidth: 560 }}>
            A workflow is a script that fans one job out to many Cora agents, in phases, with results checked
            against a schema. Pick a saved workflow to run it here, or ask Cora in a chat to write one for you.
          </div>
        )}
        {selectedWorkflow && (
          <>
            <div>
              <div style={{ fontSize: 15, fontWeight: 650 }}>{selectedWorkflow.name}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{selectedWorkflow.meta?.description}</div>
              {selectedWorkflow.meta?.whenToUse && (
                <div style={{ fontSize: 11.5, color: "var(--muted-2)", marginTop: 4 }}>
                  When to use: {selectedWorkflow.meta.whenToUse}
                </div>
              )}
            </div>
            {selectedWorkflow.meta?.phases && selectedWorkflow.meta.phases.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                Phases:{" "}
                {selectedWorkflow.meta.phases
                  .map((phase) => (phase.detail ? `${phase.title} (${phase.detail})` : phase.title))
                  .join(", ")}
              </div>
            )}
            <RunSheet workflow={selectedWorkflow} cwd={cwd} onStart={(input) => startRun(selectedWorkflow, input)} />
            {selectedWorkflow.source !== "builtin" && (
              <div>
                <button
                  type="button"
                  className="spark-btn is-danger"
                  style={{ height: 22, fontSize: 10.5 }}
                  onClick={() =>
                    void act(async () => {
                      await window.spark.workflows.remove(selectedWorkflow.id, cwd);
                      setSelection(null);
                    })
                  }
                >
                  Delete
                </button>
              </div>
            )}
            {source && (
              <pre
                className="spark-mono"
                style={{
                  margin: 0,
                  padding: "8px 10px",
                  fontSize: 10.5,
                  borderRadius: "var(--radius-control)",
                  border: "1px solid var(--rule)",
                  background: "var(--panel)",
                  overflow: "auto",
                  maxHeight: 360,
                }}
              >
                {source}
              </pre>
            )}
          </>
        )}
        {selectedRunId && !status && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Loading...</div>}
        {selectedRunId && status && runInfo && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 650 }}>{runInfo.name}</div>
                <div className="spark-mono" style={{ fontSize: 10, color: "var(--muted-2)" }}>
                  {status.runId}
                </div>
              </div>
              {runInfo.state === "running" && (
                <button
                  type="button"
                  data-testid="workflow-stop"
                  className="spark-btn"
                  onClick={() => void act(() => window.spark.workflows.stop(status.runId))}
                >
                  Stop
                </button>
              )}
              {(runInfo.state === "paused" || runInfo.state === "failed") && (
                <button
                  type="button"
                  data-testid="workflow-resume"
                  className="spark-btn is-primary"
                  onClick={() => void act(() => window.spark.workflows.resume(status.runId))}
                >
                  Resume
                </button>
              )}
              {(runInfo.state === "running" || runInfo.state === "paused") && (
                <button
                  type="button"
                  className="spark-btn is-danger"
                  onClick={() => void act(() => window.spark.workflows.cancel(status.runId))}
                >
                  Cancel
                </button>
              )}
            </div>
            <WorkflowProgressTree
              status={status}
              onSkip={(seq) => void act(() => window.spark.workflows.skip(status.runId, seq))}
            />
          </>
        )}
      </div>
    </div>
  );
}
