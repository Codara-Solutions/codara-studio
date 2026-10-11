import React, { useState } from "react";
import type { AgentMcpServerDraft, AgentMcpTarget } from "@shared/types";
import {
  CLI_LABEL,
  CLI_RUNTIMES,
  RUNTIME_LABEL,
  isSecretPair,
  pairsFrom,
  targetFor,
  type EditorState,
  type Pair,
} from "./model";
import {
  EyeGlyph,
  Field,
  SectionHead,
  TrashGlyph,
  fieldHintStyle,
  fieldLabelStyle,
  fieldStyle,
  formErrorStyle,
  optionalStyle,
  panelStyle,
  rowNoteStyle,
  sectionStyle,
  smallBtnStyle,
  textareaStyle,
} from "./controls";
import { ProbeResultView, shortPath, type ProbeState } from "./McpSection";

export default function McpServerForm({
  editor,
  targets,
  hasWorkspace,
  busy,
  error,
  probe,
  onChange,
  onTest,
  onParse,
}: {
  editor: EditorState;
  targets: AgentMcpTarget[];
  hasWorkspace: boolean;
  busy: boolean;
  error: string | null;
  probe: ProbeState | null;
  onChange: (next: EditorState) => void;
  onTest: () => void;
  onParse: (text: string) => Promise<{ servers: AgentMcpServerDraft[]; notes: string[] } | { error: string }>;
}) {
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ ...editor, [key]: value });
  const adding = editor.mode === "add";
  return (
    <section style={sectionStyle} aria-busy={busy}>
      <SectionHead
        detail={
          adding
            ? "Fill in the form, or paste the snippet from the server's README. Codara writes the server into the config files you pick below, the same entry the CLI would write itself."
            : "Changes are written to the config file straight away when you save."
        }
      />

      {adding ? <PasteBox editor={editor} onChange={onChange} onParse={onParse} /> : null}

      <div style={formGridStyle}>
        <Field label="Name" hint="Letters, digits, dot, underscore and hyphen. Agents see the tools as name_tool.">
          <input
            className="spark-input"
            value={editor.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="my-server"
            spellCheck={false}
            autoFocus
          />
        </Field>

        <div style={fieldStyle}>
          <span style={fieldLabelStyle}>How Codara starts it</span>
          <div className="spark-segmented" role="group" aria-label="Transport">
            <button
              type="button"
              className={editor.transport === "stdio" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
              aria-pressed={editor.transport === "stdio"}
              onClick={() => set("transport", "stdio")}
            >
              Run a command (stdio)
            </button>
            <button
              type="button"
              className={editor.transport === "http" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
              aria-pressed={editor.transport === "http"}
              onClick={() => set("transport", "http")}
            >
              Connect to a URL (HTTP)
            </button>
          </div>
        </div>

        {editor.transport === "stdio" ? (
          <>
            <Field label="Command">
              <input
                className="spark-input spark-mono"
                value={editor.command}
                onChange={(event) => set("command", event.target.value)}
                placeholder="npx"
                spellCheck={false}
              />
            </Field>
            <Field label={<>Arguments <span style={optionalStyle}>one per line</span></>}>
              <textarea
                className="spark-input"
                value={editor.argsText}
                onChange={(event) => set("argsText", event.target.value)}
                placeholder={"-y\n@scope/package"}
                spellCheck={false}
                rows={3}
                style={textareaStyle}
              />
            </Field>
            <PairEditor
              label="Environment variables"
              noun="variable"
              pairs={editor.env}
              keyPlaceholder="API_KEY"
              valuePlaceholder="value or ${VAR}"
              onChange={(env) => set("env", env)}
            />
          </>
        ) : (
          <>
            <Field label="URL" hint="The server's streamable HTTP endpoint.">
              <input
                className="spark-input spark-mono"
                value={editor.url}
                onChange={(event) => set("url", event.target.value)}
                placeholder="https://example.com/mcp"
                spellCheck={false}
              />
            </Field>
            <PairEditor
              label="Request headers"
              noun="header"
              pairs={editor.headers}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ${TOKEN}"
              onChange={(headers) => set("headers", headers)}
            />
          </>
        )}

        <Availability editor={editor} targets={targets} hasWorkspace={hasWorkspace} onChange={onChange} />

        <div style={{ ...panelStyle, gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="spark-btn" style={smallBtnStyle} onClick={onTest} disabled={busy || probe?.busy}>
              {probe?.busy ? "Testing" : "Test connection"}
            </button>
            <span style={rowNoteStyle}>
              Starts the server once with these settings, lists its tools, then stops it. Nothing is saved.
            </span>
          </div>
          {probe ? <ProbeResultView name={editor.name.trim() || "the server"} probe={probe} /> : null}
        </div>

        {error ? (
          <div role="alert" style={formErrorStyle}>
            {error}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Who gets the server: Cora and Pi workers read it from whatever file it is
// saved in, and each CLI reads only its own config. On add, the CLI ticks pick
// the files; an exact file is still one click away for project files and
// ~/.mcp.json.
function Availability({
  editor,
  targets,
  hasWorkspace,
  onChange,
}: {
  editor: EditorState;
  targets: AgentMcpTarget[];
  hasWorkspace: boolean;
  onChange: (next: EditorState) => void;
}) {
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ ...editor, [key]: value });
  const exactTarget = editor.customTargetId
    ? targets.find((target) => target.id === editor.customTargetId) ?? null
    : null;
  const editTarget = targets.find((target) => target.id === editor.targetId) ?? null;
  return (
    <div style={{ ...panelStyle, gap: 12 }}>
      <div style={fieldLabelStyle}>Where it is available</div>
      <div style={choiceGroupStyle} role="group" aria-label="Agents inside Codara">
        <span style={choiceCaptionStyle}>Agents inside Codara</span>
        <Check
          checked={editor.cora}
          onChange={(cora) => set("cora", cora)}
          label="Cora"
          hint="Cora picks it up on your next message."
        />
        <Check
          checked={editor.workers}
          onChange={(workers) => set("workers", workers)}
          label="Pi workers"
          hint="Workers Cora starts on Pi get it from their next launch."
        />
        <span style={fieldHintStyle}>
          These two apply in every workspace where a server named {editor.name.trim() || "like this"} is defined.
        </span>
      </div>

      {editor.mode === "add" ? (
        exactTarget || editor.customTargetId !== null ? (
          <div style={choiceGroupStyle}>
            <Field label="Save to this file" hint={exactTarget?.hint ?? exactTarget?.path}>
              <select
                className="spark-input"
                value={editor.customTargetId ?? ""}
                onChange={(event) => set("customTargetId", event.target.value)}
              >
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            {exactTarget ? <ReadByLine target={exactTarget} /> : null}
            <button type="button" className="spark-btn" style={{ ...smallBtnStyle, justifySelf: "start" }} onClick={() => set("customTargetId", null)}>
              Pick CLIs instead
            </button>
          </div>
        ) : (
          <div style={choiceGroupStyle} role="group" aria-label="CLI configs">
            <span style={choiceCaptionStyle}>CLI configs that keep it</span>
            <div className="spark-segmented" role="group" aria-label="Scope">
              <button
                type="button"
                className={editor.scope === "user" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
                aria-pressed={editor.scope === "user"}
                onClick={() => onChange({ ...editor, scope: "user" })}
              >
                Every workspace
              </button>
              <button
                type="button"
                className={editor.scope === "workspace" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
                aria-pressed={editor.scope === "workspace"}
                disabled={!hasWorkspace}
                title={hasWorkspace ? undefined : "Open a workspace to save a server for it alone"}
                onClick={() => onChange({ ...editor, scope: "workspace", clis: { ...editor.clis, grok: false } })}
              >
                This workspace only
              </button>
            </div>
            {CLI_RUNTIMES.map((cli) => {
              const target = targetFor(targets, cli, editor.scope);
              return (
                <Check
                  key={cli}
                  checked={Boolean(target) && editor.clis[cli]}
                  disabled={!target}
                  onChange={(next) => onChange({ ...editor, clis: { ...editor.clis, [cli]: next } })}
                  label={CLI_LABEL[cli]}
                  hint={
                    target
                      ? `${shortPath(target.path)}${target.hint ? `. ${target.hint}` : ""}`
                      : `${CLI_LABEL[cli]} has no per-workspace config.`
                  }
                />
              );
            })}
            <span style={fieldHintStyle}>
              Cora and Pi workers read the server from these files, so keep at least one ticked.
            </span>
            <button
              type="button"
              className="spark-btn"
              style={{ ...smallBtnStyle, justifySelf: "start" }}
              onClick={() => set("customTargetId", targets[0]?.id ?? "")}
            >
              Choose an exact file instead
            </button>
          </div>
        )
      ) : (
        <div style={choiceGroupStyle}>
          <Field label="Saved in" hint={editTarget?.hint ?? editTarget?.path}>
            <select
              className="spark-input"
              value={editor.targetId}
              onChange={(event) => set("targetId", event.target.value)}
            >
              {targets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          {editTarget ? <ReadByLine target={editTarget} /> : null}
          {editor.copies.length > 0 ? (
            <div style={choiceGroupStyle} role="group" aria-label="Other copies">
              <span style={choiceCaptionStyle}>Also update the other copies</span>
              {editor.copies.map((copy, index) => (
                <Check
                  key={copy.id}
                  checked={copy.selected}
                  onChange={(selected) =>
                    set(
                      "copies",
                      editor.copies.map((item, i) => (i === index ? { ...item, selected } : item)),
                    )
                  }
                  label={`${RUNTIME_LABEL[copy.runtime]}: ${shortPath(copy.path)}`}
                  hint={copy.matched ? "Same definition as this one." : "This copy is different today. Ticking it replaces it with the one above."}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ReadByLine({ target }: { target: AgentMcpTarget }) {
  if (!target.readBy) return null;
  const readers = target.readBy.map((cli) => CLI_LABEL[cli as keyof typeof CLI_LABEL] ?? cli);
  return (
    <span style={fieldHintStyle}>
      {readers.length > 0 ? `Loaded by the ${readers.join(" and ")}, plus Cora and Pi workers.` : "Only Cora and Pi workers load this file."}
    </span>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label style={{ ...checkRowStyle, opacity: disabled ? 0.55 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        style={{ marginTop: 2 }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ color: "var(--ink)", fontSize: 12, fontWeight: 600 }}>{label}</span>
        {hint ? <span style={{ ...fieldHintStyle, display: "block" }}>{hint}</span> : null}
      </span>
    </label>
  );
}

// Paste what a README publishes and let the main process turn it into fields.
// A snippet holding several servers asks which one this form is for.
function PasteBox({
  editor,
  onChange,
  onParse,
}: {
  editor: EditorState;
  onChange: (next: EditorState) => void;
  onParse: (text: string) => Promise<{ servers: AgentMcpServerDraft[]; notes: string[] } | { error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [choices, setChoices] = useState<AgentMcpServerDraft[]>([]);

  const apply = (draft: AgentMcpServerDraft) => {
    onChange({
      ...editor,
      name: draft.name || editor.name,
      transport: draft.transport,
      command: draft.command ?? "",
      argsText: (draft.args ?? []).join("\n"),
      env: pairsFrom(draft.env),
      url: draft.url ?? "",
      headers: pairsFrom(draft.headers),
    });
    setChoices([]);
    setOpen(false);
  };

  const parse = () => {
    setBusy(true);
    setProblem(null);
    setNotes([]);
    setChoices([]);
    void onParse(text)
      .then((result) => {
        if ("error" in result) {
          setProblem(result.error);
          return;
        }
        setNotes(result.notes);
        if (result.servers.length === 1) apply(result.servers[0]);
        else setChoices(result.servers);
      })
      .catch((err) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="spark-btn" style={smallBtnStyle} onClick={() => setOpen(true)}>
          Paste a config snippet
        </button>
        {notes.length > 0 ? <span style={rowNoteStyle}>{notes.join(" ")}</span> : null}
      </div>
    );
  }
  return (
    <div style={panelStyle}>
      <Field
        label="Paste a config snippet"
        hint="An mcpServers JSON block, one server's JSON, a Codex [mcp_servers.name] table, or a claude mcp add / codex mcp add command."
      >
        <textarea
          className="spark-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={'{\n  "mcpServers": {\n    "linear": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.linear.app/sse"] }\n  }\n}'}
          spellCheck={false}
          rows={6}
          style={textareaStyle}
          aria-label="Config snippet"
        />
      </Field>
      {problem ? (
        <div role="alert" style={formErrorStyle}>
          {problem}
        </div>
      ) : null}
      {notes.length > 0 ? <div style={rowNoteStyle}>{notes.join(" ")}</div> : null}
      {choices.length > 1 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={rowNoteStyle}>That snippet has {choices.length} servers. Which one?</span>
          {choices.map((choice, index) => (
            <button key={`${choice.name}-${index}`} type="button" className="spark-btn" style={smallBtnStyle} onClick={() => apply(choice)}>
              {choice.name || `Server ${index + 1}`}
            </button>
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="spark-btn is-primary" style={smallBtnStyle} disabled={busy || !text.trim()} onClick={parse}>
          {busy ? "Reading" : "Fill in the form"}
        </button>
        <button type="button" className="spark-btn" style={smallBtnStyle} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Key/value rows. A value whose name or shape says credential is masked until
// its row is revealed, so a screen share does not leak a token.
function PairEditor({
  label,
  noun,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  noun: string;
  pairs: Pair[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (next: Pair[]) => void;
}) {
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  const toggleReveal = (index: number) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>
        {label} <span style={optionalStyle}>optional</span>
      </span>
      {pairs.map((pair, index) => {
        const secret = isSecretPair(pair);
        const masked = secret && !revealed.has(index);
        return (
          // Rows are positional and every input is controlled, so the index is
          // a stable enough key here.
          <div key={index} style={pairRowStyle}>
            <input
              className="spark-input spark-mono"
              value={pair.key}
              onChange={(event) => update(index, { key: event.target.value })}
              placeholder={keyPlaceholder}
              spellCheck={false}
              aria-label={`${label}: name`}
            />
            <input
              className="spark-input spark-mono"
              type={masked ? "password" : "text"}
              autoComplete="off"
              value={pair.value}
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder={valuePlaceholder}
              spellCheck={false}
              aria-label={`${label}: value of ${pair.key || noun}`}
            />
            {secret ? (
              <button
                type="button"
                className="spark-icon-btn"
                aria-label={masked ? `Show the value of ${pair.key || noun}` : `Hide the value of ${pair.key || noun}`}
                aria-pressed={!masked}
                title={masked ? "Show value" : "Hide value"}
                onClick={() => toggleReveal(index)}
              >
                <EyeGlyph open={!masked} />
              </button>
            ) : (
              <span style={{ width: 22 }} aria-hidden />
            )}
            <button
              type="button"
              className="spark-icon-btn"
              aria-label={`Remove ${pair.key || noun}`}
              onClick={() => {
                onChange(pairs.filter((_, i) => i !== index));
                setRevealed(new Set());
              }}
            >
              <TrashGlyph />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="spark-btn"
        style={{ ...smallBtnStyle, justifySelf: "start" }}
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        Add {noun}
      </button>
      <span style={fieldHintStyle}>
        Write a secret as ${"{"}VAR{"}"} to read it from your environment instead of storing it in the file.
      </span>
    </div>
  );
}

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 16,
  maxWidth: 640,
};

const pairRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) auto auto",
  gap: 6,
  alignItems: "center",
};

const choiceGroupStyle: React.CSSProperties = {
  display: "grid",
  gap: 8,
};

const choiceCaptionStyle: React.CSSProperties = {
  color: "var(--muted-2)",
  fontSize: 10,
  fontWeight: 650,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

const checkRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  cursor: "default",
};
