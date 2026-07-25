import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  EditorThemeId,
  PiSubscriptionAuthEvent,
  PiSubscriptionConnection,
  PiSubscriptionOverview,
  PiSubscriptionPrompt,
  PiSubscriptionProvider,
  RunState,
  ShellInfo,
  ThemePref,
  WorkerSessionMemoryScope,
  WorkerSessionRuntime,
  WorkerSessionSummary,
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
import SubscriptionUsage from "./SubscriptionUsage";
import { EDITOR_THEME_LABEL } from "./editor-cm/themes";
import packageJson from "../../../../package.json";

// Settings is a single in-app dialog with seven tabs. Everything renders
// inline here — there is no separate Settings BrowserWindow.
type SettingsTab =
  | "general"
  | "editor"
  | "terminal"
  | "api"
  | "agents"
  | "sessions"
  | "keybindings"
  | "runs"
  | "about";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Default terminal" },
  { id: "api", label: "API and model" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
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
    case "sessions": // stacked conversation cards
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="11" rx="2.5" />
          <path d="M8 16v3l4-3" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="12" x2="13" y2="12" />
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
  onOpenWorkerSession: (
    runtime: WorkerSessionRuntime,
    cwd: string,
    session: WorkerSessionSummary | null,
  ) => void;
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
  onOpenWorkerSession,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  // Selecting a section should acknowledge the click before a large section
  // (Runs, Sessions, Agents, or the theme gallery) builds its DOM and starts
  // background IPC. The nav follows activeTab immediately while React renders
  // the section body at deferred priority.
  const renderedTab = useDeferredValue(activeTab);
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
  const hideFooter = activeTab === "runs" || activeTab === "sessions";

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
      <div className="spark-scrim settings-dialog-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="spark-glass--strong settings-dialog-surface"
        data-settings-surface
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
            data-settings-tab={renderedTab}
            aria-busy={renderedTab !== activeTab}
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
              background: "color-mix(in oklab, var(--bg) 45%, transparent)",
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
            {renderedTab === "general" && <GeneralSettings workspaceCwd={workspaceCwd} />}
            {renderedTab === "editor" && <EditorSettings />}
            {renderedTab === "terminal" && (
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
            {renderedTab === "api" && <ApiSettings draft={draft} onChange={setDraft} />}
            {renderedTab === "agents" && (
              <AgentsSettings />
            )}
            {renderedTab === "sessions" && (
              <SessionsSettings
                workspaceCwd={workspaceCwd}
                onOpenWorkerSession={onOpenWorkerSession}
              />
            )}
            {renderedTab === "keybindings" && <KeybindingsTab />}
            {renderedTab === "runs" && <RunsSettings onOpenRun={onOpenRun} />}
            {renderedTab === "about" && <AboutSettings />}
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
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklab, var(--ink) 2%, transparent)",
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
        detail="Powers the editor's inline AI and git commit-message drafts. Cora's own models are picked in the chat composer, not here."
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
          ? "color-mix(in oklab, var(--ink) 7%, var(--panel))"
          : pressed
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
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
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
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

interface PiLoginView {
  requestId: string;
  provider: PiSubscriptionProvider;
  status: "running" | "completed" | "failed" | "cancelled";
  message: string;
  url?: string;
  deviceCode?: string;
  promptId?: string;
  prompt?: PiSubscriptionPrompt;
}

interface PiInstallView {
  status: "running" | "completed" | "failed";
  message: string;
}

function PiSubscriptionSettings() {
  const [overview, setOverview] = useState<PiSubscriptionOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<PiLoginView | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [install, setInstall] = useState<PiInstallView | null>(null);
  // Bumped on connect/disconnect to force the usage panel to re-read; the main
  // process caches usage for a minute, which is right for idle re-renders but
  // wrong immediately after the set of connected subscriptions changes.
  const [usageEpoch, setUsageEpoch] = useState(0);

  const refresh = () => {
    setLoading(true);
    setError(null);
    void window.spark.piSubscriptions
      .status()
      .then(setOverview)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const remove = window.spark.piSubscriptions.onEvent((event) => {
      setPromptValue("");
      if (event.type === "completed") {
        setOverview(event.overview);
        setUsageEpoch((epoch) => epoch + 1);
        setLogin({
          requestId: event.requestId,
          provider: event.provider,
          status: "completed",
          message: event.message,
        });
        return;
      }
      if (event.type === "failed" || event.type === "cancelled") {
        setLogin((current) => ({
          requestId: event.requestId,
          provider: event.provider,
          status: event.type,
          message: event.message,
          ...(current?.requestId === event.requestId && current.url ? { url: current.url } : {}),
        }));
        return;
      }
      setLogin((current) => {
        const base: PiLoginView = current?.requestId === event.requestId
          ? current
          : {
              requestId: event.requestId,
              provider: event.provider,
              status: "running",
              message: "Connecting subscription…",
            };
        if (event.type === "auth_url") {
          return {
            ...base,
            status: "running",
            message: event.instructions || "Finish signing in in your browser.",
            url: event.url,
          };
        }
        if (event.type === "device_code") {
          return {
            ...base,
            status: "running",
            message: "Enter this code in the browser to finish connecting.",
            url: event.verificationUri,
            deviceCode: event.userCode,
          };
        }
        if (event.type === "prompt") {
          return {
            ...base,
            status: "running",
            message: event.prompt.message,
            promptId: event.promptId,
            prompt: event.prompt,
          };
        }
        return { ...base, status: "running", message: event.message };
      });
    });
    return remove;
  }, []);

  // The install runs in the main process, so its progress arrives on its own
  // channel. A Settings dialog reopened mid-install picks the run back up from
  // the overview's runtimeInstalling flag below.
  useEffect(() => {
    return window.spark.piSubscriptions.onRuntimeInstallEvent((event) => {
      if (event.type === "completed") {
        setOverview(event.overview);
        setInstall({ status: "completed", message: event.message });
        return;
      }
      setInstall({
        status: event.type === "failed" ? "failed" : "running",
        message: event.message,
      });
    });
  }, []);

  useEffect(() => {
    if (overview?.runtimeInstalling && !install) {
      setInstall({ status: "running", message: "Installing Pi…" });
    }
  }, [overview?.runtimeInstalling, install]);

  const installRuntime = () => {
    setError(null);
    setInstall({ status: "running", message: "Starting install…" });
    void window.spark.piSubscriptions.installRuntime().catch((err) => {
      setInstall({ status: "failed", message: (err as Error).message });
    });
  };

  const connect = (provider: PiSubscriptionProvider) => {
    setError(null);
    setLogin({
      requestId: "starting",
      provider,
      status: "running",
      message: "Preparing secure browser login…",
    });
    void window.spark.piSubscriptions.connect(provider).catch((err) => {
      setLogin({
        requestId: "failed-to-start",
        provider,
        status: "failed",
        message: (err as Error).message,
      });
    });
  };

  const disconnect = (provider: PiSubscriptionProvider) => {
    setLoading(true);
    setError(null);
    void window.spark.piSubscriptions
      .disconnect(provider)
      .then((next) => {
        setOverview(next);
        setUsageEpoch((epoch) => epoch + 1);
        setLogin(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  const submitPrompt = (value: string) => {
    if (!login?.promptId || !value.trim()) return;
    const { requestId, promptId } = login;
    setLogin((current) => current ? {
      ...current,
      message: "Finishing secure login…",
      prompt: undefined,
      promptId: undefined,
    } : current);
    setPromptValue("");
    void window.spark.piSubscriptions.respond({ requestId, promptId, value }).catch((err) => {
      setLogin((current) => current ? {
        ...current,
        status: "failed",
        message: (err as Error).message,
      } : current);
    });
  };

  const busyProvider = login?.status === "running" ? login.provider : null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <SectionTitle
        title="Cora subscriptions"
        detail="Connect the subscriptions Pi uses for Cora chat, planning, and every worker. Credentials stay in Codara's private Pi store; API-key environment variables are stripped from every launch."
      />
      <div
        className="spark-glass"
        style={{
          display: "grid",
          gap: 8,
          padding: 10,
          borderRadius: "var(--radius-surface, 7px)",
          border: "1px solid var(--rule-soft)",
          boxShadow: "var(--well)",
        }}
      >
        {overview?.connections.map((connection) => (
          <PiSubscriptionRow
            key={connection.provider}
            connection={connection}
            busy={busyProvider === connection.provider}
            disabled={
              // Connecting without the runtime can only fail — the OAuth flow
              // itself is loaded out of the Pi package. Point at Install
              // instead of letting the user earn the error.
              !overview.runtimeInstalled ||
              (busyProvider !== null && busyProvider !== connection.provider)
            }
            onConnect={() => connect(connection.provider)}
            onDisconnect={() => disconnect(connection.provider)}
          />
        ))}
        {!overview && loading ? <RuntimeDiagnosticSkeleton /> : null}
        {overview?.runtimeInstalled ? (
          <div
            style={{
              padding: "3px 3px 0",
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
            }}
          >
            Pinned Pi {overview.runtimeVersion} · one auth store for manager + workers
          </div>
        ) : overview ? (
          <PiRuntimeInstallRow
            expectedVersion={overview.runtimeExpectedVersion}
            runtimeError={overview.runtimeError}
            install={install}
            onInstall={installRuntime}
          />
        ) : null}
      </div>

      {login ? (
        <PiLoginPanel
          login={login}
          promptValue={promptValue}
          onPromptValue={setPromptValue}
          onSubmitPrompt={submitPrompt}
          onCancel={() => {
            if (login.status === "running" && login.requestId !== "starting") {
              void window.spark.piSubscriptions.cancel(login.requestId);
            } else {
              setLogin(null);
            }
          }}
        />
      ) : null}

      {error ? (
        <div style={{ color: "var(--danger)", fontFamily: "var(--font-sans)", fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      {/* Remounted whenever a connection changes so the bars re-read instead of
          showing the pre-login state of a subscription you just connected. */}
      {overview?.runtimeInstalled ? <SubscriptionUsage key={usageEpoch} /> : null}

      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        Claude note: Pi documents that third-party Claude Pro/Max harness use may draw from Anthropic Extra Usage.
        Codara never substitutes an Anthropic API key, but you should keep Extra Usage disabled if you require a hard
        no-metered-usage boundary.
      </div>
    </div>
  );
}

function PiSubscriptionRow({
  connection,
  busy,
  disabled,
  onConnect,
  onDisconnect,
}: {
  connection: PiSubscriptionConnection;
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  // A stored refresh token is not proof that the provider will accept it.
  // Treat an expired access token as needing attention until a real launch or
  // reconnect succeeds; the previous "Refresh ready" green state hid broken
  // Anthropic refresh credentials behind a healthy-looking row.
  const healthy = connection.connected && !connection.expired;
  const status = busy
    ? "Connecting…"
    : connection.connected
      ? connection.expired
        ? connection.canRefresh ? "Expired · reconnect recommended" : "Expired"
        : "Connected"
      : "Not connected";
  const expiry = connection.expiresAt
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        .format(new Date(connection.expiresAt))
    : null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "10px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 10,
        padding: "10px 10px",
        borderRadius: "var(--radius-control, 5px)",
        border: healthy ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        background: healthy ? "var(--accent-soft)" : "color-mix(in oklab, var(--ink) 3%, transparent)",
        boxShadow: healthy ? "var(--lift-hi)" : "none",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 99,
          background: healthy ? "var(--accent)" : connection.error ? "var(--danger)" : "var(--muted)",
          boxShadow: healthy ? "0 0 8px var(--accent-glow)" : "none",
        }}
      />
      <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
        <span style={{ color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 650 }}>
          {connection.label}
        </span>
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 11 }}>
          {connection.model} · {status}{expiry && connection.connected ? ` · token ${connection.expired ? "expired" : `until ${expiry}`}` : ""}
        </span>
        {connection.error ? (
          <span style={{ color: "var(--danger)", fontFamily: "var(--font-sans)", fontSize: 10 }}>
            {connection.error}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <FooterButton onClick={onConnect} disabled={disabled || busy} primary={!connection.connected}>
          {busy ? "Opening…" : connection.connected ? "Reconnect" : "Connect"}
        </FooterButton>
        {connection.connected ? (
          <FooterButton onClick={onDisconnect} disabled={disabled || busy}>Disconnect</FooterButton>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The missing-runtime state. Cora cannot chat, plan, or launch a worker
 * without the pinned Pi build, so the one thing this row has to do is make
 * getting it a single click instead of a terminal errand.
 */
function PiRuntimeInstallRow({
  expectedVersion,
  runtimeError,
  install,
  onInstall,
}: {
  expectedVersion: string;
  runtimeError?: string;
  install: PiInstallView | null;
  onInstall: () => void;
}) {
  const running = install?.status === "running";
  const failed = install?.status === "failed";
  const tone = failed ? "var(--danger)" : running ? "var(--accent)" : "var(--danger)";
  return (
    <div
      aria-live="polite"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: "var(--radius-control, 5px)",
        border: `1px solid color-mix(in oklab, ${tone} 38%, var(--rule-soft))`,
        background: "color-mix(in oklab, var(--ink) 3%, transparent)",
      }}
    >
      <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
        <span style={{ color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 650 }}>
          {running ? `Installing Pi ${expectedVersion}…` : `Pi ${expectedVersion} is not installed`}
        </span>
        <span
          style={{
            color: failed ? "var(--danger)" : "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            lineHeight: 1.4,
            // npm's progress lines and error tails are long; keep the row from
            // stretching the dialog while staying readable.
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 74,
            overflowY: "auto",
          }}
        >
          {install?.message ||
            runtimeError ||
            "Cora needs this exact Pi build for chat, planning, and every worker."}
        </span>
        {!running ? (
          <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
            Installs into your Codara home · needs npm on your PATH
          </span>
        ) : null}
      </div>
      <FooterButton onClick={onInstall} disabled={running} primary>
        {running ? "Installing…" : failed ? "Retry install" : `Install Pi ${expectedVersion}`}
      </FooterButton>
    </div>
  );
}

function PiLoginPanel({
  login,
  promptValue,
  onPromptValue,
  onSubmitPrompt,
  onCancel,
}: {
  login: PiLoginView;
  promptValue: string;
  onPromptValue: (value: string) => void;
  onSubmitPrompt: (value: string) => void;
  onCancel: () => void;
}) {
  const done = login.status === "completed";
  const failed = login.status === "failed";
  const tone = done ? "var(--ok)" : failed ? "var(--danger)" : "var(--accent)";
  const select = login.prompt?.type === "select" ? login.prompt : null;
  const textPrompt = login.prompt && login.prompt.type !== "select" ? login.prompt : null;
  return (
    <div
      className="spark-glass--strong"
      aria-live="polite"
      style={{
        display: "grid",
        gap: 10,
        padding: 12,
        borderRadius: "var(--radius-surface, 7px)",
        border: `1px solid color-mix(in oklab, ${tone} 42%, var(--rule-soft))`,
        boxShadow: "var(--lift-hi)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            marginTop: 4,
            borderRadius: 99,
            background: tone,
            boxShadow: login.status === "running" ? `0 0 10px ${tone}` : "none",
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 650 }}>
            {done ? "Subscription connected" : failed ? "Could not connect" : "Secure subscription login"}
          </div>
          <div style={{ marginTop: 2, color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 11, lineHeight: 1.45 }}>
            {login.message}
          </div>
        </div>
      </div>

      {login.deviceCode ? (
        <div
          className="spark-mono"
          style={{
            justifySelf: "start",
            padding: "7px 10px",
            borderRadius: "var(--radius-control, 5px)",
            border: "1px solid var(--accent-edge)",
            background: "var(--accent-soft)",
            color: "var(--ink)",
            fontSize: 14,
            letterSpacing: "0.14em",
          }}
        >
          {login.deviceCode}
        </div>
      ) : null}

      {select ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {select.options.map((option, index) => (
            <FooterButton key={option.id} primary={index === 0} onClick={() => onSubmitPrompt(option.id)}>
              {option.label}
            </FooterButton>
          ))}
        </div>
      ) : null}

      {textPrompt ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitPrompt(promptValue);
          }}
          style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 7 }}
        >
          <input
            autoFocus
            className="spark-input spark-mono"
            type={textPrompt.type === "secret" ? "password" : "text"}
            value={promptValue}
            onChange={(event) => onPromptValue(event.currentTarget.value)}
            placeholder={textPrompt.placeholder || "Paste the authorization code"}
            style={inputShellStyle}
          />
          <button type="submit" className="spark-btn is-primary" disabled={!promptValue.trim()}>
            Continue
          </button>
        </form>
      ) : null}

      <div style={{ display: "flex", gap: 6 }}>
        {login.url ? (
          <FooterButton onClick={() => void window.spark.openExternal(login.url!)}>Open browser again</FooterButton>
        ) : null}
        <FooterButton onClick={onCancel}>{login.status === "running" ? "Cancel" : "Dismiss"}</FooterButton>
      </div>
    </div>
  );
}

function AgentsSettings() {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <PiSubscriptionSettings />

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <div
        style={{
          border: "1px solid var(--rule-soft)",
          borderRadius: "var(--radius-surface, 7px)",
          padding: 12,
          background: "color-mix(in oklab, var(--ink) 3%, transparent)",
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

function SessionsSettings({
  workspaceCwd,
  onOpenWorkerSession,
}: {
  workspaceCwd?: string | null;
  onOpenWorkerSession: (
    runtime: WorkerSessionRuntime,
    cwd: string,
    session: WorkerSessionSummary | null,
  ) => void;
}) {
  const { preferences, setPreference, hydrated } = usePreferences();
  const [sessions, setSessions] = useState<WorkerSessionSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<"all" | WorkerSessionRuntime>("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkerSessionSummary | null>(null);
  const [deleteMemory, setDeleteMemory] = useState(false);

  const refresh = async () => {
    const bridge = window.spark.agentSession as Partial<typeof window.spark.agentSession>;
    try {
      if (typeof bridge.listAll !== "function") {
        setSessions([]);
        setError("Restart Codara once to finish enabling the all-project session index.");
        return;
      }
      const next = await bridge.listAll();
      setSessions(next);
      setError(null);
    } catch (err) {
      setSessions([]);
      setError(
        /no handler registered/i.test((err as Error).message)
          ? "Restart Codara once to finish enabling the all-project session index."
          : (err as Error).message,
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const query = filter.trim().toLowerCase();
    return sessions.filter((session) => {
      if (runtimeFilter !== "all" && session.runtime !== runtimeFilter) return false;
      if (!query) return true;
      return (
        session.title.toLowerCase().includes(query) ||
        session.cwd.toLowerCase().includes(query) ||
        session.sessionId.toLowerCase().includes(query)
      );
    });
  }, [filter, runtimeFilter, sessions]);

  const startNew = async (runtime: WorkerSessionRuntime) => {
    const cwd = await window.spark.dialog.openDirectory(workspaceCwd ?? undefined);
    if (cwd) onOpenWorkerSession(runtime, cwd, null);
  };

  const confirmDelete = async () => {
    const session = pendingDelete;
    if (!session) return;
    const deleteSession = (
      window.spark.agentSession as Partial<typeof window.spark.agentSession>
    ).delete;
    if (typeof deleteSession !== "function") {
      setPendingDelete(null);
      setDeleteMemory(false);
      setError("Restart Codara once to enable session deletion.");
      return;
    }
    const memoryScope: WorkerSessionMemoryScope = deleteMemory
      ? session.runtime === "claude"
        ? "claude-project"
        : "codex-all"
      : "none";
    setBusyId(`${session.runtime}:${session.sessionId}`);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteSession({
        runtime: session.runtime,
        sessionId: session.sessionId,
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
        memoryScope,
      });
      setPendingDelete(null);
      setDeleteMemory(false);
      setNotice(
        result.warnings.length > 0
          ? result.warnings.join(" ")
          : result.memoryDeleted
            ? "Session and the selected local memory scope were deleted."
            : "Session deleted.",
      );
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
        title="Agent sessions"
        detail="Start or resume Claude and Codex sessions from any local project. Opening a session switches to its workspace—or creates the workspace in Codara first."
      />

      {hydrated ? (
        <ToggleRow
          title="Resume running agent sessions when Codara reopens"
          desc="Reopens terminal tabs that still had Claude or Codex running and resumes their exact local session. Shell tabs and agents you already exited still start normally."
          checked={preferences.restoreAgentSessions === true}
          onChange={(next) => void setPreference("restoreAgentSessions", next)}
        />
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <FooterButton primary onClick={() => void startNew("claude")}>New Claude</FooterButton>
        <FooterButton primary onClick={() => void startNew("codex")}>New Codex</FooterButton>
        <div style={{ flex: 1 }} />
        <FooterButton onClick={() => void refresh()}>Refresh</FooterButton>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="spark-input"
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Filter by title, directory, or session id"
          style={{ flex: 1, width: "auto" }}
        />
        <select
          className="spark-input"
          aria-label="Filter sessions by provider"
          value={runtimeFilter}
          onChange={(event) =>
            setRuntimeFilter(event.currentTarget.value as "all" | WorkerSessionRuntime)
          }
          style={{ width: 112 }}
        >
          <option value="all">All agents</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>

      {error ? <SessionManagerMessage tone="danger">{error}</SessionManagerMessage> : null}
      {notice ? <SessionManagerMessage tone="info">{notice}</SessionManagerMessage> : null}

      {pendingDelete ? (
        <div
          role="alertdialog"
          aria-label="Confirm session deletion"
          style={{
            display: "grid",
            gap: 10,
            padding: "12px 13px",
            borderRadius: "var(--radius-surface, 7px)",
            border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
            background: "color-mix(in oklch, var(--danger) 8%, var(--bg))",
          }}
        >
          <div style={{ color: "var(--ink)", fontSize: 12, fontWeight: 700 }}>
            Permanently delete “{pendingDelete.title}”?
          </div>
          <div style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.45 }}>
            This removes the local transcript and cannot be undone. Close a running copy of the
            session before deleting it.
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              color: deleteMemory ? "var(--danger)" : "var(--ink-dim)",
              fontSize: 10,
              lineHeight: 1.4,
            }}
          >
            <input
              type="checkbox"
              checked={deleteMemory}
              onChange={(event) => setDeleteMemory(event.currentTarget.checked)}
            />
            <span>
              {pendingDelete.runtime === "claude"
                ? "Also delete this Claude project's auto-memory. This affects every Claude session sharing that project memory."
                : "Also delete ALL local Codex memories. This affects every Codex project and session on this machine."}
            </span>
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
            <FooterButton
              onClick={() => {
                setPendingDelete(null);
                setDeleteMemory(false);
              }}
            >
              Cancel
            </FooterButton>
            <DangerButton
              disabled={busyId !== null}
              onClick={() => void confirmDelete()}
            >
              {busyId ? "Deleting…" : deleteMemory ? "Delete session + memory" : "Delete session"}
            </DangerButton>
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 430,
          overflow: "auto",
          paddingRight: 2,
        }}
      >
        {sessions === null ? (
          <SessionsEmptyMessage text="Reading local session stores…" />
        ) : filtered.length === 0 ? (
          <SessionsEmptyMessage
            text={sessions.length === 0 ? "No local agent sessions found." : "No sessions match that filter."}
          />
        ) : (
          filtered.map((session) => {
            const key = `${session.runtime}:${session.sessionId}`;
            return (
              <SessionManagerRow
                key={key}
                session={session}
                busy={busyId === key}
                onOpen={() => onOpenWorkerSession(session.runtime, session.cwd, session)}
                onDelete={() => {
                  setPendingDelete(session);
                  setDeleteMemory(false);
                  setNotice(null);
                }}
              />
            );
          })
        )}
      </div>

      <div style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
        {sessions ? `${filtered.length} of ${sessions.length} sessions` : ""}
      </div>
    </div>
  );
}

function SessionManagerRow({
  session,
  busy,
  onOpen,
  onDelete,
}: {
  session: WorkerSessionSummary;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const providerColor = session.runtime === "claude" ? "var(--accent)" : "var(--info)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 11,
        padding: "9px 10px",
        background: "color-mix(in oklab, var(--bg) 82%, transparent)",
        border: "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          display: "grid",
          placeItems: "center",
          borderRadius: 8,
          color: providerColor,
          background: `color-mix(in oklch, ${providerColor} 11%, transparent)`,
          border: `1px solid color-mix(in oklch, ${providerColor} 30%, transparent)`,
          fontFamily: "var(--font-mono)",
          fontWeight: 800,
          fontSize: 11,
        }}
      >
        {session.runtime === "claude" ? "C" : "X"}
      </span>
      <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
        <div
          title={session.title}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--ink)",
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          {session.title}
        </div>
        <div
          title={session.cwd}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: session.cwdExists ? "var(--muted)" : "var(--danger)",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
          }}
        >
          {session.cwdExists ? session.cwd : `${session.cwd} · directory missing`}
        </div>
        <div style={{ display: "flex", gap: 7, color: "var(--muted)", fontSize: 9 }}>
          <span>{session.runtime === "claude" ? "Claude" : "Codex"}</span>
          <span>·</span>
          <span title={session.sessionId}>{shortWorkerSessionId(session.sessionId)}</span>
          <span>·</span>
          <span>{formatSessionUpdated(session.updatedAt)}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <FooterButton onClick={onOpen} disabled={!session.cwdExists || busy}>Open</FooterButton>
        <DangerButton onClick={onDelete} disabled={busy}>Delete</DangerButton>
      </div>
    </div>
  );
}

function SessionManagerMessage({
  tone,
  children,
}: {
  tone: "danger" | "info";
  children: React.ReactNode;
}) {
  const color = tone === "danger" ? "var(--danger)" : "var(--info)";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      style={{
        color,
        fontSize: 10,
        lineHeight: 1.45,
        border: `1px solid color-mix(in oklch, ${color} 34%, transparent)`,
        background: `color-mix(in oklch, ${color} 8%, transparent)`,
        borderRadius: "var(--radius-surface, 7px)",
        padding: "7px 10px",
      }}
    >
      {children}
    </div>
  );
}

function shortWorkerSessionId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatSessionUpdated(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently";
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 1) return "Just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(timestamp);
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
              background: "color-mix(in oklab, var(--ink) 6%, transparent)",
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
  return <SettingsEmptyMessage label="Runs" text={text} />;
}

function SessionsEmptyMessage({ text }: { text: string }) {
  return <SettingsEmptyMessage label="Sessions" text={text} />;
}

function SettingsEmptyMessage({ label, text }: { label: string; text: string }) {
  return (
    <div
      className="spark-empty"
      style={{
        minHeight: 72,
        border: "1px dashed var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
      }}
    >
      <span className="spark-eyebrow">{label}</span>
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
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklab, var(--panel) 70%, transparent)",
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
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
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
          ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
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
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklab, var(--ink) 2%, transparent)",
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
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "color-mix(in oklab, var(--ink) 2%, transparent)",
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

// One liquid-glass tuning slider: 0–200% of the design default. Keep drag state
// local and persist once on release/blur. Sending an IPC preference write for
// every pointer sample forced the whole themed app (including SVG lens filters)
// to repaint dozens of times per second and made Settings feel sticky.
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
  const [draftValue, setDraftValue] = useState(value);
  const dragging = useRef(false);
  const committedValue = useRef(value);

  useEffect(() => {
    committedValue.current = value;
    if (!dragging.current) setDraftValue(value);
  }, [value]);

  const commit = (next: number) => {
    dragging.current = false;
    setDraftValue(next);
    if (next !== committedValue.current) {
      committedValue.current = next;
      onChange(next);
    }
  };

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
        value={draftValue}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(event) => setDraftValue(Number(event.currentTarget.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerCancel={(event) => commit(Number(event.currentTarget.value))}
        onBlur={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
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
        {draftValue}%
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
// nested inside a larger clickable row, where a nested <button> would be
// invalid HTML.
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
          : "color-mix(in oklab, var(--ink) 5%, transparent)",
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
