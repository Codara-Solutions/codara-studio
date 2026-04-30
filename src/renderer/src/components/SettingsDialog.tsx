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
        background: "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        fontFamily: "var(--font-sans)",
      }}
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{
          width: "min(520px, calc(100vw - 44px))",
          maxHeight: "min(640px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--rule)",
          borderRadius: 8,
          boxShadow: "var(--shadow-2)",
          overflow: "hidden",
          padding: 0,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "16px 20px",
            borderBottom: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              fontWeight: 600,
              color: "var(--ink)",
              letterSpacing: "-0.005em",
            }}
          >
            Settings
          </div>
        </header>

        <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
          <nav
            style={{
              flex: "0 0 168px",
              borderRight: "1px solid var(--rule-soft)",
              background: "var(--bg)",
              padding: "12px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <TabButton
              label="Default terminal"
              active={activeTab === "terminal"}
              onClick={() => setActiveTab("terminal")}
            />
            <TabButton
              label="API and model"
              active={activeTab === "api"}
              onClick={() => setActiveTab("api")}
            />
          </nav>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              padding: "20px 20px 24px",
              overflow: "auto",
            }}
          >
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
            gap: 8,
            padding: "12px 20px",
            borderTop: "1px solid var(--rule-soft)",
          }}
        >
          {error ? (
            <div
              style={{
                color: "var(--danger)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                flex: 1,
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          ) : (
            <div style={{ flex: 1 }} />
          )}
          <FooterButton onClick={onClose}>Cancel</FooterButton>
          <FooterButton onClick={save} disabled={saving} primary>
            {saving ? "Saving" : "Save"}
          </FooterButton>
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
      <SectionTitle title="Default terminal" detail="Used for new manual worker panes." />
      <div style={{ display: "grid", gap: 8 }}>
        {shells.length === 0 && (
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
            }}
          >
            No terminals detected.
          </div>
        )}
        {shells.map((shell) => (
          <ShellOption
            key={shell.id}
            shell={shell}
            selected={shell.id === selectedShellId}
            onSelect={() => onSelect(shell.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ShellOption({
  shell,
  selected,
  onSelect,
}: {
  shell: ShellInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Use ${shell.label} as default terminal`}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        textAlign: "left",
        border: selected
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule)",
        borderRadius: 4,
        background: selected
          ? "var(--accent-soft)"
          : hover
            ? "var(--hover)"
            : "var(--panel-2)",
        color: "var(--ink)",
        padding: "10px 12px",
        fontFamily: "var(--font-sans)",
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: selected ? "var(--accent)" : "var(--rule-strong)",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          {shell.label}
        </span>
        <span
          style={{
            display: "block",
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginTop: 2,
          }}
        >
          {shell.exe}
        </span>
      </span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
        }}
      >
        {shell.family}
      </span>
    </button>
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
    <div style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "grid", gap: 12 }}>
        <SectionTitle
          title="OpenRouter"
          detail="Used by Spark Agent to plan Claude and Codex worker tasks."
        />
        <Label text="OpenRouter API key">
          <input
            type="password"
            value={draft.openRouterApiKey}
            onChange={(event) => onChange({ ...draft, openRouterApiKey: event.currentTarget.value })}
            placeholder="sk-or-..."
            style={inputStyle}
          />
        </Label>
        <Label text="Model">
          <input
            type="text"
            value={draft.openRouterModel}
            onChange={(event) => onChange({ ...draft, openRouterModel: event.currentTarget.value })}
            placeholder="google/gemini-flash-latest"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
        </Label>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <SectionTitle
          title="LangSmith"
          detail="Optional tracing for Spark manager calls. OpenRouter remains the model transport."
        />
        <Label text="LangSmith API key">
          <input
            type="password"
            value={draft.langSmithApiKey}
            onChange={(event) => onChange({ ...draft, langSmithApiKey: event.currentTarget.value })}
            placeholder="lsv2_..."
            style={inputStyle}
          />
        </Label>
        <Label text="Project">
          <input
            type="text"
            value={draft.langSmithProject}
            onChange={(event) => onChange({ ...draft, langSmithProject: event.currentTarget.value })}
            placeholder="spark-agent-dev"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
        </Label>
        <Label text="Endpoint">
          <input
            type="text"
            value={draft.langSmithEndpoint}
            onChange={(event) => onChange({ ...draft, langSmithEndpoint: event.currentTarget.value })}
            placeholder="https://api.smith.langchain.com"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
        </Label>
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        borderRadius: 4,
        background: active
          ? "var(--panel-2)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "8px 10px",
        textAlign: "left",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        letterSpacing: "0.005em",
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink)",
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 4,
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {detail}
      </div>
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {text}
      </span>
      {children}
    </label>
  );
}

function FooterButton({
  onClick,
  disabled,
  children,
  primary,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  primary?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const base: React.CSSProperties = {
    appearance: "none",
    border: primary
      ? "1px solid var(--accent-edge)"
      : "1px solid var(--rule-strong)",
    borderRadius: 4,
    background: primary ? "var(--accent-soft)" : "transparent",
    color: disabled ? "var(--muted)" : "var(--ink)",
    padding: "8px 14px",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.01em",
    cursor: "default",
    transition:
      "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
  };
  if (hover && !disabled) {
    if (primary) {
      base.background = "color-mix(in oklch, var(--accent) 28%, transparent)";
    } else {
      base.background = "var(--hover-strong)";
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={base}
    >
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--rule-strong)",
  borderRadius: 4,
  background: "var(--panel-2)",
  color: "var(--ink)",
  padding: "8px 10px",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  transition:
    "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
};
