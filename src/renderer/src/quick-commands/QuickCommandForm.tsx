import React, { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { makeId } from "@shared/ids";
import {
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TEXT_LENGTH,
  QUICK_COMMAND_AGENTS,
  sameRepoKey,
  type QuickCommand,
  type QuickCommandAgent,
  type QuickCommandPromptTarget,
  type QuickCommandScope,
  type QuickCommandShellTarget,
} from "@shared/quick-commands";
import { runtimeLabel } from "../routing/agent-destinations";
import { IS_MAC } from "../shortcuts/platform";
import { Switch } from "../components/settings/SettingsPrimitives";
import type { QuickCommandRepoOption } from "./QuickCommandsContext";

// The fields of one quick command, used inline on the Settings page and in
// the dialog the tab strip, the terminal menu and the palette open. The two
// kinds keep their own text, so switching between them never loses what was
// typed. Mod+Enter saves, as in the other forms.

export function newQuickCommandDraft(scope: QuickCommandScope = { type: "global" }): QuickCommand {
  return { id: makeId("qc"), label: "", kind: "shell", command: "", target: "focused", submit: true, scope };
}

interface Draft {
  label: string;
  kind: QuickCommand["kind"];
  command: string;
  prompt: string;
  shellTarget: QuickCommandShellTarget;
  promptTarget: QuickCommandPromptTarget;
  agent: QuickCommandAgent;
  shellSubmit: boolean;
  promptSubmit: boolean;
  scope: string;
}

const GLOBAL_SCOPE = "";

function toDraft(command: QuickCommand): Draft {
  return {
    label: command.label,
    kind: command.kind,
    command: command.kind === "shell" ? command.command : "",
    prompt: command.kind === "prompt" ? command.prompt : "",
    shellTarget: command.kind === "shell" ? command.target : "focused",
    promptTarget: command.kind === "prompt" ? command.target : "focused",
    agent: command.kind === "prompt" ? command.agent : "claude",
    shellSubmit: command.kind === "shell" ? command.submit : true,
    promptSubmit: command.kind === "prompt" ? command.submit : true,
    scope: command.scope.type === "repo" ? command.scope.repo : GLOBAL_SCOPE,
  };
}

function fromDraft(id: string, draft: Draft): QuickCommand {
  const scope: QuickCommandScope = draft.scope ? { type: "repo", repo: draft.scope } : { type: "global" };
  const label = draft.label.trim();
  if (draft.kind === "prompt") {
    return { id, label, scope, kind: "prompt", prompt: draft.prompt.trimEnd(), target: draft.promptTarget, agent: draft.agent, submit: draft.promptSubmit };
  }
  return { id, label, scope, kind: "shell", command: draft.command.trimEnd(), target: draft.shellTarget, submit: draft.shellSubmit };
}

function Segments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="spark-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={`spark-segmented-item${option.value === value ? " is-selected" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 600,
};

const fieldHint: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

const textArea: React.CSSProperties = {
  height: "auto",
  minHeight: 84,
  padding: "8px 10px",
  lineHeight: 1.45,
  resize: "vertical",
};

export interface QuickCommandFormProps {
  initial: QuickCommand;
  mode: "add" | "edit";
  repoOptions: readonly QuickCommandRepoOption[];
  onSave: (command: QuickCommand) => void;
  onCancel: () => void;
  onDelete?: () => void;
  /** Delete takes a second press, for a place with no Undo. */
  confirmDelete?: boolean;
}

export default function QuickCommandForm({ initial, mode, repoOptions, onSave, onCancel, onDelete, confirmDelete }: QuickCommandFormProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [deleteArmed, setDeleteArmed] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const ids = useId();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  useLayoutEffect(() => {
    nameRef.current?.focus();
  }, []);

  // A repository the command was scoped to stays pickable even when none of
  // its workspaces is open.
  const scopes = useMemo(() => {
    const out = [...repoOptions];
    if (draft.scope && !out.some((option) => sameRepoKey(option.key, draft.scope))) {
      out.push({ key: draft.scope, label: draft.scope });
    }
    return out;
  }, [draft.scope, repoOptions]);

  const body = draft.kind === "prompt" ? draft.prompt : draft.command;
  const canSave = draft.label.trim().length > 0 && body.trim().length > 0;
  const save = () => {
    if (canSave) onSave(fromDraft(initial.id, draft));
  };

  return (
    <form
      aria-label={mode === "add" ? "New quick command" : `Edit ${initial.label}`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (IS_MAC ? event.metaKey : event.ctrlKey)) {
          event.preventDefault();
          save();
        } else if (event.key === "Escape" && !event.defaultPrevented) {
          // Escape cancels this edit only; Settings around it stays open.
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      style={{ display: "grid", gap: 14 }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <label htmlFor={`${ids}-name`} style={fieldLabel}>Name</label>
        <input
          id={`${ids}-name`}
          ref={nameRef}
          className="spark-input"
          value={draft.label}
          maxLength={MAX_QUICK_COMMAND_LABEL_LENGTH}
          placeholder="For example Run tests"
          spellCheck={false}
          onChange={(event) => set("label", event.currentTarget.value)}
        />
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <span style={fieldLabel}>Type</span>
        <div>
          <Segments
            label="Type"
            value={draft.kind}
            options={[
              { value: "shell", label: "Shell command" },
              { value: "prompt", label: "Agent prompt" },
            ]}
            onChange={(kind) => set("kind", kind)}
          />
        </div>
      </div>

      {draft.kind === "shell" ? (
        <>
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${ids}-command`} style={fieldLabel}>Command</label>
            <textarea
              id={`${ids}-command`}
              className="spark-input spark-mono"
              style={textArea}
              value={draft.command}
              maxLength={MAX_QUICK_COMMAND_TEXT_LENGTH}
              placeholder="npm test"
              spellCheck={false}
              onChange={(event) => set("command", event.currentTarget.value)}
            />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabel}>Run in</span>
            <div>
              <Segments
                label="Run in"
                value={draft.shellTarget}
                options={[
                  { value: "focused", label: "Focused terminal" },
                  { value: "new", label: "New terminal" },
                ]}
                onChange={(target) => set("shellTarget", target)}
              />
            </div>
            <span style={fieldHint}>
              {draft.shellTarget === "new"
                ? "Opens a terminal tab in the workspace folder and runs it there."
                : draft.shellSubmit
                  ? "Types it into the terminal you were last in. If an agent or another full-screen program runs there, it runs in a new terminal instead."
                  : "Types it into the terminal you were last in for you to finish. If an agent or another full-screen program runs there, nothing is typed."}
            </span>
          </div>
          {draft.shellTarget === "focused" ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "grid", gap: 2 }}>
                <span style={fieldLabel}>Press Enter</span>
                <span style={fieldHint}>Off types the command and leaves it for you to edit.</span>
              </span>
              <Switch checked={draft.shellSubmit} onChange={(next) => set("shellSubmit", next)} ariaLabel="Press Enter" />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${ids}-prompt`} style={fieldLabel}>Prompt</label>
            <textarea
              id={`${ids}-prompt`}
              className="spark-input"
              style={textArea}
              value={draft.prompt}
              maxLength={MAX_QUICK_COMMAND_TEXT_LENGTH}
              placeholder="Review the changes on this branch and list anything risky."
              onChange={(event) => set("prompt", event.currentTarget.value)}
            />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <span style={fieldLabel}>Send to</span>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Segments
                label="Send to"
                value={draft.promptTarget}
                options={[
                  { value: "focused", label: "Focused agent" },
                  { value: "cora", label: "Cora" },
                  { value: "new", label: "New agent" },
                ]}
                onChange={(target) => set("promptTarget", target)}
              />
              {draft.promptTarget === "new" ? (
                <select
                  aria-label="Agent"
                  className="spark-select"
                  style={{ width: "auto" }}
                  value={draft.agent}
                  onChange={(event) => set("agent", event.currentTarget.value as QuickCommandAgent)}
                >
                  {QUICK_COMMAND_AGENTS.map((agent) => (
                    <option key={agent} value={agent}>{runtimeLabel(agent)}</option>
                  ))}
                </select>
              ) : null}
            </div>
            <span style={fieldHint}>
              {draft.promptTarget === "cora"
                ? "Goes to the Cora chat open in this workspace, or starts a new chat."
                : draft.promptTarget === "new"
                  ? "Opens a terminal with this agent and sends the prompt once it is ready."
                  : "Goes to the agent in the terminal you were last in: Claude Code, Codex, Grok or Pi."}
            </span>
          </div>
          {draft.promptTarget !== "cora" ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "grid", gap: 2 }}>
                <span style={fieldLabel}>Send right away</span>
                <span style={fieldHint}>Off leaves the prompt in the agent's input for you to edit.</span>
              </span>
              <Switch checked={draft.promptSubmit} onChange={(next) => set("promptSubmit", next)} ariaLabel="Send right away" />
            </div>
          ) : null}
        </>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        <label htmlFor={`${ids}-scope`} style={fieldLabel}>Available in</label>
        <select
          id={`${ids}-scope`}
          className="spark-select"
          value={scopes.find((option) => draft.scope && sameRepoKey(option.key, draft.scope))?.key ?? GLOBAL_SCOPE}
          onChange={(event) => set("scope", event.currentTarget.value)}
        >
          <option value={GLOBAL_SCOPE}>All workspaces</option>
          {scopes.map((option) => (
            <option key={option.key} value={option.key}>Only {option.label}</option>
          ))}
        </select>
      </div>

      <p style={{ ...fieldHint, margin: 0 }}>
        {draft.kind === "shell"
          ? "{branch} and {cwd} fill in the git branch and the folder it runs in. Write \"{cwd}\" in double quotes: outside quotes, a folder with spaces stops the command."
          : "{branch} and {cwd} fill in the git branch and the folder of the terminal or workspace it goes to."}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {onDelete ? (
          <button
            type="button"
            className="spark-btn is-danger"
            onClick={() => {
              if (confirmDelete && !deleteArmed) setDeleteArmed(true);
              else onDelete();
            }}
            onBlur={() => setDeleteArmed(false)}
          >
            {deleteArmed ? "Delete for good" : "Delete"}
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="spark-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="spark-btn is-primary" disabled={!canSave}>
          {mode === "add" ? "Add" : "Save"}
        </button>
      </div>
    </form>
  );
}
