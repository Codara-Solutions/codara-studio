import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRuntimeDiagnostic,
  AgentRuntimeKind,
  AgentRuntimeSelection,
  AppSettings,
  EditorThemeId,
  RunState,
  ShellInfo,
  ThemePref,
} from "@shared/types";
import {
  APP_THEME_IDS,
  DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID,
  EDITOR_THEME_IDS,
  INLINE_AI_DELAY_PRESETS,
  INLINE_AI_MODEL_PRESETS,
} from "@shared/types";
import { runStatusColor } from "../lib/run-status";
import { useTheme } from "../theme/ThemeProvider";
import { usePreferences } from "../preferences/usePreferences";
import KeybindingsSection from "../shortcuts/KeybindingsSection";
import { EDITOR_THEME_LABEL } from "./editor-cm/themes";
import { Capability } from "./Capability";
import packageJson from "../../../../package.json";

// Settings is a single in-app dialog with seven tabs. Everything renders
// inline here — there is no separate Settings BrowserWindow.
type SettingsTab =
  | "general"
  | "editor"
  | "terminal"
  | "api"
  | "agents"
  | "keybindings"
  | "runs"
  | "about";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Default terminal" },
  { id: "api", label: "API and model" },
  { id: "agents", label: "Agents" },
  { id: "keybindings", label: "Keybindings" },
  { id: "runs", label: "Runs" },
  { id: "about", label: "About" },
];

interface SettingsDialogProps {
  settings: AppSettings;
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  workspaceCwd?: string | null;
  initialTab?: SettingsTab;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
  // Click "Open" on a row in the Runs tab. Caller is expected to switch
  // active workspace, select the run, and close this dialog.
  onOpenRun: (runId: string, workspaceId: string) => void;
}

export default function SettingsDialog({
  settings,
  shells,
  defaultShell,
  initialTab = "general",
  onClose,
  onSave,
  onOpenRun,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the active tab uses the draft-and-Save flow (terminal, api, agents) or
  // auto-applies on change (general, editor, about). The footer
  // hides Save/Cancel on auto-save tabs so the UI doesn't pretend the user
  // needs to commit a change that already persisted.
  const isDraftTab = activeTab === "terminal" || activeTab === "api" || activeTab === "agents";
  // The runs tab has its own scrolling list and per-row destructive actions;
  // the global Save/Cancel footer would be misleading there. Hide the
  // footer entirely on tabs that manage their own persistence semantics.
  const hideFooter = activeTab === "runs";

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
        background: "rgba(0, 0, 0, 0.58)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        fontFamily: "var(--font-sans)",
      }}
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{
          // Fixed footprint — switching tabs (or resizing the inner content)
          // shouldn't make the dialog grow or shrink. Only the inner content
          // pane scrolls; the dialog stays the same size.
          width: "min(560px, calc(100vw - 44px))",
          height: "min(720px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 12,
          boxShadow: "var(--shadow-2)",
          overflow: "hidden",
          padding: 0,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "13px 18px",
            borderBottom: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 9px var(--accent-glow)",
            }}
          />
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              fontWeight: 700,
              color: "var(--ink)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
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
              background: "color-mix(in oklch, var(--bg) 60%, var(--panel))",
              padding: "12px 9px",
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            {TABS.map((tab) => (
              <TabButton
                key={tab.id}
                label={tab.label}
                active={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
          </nav>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              padding: "20px 20px 24px",
              overflow: "auto",
            }}
          >
            {activeTab === "general" && <GeneralSettings />}
            {activeTab === "editor" && <EditorSettings />}
            {activeTab === "terminal" && (
              <TerminalSettings
                shells={shells}
                selectedShellId={selectedShell?.id ?? null}
                onSelect={(defaultShellId) =>
                  setDraft((current) => ({ ...current, defaultShellId }))
                }
              />
            )}
            {activeTab === "api" && <ApiSettings draft={draft} onChange={setDraft} />}
            {activeTab === "agents" && (
              <AgentsSettings draft={draft} onChange={setDraft} />
            )}
            {activeTab === "keybindings" && <KeybindingsTab />}
            {activeTab === "runs" && <RunsSettings onOpenRun={onOpenRun} />}
            {activeTab === "about" && <AboutSettings />}
          </div>
        </div>

        {hideFooter ? null : (
          <footer
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 18px",
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
              <div
                style={{
                  flex: 1,
                  color: "var(--muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                }}
              >
                {isDraftTab ? null : "Changes apply instantly."}
              </div>
            )}
            {isDraftTab ? (
              <>
                <FooterButton onClick={onClose}>Cancel</FooterButton>
                <FooterButton onClick={save} disabled={saving} primary>
                  {saving ? "Saving" : "Save"}
                </FooterButton>
              </>
            ) : (
              <FooterButton onClick={onClose} primary>
                Done
              </FooterButton>
            )}
          </footer>
        )}
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
          ? "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
          : hover
            ? "1px solid var(--rule-soft)"
            : "1px solid transparent",
        borderRadius: 8,
        background: selected
          ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: "var(--ink)",
        padding: "9px 10px",
        fontFamily: "var(--font-sans)",
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        boxShadow: selected
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 16%, transparent), 0 8px 18px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: selected ? "var(--accent)" : "var(--rule-strong)",
          boxShadow: selected ? "0 0 9px var(--accent-glow)" : "none",
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
          detail="Used by Spark Agent to plan Claude, Codex, and Cursor worker tasks."
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
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 46%, var(--rule-strong))"
          : hover
            ? "1px solid var(--rule-soft)"
            : "1px solid transparent",
        borderRadius: 999,
        background: active
          ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "7px 10px",
        textAlign: "left",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: active ? 700 : 600,
        letterSpacing: "0.005em",
        cursor: "default",
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 14%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {active && (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: "var(--accent)",
            boxShadow: "0 0 8px var(--accent-glow)",
            flex: "0 0 7px",
          }}
        />
      )}
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
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink-dim)",
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
      ? "1px solid color-mix(in oklch, var(--accent) 50%, var(--rule-strong))"
      : "1px solid var(--rule-strong)",
    borderRadius: 999,
    background: primary
      ? "color-mix(in oklch, var(--ink) 3%, transparent)"
      : "transparent",
    color: disabled ? "var(--muted)" : "var(--ink)",
    padding: "7px 14px",
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
      base.background = "var(--hover)";
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

// ── Setting panes, all rendered inline in this dialog's chrome.

const APP_THEME_META: Readonly<
  Record<
    ThemePref,
    {
      label: string;
      swatches: readonly [string, string, string, string];
    }
  >
> = {
  "spark-classic": {
    label: "Spark Classic",
    swatches: ["#191914", "#25241f", "#f0c419", "#f5f2e9"],
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    swatches: ["#1e1e2e", "#313244", "#89b4fa", "#cdd6f4"],
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    swatches: ["#eff1f5", "#dce0e8", "#1e66f5", "#4c4f69"],
  },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    swatches: ["#282828", "#3c3836", "#fabd2f", "#ebdbb2"],
  },
  "solarized-dark": {
    label: "Solarized Dark",
    swatches: ["#002b36", "#073642", "#268bd2", "#eee8d5"],
  },
  dracula: {
    label: "Dracula",
    swatches: ["#282a36", "#44475a", "#bd93f9", "#f8f8f2"],
  },
  "one-dark": {
    label: "One Dark",
    swatches: ["#282c34", "#2c313a", "#61afef", "#abb2bf"],
  },
  "rose-pine": {
    label: "Rose Pine",
    swatches: ["#191724", "#26233a", "#ebbcba", "#e0def4"],
  },
  everforest: {
    label: "Everforest",
    swatches: ["#2d353b", "#3d484d", "#a7c080", "#d3c6aa"],
  },
  "kanagawa-wave": {
    label: "Kanagawa Wave",
    swatches: ["#1f1f28", "#2a2a37", "#7e9cd8", "#dcd7ba"],
  },
};

const APPEARANCE = APP_THEME_IDS.map((id) => ({
  id,
  ...APP_THEME_META[id],
}));

function GeneralSettings() {
  const { theme, setTheme } = useTheme();
  const { preferences, hydrated, setPreference } = usePreferences();
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <SectionTitle title="Appearance" detail="Comfortable palettes people actually keep using." />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
          gap: 8,
        }}
      >
        {APPEARANCE.map((opt) => (
          <ThemeCard
            key={opt.id}
            label={opt.label}
            swatches={opt.swatches}
            active={theme === opt.id}
            onClick={() => setTheme(opt.id)}
          />
        ))}
      </div>

      <div
        style={{
          height: 1,
          background: "var(--rule-soft)",
          margin: "2px 0",
        }}
      />

      <SectionTitle
        title="Performance"
        detail="Tune renderer resource usage. Some flags only apply after restart."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="Disable hardware acceleration (requires restart)"
            desc="Reduces RAM ~60-90MB on integrated GPUs. Restart to apply."
            checked={Boolean(preferences.disableHardwareAcceleration)}
            onChange={(v) => void setPreference("disableHardwareAcceleration", v)}
          />
        </div>
      ) : (
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
          }}
        >
          Loading preferences…
        </div>
      )}

      <div
        style={{
          height: 1,
          background: "var(--rule-soft)",
          margin: "2px 0",
        }}
      />

      <SectionTitle
        title="Notifications"
        detail="Pick which channels fire when a run is blocked or finishes while you're away. The 3-rule policy gates all channels — they never fire when you're already watching the chat that finished."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="In-app toast"
            desc="Stacked top-right card. Click to jump to the chat that needs you."
            checked={preferences.notificationChannels.inApp}
            onChange={(v) =>
              void setPreference("notificationChannels", {
                ...preferences.notificationChannels,
                inApp: v,
              })
            }
          />
          <ToggleRow
            title="Native OS notification"
            desc="System tray / notification center alert via your OS notifications service."
            checked={preferences.notificationChannels.native}
            onChange={(v) =>
              void setPreference("notificationChannels", {
                ...preferences.notificationChannels,
                native: v,
              })
            }
          />
          <ToggleRow
            title="Embedded sound clip"
            desc="Plays a short cue: one for 'needs you' (blocked), one for 'done'."
            checked={preferences.notificationChannels.sound}
            onChange={(v) =>
              void setPreference("notificationChannels", {
                ...preferences.notificationChannels,
                sound: v,
              })
            }
          />
          <ToggleRow
            title="OS-specific cues"
            desc="macOS dock badge / Windows taskbar flash. Clears when you focus Spark."
            checked={preferences.notificationChannels.osCues}
            onChange={(v) =>
              void setPreference("notificationChannels", {
                ...preferences.notificationChannels,
                osCues: v,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function EditorSettings() {
  const { preferences, hydrated, setPreference } = usePreferences();
  if (!hydrated) {
    return (
      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
        }}
      >
        Loading preferences…
      </div>
    );
  }
  const currentInlineModelId = preferences.inlineAutocompleteModelId.trim();
  const currentInlinePreset = INLINE_AI_MODEL_PRESETS.find(
    (preset) => preset.id === currentInlineModelId,
  );
  const setInlineModel = (modelId: string) => {
    void setPreference("inlineAutocompleteModelId", modelId);
  };
  const normalizeInlineModelInput = () => {
    const next = preferences.inlineAutocompleteModelId.trim() || DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID;
    if (next !== preferences.inlineAutocompleteModelId) {
      setInlineModel(next);
    }
  };
  const currentInlineDelayMs = Math.max(
    0,
    Math.min(2_000, Math.round(preferences.inlineAutocompleteDelayMs)),
  );
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <SectionTitle title="Code editor" detail="Editing behaviour for the file editor pane." />
      <ToggleRow
        title="Vim mode"
        desc="Modal editing with :w / :q / :wq / :x ex-commands."
        checked={preferences.vimMode}
        onChange={(v) => void setPreference("vimMode", v)}
      />
      <Label text="Editor theme">
        <CustomSelect
          value={preferences.editorTheme}
          options={EDITOR_THEME_IDS.map((id) => ({
            value: id,
            label: EDITOR_THEME_LABEL[id],
          }))}
          onChange={(v) =>
            void setPreference("editorTheme", v as EditorThemeId)
          }
        />
      </Label>

      <div
        style={{
          height: 1,
          background: "var(--rule-soft)",
          margin: "2px 0",
        }}
      />

      <SectionTitle
        title="Inline AI"
        detail="Ghost-text autocomplete and git commit-message drafts share this OpenRouter model."
      />
      <ToggleRow
        title="Inline AI autocomplete"
        desc="Ghost-text suggestions as you type. Tab to accept, Esc to dismiss, Alt+\\ to trigger manually."
        checked={preferences.inlineAutocompleteEnabled}
        onChange={(v) => void setPreference("inlineAutocompleteEnabled", v)}
      />
      <div style={{ display: "grid", gap: 7 }}>
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
          Suggestion timing
        </span>
        <div
          role="group"
          aria-label="Inline AI suggestion timing"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 6,
          }}
        >
          {INLINE_AI_DELAY_PRESETS.map((preset) => (
            <TimingPresetButton
              key={preset.value}
              label={preset.label}
              hint={preset.hint}
              active={currentInlineDelayMs === preset.value}
              onClick={() =>
                void setPreference("inlineAutocompleteDelayMs", preset.value)
              }
            />
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 10,
            alignItems: "center",
          }}
        >
          <input
            aria-label="Inline AI wait time"
            type="range"
            min={0}
            max={2000}
            step={50}
            value={currentInlineDelayMs}
            onChange={(event) =>
              void setPreference("inlineAutocompleteDelayMs", Number(event.currentTarget.value))
            }
            style={{ width: "100%" }}
          />
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              minWidth: 44,
              textAlign: "right",
            }}
          >
            {currentInlineDelayMs === 0 ? "live" : `${currentInlineDelayMs}ms`}
          </span>
        </div>
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        <span
          id="inline-ai-model-label"
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Inline AI model
        </span>
        <div
          role="group"
          aria-label="Inline AI model presets"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 8,
          }}
        >
          {INLINE_AI_MODEL_PRESETS.map((preset) => (
            <ModelPresetCard
              key={preset.id}
              label={preset.label}
              modelId={preset.id}
              hint={preset.hint}
              detail={preset.detail}
              badge={preset.badge}
              active={currentInlineModelId === preset.id}
              onClick={() => setInlineModel(preset.id)}
            />
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "center",
          }}
        >
          <input
            aria-labelledby="inline-ai-model-label"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={preferences.inlineAutocompleteModelId}
            onChange={(e) =>
              void setPreference("inlineAutocompleteModelId", e.target.value)
            }
            onBlur={normalizeInlineModelInput}
            placeholder={DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button
            type="button"
            aria-label="Use default Inline AI model"
            onClick={() => setInlineModel(DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID)}
            title="Use the recommended Inline AI model"
            style={{
              ...inputStyle,
              width: "auto",
              padding: "8px 10px",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color:
                currentInlineModelId === DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID
                  ? "var(--ink)"
                  : "var(--muted)",
              cursor: "default",
              whiteSpace: "nowrap",
              borderColor:
                currentInlineModelId === DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID
                  ? "color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
                  : "var(--rule-soft)",
              background:
                currentInlineModelId === DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID
                  ? "color-mix(in oklch, var(--accent) 12%, transparent)"
                  : "color-mix(in oklch, var(--ink) 3%, transparent)",
            }}
          >
            Default
          </button>
        </div>
        <div
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {currentInlinePreset
            ? `${currentInlinePreset.label} is selected.`
            : currentInlineModelId
              ? "Custom OpenRouter model selected."
              : "No model selected."}{" "}
          Paste any OpenRouter model id to override the presets.
        </div>
      </div>
    </div>
  );
}

const ALL_AGENT_RUNTIME_KINDS: ReadonlyArray<AgentRuntimeKind> = ["claude", "codex"];

function AgentsSettings({
  draft,
  onChange,
}: {
  draft: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  const [diagnostics, setDiagnostics] = useState<AgentRuntimeDiagnostic[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.spark.agents
      .runtimes(true)
      .then((next) => {
        if (!alive) return;
        setDiagnostics(next);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const enabledKinds = enabledRuntimeKinds(draft.agentRuntimeSelection);

  const toggleRuntime = (kind: AgentRuntimeKind) => {
    const next = new Set(enabledKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    // Preserve canonical order so the persisted form is stable.
    const ordered = ALL_AGENT_RUNTIME_KINDS.filter((k) => next.has(k));
    onChange({ ...draft, agentRuntimeSelection: ordered });
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gap: 12 }}>
        <SectionTitle
          title="Agent runtimes"
          detail="Pick which local agent CLIs Spark may dispatch workers to. Each runtime can be toggled independently — deselect any that you do not want Spark to spawn."
        />
        <div style={{ display: "grid", gap: 8 }}>
          {diagnostics?.map((runtime) => (
            <RuntimeDiagnosticRow
              key={runtime.kind}
              runtime={runtime}
              enabled={enabledKinds.has(runtime.kind)}
              onToggle={() => toggleRuntime(runtime.kind)}
            />
          ))}
          {!diagnostics && !error ? (
            <RuntimeDiagnosticSkeleton />
          ) : null}
          {error ? (
            <div style={{ color: "var(--danger)", fontFamily: "var(--font-sans)", fontSize: 12 }}>
              {error}
            </div>
          ) : null}
        </div>
      </div>
      <div
        style={{
          border: "1px solid var(--rule-soft)",
          borderRadius: 8,
          padding: 12,
          background: "color-mix(in oklch, var(--ink) 3%, transparent)",
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        MCP servers and skills now live in the Capability Center from the Spark composer. That space is larger and gives
        per-item activation, compatibility, deletion, and sync controls.
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <SectionTitle
          title="Stuck-worker watchdog"
          detail="Three-channel idle detector. A worker is killed and auto-restarted from its on-disk state only when the pty stream, the agent's session log, and the workspace filesystem are ALL silent for the threshold. Long thinks and tool work each ping at least one channel, so false positives are essentially zero."
        />
        <ToggleRow
          title="Auto-kill stuck workers"
          desc="If a Claude or Codex worker stops emitting any activity at all, kill it and (optionally) spin up a fresh attempt on the same task."
          checked={draft.workerStuckDetectEnabled}
          onChange={(workerStuckDetectEnabled) =>
            onChange({ ...draft, workerStuckDetectEnabled })
          }
        />
        <NumberRow
          title="Idle threshold (seconds)"
          desc="All three channels (pty, session log, workspace) must be silent for this long before the worker is declared stuck. Default 180s."
          min={60}
          max={3600}
          value={draft.workerStuckIdleSeconds}
          disabled={!draft.workerStuckDetectEnabled}
          onChange={(workerStuckIdleSeconds) =>
            onChange({ ...draft, workerStuckIdleSeconds })
          }
        />
        <NumberRow
          title="Max auto-retries per task"
          desc="After this many stuck-fails on the same task, Spark stops auto-retrying and surfaces it to the planner instead. 0 disables auto-retry (kill only). Default 2."
          min={0}
          max={5}
          value={draft.workerStuckMaxAutoRetries}
          disabled={!draft.workerStuckDetectEnabled}
          onChange={(workerStuckMaxAutoRetries) =>
            onChange({ ...draft, workerStuckMaxAutoRetries })
          }
        />
      </div>
    </div>
  );
}

function NumberRow({
  title,
  desc,
  min,
  max,
  value,
  disabled,
  onChange,
}: {
  title: string;
  desc: string;
  min: number;
  max: number;
  value: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 0",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
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
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.45,
            marginTop: 2,
          }}
        >
          {desc}
        </div>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, Math.trunc(next))));
        }}
        style={{
          width: 72,
          flex: "0 0 72px",
          padding: "6px 8px",
          borderRadius: 6,
          border: "1px solid var(--rule-strong)",
          background: "var(--panel)",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          textAlign: "right",
        }}
      />
    </div>
  );
}

type CapabilityChipTone = "neutral" | "success" | "warning" | "blue" | "violet";

function CapabilityChip({
  text,
  tone,
  title,
}: {
  text: string;
  tone: CapabilityChipTone;
  title?: string;
}) {
  const palette: Record<CapabilityChipTone, { bg: string; border: string; color: string }> = {
    neutral: {
      bg: "color-mix(in oklch, var(--ink) 6%, transparent)",
      border: "var(--rule-soft)",
      color: "var(--muted)",
    },
    success: {
      bg: "color-mix(in oklch, #55d68a 12%, transparent)",
      border: "color-mix(in oklch, #55d68a 28%, var(--rule-soft))",
      color: "#92e8b2",
    },
    warning: {
      bg: "color-mix(in oklch, #f0c419 12%, transparent)",
      border: "color-mix(in oklch, #f0c419 30%, var(--rule-soft))",
      color: "#f4d35e",
    },
    blue: {
      bg: "color-mix(in oklch, #6ea8ff 13%, transparent)",
      border: "color-mix(in oklch, #6ea8ff 32%, var(--rule-soft))",
      color: "#9cc4ff",
    },
    violet: {
      bg: "color-mix(in oklch, var(--accent) 13%, transparent)",
      border: "color-mix(in oklch, var(--accent) 35%, var(--rule-soft))",
      color: "var(--accent)",
    },
  };
  const p = palette[tone];
  return (
    <span
      title={title}
      style={{
        border: `1px solid ${p.border}`,
        borderRadius: 999,
        background: p.bg,
        color: p.color,
        padding: "2px 6px",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function enabledRuntimeKinds(selection: AgentRuntimeSelection): Set<AgentRuntimeKind> {
  if (Array.isArray(selection)) {
    return new Set(selection.filter((kind) => ALL_AGENT_RUNTIME_KINDS.includes(kind)));
  }
  if (selection === "claude") return new Set<AgentRuntimeKind>(["claude"]);
  if (selection === "codex") return new Set<AgentRuntimeKind>(["codex"]);
  if (selection === "both") return new Set<AgentRuntimeKind>(["claude", "codex"]);
  return new Set<AgentRuntimeKind>(ALL_AGENT_RUNTIME_KINDS);
}

function RuntimeDiagnosticRow({
  runtime,
  enabled,
  onToggle,
}: {
  runtime: AgentRuntimeDiagnostic;
  enabled: boolean;
  onToggle: () => void;
}) {
  const active = runtime.installed && enabled;
  const status = !runtime.installed
    ? "Missing"
    : enabled
      ? "Enabled"
      : "Off";
  const dotColor = active
    ? "var(--accent)"
    : runtime.installed
      ? "var(--muted)"
      : "var(--danger)";
  const detail = runtime.installed
    ? runtime.version || runtime.executablePath || "Installed"
    : runtime.installHint;
  const canToggle = runtime.installed;

  return (
    <button
      type="button"
      onClick={canToggle ? onToggle : undefined}
      disabled={!canToggle}
      title={
        !canToggle
          ? "Install this runtime to enable it."
          : enabled
            ? `Click to disable ${runtime.label} workers.`
            : `Click to enable ${runtime.label} workers.`
      }
      style={{
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) auto auto",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        border: "1px solid var(--rule-soft)",
        borderRadius: 8,
        background: active
          ? "color-mix(in oklch, var(--accent) 7%, transparent)"
          : "color-mix(in oklch, var(--ink) 3%, transparent)",
        cursor: canToggle ? "pointer" : "not-allowed",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
        width: "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: dotColor,
          boxShadow: active ? "0 0 8px var(--accent-glow)" : "none",
        }}
      />
      <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
        <span
          style={{
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 650,
          }}
        >
          {runtime.label}
        </span>
        <span
          title={detail}
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {detail}
        </span>
        {runtime.installed ? (
          <span style={capabilityChipRowStyle}>
            <Capability runtime={runtime} feature="costTracking">
              <CapabilityChip text="cost" tone="neutral" title="Reports per-run cost" />
            </Capability>
            <Capability runtime={runtime} feature="contextWindow">
              <CapabilityChip text="context" tone="neutral" title="Reports context-window usage" />
            </Capability>
            <Capability runtime={runtime} feature="hookStatus">
              <CapabilityChip text="hooks" tone="neutral" title="Supports hook status events" />
            </Capability>
            <Capability runtime={runtime} feature="planModeArg">
              <CapabilityChip text="plan-mode" tone="neutral" title="Accepts a plan-mode argument" />
            </Capability>
            <Capability runtime={runtime} feature="shiftEnterNewline">
              <CapabilityChip text="shift+enter" tone="neutral" title="Supports shift+enter newline" />
            </Capability>
            <Capability runtime={runtime} feature="systemPromptInjection">
              <CapabilityChip text="sys-prompt" tone="neutral" title="Accepts an injected system prompt" />
            </Capability>
            <Capability runtime={runtime} feature="sessionResume">
              <CapabilityChip text="resume" tone="neutral" title="Supports session resume" />
            </Capability>
          </span>
        ) : null}
      </span>
      <span
        style={{
          color: active ? "var(--ink)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {status}
      </span>
      <RuntimeToggle on={enabled} disabled={!canToggle} />
    </button>
  );
}

const capabilityChipRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 4,
};

function RuntimeToggle({ on, disabled }: { on: boolean; disabled?: boolean }) {
  const width = 28;
  const height = 16;
  const knob = 12;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        position: "relative",
        width,
        height,
        borderRadius: 999,
        background: disabled
          ? "color-mix(in oklch, var(--ink) 8%, transparent)"
          : on
            ? "var(--accent)"
            : "color-mix(in oklch, var(--ink) 18%, transparent)",
        opacity: disabled ? 0.55 : 1,
        transition: "background 120ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: (height - knob) / 2,
          left: on ? width - knob - 2 : 2,
          width: knob,
          height: knob,
          borderRadius: 999,
          background: "var(--surface)",
          transition: "left 120ms ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        }}
      />
    </span>
  );
}

function RuntimeDiagnosticSkeleton() {
  return (
    <div
      style={{
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        padding: "10px 0",
      }}
    >
      Checking Claude, Codex, and Cursor...
    </div>
  );
}

// Wrapper that hydrates preferences and forwards them to the keybindings
// editor. Kept here so the section follows the same import/colocation
// pattern as the other Settings tabs.
function KeybindingsTab() {
  const { preferences, setPreference, hydrated } = usePreferences();
  if (!hydrated) {
    return (
      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
        }}
      >
        Loading…
      </div>
    );
  }
  return <KeybindingsSection preferences={preferences} setPreference={setPreference} />;
}

// Cross-workspace runs index. Shows every run on disk with its status,
// title, workspace, created-at, and id. Each row has Open (close the
// dialog and surface the run on the canvas) and Delete (hard-delete via
// the same code path the runs list uses, including the Force-pause-then-
// remove flow that bypasses Windows' "are you sure?" prompts).
function RunsSettings({
  onOpenRun,
}: {
  onOpenRun: (runId: string, workspaceId: string) => void;
}) {
  const [runs, setRuns] = useState<RunState[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({});
  // Pending trailing-debounce handle for the event-driven refresh below.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    try {
      const next = await window.spark.orchestration.listRuns();
      setRuns(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Workspace ids on a RunState aren't human-readable, so we look up the
  // matching workspace name from the persisted app state. Falls back to
  // a truncated id chip when the workspace has been deleted.
  useEffect(() => {
    let alive = true;
    void window.spark.state
      .load()
      .then((state) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const ws of state.workspaces) map[ws.id] = ws.name;
        setWorkspaceNames(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.spark.orchestration.onEvent((event) => {
      // Lightweight refresh trigger: any orchestration event involving a
      // run can change the list (created, status update, deleted). We
      // re-fetch instead of patching in place — avoids a parallel state
      // tree and the list rarely exceeds a hundred items.
      if (
        event.type === "run.created" ||
        event.type === "run.deleted" ||
        event.type.startsWith("run.")
      ) {
        // A live run emits run.* events in bursts; debounce so a flurry
        // collapses into a single listRuns() once the burst settles
        // (trailing edge, ~300ms) instead of one fetch per event.
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          void refresh();
        }, 300);
      }
    });
    return () => {
      off();
      // Drop any pending debounced refresh so it can't fire post-unmount.
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, []);

  const filtered = useMemo(() => {
    if (!runs) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((run) => {
      if (run.id.toLowerCase().includes(q)) return true;
      if (run.title.toLowerCase().includes(q)) return true;
      const wsName = workspaceNames[run.workspaceId];
      if (wsName && wsName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [runs, filter, workspaceNames]);

  const deleteRun = async (run: RunState) => {
    // Confirmation is handled in-app by RunRow's two-step delete button
    // (click to arm, click again to confirm) — no native OS dialog.
    setBusyId(run.id);
    setError(null);
    try {
      await window.spark.orchestration.deleteRun(run.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <SectionTitle
        title="All runs"
        detail="Every run Spark has on disk, across every workspace. Open to inspect, Delete to remove the artifact directory."
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by id, title, or workspace"
          style={{
            flex: 1,
            appearance: "none",
            background: "var(--bg)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            padding: "7px 10px",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <FooterButton onClick={() => void refresh()}>Refresh</FooterButton>
      </div>

      {error ? (
        <div
          style={{
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            background: "color-mix(in oklch, var(--danger) 10%, transparent)",
            border: "1px solid color-mix(in oklch, var(--danger) 35%, transparent)",
            borderRadius: 6,
            padding: "6px 10px",
          }}
        >
          {error}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 360,
          overflow: "auto",
          paddingRight: 2,
        }}
      >
        {runs === null ? (
          <RunsEmptyMessage text="Loading runs…" />
        ) : filtered.length === 0 ? (
          <RunsEmptyMessage
            text={runs.length === 0 ? "No runs yet." : "No runs match that filter."}
          />
        ) : (
          filtered.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              workspaceName={workspaceNames[run.workspaceId]}
              busy={busyId === run.id}
              onOpen={() => onOpenRun(run.id, run.workspaceId)}
              onDelete={() => void deleteRun(run)}
            />
          ))
        )}
      </div>

      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.04em",
        }}
      >
        {runs ? `${filtered.length} of ${runs.length}` : ""}
      </div>
    </div>
  );
}

function RunRow({
  run,
  workspaceName,
  busy,
  onOpen,
  onDelete,
}: {
  run: RunState;
  workspaceName: string | undefined;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const status = run.status;
  const statusColor = runStatusColor(status);
  const created = formatRunCreated(run.createdAt);
  // Two-step delete: first click arms, second click confirms. Disarms when the
  // pointer leaves the button group, so a stray click never deletes a run.
  const [armed, setArmed] = useState(false);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        background: "var(--bg)",
        border: "1px solid var(--rule-soft)",
        borderRadius: 7,
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: statusColor,
          boxShadow:
            status === "running" || status === "planning" || status === "reviewing"
              ? `0 0 8px ${statusColor}`
              : "none",
        }}
      />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            title={run.title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            {run.title}
          </span>
          <span
            style={{
              flex: "0 0 auto",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              fontWeight: 600,
              color: statusColor,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {status}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            minWidth: 0,
          }}
        >
          <span
            title={run.id}
            style={{
              flex: "0 0 auto",
              padding: "1px 6px",
              borderRadius: 4,
              background: "color-mix(in oklch, var(--ink) 6%, transparent)",
              color: "var(--ink-dim)",
            }}
          >
            {run.id}
          </span>
          {workspaceName ? <span>· {workspaceName}</span> : null}
          <span style={{ marginLeft: "auto" }}>{created}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }} onMouseLeave={() => setArmed(false)}>
        <FooterButton onClick={onOpen}>Open</FooterButton>
        <DangerButton
          onClick={() => {
            if (busy) return;
            if (!armed) {
              setArmed(true);
              return;
            }
            setArmed(false);
            onDelete();
          }}
          disabled={busy}
        >
          {busy ? "…" : armed ? "Confirm delete" : "Delete"}
        </DangerButton>
      </div>
    </div>
  );
}

function DangerButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        background: disabled
          ? "transparent"
          : hover
            ? "color-mix(in oklch, var(--danger) 22%, transparent)"
            : "color-mix(in oklch, var(--danger) 10%, transparent)",
        border: `1px solid ${
          disabled
            ? "var(--rule-soft)"
            : "color-mix(in oklch, var(--danger) 45%, var(--rule-strong))"
        }`,
        borderRadius: 6,
        color: disabled ? "var(--muted)" : "var(--danger)",
        padding: "5px 10px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function RunsEmptyMessage({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "18px 12px",
        textAlign: "center",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        border: "1px dashed var(--rule-soft)",
        borderRadius: 7,
      }}
    >
      {text}
    </div>
  );
}

function formatRunCreated(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  // "2026-05-10 18:29" — short and unambiguous; the row already shows the
  // run id for disambiguation if two runs share a creation minute.
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AboutSettings() {
  const [platform, setPlatform] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void window.spark.app.platform().then((p) => {
      if (alive) setPlatform(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  const version = (packageJson as { version: string }).version;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <SectionTitle
        title="About"
        detail="Spark Agent — terminal multiplexer with orchestration."
      />
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 8,
          columnGap: 16,
          margin: 0,
          fontFamily: "var(--font-sans)",
          fontSize: 12,
        }}
      >
        <MetaRow label="Version" value={`v${version}`} mono />
        <MetaRow label="Platform" value={platform || "—"} mono />
        <MetaRow label="App ID" value="com.spark.agent" mono />
      </dl>
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt
        style={{
          color: "var(--muted)",
          fontWeight: 600,
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          color: "var(--ink)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: mono ? 11 : 12,
        }}
      >
        {value}
      </dd>
    </>
  );
}

function ThemeCard({
  label,
  swatches,
  active,
  onClick,
}: {
  label: string;
  swatches: readonly [string, string, string, string];
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Use ${label} theme`}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        position: "relative",
        overflow: "hidden",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 62%, var(--rule-strong))"
          : hover
            ? "1px solid color-mix(in oklch, var(--ink) 16%, var(--rule-soft))"
            : "1px solid var(--rule-soft)",
        background: active
          ? "color-mix(in oklch, var(--accent) 7%, var(--panel))"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "color-mix(in oklch, var(--panel) 70%, transparent)",
        borderRadius: 8,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 8,
        color: "var(--ink)",
        cursor: "pointer",
        minHeight: 104,
        minWidth: 0,
        textAlign: "left",
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 18%, transparent), var(--shadow-1)"
          : hover
            ? "var(--shadow-1)"
            : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {active ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 9,
            right: 9,
            width: 7,
            height: 7,
            borderRadius: 2,
            background: "var(--accent)",
            boxShadow: "0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent)",
          }}
        />
      ) : null}
      <span
        aria-hidden
        style={{
          display: "grid",
          gridTemplateRows: "12px 1fr",
          gap: 6,
          height: 58,
          borderRadius: 6,
          border: `1px solid color-mix(in srgb, ${swatches[1]} 72%, ${swatches[3]} 28%)`,
          background: swatches[0],
          padding: 7,
        }}
      >
        <span
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 18px 10px",
            gap: 5,
          }}
        >
          <span style={{ borderRadius: 3, background: swatches[1] }} />
          <span style={{ borderRadius: 3, background: swatches[2] }} />
          <span style={{ borderRadius: 3, background: swatches[3], opacity: 0.72 }} />
        </span>
        <span
          style={{
            display: "grid",
            gridTemplateColumns: "18px 1fr",
            gap: 6,
            minHeight: 0,
          }}
        >
          <span style={{ borderRadius: 4, background: swatches[2] }} />
          <span style={{ display: "grid", alignContent: "center", gap: 5 }}>
            <span
              style={{
                width: "84%",
                height: 7,
                borderRadius: 3,
                background: swatches[3],
                opacity: 0.86,
              }}
            />
            <span
              style={{
                width: "58%",
                height: 7,
                borderRadius: 3,
                background: swatches[3],
                opacity: 0.42,
              }}
            />
          </span>
        </span>
      </span>
      <span
        style={{
          color: active ? "var(--ink)" : "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.25,
          overflowWrap: "anywhere",
        }}
      >
        {label}
      </span>
    </button>
  );
}

interface CustomSelectOption {
  value: string;
  label: string;
}

// Replaces the native <select> dropdown — Chromium's OS-rendered popup on
// Windows ignores our theme variables, so unselected options render with
// near-zero contrast in dark mode. This in-app dropdown is an absolutely-
// positioned panel anchored to the trigger, themed with the dialog's
// tokens, and dismissed on outside-click / Escape / blur.
function CustomSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ReadonlyArray<CustomSelectOption>;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !popupRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          ...inputStyle,
          fontSize: 13,
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          cursor: "default",
          background: hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "color-mix(in oklch, var(--ink) 3%, transparent)",
          borderColor: open
            ? "color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
            : "var(--rule-soft)",
        }}
      >
        <span style={{ color: "var(--ink)" }}>
          {current?.label ?? value}
        </span>
        <span
          aria-hidden
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={popupRef}
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 10,
            background: "var(--panel)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 7,
            boxShadow: "var(--shadow-2)",
            padding: 4,
            maxHeight: 240,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {options.map((opt) => (
            <SelectOption
              key={opt.value}
              label={opt.label}
              active={opt.value === value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SelectOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        textAlign: "left",
        border: "none",
        borderRadius: 5,
        background: active
          ? "color-mix(in oklch, var(--accent) 22%, transparent)"
          : hover
            ? "color-mix(in oklch, var(--ink) 6%, transparent)"
            : "transparent",
        color: "var(--ink)",
        padding: "7px 10px",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function TimingPresetButton({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        textAlign: "left",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 46%, var(--rule-strong))"
          : hover
            ? "1px solid var(--rule-soft)"
            : "1px solid transparent",
        borderRadius: 7,
        background: active
          ? "color-mix(in oklch, var(--accent) 10%, transparent)"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: "var(--ink)",
        padding: "7px 9px",
        cursor: "default",
        display: "grid",
        gap: 2,
        minHeight: 46,
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 14%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 700,
          color: active ? "var(--ink)" : "var(--ink-dim)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          lineHeight: 1.3,
          color: "var(--muted)",
        }}
      >
        {hint}
      </span>
    </button>
  );
}

function ModelPresetCard({
  label,
  modelId,
  hint,
  detail,
  badge,
  active,
  onClick,
}: {
  label: string;
  modelId: string;
  hint: string;
  detail: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Use ${label} for Inline AI`}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        textAlign: "left",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
          : hover
            ? "1px solid var(--rule-soft)"
            : "1px solid transparent",
        borderRadius: 8,
        background: active
          ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: "var(--ink)",
        padding: "9px 11px",
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr)",
        gap: 12,
        alignItems: "center",
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 16%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: active ? "var(--accent)" : "var(--rule-strong)",
          boxShadow: active ? "0 0 8px var(--accent-glow)" : "none",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      />
      <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
          {badge && (
            <span
              style={{
                color: active ? "var(--ink)" : "var(--muted)",
                border: active
                  ? "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
                  : "1px solid var(--rule-soft)",
                borderRadius: 999,
                padding: "1px 6px",
                fontFamily: "var(--font-sans)",
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                flex: "0 0 auto",
              }}
            >
              {badge}
            </span>
          )}
        </span>
        <span
          title={modelId}
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {modelId}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </span>
        <span
          style={{
            color: "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            lineHeight: 1.35,
          }}
        >
          {detail}
        </span>
      </span>
    </button>
  );
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 0",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
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
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.45,
            marginTop: 2,
          }}
        >
          {desc}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        appearance: "none",
        position: "relative",
        width: 34,
        height: 20,
        flex: "0 0 34px",
        borderRadius: 999,
        border: checked
          ? "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
          : "1px solid var(--rule-strong)",
        background: checked
          ? "color-mix(in oklch, var(--accent) 32%, var(--panel))"
          : "color-mix(in oklch, var(--ink) 5%, transparent)",
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        padding: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 1,
          left: checked ? 16 : 1,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: checked ? "var(--accent)" : "var(--ink-dim)",
          boxShadow: checked ? "0 0 8px var(--accent-glow)" : "none",
          transition:
            "left var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      />
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--rule-soft)",
  borderRadius: 7,
  background: "color-mix(in oklch, var(--ink) 3%, transparent)",
  color: "var(--ink)",
  padding: "8px 10px",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  transition:
    "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
};
