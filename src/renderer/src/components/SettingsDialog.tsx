import React, { useEffect, useMemo, useState } from "react";
import type { AppSettings, ShellInfo } from "@shared/types";

type SettingsTab = "terminal" | "api";

interface SettingsDialogProps {
  settings: AppSettings;
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

export default function SettingsDialog({
  settings,
  shells,
  defaultShell,
  onClose,
  onSave,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("terminal");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
    setError(null);
  }, [settings]);

  const selectedShell = useMemo(
    () => shells.find((shell) => shell.id === draft.defaultShellId) ?? defaultShell,
    [defaultShell, draft.defaultShellId, shells],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...draft,
        openRouterApiKey: draft.openRouterApiKey.trim(),
        openRouterModel: draft.openRouterModel.trim(),
        langSmithApiKey: draft.langSmithApiKey.trim(),
        langSmithProject: draft.langSmithProject.trim(),
        langSmithEndpoint: draft.langSmithEndpoint.trim().replace(/\/+$/, ""),
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
      }}
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{
          width: "min(720px, calc(100vw - 44px))",
          maxHeight: "min(620px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--rule-strong)",
          boxShadow: "0 18px 80px rgba(0,0,0,0.55)",
          overflow: "hidden",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          style={{
            flex: "0 0 42px",
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid var(--rule)",
          }}
        >
          <div
            style={{
              padding: "0 14px",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.14em",
            }}
          >
            SETTINGS
          </div>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={chromeButtonStyle}>
            CLOSE
          </button>
        </header>

        <div style={{ display: "flex", minHeight: 0 }}>
          <nav
            style={{
              flex: "0 0 180px",
              borderRight: "1px solid var(--rule)",
              background: "var(--bg)",
              padding: 8,
            }}
          >
            <TabButton
              label="DEFAULT TERMINAL"
              active={activeTab === "terminal"}
              onClick={() => setActiveTab("terminal")}
            />
            <TabButton label="API + MODEL" active={activeTab === "api"} onClick={() => setActiveTab("api")} />
          </nav>

          <div style={{ flex: 1, minWidth: 0, padding: 16, overflow: "auto" }}>
            {activeTab === "terminal" ? (
              <TerminalSettings
                shells={shells}
                selectedShellId={selectedShell?.id ?? null}
                onSelect={(defaultShellId) => setDraft((current) => ({ ...current, defaultShellId }))}
              />
            ) : (
              <ApiSettings draft={draft} onChange={setDraft} />
            )}
          </div>
        </div>

        <footer
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 12,
            borderTop: "1px solid var(--rule)",
          }}
        >
          {error && <div style={{ color: "var(--danger)", fontSize: 11, flex: 1 }}>{error}</div>}
          {!error && <div style={{ flex: 1 }} />}
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>
            CANCEL
          </button>
          <button type="button" onClick={save} disabled={saving} style={primaryButtonStyle}>
            {saving ? "SAVING" : "SAVE"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function TerminalSettings({
  shells,
  selectedShellId,
  onSelect,
}: {
  shells: ShellInfo[];
  selectedShellId: string | null;
  onSelect: (shellId: string) => void;
}) {
  return (
    <div>
      <SectionTitle title="Default Terminal" detail="Used for new manual worker panes." />
      <div style={{ display: "grid", gap: 8 }}>
        {shells.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>No terminals detected.</div>}
        {shells.map((shell) => {
          const selected = shell.id === selectedShellId;
          return (
            <button
              key={shell.id}
              type="button"
              aria-label={`Use ${shell.label} as default terminal`}
              onClick={() => onSelect(shell.id)}
              style={{
                appearance: "none",
                width: "100%",
                textAlign: "left",
                border: selected ? "1px solid var(--accent)" : "1px solid var(--rule)",
                background: selected ? "var(--panel-2)" : "transparent",
                color: "var(--ink)",
                padding: "10px 12px",
                fontFamily: "inherit",
                cursor: "default",
                display: "grid",
                gridTemplateColumns: "10px minmax(0, 1fr) auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <span style={{ width: 8, height: 8, background: selected ? "var(--accent)" : "var(--rule)" }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 700 }}>{shell.label}</span>
                <span
                  style={{
                    display: "block",
                    color: "var(--muted)",
                    fontSize: 10,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {shell.exe}
                </span>
              </span>
              <span style={{ color: "var(--muted)", fontSize: 10 }}>{shell.family}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ApiSettings({
  draft,
  onChange,
}: {
  draft: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <SectionTitle title="OpenRouter" detail="Used by Spark Agent to plan Claude/Codex worker tasks." />
      <Label text="OPENROUTER API KEY">
        <input
          type="password"
          value={draft.openRouterApiKey}
          onChange={(event) => onChange({ ...draft, openRouterApiKey: event.currentTarget.value })}
          placeholder="sk-or-..."
          style={inputStyle}
        />
      </Label>
      <Label text="MODEL">
        <input
          type="text"
          value={draft.openRouterModel}
          onChange={(event) => onChange({ ...draft, openRouterModel: event.currentTarget.value })}
          placeholder="google/gemini-flash-latest"
          style={inputStyle}
        />
      </Label>

      <SectionTitle title="LangSmith" detail="Optional tracing for Spark manager calls. OpenRouter remains the model transport." />
      <Label text="LANGSMITH API KEY">
        <input
          type="password"
          value={draft.langSmithApiKey}
          onChange={(event) => onChange({ ...draft, langSmithApiKey: event.currentTarget.value })}
          placeholder="lsv2_..."
          style={inputStyle}
        />
      </Label>
      <Label text="PROJECT">
        <input
          type="text"
          value={draft.langSmithProject}
          onChange={(event) => onChange({ ...draft, langSmithProject: event.currentTarget.value })}
          placeholder="spark-agent-dev"
          style={inputStyle}
        />
      </Label>
      <Label text="ENDPOINT">
        <input
          type="text"
          value={draft.langSmithEndpoint}
          onChange={(event) => onChange({ ...draft, langSmithEndpoint: event.currentTarget.value })}
          placeholder="https://api.smith.langchain.com"
          style={inputStyle}
        />
      </Label>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        background: active ? "var(--panel)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "9px 10px",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.1em",
        cursor: "default",
      }}
    >
      {label}
    </button>
  );
}

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase" }}>
        {title}
      </div>
      <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 11 }}>{detail}</div>
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ color: "var(--ink-dim)", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em" }}>
        {text}
      </span>
      {children}
    </label>
  );
}

const chromeButtonStyle: React.CSSProperties = {
  appearance: "none",
  alignSelf: "stretch",
  border: "none",
  borderLeft: "1px solid var(--rule)",
  background: "transparent",
  color: "var(--ink-dim)",
  padding: "0 14px",
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.1em",
  cursor: "default",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--rule-strong)",
  background: "var(--bg)",
  color: "var(--ink)",
  padding: "9px 10px",
  fontFamily: "inherit",
  fontSize: 12,
  outline: "none",
};

const secondaryButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--rule-strong)",
  background: "transparent",
  color: "var(--ink-dim)",
  padding: "8px 14px",
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.1em",
  cursor: "default",
};

const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: "1px solid var(--accent)",
  color: "var(--ink)",
  background: "var(--panel-2)",
};
