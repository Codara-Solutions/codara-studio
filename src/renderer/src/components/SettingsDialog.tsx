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
  DEFAULT_COPY_BRANCH_SETUP_COMMAND,
  DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID,
  EDITOR_THEME_IDS,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MAX,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MIN,
  AUTOSAVE_DELAY_PRESETS,
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

// ── Shared interaction state ─────────────────────────────────────────────────
// Hand-rolled buttons in this dialog set inline box-shadow, which silently wins
// over the global :focus-visible ring (the ring rule isn't !important). Each
// custom control tracks hover / focus-visible / press locally and composes the
// accent --focus-ring + the --press settle back into its inline box-shadow so
// keyboard focus actually renders and every click has a tactile beat. Native
// elements that DON'T set an inline box-shadow (e.g. .spark-* utilities) inherit
// the global ring for free and don't need this.
function useInteractive() {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressed, setPressed] = useState(false);
  const handlers = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setPressed(false);
    },
    onMouseDown: () => setPressed(true),
    onMouseUp: () => setPressed(false),
    onFocus: (event: React.FocusEvent) => {
      // Only light the ring for keyboard focus, matching :focus-visible.
      if (event.target.matches(":focus-visible")) setFocus(true);
    },
    onBlur: () => {
      setFocus(false);
      setPressed(false);
    },
  };
  return { hover, focus, pressed, handlers };
}

// Compose an optional base box-shadow with the focus ring when keyboard-focused.
// Keeps the resting shadow intact and only adds the accent ring on focus-visible.
function withFocusRing(base: string | undefined, focus: boolean): string | undefined {
  if (!focus) return base;
  if (!base || base === "none") return "var(--focus-ring)";
  return `${base}, var(--focus-ring)`;
}

// The recurring 7-8px accent selection dot + its soft glow, in one place so the
// size, radius, and glow never drift between rows, cards, and presets.
function AccentDot({ active, size = 8 }: { active: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: 999,
        background: active ? "var(--accent)" : "var(--rule-strong)",
        boxShadow: active ? "0 0 8px var(--accent-glow)" : "none",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    />
  );
}

// One crisp 16px / ~1.5px-stroke SVG per nav tab, drawn at currentColor so the
// icon inherits the row's ink (dim when inactive, --ink when selected). Each
// sits in a fixed 18px leading slot in TabButton so all labels share one
// x-origin and nothing reflows on selection. Single stroke/geometry family,
// matching the app's SVG icons — never Unicode glyphs.
function NavIcon({ tab }: { tab: SettingsTab }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (tab) {
    case "general": // sliders / controls
      return (
        <svg {...common}>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2" />
          <circle cx="15" cy="17" r="2" />
        </svg>
      );
    case "editor": // code / angle brackets
      return (
        <svg {...common}>
          <path d="M9 8l-4 4 4 4" />
          <path d="M15 8l4 4-4 4" />
        </svg>
      );
    case "terminal": // terminal prompt ">_"
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 10l2.5 2L7 14" />
          <line x1="12.5" y1="15" x2="16" y2="15" />
        </svg>
      );
    case "api": // key
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3.5" />
          <path d="M10.5 10.5L20 20" />
          <path d="M16 16l2-2" />
          <path d="M18.5 18.5l2-2" />
        </svg>
      );
    case "agents": // spark / robot
      return (
        <svg {...common}>
          <rect x="5" y="9" width="14" height="10" rx="2.5" />
          <line x1="12" y1="5" x2="12" y2="9" />
          <circle cx="12" cy="4" r="1.2" />
          <circle cx="9.5" cy="14" r="1" />
          <circle cx="14.5" cy="14" r="1" />
        </svg>
      );
    case "keybindings": // command key (⌘) drawn as SVG, not a glyph
      return (
        <svg {...common}>
          <path d="M9 9a2 2 0 1 1 2 2H9V9z" />
          <path d="M15 9a2 2 0 1 0-2 2h2V9z" />
          <path d="M9 15a2 2 0 1 0 2-2H9v2z" />
          <path d="M15 15a2 2 0 1 1-2-2h2v2z" />
          <rect x="9" y="9" width="6" height="6" rx="0.5" />
        </svg>
      );
    case "runs": // activity / pulse
      return (
        <svg {...common}>
          <path d="M3 12h4l2.5-6 4 13 2.5-7H21" />
        </svg>
      );
    case "about": // info circle
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16.5" />
          <circle cx="12" cy="7.75" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

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
  workspaceCwd,
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
        fontFamily: "var(--font-sans)",
      }}
      onMouseDown={onClose}
    >
      {/* Scrim + dialog face come from the shared glass classes (frosted in
          glass mode, opaque panel look otherwise). */}
      <div className="spark-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="spark-glass--strong"
        style={{
          zIndex: 1,
          // Fixed footprint — switching tabs (or resizing the inner content)
          // shouldn't make the dialog grow or shrink. Only the inner content
          // pane scrolls; the dialog stays the same size. Sized like macOS
          // System Settings so the nav + content pane both breathe.
          width: "min(860px, calc(100vw - 44px))",
          height: "min(760px, calc(100vh - 44px))",
          display: "flex",
          flexDirection: "column",
          borderRadius: 12,
          overflow: "hidden",
          padding: 0,
          animation: "spark-fade-in var(--motion) var(--ease-out)",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "15px 22px",
            borderBottom: "1px solid var(--rule-soft)",
            // A raised header band: the 1px top highlight lifts it off the body.
            boxShadow: "var(--lift-hi)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <AccentDot active size={7} />
          {/* A real System-Settings title: title case at 15px/600, not an
              all-caps tracked eyebrow. The accent dot supplies the brand mark. */}
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 15,
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
              flex: "0 0 200px",
              borderRight: "1px solid var(--rule-soft)",
              // Translucent so the dialog's glass face shows through; over the
              // opaque fallback face it reads like the old --bg/--panel mix.
              background: "color-mix(in oklch, var(--bg) 45%, transparent)",
              padding: "12px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {TABS.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab.id}
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
              padding: "24px 28px 30px",
              overflow: "auto",
            }}
          >
            {activeTab === "general" && <GeneralSettings workspaceCwd={workspaceCwd} />}
            {activeTab === "editor" && <EditorSettings />}
            {activeTab === "terminal" && (
              <TerminalSettings
                shells={shells}
                selectedShellId={selectedShell?.id ?? null}
                scrollbackLineLimit={draft.terminalScrollbackLineLimit}
                onSelect={(defaultShellId) =>
                  setDraft((current) => ({ ...current, defaultShellId }))
                }
                onScrollbackLineLimitChange={(terminalScrollbackLineLimit) =>
                  setDraft((current) => ({ ...current, terminalScrollbackLineLimit }))
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
  scrollbackLineLimit,
  onSelect,
  onScrollbackLineLimitChange,
}: {
  shells: ShellInfo[];
  selectedShellId: string | null;
  scrollbackLineLimit: number;
  onSelect: (shellId: string) => void;
  onScrollbackLineLimitChange: (lineLimit: number) => void;
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
      <div style={{ marginTop: 22 }}>
        <SectionTitle
          title="Output history"
          detail="Applies to manual terminals, worker panes, and chat backend terminal views."
        />
        <NumberRow
          title="Scrollback lines"
          desc={`Keep at most this many terminal output lines in memory. Range ${TERMINAL_SCROLLBACK_LINE_LIMIT_MIN.toLocaleString()}-${TERMINAL_SCROLLBACK_LINE_LIMIT_MAX.toLocaleString()} lines.`}
          min={TERMINAL_SCROLLBACK_LINE_LIMIT_MIN}
          max={TERMINAL_SCROLLBACK_LINE_LIMIT_MAX}
          value={scrollbackLineLimit}
          onChange={onScrollbackLineLimitChange}
        />
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
  const { hover, focus, pressed, handlers } = useInteractive();
  // Selected carries a single soft cue: accent-soft fill + accent-edge border.
  // No stacked ring + shadow + lift halo. Font-weight is held constant.
  const restShadow = selected ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      aria-label={`Use ${shell.label} as default terminal`}
      aria-pressed={selected}
      onClick={onSelect}
      {...handlers}
      style={{
        appearance: "none",
        width: "100%",
        textAlign: "left",
        border: selected
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
        background: selected
          ? "var(--accent-soft)"
          : pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: "var(--ink)",
        padding: "10px 11px",
        fontFamily: "var(--font-sans)",
        // Terminal-native idiom: chrome controls keep the default arrow cursor,
        // matching the .spark-* utility classes (no cursor:pointer anywhere).
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        boxShadow: withFocusRing(restShadow, focus),
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <AccentDot active={selected} />
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
    <div style={{ display: "grid", gap: 12 }}>
      <SectionTitle
        title="OpenRouter"
        detail="Used by Cora to plan Claude and Codex worker tasks."
      />
      <Label text="OpenRouter API key">
        <input
          className="spark-input"
          type="password"
          value={draft.openRouterApiKey}
          onChange={(event) => onChange({ ...draft, openRouterApiKey: event.currentTarget.value })}
          placeholder="sk-or-..."
          style={inputShellStyle}
        />
      </Label>
      <Label text="Model">
        <input
          className="spark-input spark-mono"
          type="text"
          value={draft.openRouterModel}
          onChange={(event) => onChange({ ...draft, openRouterModel: event.currentTarget.value })}
          placeholder="google/gemini-flash-latest"
          style={inputShellStyle}
        />
      </Label>
    </div>
  );
}

function TabButton({
  tab,
  label,
  active,
  onClick,
}: {
  tab: SettingsTab;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const { hover, focus, pressed, handlers } = useInteractive();
  // A quiet macOS-style sidebar row: selection is a calm ink fill alone — no
  // glow halo, no border swap. Font-weight is held constant across states
  // (color carries selection) so the label never reflows. A 16px nav icon sits
  // in a fixed 18px leading slot so every label shares one x-origin; the icon
  // dims to --muted when inactive and rises to --ink when the row is selected.
  const restShadow = active ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      {...handlers}
      style={{
        appearance: "none",
        width: "100%",
        border: "1px solid transparent",
        borderRadius: "var(--radius-control, 5px)",
        background: active
          ? "color-mix(in oklch, var(--ink) 7%, var(--panel))"
          : pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "8px 10px",
        textAlign: "left",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.005em",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        display: "flex",
        alignItems: "center",
        gap: 9,
        boxShadow: withFocusRing(restShadow, focus),
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 18px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-start",
          // Icon ink tracks selection: --muted at rest, --ink when current.
          color: active ? "var(--ink)" : "var(--muted)",
          transition: "color var(--motion-fast) var(--ease-out)",
        }}
      >
        <NavIcon tab={tab} />
      </span>
      {label}
    </button>
  );
}

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <div className="spark-eyebrow" style={{ fontFamily: "var(--font-sans)" }}>
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
      <span className="spark-eyebrow" style={{ fontSize: 11 }}>
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
  // The shared button vocabulary — consistent radius, hover, translateY+well
  // press, disabled treatment, and the global focus-visible ring for free.
  return (
    <button
      type="button"
      className={primary ? "spark-btn is-primary" : "spark-btn"}
      onClick={onClick}
      disabled={disabled}
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
  "codara-classic": {
    label: "Codara Classic",
    swatches: ["#191914", "#25241f", "#f0c419", "#f5f2e9"],
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    swatches: ["#1e1e2e", "#313244", "#89b4fa", "#cdd6f4"],
  },
  dracula: {
    label: "Dracula",
    swatches: ["#282a36", "#44475a", "#bd93f9", "#f8f8f2"],
  },
  "one-dark": {
    label: "One Dark",
    swatches: ["#282c34", "#2c313a", "#61afef", "#abb2bf"],
  },
  "codara-daylight": {
    label: "Codara Daylight",
    swatches: ["#faf9f5", "#eae7dd", "#f0c419", "#211f1a"],
  },
  "github-light": {
    label: "GitHub Light",
    swatches: ["#ffffff", "#eaeef2", "#0969da", "#1f2328"],
  },
  "rose-pine-dawn": {
    label: "Rosé Pine Dawn",
    swatches: ["#faf4ed", "#f2e9e1", "#d7827e", "#575279"],
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    swatches: ["#f3f5f8", "#dce0e8", "#1e66f5", "#4c4f69"],
  },
};

const APPEARANCE = APP_THEME_IDS.map((id) => ({
  id,
  ...APP_THEME_META[id],
}));

function GeneralSettings({ workspaceCwd }: { workspaceCwd?: string | null }) {
  const { theme, setTheme } = useTheme();
  const { preferences, hydrated, setPreference } = usePreferences();
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <SectionTitle title="Appearance" detail="Comfortable palettes people actually keep using." />
      <div
        style={{
          display: "grid",
          // Two roomy columns in the widened pane; the cards now breathe with a
          // generous gap instead of feeling squeezed against the nav.
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
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

      {hydrated ? (
        <>
          <ToggleRow
            title="Liquid glass surfaces"
            desc="Frosted, translucent popovers, toasts, and dialogs. Turn off for fully opaque surfaces (also forced off by the OS reduced-transparency setting)."
            checked={preferences.glassEffects !== false}
            onChange={(v) => void setPreference("glassEffects", v)}
          />
          {preferences.glassEffects !== false && (
            <div
              style={{
                display: "grid",
                gap: 10,
                padding: "10px 12px",
                border: "1px solid var(--rule-soft)",
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span className="spark-eyebrow" style={{ fontSize: 11 }}>
                  Glass tuning
                </span>
                <button
                  type="button"
                  className="spark-menu-item"
                  style={{ width: "auto", fontSize: 11, color: "var(--muted)" }}
                  onClick={() => {
                    void setPreference("glassVeil", 100);
                    void setPreference("glassBlur", 100);
                    void setPreference("glassRefraction", 100);
                    void setPreference("glassChroma", 100);
                  }}
                >
                  Reset
                </button>
              </div>
              <GlassSliderRow
                label="Tint"
                hint="Surface tint strength — lower is clearer"
                // Floor at 10%: veil 0 + blur 0 leaves menus as border-only
                // outlines over live content, which reads as a rendering bug.
                min={10}
                value={preferences.glassVeil ?? 100}
                onChange={(v) => void setPreference("glassVeil", v)}
              />
              <GlassSliderRow
                label="Blur"
                hint="Backdrop blur behind the surface"
                value={preferences.glassBlur ?? 100}
                onChange={(v) => void setPreference("glassBlur", v)}
              />
              <GlassSliderRow
                label="Refraction"
                hint="How much the edges bend what's behind"
                value={preferences.glassRefraction ?? 100}
                onChange={(v) => void setPreference("glassRefraction", v)}
              />
              <GlassSliderRow
                label="Chromatic fringe"
                hint="Color split along the refracting rim"
                value={preferences.glassChroma ?? 100}
                onChange={(v) => void setPreference("glassChroma", v)}
              />
            </div>
          )}
        </>
      ) : null}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <SectionTitle
        title="Window"
        detail="Control what happens when you close the main window."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="Keep running in the background when the window is closed"
            desc="Closing the window hides Codara Studio to the system tray instead of quitting, so automations keep running. Quit from the tray menu."
            checked={preferences.keepRunningInBackground !== false}
            onChange={(v) => void setPreference("keepRunningInBackground", v)}
          />
          <ToggleRow
            title="Auto-open preview for local dev servers"
            desc="When an agent or terminal prints a localhost URL (e.g. a Vite/Next dev server), automatically open it in a preview tab. When off, a clickable chip appears instead."
            checked={Boolean(preferences.autoOpenPreview)}
            onChange={(v) => void setPreference("autoOpenPreview", v)}
          />
        </div>
      ) : null}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <SectionTitle
        title="Agent sessions"
        detail="Continue Claude/Codex terminal conversations across app restarts."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="Resume agent sessions on relaunch"
            desc="Panes whose Claude/Codex agent was running at quit relaunch it with --resume, terminal output is restored, and a pane whose shell dies under a live agent (sleep, crash) resumes in place. When off, every relaunch starts fresh shells."
            checked={preferences.restoreAgentSessions === true}
            onChange={(v) => void setPreference("restoreAgentSessions", v)}
          />
        </div>
      ) : null}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

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

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <SectionTitle
        title="Tabs"
        detail="How the workspace tab strip responds to the mouse."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="Middle-click to close tabs"
            desc="Click a tab with the mouse wheel button to close it, just like the × button."
            checked={preferences.closeTabsOnMiddleClick}
            onChange={(v) => void setPreference("closeTabsOnMiddleClick", v)}
          />
        </div>
      ) : null}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <SectionTitle
        title="Notifications"
        detail="Pick which channels fire when a run — or a Claude/Codex CLI you ran in a terminal — is blocked or finishes while you're away. The in-app toast and the native OS notification never fire together: you get the toast while Codara Studio is focused, and the OS notification when it's minimized or in the background — never both at once. Turn off Native OS notification to stop those system alerts, or Embedded sound clip to silence the chime. Alerts never fire when you're already watching that chat or terminal tab; the workspace rail still shows a quiet dot until you visit it."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="In-app toast"
            desc="Stacked top-right card, shown while Codara Studio is focused. Click to jump to the chat or terminal that needs you."
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
            desc="System notification-center alert, shown only when Codara Studio is minimized or in the background — so it never doubles up with the in-app toast."
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
            desc="macOS dock badge / Windows taskbar flash. Clears when you focus Codara Studio."
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

      {workspaceCwd ? <CopyBranchSetupField workspaceCwd={workspaceCwd} /> : null}
    </div>
  );
}

function CopyBranchSetupField({ workspaceCwd }: { workspaceCwd: string }) {
  const { preferences, hydrated, setPreference } = usePreferences();
  const stored = preferences.copyBranchSetupCommandByRepo?.[workspaceCwd];
  const [text, setText] = useState<string>(stored ?? DEFAULT_COPY_BRANCH_SETUP_COMMAND);

  useEffect(() => {
    setText(
      preferences.copyBranchSetupCommandByRepo?.[workspaceCwd] ??
        DEFAULT_COPY_BRANCH_SETUP_COMMAND,
    );
  }, [workspaceCwd, preferences.copyBranchSetupCommandByRepo]);

  if (!hydrated) return null;

  const commit = () => {
    const trimmed = text.trim();
    const next = { ...(preferences.copyBranchSetupCommandByRepo ?? {}) };
    // Store only meaningful overrides; the default is implicit.
    if (!trimmed || trimmed === DEFAULT_COPY_BRANCH_SETUP_COMMAND) {
      delete next[workspaceCwd];
    } else {
      next[workspaceCwd] = trimmed;
    }
    void setPreference("copyBranchSetupCommandByRepo", next);
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <hr className="spark-divider" style={{ margin: "2px 0" }} />
      <SectionTitle
        title="Copy-branch workspaces"
        detail="Optional. Command run in a terminal in a new copy-branch worktree to restore deps git doesn't track (e.g. pnpm install). Blank = no setup. Saved for this repo."
      />
      <Label text="Setup command">
        <input
          className="spark-input spark-mono"
          type="text"
          value={text}
          spellCheck={false}
          placeholder="e.g. pnpm install — leave blank for none"
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              e.currentTarget.blur();
            }
          }}
          style={inputShellStyle}
        />
      </Label>
    </div>
  );
}

// The "reset to recommended model" button. When the field already holds the
// default it reads as accent-lit selected; otherwise it's a quiet ghost button.
// Press + focus-visible compose into the inline box-shadow so the click is
// tactile and the keyboard ring renders.
function DefaultModelButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { hover, focus, pressed, handlers } = useInteractive();
  const restShadow = active ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      aria-label="Use default Inline AI model"
      aria-pressed={active}
      onClick={onClick}
      title="Use the recommended Inline AI model"
      {...handlers}
      style={{
        ...inputStyle,
        width: "auto",
        padding: "8px 10px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: active ? "var(--ink)" : "var(--muted)",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        whiteSpace: "nowrap",
        borderColor: active ? "var(--accent-edge)" : "var(--rule)",
        background: active
          ? "var(--accent-soft)"
          : pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "var(--bg)",
        boxShadow: withFocusRing(restShadow, focus),
      }}
    >
      Default
    </button>
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
  const currentAutosaveDelayMs = Math.max(
    250,
    Math.min(10_000, Math.round(preferences.autosaveDelayMs)),
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

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <SectionTitle
        title="Autosave"
        detail="Save the active file automatically after you stop typing."
      />
      <ToggleRow
        title="Autosave"
        desc="Debounced save after the last keystroke. If the file changed on disk (e.g. an agent edited it), autosave pauses and asks instead of overwriting. Ctrl/Cmd+S always saves."
        checked={preferences.autosaveEnabled}
        onChange={(v) => void setPreference("autosaveEnabled", v)}
      />
      {preferences.autosaveEnabled && (
        <div style={{ display: "grid", gap: 7 }}>
          <span className="spark-eyebrow" style={{ fontSize: 11 }}>
            Autosave delay
          </span>
          <div
            role="group"
            aria-label="Autosave delay"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 6,
            }}
          >
            {AUTOSAVE_DELAY_PRESETS.map((preset) => (
              <TimingPresetButton
                key={preset.value}
                label={preset.label}
                hint={preset.hint}
                active={currentAutosaveDelayMs === preset.value}
                onClick={() => void setPreference("autosaveDelayMs", preset.value)}
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
              aria-label="Autosave wait time"
              type="range"
              min={250}
              max={10000}
              step={250}
              value={currentAutosaveDelayMs}
              onChange={(event) =>
                void setPreference("autosaveDelayMs", Number(event.currentTarget.value))
              }
              style={{ width: "100%", accentColor: "var(--accent)" }}
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
              {(currentAutosaveDelayMs / 1000).toFixed(currentAutosaveDelayMs % 1000 === 0 ? 0 : 2)}s
            </span>
          </div>
        </div>
      )}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

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
        <span className="spark-eyebrow" style={{ fontSize: 11 }}>
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
            // Theme the native range track/thumb so no un-tinted OS chrome shows.
            style={{ width: "100%", accentColor: "var(--accent)" }}
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
        <span id="inline-ai-model-label" className="spark-eyebrow" style={{ fontSize: 11 }}>
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
            className="spark-input spark-mono"
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
            style={inputShellStyle}
          />
          <DefaultModelButton
            active={currentInlineModelId === DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID}
            onClick={() => setInlineModel(DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID)}
          />
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
  const { preferences, setPreference } = usePreferences();

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
          detail="Pick which local agent CLIs Cora may dispatch workers to. Each runtime can be toggled independently — deselect any that you do not want Cora to spawn."
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
          borderRadius: "var(--radius-surface, 7px)",
          padding: 12,
          background: "color-mix(in oklch, var(--ink) 3%, transparent)",
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          lineHeight: 1.45,
          boxShadow: "var(--well)",
        }}
      >
        MCP servers and skills now live in the Capability Center from the Cora composer. That space is larger and gives
        per-item activation, compatibility, deletion, and sync controls.
      </div>

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

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
          desc="After this many stuck-fails on the same task, Cora stops auto-retrying and surfaces it to the planner instead. 0 disables auto-retry (kill only). Default 2."
          min={0}
          max={5}
          value={draft.workerStuckMaxAutoRetries}
          disabled={!draft.workerStuckDetectEnabled}
          onChange={(workerStuckMaxAutoRetries) =>
            onChange({ ...draft, workerStuckMaxAutoRetries })
          }
        />
      </div>

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <div style={{ display: "grid", gap: 8 }}>
        <SectionTitle
          title="Models"
          detail="Extra models that are hidden by default because they cost significantly more."
        />
        <ToggleRow
          title="Allow Fable 5"
          desc="Fable 5 is Anthropic's top-tier model — significantly more expensive than Opus 4.8. Off by default: when off it is hidden from the chat model picker and any automation that requests it falls back to Opus 4.8."
          checked={preferences.fableEnabled === true}
          onChange={(v) => void setPreference("fableEnabled", v)}
        />
      </div>
    </div>
  );
}

// The shared setting-row primitive: a left-aligned label + 11px --muted
// description stacked on a fixed x-origin, with the trailing control held to
// the right on one grid. ToggleRow / NumberRow / runtime rows all render
// through this so spacing, alignment, and the disabled dim are identical.
function SettingRow({
  title,
  desc,
  control,
  disabled,
  htmlFor,
}: {
  title: string;
  desc: string;
  control: React.ReactNode;
  disabled?: boolean;
  htmlFor?: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 14,
        padding: "10px 0",
        opacity: disabled ? 0.55 : 1,
        transition: "opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <label
          htmlFor={htmlFor}
          style={{
            display: "block",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          {title}
        </label>
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
      {control}
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
  // Edit against a local draft and only parse+clamp+commit on blur/Enter —
  // clamping every keystroke would turn a partially-typed "90" into the min
  // (e.g. 600) and make the field impossible to clear while retyping.
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);
  const commit = (raw: string) => {
    const next = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(next)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.trunc(next)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <SettingRow
      title={title}
      desc={desc}
      disabled={disabled}
      control={
      <input
        className="spark-input spark-mono"
        type="number"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={(e) => {
          setEditing(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        style={{
          width: 72,
          flex: "0 0 72px",
          height: "auto",
          padding: "6px 8px",
          // Tint the native number spinners so no un-themed OS chrome remains.
          accentColor: "var(--accent)",
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
        }}
      />
      }
    />
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
  // Adopt the shared .spark-badge so every status tint re-tints across the 8
  // OKLCH palettes (the old hardcoded hex froze a color that clashed on light
  // themes). Tones map onto the badge's token-backed modifiers: success -> ok,
  // warning -> warn, blue -> info, violet -> accent (brand).
  const toneClass: Record<CapabilityChipTone, string> = {
    neutral: "",
    success: "is-ok",
    warning: "is-warn",
    blue: "is-info",
    violet: "is-accent",
  };
  return (
    <span
      className={`spark-badge ${toneClass[tone]}`.trim()}
      title={title}
      style={{
        // These tags read as lowercase code-ish identifiers, not shouted
        // labels — keep mono + lowercase rather than the badge's uppercase.
        fontFamily: "var(--font-mono)",
        textTransform: "none",
        letterSpacing: "0.02em",
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
  const { hover, focus, pressed, handlers } = useInteractive();
  const restShadow = active ? "var(--lift-hi)" : undefined;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={canToggle ? onToggle : undefined}
      disabled={!canToggle}
      {...handlers}
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
        // One soft cue for the enabled state: accent-edge border + accent-soft
        // fill. No stacked glow halo.
        border: active ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
        background: active
          ? "var(--accent-soft)"
          : !canToggle
            ? "color-mix(in oklch, var(--ink) 2%, transparent)"
            : pressed
              ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
              : hover
                ? "var(--hover)"
                : "color-mix(in oklch, var(--ink) 3%, transparent)",
        // Default arrow cursor when togglable (matching the .spark-* utility
        // classes); a not-allowed cue only when the runtime can't be enabled.
        cursor: canToggle ? "default" : "not-allowed",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
        width: "100%",
        boxShadow: withFocusRing(restShadow, focus),
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
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
            fontWeight: 600,
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
      {/* One switch metric: the same visual track as ToggleRow, rendered as a
          decorative indicator because the whole row is the clickable target. */}
      <SwitchTrack checked={enabled} disabled={!canToggle} />
    </button>
  );
}

const capabilityChipRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 4,
};

function RuntimeDiagnosticSkeleton() {
  return (
    <div className="spark-empty" style={{ minHeight: 64, padding: "16px 12px" }}>
      <span className="spark-eyebrow">Checking runtimes</span>
      <span className="spark-empty__body">Detecting Claude and Codex CLIs…</span>
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
        detail="Every run Codara Studio has on disk, across every workspace. Open to inspect, Delete to remove the artifact directory."
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="spark-input"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by id, title, or workspace"
          style={{ flex: 1, width: "auto" }}
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
            borderRadius: "var(--radius-surface, 7px)",
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
        borderRadius: "var(--radius-surface, 7px)",
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
              borderRadius: "var(--radius-control, 5px)",
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
      <div
        style={{ display: "flex", gap: 6 }}
        onMouseLeave={() => setArmed(false)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setArmed(false);
        }}
      >
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
  // The shared destructive button. The two-step arm/confirm semantics stay in
  // the caller (RunRow); this is styling only, matching FooterButton's size.
  return (
    <button
      type="button"
      className="spark-btn is-danger"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function RunsEmptyMessage({ text }: { text: string }) {
  return (
    <div
      className="spark-empty"
      style={{
        minHeight: 72,
        border: "1px dashed var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
      }}
    >
      <span className="spark-eyebrow">Runs</span>
      <span className="spark-empty__body">{text}</span>
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
        detail="Codara Studio — terminal multiplexer with agent orchestration, driven by Cora."
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
        <MetaRow label="App ID" value="com.codara.app" mono />
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
  const { hover, focus, pressed, handlers } = useInteractive();
  // One soft selection cue: accent-edge border + the --lift-hi soft cue, over a
  // calm accent-soft fill. No stacked accent ring + drop-shadow + glow halo.
  // Border width is held at 1px in every state (color swaps transparent<->edge),
  // so nothing reflows. The corner mark is a crisp SVG check on an accent disc —
  // no glyph, no extra glow. Press settles the whole card by 0.5px.
  const restShadow = active ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      aria-label={`Use ${label} theme`}
      aria-pressed={active}
      onClick={onClick}
      {...handlers}
      style={{
        appearance: "none",
        position: "relative",
        overflow: "hidden",
        border: active
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule-soft)",
        background: active
          ? "var(--accent-soft)"
          : pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklch, var(--panel) 70%, transparent)",
        // Surface rung — a card sits on the 7px ladder step.
        borderRadius: "var(--radius-surface, 7px)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 9,
        color: "var(--ink)",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        minHeight: 116,
        minWidth: 0,
        textAlign: "left",
        transform: pressed ? "translateY(0.5px)" : "none",
        boxShadow: withFocusRing(restShadow, focus),
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
      }}
    >
      {active ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 9,
            right: 9,
            width: 16,
            height: 16,
            borderRadius: 999,
            background: "var(--accent)",
            color: "var(--accent-ink)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12.5l4.5 4.5L19 7" />
          </svg>
        </span>
      ) : null}
      <span
        aria-hidden
        style={{
          display: "grid",
          gridTemplateRows: "12px 1fr",
          gap: 6,
          height: 64,
          // Inner preview nests one rung below the 7px card (control rung, 5px).
          borderRadius: "var(--radius-control, 5px)",
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

// A crisp 1.5px-stroke chevron at currentColor — replaces the Unicode "▾",
// which sits on a text baseline and renders heavier/blurrier than the SVG
// icons elsewhere in the app. Flips on open.
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        color: "var(--muted)",
        flex: "0 0 13px",
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
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
  const { hover, focus, pressed, handlers } = useInteractive();
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
        // Capture + stopPropagation so Escape dismisses just the dropdown
        // instead of also closing the whole Settings dialog.
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, { capture: true });
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
        {...handlers}
        style={{
          ...inputStyle,
          fontSize: 13,
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          // Default arrow cursor, matching the .spark-* utility classes.
          cursor: "default",
          background: pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "var(--bg)",
          // Open OR keyboard-focused lights the accent edge; the focus ring is
          // composed in so keyboard nav is visible.
          borderColor: open || focus ? "var(--accent-edge)" : "var(--rule)",
          boxShadow: withFocusRing("var(--well)", focus),
        }}
      >
        <span style={{ color: "var(--ink)" }}>
          {current?.label ?? value}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div
          ref={popupRef}
          role="listbox"
          className="spark-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 10,
            minWidth: 0,
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
  const { pressed, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={active ? "spark-menu-item is-active" : "spark-menu-item"}
      onClick={onClick}
      {...handlers}
      style={{
        // Default arrow cursor, matching the .spark-menu-item base class.
        cursor: "default",
        // Font-weight is held constant across active/inactive (color +
        // accent-soft fill carry selection) so the option never reflows.
        fontWeight: 500,
        // Pressed beat for rows where the .spark-btn transform would break the
        // menu seam — a momentary darker fill instead.
        background: pressed
          ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
          : undefined,
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
  const { hover, focus, pressed, handlers } = useInteractive();
  const restShadow = active ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      {...handlers}
      style={{
        appearance: "none",
        textAlign: "left",
        // Single accent cue: accent-edge border + accent-soft fill. No 1px ring.
        border: active ? "1px solid var(--accent-edge)" : "1px solid transparent",
        borderRadius: "var(--radius-surface, 7px)",
        background: active
          ? "var(--accent-soft)"
          : pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: "var(--ink)",
        padding: "7px 9px",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        display: "grid",
        gap: 2,
        minHeight: 46,
        boxShadow: withFocusRing(restShadow, focus),
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
  const { hover, focus, pressed, handlers } = useInteractive();
  const restShadow = active ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Use ${label} for Inline AI`}
      onClick={onClick}
      {...handlers}
      style={{
        appearance: "none",
        textAlign: "left",
        // Single accent cue: accent-edge border + accent-soft fill.
        border: active ? "1px solid var(--accent-edge)" : "1px solid transparent",
        borderRadius: "var(--radius-surface, 7px)",
        background: active
          ? "var(--accent-soft)"
          : pressed
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: "var(--ink)",
        padding: "9px 11px",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr)",
        gap: 12,
        alignItems: "center",
        boxShadow: withFocusRing(restShadow, focus),
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <AccentDot active={active} />
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
                color: active ? "var(--accent)" : "var(--muted)",
                border: active ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
                borderRadius: 999,
                padding: "1px 6px",
                fontFamily: "var(--font-sans)",
                fontSize: 9,
                fontWeight: 700,
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

// One liquid-glass tuning slider: 0–200% of the design default. Lives right
// under the glass toggle; changes apply live (ThemeProvider maps the pref to
// CSS scale vars / SVG lens attributes), so the dialog itself is the preview.
function GlassSliderRow({
  label,
  hint,
  min = 0,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  min?: number;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "130px minmax(0, 1fr) auto",
        gap: 10,
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink)" }} title={hint}>
        {label}
      </span>
      <input
        aria-label={`${label} — ${hint}`}
        type="range"
        min={min}
        max={200}
        step={5}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        style={{ width: "100%", accentColor: "var(--accent)" }}
      />
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          minWidth: 40,
          textAlign: "right",
        }}
      >
        {value}%
      </span>
    </div>
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
    <SettingRow
      title={title}
      desc={desc}
      control={<Switch checked={checked} onChange={onChange} ariaLabel={title} />}
    />
  );
}

// One switch metric, app-wide. 34x20 track, 16px knob, 2px inset, accent fill
// + glow when on. SwitchTrack is the pure-visual part so the same geometry can
// be (a) an interactive role=switch button, or (b) a decorative indicator
// nested inside a larger clickable row (RuntimeDiagnosticRow), where a nested
// <button> would be invalid HTML.
const SWITCH_W = 34;
const SWITCH_H = 20;
const SWITCH_KNOB = 16;

function SwitchTrack({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        position: "relative",
        width: SWITCH_W,
        height: SWITCH_H,
        borderRadius: 999,
        boxSizing: "border-box",
        border: checked
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule-strong)",
        background: checked
          ? "color-mix(in oklch, var(--accent) 32%, var(--panel))"
          : "color-mix(in oklch, var(--ink) 5%, transparent)",
        opacity: disabled ? 0.55 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: checked ? SWITCH_W - SWITCH_KNOB - 2 : 1,
          width: SWITCH_KNOB,
          height: SWITCH_KNOB,
          borderRadius: "50%",
          background: checked ? "var(--accent)" : "var(--ink-dim)",
          boxShadow: checked ? "0 0 8px var(--accent-glow)" : "none",
          transition:
            "left var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      />
    </span>
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}) {
  const { focus, pressed, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      {...handlers}
      style={{
        appearance: "none",
        display: "inline-flex",
        flex: `0 0 ${SWITCH_W}px`,
        padding: 0,
        border: "none",
        borderRadius: 999,
        background: "transparent",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        // The press settle: a hair of downward travel, no reflow.
        transform: pressed ? "translateY(0.5px)" : "none",
        // Let the global focus-visible ring render — it follows the 999px radius.
        boxShadow: withFocusRing(undefined, focus),
        transition: "transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <SwitchTrack checked={checked} />
    </button>
  );
}

// Comfortable field geometry layered on top of the .spark-input class: the
// class supplies the shared fill, border, radius, recessed --well, and the
// global focus-visible accent ring (its CSS box-shadow isn't clobbered because
// we set no inline box-shadow here). We only relax the class's compact 26px
// height to the dialog's roomier rhythm. One input shell, app-consistent focus.
const inputShellStyle: React.CSSProperties = {
  height: "auto",
  padding: "8px 10px",
  fontSize: 13,
};

// Button-shaped controls that visually mimic an input field (the Default reset
// button, the CustomSelect trigger). Not real <input>s, so they don't get the
// .spark-input CSS — these compose the well + focus ring inline instead.
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--rule)",
  // Inputs sit on the 7px surface rung, matching .spark-input and the
  // --radius-surface comment in styles.css.
  borderRadius: "var(--radius-surface, 7px)",
  background: "var(--bg)",
  color: "var(--ink)",
  padding: "8px 10px",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  boxShadow: "var(--well)",
  transition:
    "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};
