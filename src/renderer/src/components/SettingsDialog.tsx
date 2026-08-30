import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_FAMILIES,
  AGENT_FAMILY_IDS,
  familyForModelId,
  runtimeForSubscription,
} from "@shared/agent-families";
import { ALLOWED_WORKER_MODELS } from "@shared/worker-model-roster";
import type { NativeCliShellProfileLeftover } from "@shared/native-cli-shell-leftover";
import type {
  AppSettings,
  EditorThemeId,
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionPrompt,
  PiSubscriptionProvider,
  PtyResourceSnapshot,
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
  EDITOR_THEME_IDS,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MAX,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MIN,
  AUTOSAVE_DELAY_PRESETS,
  DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES,
  DEFAULT_TOAST_DURATION_MS,
  GIT_AUTO_FETCH_INTERVAL_PRESETS,
  TOAST_DURATION_PRESETS,
  INLINE_AI_DELAY_PRESETS,
} from "@shared/types";
import { runStatusColor } from "../lib/run-status";
import { useTheme } from "../theme/theme-context";
import { usePreferences } from "../preferences/usePreferences";
import KeybindingsSection from "../shortcuts/KeybindingsSection";
import {
  UsageEntryBody,
  useSubscriptionUsage,
  type UsageEntry,
} from "./SubscriptionUsage";
import AccountCards, {
  AccountAddPicker,
  type AccountActions,
  type AccountProviderView,
} from "./AccountCards";
import type { AccountCardView } from "./AccountCard";
import {
  ACCOUNT_PROVIDER_DESCRIPTORS,
  accountProviderDetail,
} from "../lib/account-provider-descriptors";
import RemoteAccessSettings from "./RemoteAccessSettings";
import { RuntimeMark } from "./BrandMarks";
import { EDITOR_THEME_LABEL } from "./editor-cm/themes";
import packageJson from "../../../../package.json";
import {
  workerSessionMemoryDeleteOption,
  workerSessionMemoryScope,
} from "../lib/worker-session-memory";

// Settings is a single in-app dialog with seven tabs. Everything renders
// inline here — there is no separate Settings BrowserWindow.

// The commit-message picker offers every native model Cora workers may launch
// on — the same roster as the Cora model picker — derived from the shared
// table so a roster change reaches this picker without a second edit.
// Rendered like the Cora picker: friendly names under uppercase vendor
// headers (OPENAI / ANTHROPIC / XAI), vendors in family-table order.

// "claude-fable-5" -> "Claude Fable 5", "gpt-5.6-sol" -> "GPT-5.6 Sol",
// "grok-4.6" -> "Grok 4.6". Generic title-casing over the id's segments, with
// the gpt prefix uppercased — no per-model table to drift out of date.
function friendlyModelLabel(id: string): string {
  return id
    .split("-")
    .map((part) =>
      part === "gpt"
        ? "GPT"
        : /^\d/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

// Within a vendor group, order by tier like the Cora picker: premium /
// flagship first, fast tiers last. Unrecognized ids sort after the known
// lineup, still selectable.
const COMMIT_MODEL_TIER_RANK: Array<{ match: RegExp; rank: number }> = [
  { match: /fable/i, rank: 0 },
  { match: /-sol$/i, rank: 0 },
  { match: /opus/i, rank: 1 },
  { match: /^grok-/i, rank: 1 },
  { match: /-terra$/i, rank: 2 },
  { match: /sonnet/i, rank: 2 },
  { match: /-luna$/i, rank: 3 },
  { match: /haiku/i, rank: 3 },
];

function commitModelRank(id: string): number {
  return COMMIT_MODEL_TIER_RANK.find(({ match }) => match.test(id))?.rank ?? 9;
}

const COMMIT_MESSAGE_NATIVE_MODELS: { id: string; label: string; group: string }[] =
  AGENT_FAMILY_IDS.flatMap((familyId) => {
    const vendor = AGENT_FAMILIES[familyId].vendorLabel;
    return ALLOWED_WORKER_MODELS.filter((id) => familyForModelId(id) === familyId)
      .slice()
      .sort((a, b) => commitModelRank(a) - commitModelRank(b) || a.localeCompare(b))
      .map((id) => ({ id, label: friendlyModelLabel(id), group: vendor }));
  });

type SettingsTab =
  | "general"
  | "editor"
  | "terminal"
  | "api"
  | "agents"
  | "sessions"
  | "remote-access"
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
  { id: "remote-access", label: "Remote access" },
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
    case "remote-access": // phone with radiating link
      return (
        <svg {...common}>
          <rect x="4" y="4" width="9" height="16" rx="2" />
          <line x1="6.5" y1="17" x2="10.5" y2="17" />
          <path d="M16 9a5 5 0 0 1 0 6" />
          <path d="M18.5 6.5a9 9 0 0 1 0 11" />
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
    session: WorkerSessionSummary,
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
  // Whether the active tab uses the draft-and-Save flow (terminal, api) or
  // auto-applies on change (general, editor, about, agents). The footer
  // hides Save/Cancel on auto-save tabs so the UI doesn't pretend the user
  // needs to commit a change that already persisted. Agents left the draft
  // flow when its last AppSettings row (fast mode) moved to the composer:
  // accounts and the Capability Center pointer own their own persistence.
  const isDraftTab = activeTab === "terminal" || activeTab === "api";
  // The runs tab has its own scrolling list and per-row destructive actions;
  // the global Save/Cancel footer would be misleading there. Hide the
  // footer entirely on tabs that manage their own persistence semantics.
  const hideFooter =
    activeTab === "runs" || activeTab === "sessions" || activeTab === "remote-access";

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
            {renderedTab === "general" && (
              <GeneralSettings workspaceCwd={workspaceCwd} />
            )}
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
                onOpenWorkerSession={onOpenWorkerSession}
              />
            )}
            {renderedTab === "remote-access" && <RemoteAccessSettings />}
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
  const [resourceSnapshot, setResourceSnapshot] =
    useState<PtyResourceSnapshot | null>(null);
  const [resourceError, setResourceError] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = await window.spark.pty.resourceSnapshot();
        if (!active) return;
        setResourceSnapshot(snapshot);
        setResourceError(false);
      } catch {
        if (active) setResourceError(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

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
          title="Resource overview"
          detail="Observation only. Parked output streams can still have a running child process; Codara never stops terminal work just because it is quiet."
        />
        <div
          aria-live="polite"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 8,
          }}
        >
          <ResourceMetric
            label="Live"
            value={resourceSnapshot?.totals.live ?? "—"}
          />
          <ResourceMetric
            label="Visible streams"
            value={resourceSnapshot?.totals.attached ?? "—"}
          />
          <ResourceMetric
            label="Parked / headless"
            value={resourceSnapshot?.totals.detached ?? "—"}
          />
          <ResourceMetric
            label="Bounded buffers"
            value={
              resourceSnapshot
                ? formatResourceBytes(
                    resourceSnapshot.totals.tailBytes +
                      resourceSnapshot.totals.detachedBacklogBytes +
                      resourceSnapshot.totals.pendingBytes,
                  )
                : "—"
            }
          />
        </div>
        <div
          style={{
            marginTop: 8,
            color: resourceError ? "var(--danger)" : "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
          }}
        >
          {resourceError
            ? "Resource inventory is temporarily unavailable."
            : resourceSnapshot?.totals.remote
              ? `${resourceSnapshot.totals.remote} remote terminal${resourceSnapshot.totals.remote === 1 ? "" : "s"} included. CPU and resident memory are not estimated yet.`
              : "CPU and resident memory are not estimated yet."}
        </div>
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
      <div style={{ marginTop: 22 }}>
        <SectionTitle
          title="Run terminal lifecycle"
          detail="Temporary worker panes close when a run settles. Service panes remain until the run is deleted. Failed closes retry automatically."
        />
      </div>
    </div>
  );
}

function ResourceMetric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        minWidth: 0,
        border: "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
        background: "color-mix(in oklab, var(--ink) 2%, transparent)",
        padding: "10px 11px",
      }}
    >
      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          color: "var(--ink)",
          fontFamily: "var(--font-mono)",
          fontSize: 15,
          fontWeight: 650,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function formatResourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const coraModels = draft.openRouterCoraModels.length > 0
    ? draft.openRouterCoraModels
    : [""];

  const replaceCoraModel = (index: number, value: string) => {
    const previous = draft.openRouterCoraModels[index]?.trim();
    const models = draft.openRouterCoraModels.length > 0
      ? [...draft.openRouterCoraModels]
      : [""];
    models[index] = value;
    const nextWorkerModels = draft.coraWorkerModels.filter((id) => id !== previous);
    if (value.trim()) nextWorkerModels.push(value.trim());
    setCheckMessage(null);
    onChange({
      ...draft,
      openRouterCoraModels: models,
      openRouterVerifiedKeyHash: "",
      coraWorkerModels: [...new Set(nextWorkerModels)],
    });
  };

  const removeCoraModel = (index: number) => {
    const removed = draft.openRouterCoraModels[index]?.trim();
    const models = draft.openRouterCoraModels.filter((_, itemIndex) => itemIndex !== index);
    setCheckMessage(null);
    onChange({
      ...draft,
      openRouterCoraModels: models,
      openRouterVerifiedKeyHash: "",
      coraWorkerModels: removed
        ? draft.coraWorkerModels.filter((id) => id !== removed)
        : draft.coraWorkerModels,
    });
  };

  const checkOpenRouter = async () => {
    setChecking(true);
    setCheckMessage(null);
    try {
      const result = await window.spark.openRouter.validate({
        apiKey: draft.openRouterApiKey,
        coraModelIds: draft.openRouterCoraModels,
      });
      if (!result.ok || !result.keyHash) {
        onChange({ ...draft, openRouterVerifiedKeyHash: "" });
        setCheckMessage({ tone: "error", text: result.error || "OpenRouter check failed." });
        return;
      }
      onChange({ ...draft, openRouterVerifiedKeyHash: result.keyHash });
      const count = result.models?.length ?? 0;
      setCheckMessage({
        tone: "ok",
        text: count > 0
          ? `Connected. ${count} Cora model${count === 1 ? "" : "s"} verified.`
          : "Connected. Add a Cora model below to show it in the model picker.",
      });
    } catch (error) {
      onChange({ ...draft, openRouterVerifiedKeyHash: "" });
      setCheckMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <SectionTitle
        title="OpenRouter"
        detail="One key for inline edits, optional commit drafts, and your favorite Cora models."
      />
      <Label text="OpenRouter API key">
        <input
          className="spark-input"
          type="password"
          value={draft.openRouterApiKey}
          onChange={(event) => {
            setCheckMessage(null);
            onChange({
              ...draft,
              openRouterApiKey: event.currentTarget.value,
              openRouterVerifiedKeyHash: "",
            });
          }}
          placeholder="sk-or-..."
          style={inputShellStyle}
        />
      </Label>
      <Label text="Inline edit and commit model">
        <input
          className="spark-input spark-mono"
          type="text"
          value={draft.openRouterModel}
          onChange={(event) => onChange({ ...draft, openRouterModel: event.currentTarget.value })}
          placeholder="google/gemini-flash-latest"
          style={inputShellStyle}
        />
      </Label>
      <div style={{ display: "grid", gap: 7 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span className="spark-eyebrow" style={{ fontSize: 11 }}>Models for Cora</span>
          <button
            type="button"
            className="spark-btn spark-btn-secondary"
            onClick={() => onChange({
              ...draft,
              openRouterCoraModels: draft.openRouterCoraModels.length > 0
                ? [...draft.openRouterCoraModels, ""]
                : [""],
              openRouterVerifiedKeyHash: "",
            })}
            style={{ minHeight: 28, padding: "4px 9px" }}
          >
            + Add model
          </button>
        </div>
        {coraModels.map((modelId, index) => (
          <div
            key={`${index}:${draft.openRouterCoraModels.length}`}
            style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 7 }}
          >
            <input
              className="spark-input spark-mono"
              aria-label={`OpenRouter Cora model ${index + 1}`}
              type="text"
              value={modelId}
              onChange={(event) => replaceCoraModel(index, event.currentTarget.value)}
              placeholder="anthropic/claude-sonnet-4.5"
              style={inputShellStyle}
            />
            <button
              type="button"
              className="spark-btn spark-btn-secondary"
              aria-label={`Remove OpenRouter Cora model ${index + 1}`}
              onClick={() => removeCoraModel(index)}
              style={{ minHeight: 34, padding: "4px 10px" }}
            >
              Remove
            </button>
          </div>
        ))}
        <span style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.45 }}>
          Verified entries appear under OpenRouter in Cora's model selector.
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <button
          type="button"
          className="spark-btn spark-btn-secondary"
          disabled={checking || !draft.openRouterApiKey.trim()}
          onClick={() => void checkOpenRouter()}
        >
          {checking ? "Checking…" : "Check key and models"}
        </button>
        {checkMessage ? (
          <span
            role={checkMessage.tone === "error" ? "alert" : "status"}
            style={{
              color: checkMessage.tone === "error" ? "var(--danger)" : "var(--success, #43c59e)",
              fontSize: 11,
            }}
          >
            {checkMessage.text}
          </span>
        ) : null}
      </div>
      <hr className="spark-divider" style={{ margin: "6px 0" }} />
      <SectionTitle
        title="Git commit messages"
        detail="Automatic picks a fast model on your first usable subscription. Native models run on their own subscription. OpenRouter uses the inline edit and commit model above."
      />
      <Label text="Commit message model">
        <CustomSelect
          value={draft.commitMessageModel}
          options={[
            { value: "auto", label: "Automatic (fast model, OpenAI first)" },
            { value: "openrouter", label: `OpenRouter, ${draft.openRouterModel || "model above"}` },
            ...COMMIT_MESSAGE_NATIVE_MODELS.map((model) => ({
              value: model.id,
              label: model.label,
              group: model.group,
            })),
          ]}
          onChange={(value) =>
            onChange({
              ...draft,
              commitMessageModel: value as AppSettings["commitMessageModel"],
            })
          }
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

function GeneralSettings({
  workspaceCwd,
}: {
  workspaceCwd?: string | null;
}) {
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
                floor={10}
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
            title="Auto-open browser for local dev servers"
            desc="When an agent or terminal prints a localhost URL (e.g. a Vite/Next dev server), automatically open it in a browser tab. When off, a clickable chip appears instead."
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
          {preferences.notificationChannels.inApp ? (
            <div style={{ display: "grid", gap: 7, marginTop: 4 }}>
              <span className="spark-eyebrow" style={{ fontSize: 11 }}>
                Toast stays on screen
              </span>
              <div
                role="group"
                aria-label="Toast duration"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                  gap: 6,
                }}
              >
                {TOAST_DURATION_PRESETS.map((preset) => (
                  <TimingPresetButton
                    key={preset.value}
                    label={preset.label}
                    hint={preset.hint}
                    active={
                      (preferences.toastDurationMs ?? DEFAULT_TOAST_DURATION_MS) === preset.value
                    }
                    onClick={() => void setPreference("toastDurationMs", preset.value)}
                  />
                ))}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 11 }}>
                A toast that times out is never lost — it stays unread in the bell until you
                visit its chat or terminal.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />

      <SectionTitle
        title="Git"
        detail="Codara Studio can fetch every local workspace's remote in the background: one fetch per repository (worktrees share it), never pruning, at most two at a time, nothing while you're offline, and far less often while the machine is idle — so ahead/behind and the history graph stay current without pressing Fetch. Separately, it can watch your GitHub repositories for pushes by other people and tell you about them. With the Codara Studio GitHub App installed (see Instant git triggers below), pushes also arrive as webhooks and fetch immediately; the interval here is the fallback cadence for everything the app doesn't cover."
      />
      {hydrated ? (
        <div style={{ display: "grid", gap: 6 }}>
          <ToggleRow
            title="Auto-fetch remotes in the background"
            desc="Keeps ahead/behind and the remote branches in the graph current without pressing Fetch. Off = the manual Fetch button is the only network activity."
            checked={preferences.gitAutoFetchEnabled !== false}
            onChange={(v) => void setPreference("gitAutoFetchEnabled", v)}
          />
          {preferences.gitAutoFetchEnabled !== false ? (
            <>
              <div style={{ display: "grid", gap: 7 }}>
                <span className="spark-eyebrow" style={{ fontSize: 11 }}>
                  Fetch interval
                </span>
                <div
                  role="group"
                  aria-label="Auto-fetch interval"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: 6,
                  }}
                >
                  {GIT_AUTO_FETCH_INTERVAL_PRESETS.map((preset) => (
                    <TimingPresetButton
                      key={preset.value}
                      label={preset.label}
                      hint={preset.hint}
                      active={
                        (preferences.gitAutoFetchIntervalMinutes ??
                          DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES) === preset.value
                      }
                      onClick={() =>
                        void setPreference("gitAutoFetchIntervalMinutes", preset.value)
                      }
                    />
                  ))}
                </div>
              </div>
              <ToggleRow
                title="Notify me when teammates push"
                desc="Asks GitHub who pushed (via the signed-in gh account), so your own merges never come back as someone else's. One grouped alert per repository, silent by default — a toast and a bell entry, no chime. Needs gh to be signed in; non-GitHub remotes are not watched."
                checked={preferences.notifyTeammatePushes !== false}
                onChange={(v) => void setPreference("notifyTeammatePushes", v)}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {workspaceCwd ? <CopyBranchSetupField workspaceCwd={workspaceCwd} /> : null}

      <hr className="spark-divider" style={{ margin: "2px 0" }} />
      <GithubWebhookSettings />
    </div>
  );
}

// GitHub push webhooks: instant git triggers instead of the 3-minute fetch
// cadence. The webhook URL (carrying its secret path token) is the user's to
// paste once — it is remembered locally, never bundled with the app.
function GithubWebhookSettings() {
  const [url, setUrl] = useState<string>(() => {
    try {
      return window.localStorage.getItem("codara.githubWebhookUrl") ?? "";
    } catch {
      return "";
    }
  });
  const [copied, setCopied] = useState(false);
  const save = (value: string): void => {
    setUrl(value);
    try {
      window.localStorage.setItem("codara.githubWebhookUrl", value);
    } catch {
      /* storage unavailable: the field still works for this session */
    }
  };
  const copy = (): void => {
    void window.spark.clipboard
      .writeText(url.trim())
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <>
      <SectionTitle
        title="Instant git triggers"
        detail="Install the Codara Studio app on your GitHub account and pushes reach your git-triggered automations in seconds instead of on the next background fetch. GitHub asks which account and repositories during install; pick All repositories to cover future repos too. Codara Studio only receives a content-free 'something was pushed' signal — your code and repository names never pass through it."
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="spark-btn is-primary"
          onClick={() => {
            void window.spark.openExternal(
              "https://github.com/apps/codara-studio/installations/new",
            );
          }}
        >
          Install the GitHub App
        </button>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Without it, pushes are still picked up by the background fetch within a few minutes.
        </span>
      </div>
      <details>
        <summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "default" }}>
          Advanced: custom webhook receiver
        </summary>
        <div
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}
        >
          <input
            className="spark-input spark-mono"
            value={url}
            onChange={(e) => save(e.target.value)}
            placeholder="https://studio.codarasolutions.com/hooks/github/…"
            style={{ flex: 1, minWidth: 260 }}
          />
          <button type="button" className="spark-btn" onClick={copy} disabled={!url.trim()}>
            {copied ? "Copied ✓" : "Copy URL"}
          </button>
        </div>
      </details>
    </>
  );
}


// The "Use the Active account in your terminal" feature was removed: plain
// `claude` keeps its chats, settings, agents, and commands inside the config
// directory that setting redirected, so switching accounts made the terminal
// lose all of that state. This note only appears while the block the old
// feature added is still in the user's shell startup file, and tells them how
// to delete it themselves — Codara no longer edits shell startup files at all.
function TerminalAccountLeftoverNote() {
  const [leftover, setLeftover] = useState<NativeCliShellProfileLeftover | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.spark.nativeCliShellLeftover
      .status()
      .then((next) => {
        if (mounted) setLeftover(next);
      })
      .catch(() => {
        // Detection is best-effort; a failed read just means no note.
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (!leftover) return null;
  return (
    <div
      style={{
        padding: "10px 14px",
        border: "1px solid var(--rule-soft)",
        borderRadius: 8,
        color: "var(--muted)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      The "Use the Active account in your terminal" setting was removed — it
      made plain <code className="spark-mono">claude</code> lose its chats and
      settings. To finish tidying up, open{" "}
      <code className="spark-mono">{leftover.profilePath}</code> and delete the
      lines from <code className="spark-mono">{leftover.markerBegin}</code>{" "}
      through <code className="spark-mono">{leftover.markerEnd}</code>.
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
        detail="Ghost-text autocomplete uses the OpenRouter key and model configured in Settings."
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
      <div style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.45 }}>
        The model is configured once in <strong>API and model</strong>, where it
        is also available for OpenRouter commit drafts.
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

/**
 * One section for every account behind Codara, grouped by provider. An
 * account is one sign-in with two halves (a Cora row and its terminal
 * profile) that the main process pairs and keeps in step, for Anthropic,
 * OpenAI and xAI alike; the card shows one account and one Use action.
 */
function AccountsSettings() {
  const [overview, setOverview] = useState<PiSubscriptionOverview | null>(null);
  const [loading, setLoading] = useState(true);
  // True once the first status read settled either way: a store that failed
  // has answered too, and the cards the CLI side can still build must show.
  const [overviewSettled, setOverviewSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<PiLoginView | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [install, setInstall] = useState<PiInstallView | null>(null);
  const [addingProvider, setAddingProvider] = useState<PiSubscriptionProvider | null>(null);
  const [addLabel, setAddLabel] = useState("");
  const [accountMutationId, setAccountMutationId] = useState<string | null>(null);
  // Main refuses to delete an account while terminals run on it, and refuses
  // a Codex switch the same way, saying how many; the card's next Delete or
  // Use offers to close them first.
  const [closeSessionsPrompt, setCloseSessionsPrompt] = useState<{
    profileId: string;
    action: "use" | "delete";
    count: number;
  } | null>(null);
  const [cliInspection, setCliInspection] =
    useState<NativeCliAccountsInspection | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const {
    overview: usageOverview,
    loading: usageLoading,
    error: usageError,
    load: loadUsage,
  } = useSubscriptionUsage();
  // Bumped on connect/disconnect to force the usage panel to re-read; the main
  // process caches usage for a minute, which is right for idle re-renders but
  // wrong immediately after the set of connected subscriptions changes.
  const [usageEpoch, setUsageEpoch] = useState(0);

  const refresh = () => {
    setLoading(true);
    setError(null);
    // A refusal's session count is only right until the next read; the
    // overview carries the live count from then on.
    setCloseSessionsPrompt(null);
    void window.spark.piSubscriptions
      .status()
      .then(setOverview)
      .catch((err) => setError(ipcErrorMessage(err)))
      .finally(() => {
        setLoading(false);
        setOverviewSettled(true);
      });
  };

  useEffect(() => {
    refresh();
    const remove = window.spark.piSubscriptions.onEvent((event) => {
      // Broadcast store-change pings carry no login-flow state; they exist for
      // the always-on usage surfaces. This dialog re-reads the connection
      // overview and leaves the login view alone.
      if (event.type === "changed") {
        refresh();
        return;
      }
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
              message: "Signing in…",
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

  // Account mutations bump the epoch; the cached usage read in main is right
  // for idle re-renders but wrong the moment the set of accounts changes.
  useEffect(() => {
    if (usageEpoch > 0) loadUsage(false);
  }, [usageEpoch, loadUsage]);

  const installRuntime = () => {
    setError(null);
    setInstall({ status: "running", message: "Starting install…" });
    void window.spark.piSubscriptions.installRuntime().catch((err) => {
      setInstall({ status: "failed", message: (err as Error).message });
    });
  };

  const beginProfileLogin = (
    provider: PiSubscriptionProvider,
    message: string,
    start: () => Promise<unknown>,
  ) => {
    setError(null);
    setAddingProvider(null);
    setAddLabel("");
    setLogin({
      requestId: "starting",
      provider,
      status: "running",
      message,
    });
    void start().catch((err) => {
      setLogin({
        requestId: "failed-to-start",
        provider,
        status: "failed",
        message: ipcErrorMessage(err),
      });
    });
  };

  // One sign-in for every provider: main runs Pi's login (a browser page for
  // Anthropic and OpenAI, a device code for xAI) and writes both halves.
  const addAccount = (provider: PiSubscriptionProvider, label: string) => {
    beginProfileLogin(
      provider,
      "Opening your browser to sign in to another account…",
      () => window.spark.piSubscriptions.addAccount({
        provider,
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    );
  };

  const reconnectAccount = (
    provider: PiSubscriptionProvider,
    profileId: string,
    label: string,
  ) => {
    beginProfileLogin(
      provider,
      `Opening your browser to sign in to ${label}…`,
      () => window.spark.piSubscriptions.reconnectAccount({ provider, profileId }),
    );
  };

  const mutateAccount = async (
    profileId: string,
    mutation: () => Promise<PiSubscriptionOverview>,
  ): Promise<boolean> => {
    setError(null);
    setAccountMutationId(profileId);
    try {
      const next = await mutation();
      setOverview(next);
      setUsageEpoch((epoch) => epoch + 1);
      return true;
    } catch (err) {
      setError(ipcErrorMessage(err));
      return false;
    } finally {
      setAccountMutationId(null);
    }
  };

  const renameAccount = (profileId: string, label: string): Promise<boolean> =>
    mutateAccount(profileId, () =>
      window.spark.piSubscriptions.renameAccount({ profileId, label }),
    );

  // A refusal carries the count of terminals it would close; the card's
  // next Use or Delete resends with closeSessions.
  const refusedWithSessions = (
    profileId: string,
    action: "use" | "delete",
    err: unknown,
  ) => {
    const count = liveTerminalCount(ipcErrorMessage(err));
    if (count !== null) setCloseSessionsPrompt({ profileId, action, count });
  };

  const makeDefault = (
    provider: PiSubscriptionProvider,
    profileId: string,
    closeSessions: boolean,
  ): Promise<boolean> => {
    setCloseSessionsPrompt(null);
    return mutateAccount(profileId, async () => {
      try {
        return await window.spark.piSubscriptions.makeDefault({
          provider,
          profileId,
          ...(closeSessions ? { closeSessions: true } : {}),
        });
      } catch (err) {
        refusedWithSessions(profileId, "use", err);
        throw err;
      }
    });
  };

  const deleteAccount = (
    profileId: string,
    closeSessions: boolean,
  ): Promise<boolean> => {
    setCloseSessionsPrompt(null);
    return mutateAccount(profileId, async () => {
      try {
        return await window.spark.piSubscriptions.deleteAccount({
          profileId,
          ...(closeSessions ? { closeSessions: true } : {}),
        });
      } catch (err) {
        refusedWithSessions(profileId, "delete", err);
        throw err;
      }
    });
  };

  // A terminal-only half is renamed and deleted through the native account
  // store, but its card lives in the same list, so the result is re-read as
  // the account overview the other mutations return.
  const mutateTerminalHalf = (
    cliProfileId: string,
    mutation: () => Promise<unknown>,
  ): Promise<boolean> =>
    mutateAccount(cliProfileId, async () => {
      await mutation();
      return window.spark.piSubscriptions.status();
    });

  // The terminal side is a separate main-process store with its own change
  // feed; it supplies the halves no row names yet.
  const refreshCli = useCallback(async () => {
    try {
      const next = await window.spark.nativeCliAccounts.inspect();
      setCliInspection(next);
      setCliError(null);
    } catch (err) {
      setCliError(
        (err as Error).message || "Command-line accounts could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    void refreshCli();
    return window.spark.nativeCliAccounts.onChanged(() => {
      void refreshCli();
    });
  }, [refreshCli]);

  const submitPrompt = (value: string) => {
    if (!login?.promptId || !value.trim()) return;
    const { requestId, promptId } = login;
    setLogin((current) => current ? {
      ...current,
      message: "Finishing sign-in…",
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

  const providerViews = useMemo<AccountProviderView[]>(() => {
    // Limits are reported per Cora account, so they belong in that account's
    // card rather than in a second list of provider cards below it.
    const usageByProfile = new Map(
      (usageOverview?.profiles ?? []).map((entry) => [entry.profileId, entry] as const),
    );
    const disabled = !overview?.runtimeInstalled;
    const busy = busyProvider !== null || accountMutationId !== null;
    return ACCOUNT_PROVIDER_DESCRIPTORS.map((descriptor) => {
      const { provider } = descriptor;
      const piProfiles = (overview?.profiles ?? []).filter(
        (profile) => profile.provider === provider,
      );
      const inspected = cliInspection?.runtimes.find(
        (entry) => entry.runtime === descriptor.runtime,
      );
      const cliProfiles = inspected?.profiles ?? [];
      const cliUnavailable = inspected?.unavailable === true;

      // One card per account, paired in the main process: every Cora row
      // names its terminal half, so nothing is matched here. Keys are the
      // row id (or the terminal id for a half without a row), which never
      // changes when a half is shared, so cards never remount.
      const linked = new Set(
        piProfiles.flatMap((profile) =>
          profile.cliProfileId ? [profile.cliProfileId] : [],
        ),
      );
      const rows = piProfiles.map<AccountCardView>((profile) => {
        const usage = usageByProfile.get(profile.id);
        const refused =
          closeSessionsPrompt?.profileId === profile.id ? closeSessionsPrompt : null;
        // The count main refused with is right until the next read; after
        // that the overview's live count keeps the armed Delete honest.
        const closeSessionsCount =
          refused?.action === "delete"
            ? refused.count
            : (profile.terminal?.liveSessions ?? 0);
        const switchCloseSessionsCount = refused?.action === "use" ? refused.count : 0;
        return {
          key: `${provider}:${profile.id}`,
          provider,
          label: profile.label,
          ...(profile.email ? { email: profile.email } : {}),
          ...(usage?.plan ? { plan: usage.plan } : {}),
          // SuperGrok (and any provider with no quota API) reports status ok
          // and zero windows. That is not a failure, so do not render the
          // empty report as a red "no usage windows" error on the card.
          ...(usage && accountCardShowsUsage(usage)
            ? { usage: <UsageEntryBody usage={usage} compact /> }
            : {}),
          coraProfileId: profile.id,
          ...(profile.cliProfileId ? { cliProfileId: profile.cliProfileId } : {}),
          builtIn: profile.builtIn === true,
          active: profile.isDefault,
          cora: {
            connected: profile.connected,
            expired: profile.expired,
            canRefresh: profile.canRefresh,
            ...(profile.error ? { error: profile.error } : {}),
          },
          ...(profile.terminal ? { terminal: profile.terminal } : {}),
          busy: accountMutationId === profile.id,
          ...(closeSessionsCount > 0 ? { closeSessionsCount } : {}),
          ...(switchCloseSessionsCount > 0 ? { switchCloseSessionsCount } : {}),
        };
      });
      // Account 1 first: it is the user's own CLI login and the account
      // everything else hands off to.
      rows.sort((left, right) => Number(right.builtIn) - Number(left.builtIn));
      // Terminal profiles no row names are terminal-only halves; the card
      // offers to share them with Cora.
      const terminalOnly = cliProfiles
        .filter((profile) => profile.managed && !linked.has(profile.id))
        .map<AccountCardView>((profile) => ({
          key: `${provider}:cli:${profile.id}`,
          provider,
          label: profile.label,
          ...(profile.email ? { email: profile.email } : {}),
          cliProfileId: profile.id,
          builtIn: false,
          active: false,
          terminal: {
            connected: profile.status === "connected",
            ...(profile.status === "unsafe" ? { unsafe: true } : {}),
          },
          cliDefault: profile.isDefault,
          busy: accountMutationId === profile.id,
        }));
      // The user's own CLI login has no row until it holds a credential
      // (main creates one the moment it does). Until then the slot says
      // what to do instead of vanishing.
      const personal = cliProfiles.find((profile) => !profile.managed);
      const accountOneSlot: AccountCardView[] =
        personal && !linked.has(personal.id)
          ? [
              {
                key: `${provider}:account-one`,
                provider,
                label: personal.label || "Account 1",
                builtIn: true,
                active: false,
                terminal: { connected: personal.status === "connected" },
                busy: false,
              },
            ]
          : [];
      const cards = [...accountOneSlot, ...rows, ...terminalOnly];
      // The signed-out Account 1 slot is an instruction, not an account.
      const count = cards.filter(
        (card) => card.coraProfileId || card.terminal?.connected,
      ).length;
      return {
        descriptor,
        detail: accountProviderDetail(descriptor),
        cards,
        ...(count > 0 ? { footer: `${count} ${count === 1 ? "account" : "accounts"}` } : {}),
        disabled,
        busy,
        cliError: cliUnavailable || Boolean(cliError && !cliInspection),
        addLabel: addingProvider === provider ? addLabel : "",
      };
    });
  }, [
    accountMutationId,
    addLabel,
    addingProvider,
    busyProvider,
    cliError,
    cliInspection,
    closeSessionsPrompt,
    overview,
    usageOverview,
  ]);

  // One account, one action each, for every provider. Every mutation goes
  // through the Pi account channels, which switch, share, and delete both
  // halves in the main process; the terminal id is only used for a half
  // that has no row. Cora and the terminal tool switch together, so nothing
  // is opened here: new terminals pick the account up. Codex closes its
  // running sessions in main, after the card has asked with the count.
  const accountActions: AccountActions = {
    onBeginAdd: (provider) => {
      setAddingProvider(provider);
      setAddLabel("");
      setError(null);
    },
    onAddLabel: setAddLabel,
    onAdd: (provider) => addAccount(provider, addLabel),
    onCancelAdd: () => {
      setAddingProvider(null);
      setAddLabel("");
    },
    onUse: (card, { closeSessions }) => {
      if (!card.coraProfileId) return;
      void makeDefault(card.provider, card.coraProfileId, closeSessions);
    },
    onReconnect: (card) => {
      if (!card.coraProfileId) return;
      reconnectAccount(card.provider, card.coraProfileId, card.label);
    },
    onShare: (card) => {
      if (card.coraProfileId) {
        const coraProfileId = card.coraProfileId;
        void mutateAccount(coraProfileId, () =>
          window.spark.piSubscriptions.shareLogin({ coraProfileId }),
        );
        return;
      }
      if (!card.cliProfileId) return;
      const cliProfileId = card.cliProfileId;
      void mutateAccount(cliProfileId, () =>
        window.spark.piSubscriptions.shareLogin({
          cliProfileId,
          provider: card.provider,
        }),
      );
    },
    onRename: (card, label) => {
      if (card.coraProfileId) return renameAccount(card.coraProfileId, label);
      if (!card.cliProfileId) return Promise.resolve(false);
      const profileId = card.cliProfileId;
      return mutateTerminalHalf(profileId, () =>
        window.spark.nativeCliAccounts.rename({
          runtime: runtimeForSubscription(card.provider),
          profileId,
          label,
        }),
      );
    },
    onDelete: (card, { closeSessions }) => {
      if (card.builtIn) return;
      if (card.coraProfileId) {
        void deleteAccount(card.coraProfileId, closeSessions);
        return;
      }
      if (!card.cliProfileId) return;
      const profileId = card.cliProfileId;
      void mutateTerminalHalf(profileId, () =>
        window.spark.nativeCliAccounts.delete({
          runtime: runtimeForSubscription(card.provider),
          profileId,
        }),
      );
    },
  };

  // Every store answers before any card shows. Rendering the Cora rows alone
  // made the terminal-only cards pop in a beat later, which read as accounts
  // appearing out of nowhere. A store that failed has answered too: the
  // cards the other side can still build show above its error line.
  const accountsReady =
    (overview !== null || overviewSettled) && (cliInspection !== null || cliError !== null);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <SectionTitle
            title="Accounts"
            detail="The sign-ins Cora and the terminal tools run on. Every account is one sign-in for both Cora and its terminal tool: Claude Code, Codex, or Grok."
          />
        </div>
        <AccountAddPicker providers={providerViews} actions={accountActions} />
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {!accountsReady ? (
          <span style={{ fontSize: 11.5, color: "var(--muted-2)" }}>Loading accounts…</span>
        ) : (
          <AccountCards providers={providerViews} actions={accountActions} />
        )}
        {!overview && loading ? <RuntimeDiagnosticSkeleton /> : null}
        {overview?.runtimeInstalled ? (
          <div
            style={{
              padding: "3px 3px 0",
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            Cora runs on Pi {overview.runtimeVersion}. Each account keeps its own
            private sign-in, and they all share the same Cora chats.
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

      <TerminalAccountLeftoverNote />

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

      {cliError ? (
        <div
          role="alert"
          style={{ color: "var(--danger)", fontFamily: "var(--font-sans)", fontSize: 12 }}
        >
          {cliError}
        </div>
      ) : null}

      {/* Limits live inside each account card above. */}
      {overview?.runtimeInstalled ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            style={{
              color: usageError ? "var(--danger)" : "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {usageError
              ? usageError
              : "Limits come straight from each provider. Claude's are re-checked every 15 minutes."}
          </span>
          <FooterButton onClick={() => loadUsage(true)} disabled={usageLoading}>
            {usageLoading ? "Checking…" : "Refresh limits"}
          </FooterButton>
        </div>
      ) : null}

      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        About Claude accounts: using a Claude Pro or Max account outside Anthropic's own apps can draw on Anthropic
        Extra Usage, which is billed on top of the plan. Codara never quietly switches you to a paid API key, but if
        you want a hard no-extra-charges limit, turn Extra Usage off in your Anthropic account.
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
            "Cora needs this exact Pi build for chats, planning, and every worker."}
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
            {done ? "Account connected" : failed ? "Could not sign in" : "Signing in to this account"}
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
            placeholder={textPrompt.placeholder || "Paste the code from your browser"}
            style={inputShellStyle}
          />
          <button type="submit" className="spark-btn is-primary" disabled={!promptValue.trim()}>
            Continue
          </button>
        </form>
      ) : null}

      <div style={{ display: "flex", gap: 6 }}>
        {login.url ? (
          <FooterButton onClick={() => void window.spark.openInSystemBrowser(login.url!)}>Open browser again</FooterButton>
        ) : null}
        <FooterButton onClick={onCancel}>{login.status === "running" ? "Cancel" : "Dismiss"}</FooterButton>
      </div>
    </div>
  );
}

/**
 * Electron wraps a main-process throw as "Error invoking remote method 'x':
 * <name>: msg", where the name is whatever class the error carried
 * (AnthropicAccountNotConnectedError, TypeError). Only the message is for
 * the user.
 */
function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "");
}

/**
 * The count main puts in its refusal to delete an account with terminals
 * still running on it. The card's next Delete closes that many first.
 */
function liveTerminalCount(message: string): number | null {
  const match = /(\d+) terminal sessions? (?:is|are) using this account/.exec(message);
  return match ? Number(match[1]) : null;
}

/** True when the in-card usage block has something to say besides silence. */
function accountCardShowsUsage(usage: UsageEntry): boolean {
  if (usage.windows.length > 0) return true;
  if (usage.limitReached) return true;
  if (usage.status === "ok" || usage.status === "not_connected") return false;
  return Boolean(usage.message);
}

// Accounts, plus a pointer to the Capability Center. The fast-mode toggle used
// to sit here; it now lives on the composer's flash button, next to the model
// it applies to.
function AgentsSettings() {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <AccountsSettings />

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

// One confirm panel serves both deletes, so what is pending is either a single
// session or a whole selection. Bulk never carries a memory scope: which memory
// a delete may take with it is a per-session call (a Claude project's memory is
// shared, Codex's is machine-wide), and that decision doesn't survive being
// applied to a dozen rows at once.
type PendingSessionDelete =
  | { kind: "one"; session: WorkerSessionSummary }
  | { kind: "many"; sessions: WorkerSessionSummary[] };

function SessionsSettings({
  onOpenWorkerSession,
}: {
  onOpenWorkerSession: (
    runtime: WorkerSessionRuntime,
    cwd: string,
    session: WorkerSessionSummary,
  ) => void;
}) {
  const { preferences, setPreference, hydrated } = usePreferences();
  const [sessions, setSessions] = useState<WorkerSessionSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<"all" | WorkerSessionRuntime>("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingSessionDelete | null>(null);
  const [deleteMemory, setDeleteMemory] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Number of sessions a running bulk delete has already worked through, or
  // null when no bulk delete is in flight. Doubles as the busy flag.
  const [bulkDone, setBulkDone] = useState<number | null>(null);
  const bulkBusy = bulkDone !== null;
  const locked = bulkBusy || busyId !== null;

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

  // A session that disappeared between refreshes (deleted here, or from
  // another window) must not linger in the selection and come back as a
  // delete target the next time the user hits Delete selected.
  useEffect(() => {
    if (!sessions) return;
    const live = new Set(sessions.map(workerSessionKey));
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => live.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

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

  // Select-all only ever acts on what the filter is showing, but the selection
  // itself survives a filter change — what you ticked is what gets deleted.
  const filteredKeys = useMemo(() => filtered.map(workerSessionKey), [filtered]);
  const selectedFilteredCount = filteredKeys.filter((key) => selected.has(key)).length;
  const allFilteredSelected =
    filteredKeys.length > 0 && selectedFilteredCount === filteredKeys.length;
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;
  const selectedSessions = useMemo(
    () => (sessions ?? []).filter((session) => selected.has(workerSessionKey(session))),
    [sessions, selected],
  );

  const toggleSession = (key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAllFiltered = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of filteredKeys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const confirmSingleDelete = async (session: WorkerSessionSummary) => {
    const deleteSession = (
      window.spark.agentSession as Partial<typeof window.spark.agentSession>
    ).delete;
    if (typeof deleteSession !== "function") {
      setPendingDelete(null);
      setDeleteMemory(false);
      setError("Restart Codara once to enable session deletion.");
      return;
    }
    const memoryScope: WorkerSessionMemoryScope = workerSessionMemoryScope(
      session.runtime,
      deleteMemory,
    );
    setBusyId(`${session.runtime}:${session.sessionId}`);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteSession({
        runtime: session.runtime,
        nativeClaudeProfileId: session.nativeClaudeProfileId,
        nativeCodexProfileId: session.nativeCodexProfileId,
        nativeGrokProfileId: session.nativeGrokProfileId,
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

  // Sequential on purpose: the delete IPC rewrites the shared history index
  // per call, so overlapping deletes would race each other's rewrite. One
  // failure never stops the run — the rest are still deleted and the failure
  // is reported at the end.
  const confirmBulkDelete = async (targets: WorkerSessionSummary[]) => {
    const deleteSession = (
      window.spark.agentSession as Partial<typeof window.spark.agentSession>
    ).delete;
    if (typeof deleteSession !== "function") {
      setPendingDelete(null);
      setError("Restart Codara once to enable session deletion.");
      return;
    }
    setBulkDone(0);
    setError(null);
    setNotice(null);
    const warnings: string[] = [];
    const failures: string[] = [];
    let deleted = 0;
    for (const session of targets) {
      try {
        const result = await deleteSession({
          runtime: session.runtime,
          nativeClaudeProfileId: session.nativeClaudeProfileId,
          nativeCodexProfileId: session.nativeCodexProfileId,
          nativeGrokProfileId: session.nativeGrokProfileId,
          sessionId: session.sessionId,
          cwd: session.cwd,
          transcriptPath: session.transcriptPath,
          memoryScope: "none",
        });
        deleted += 1;
        warnings.push(...result.warnings);
      } catch (err) {
        failures.push(`“${session.title}”: ${(err as Error).message}`);
      }
      setBulkDone((done) => (done === null ? null : done + 1));
    }
    setPendingDelete(null);
    setSelected(new Set());
    setBulkDone(null);
    // refresh() clears the error banner on success, so the outcome is written
    // after the list has been re-read.
    await refresh();
    setNotice([`Deleted ${countedSessions(deleted)}.`, ...warnings].join(" "));
    if (failures.length > 0) {
      setError(`${countedSessions(failures.length)} could not be deleted. ${failures.join(" ")}`);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <SectionTitle
        title="Agent sessions"
        detail="Browse and resume Claude and Codex sessions from any local project. Opening a session switches to its workspace, or creates the workspace in Codara first."
      />

      {hydrated ? (
        <ToggleRow
          title="Resume running agent sessions when Codara reopens"
          desc="Reopens terminal tabs that still had Claude or Codex running and resumes their exact local session. Shell tabs and agents you already exited still start normally."
          checked={preferences.restoreAgentSessions === true}
          onChange={(next) => void setPreference("restoreAgentSessions", next)}
        />
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <FooterButton disabled={bulkBusy} onClick={() => void refresh()}>Refresh</FooterButton>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="spark-input"
          type="text"
          value={filter}
          disabled={bulkBusy}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Filter by title, directory, or session id"
          style={{ flex: 1, width: "auto" }}
        />
        <select
          className="spark-input"
          aria-label="Filter sessions by provider"
          value={runtimeFilter}
          disabled={bulkBusy}
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

      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 26, padding: "0 2px" }}>
        <input
          type="checkbox"
          aria-label="Select all filtered sessions"
          checked={allFilteredSelected}
          disabled={filteredKeys.length === 0 || locked}
          ref={(node) => {
            // Indeterminate is a DOM property, not an attribute, so React can
            // only reach it through the node itself.
            if (node) node.indeterminate = someFilteredSelected;
          }}
          onChange={(event) => toggleAllFiltered(event.currentTarget.checked)}
          style={{ accentColor: "var(--accent)", cursor: "default" }}
        />
        {selected.size > 0 ? (
          <span
            style={{
              color: "var(--ink-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 9.5,
            }}
          >
            {selected.size} selected
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <DangerButton
          disabled={selected.size === 0 || locked}
          onClick={() => {
            setPendingDelete({ kind: "many", sessions: selectedSessions });
            setDeleteMemory(false);
            setNotice(null);
          }}
        >
          Delete selected
        </DangerButton>
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
            {pendingDelete.kind === "one"
              ? `Permanently delete “${pendingDelete.session.title}”?`
              : `Permanently delete ${countedSessions(pendingDelete.sessions.length)}?`}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.45 }}>
            {pendingDelete.kind === "one"
              ? "This removes the local transcript and cannot be undone. Close a running copy of the session before deleting it."
              : "This removes each local transcript and cannot be undone. Close any running copies of these sessions before deleting them."}
          </div>
          {pendingDelete.kind === "one" &&
          workerSessionMemoryDeleteOption(pendingDelete.session.runtime) ? (
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
                {
                  workerSessionMemoryDeleteOption(pendingDelete.session.runtime)
                    ?.detail
                }
              </span>
            </label>
          ) : pendingDelete.kind === "many" ? (
            <div style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.4 }}>
              Local agent memory is kept. Delete a session individually to also remove its memory.
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
            <FooterButton
              disabled={bulkBusy}
              onClick={() => {
                setPendingDelete(null);
                setDeleteMemory(false);
              }}
            >
              Cancel
            </FooterButton>
            <DangerButton
              disabled={locked}
              onClick={() => {
                if (pendingDelete.kind === "one") void confirmSingleDelete(pendingDelete.session);
                else void confirmBulkDelete(pendingDelete.sessions);
              }}
            >
              {pendingDelete.kind === "one"
                ? busyId
                  ? "Deleting…"
                  : deleteMemory
                    ? "Delete session + memory"
                    : "Delete session"
                : bulkBusy
                  ? `Deleting ${Math.min((bulkDone ?? 0) + 1, pendingDelete.sessions.length)} of ${pendingDelete.sessions.length}…`
                  : `Delete ${countedSessions(pendingDelete.sessions.length)}`}
            </DangerButton>
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
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
            const key = workerSessionKey(session);
            return (
              <SessionManagerRow
                key={key}
                session={session}
                busy={busyId === key}
                locked={bulkBusy}
                selected={selected.has(key)}
                onToggleSelect={(checked) => toggleSession(key, checked)}
                onOpen={() => onOpenWorkerSession(session.runtime, session.cwd, session)}
                onDelete={() => {
                  setPendingDelete({ kind: "one", session });
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
  locked,
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  session: WorkerSessionSummary;
  busy: boolean;
  locked: boolean;
  selected: boolean;
  onToggleSelect: (checked: boolean) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  // Quiet until pointed at: a management list shouldn't read as a column of
  // red buttons, but the intent has to be unmistakable once you're on it.
  const [deleteHover, setDeleteHover] = useState(false);
  const providerColor = session.runtime === "claude" ? "var(--accent)" : "var(--info)";
  // Anywhere on the row toggles it. The checkbox is a 13px target in a list
  // you are meant to sweep through, so the row body carries the same action —
  // except where the click belongs to a real control (Open, the trash, the
  // checkbox itself), which owns it. Guarding on the event target beats
  // stopPropagation on each control: a control added later is covered too.
  const toggleFromRow = (event: React.MouseEvent<HTMLDivElement>) => {
    if (locked) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, a, select, label, textarea")) {
      return;
    }
    onToggleSelect(!selected);
  };
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setDeleteHover(false);
      }}
      onClick={toggleFromRow}
      style={{
        display: "grid",
        gridTemplateColumns: "auto auto minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: selected
          ? `color-mix(in oklch, ${providerColor} ${hover ? 15 : 10}%, var(--panel))`
          : hover
            ? "color-mix(in oklab, var(--panel) 92%, transparent)"
            : "color-mix(in oklab, var(--bg) 82%, transparent)",
        border: `1px solid ${
          selected
            ? `color-mix(in oklch, ${providerColor} ${hover ? 46 : 34}%, var(--rule-soft))`
            : "var(--rule-soft)"
        }`,
        borderRadius: "var(--radius-surface, 7px)",
        // Left rail: at a glance, which rows a bulk delete would take.
        boxShadow: selected ? `inset 2px 0 0 ${providerColor}` : "none",
        cursor: locked ? "default" : "pointer",
        // Sweeping the list toggles rows fast; without this the titles pick up
        // a drag selection on the way past.
        userSelect: "none",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={locked}
        aria-label={`Select session “${session.title}”`}
        onChange={(event) => onToggleSelect(event.currentTarget.checked)}
        style={{ accentColor: "var(--accent)", cursor: "default" }}
      />
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
        }}
      >
        <RuntimeMark runtime={session.runtime} size={14} />
      </span>
      <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
        <div
          title={session.title}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--ink)",
            fontSize: 12.5,
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
            fontSize: 10,
          }}
        >
          {session.cwdExists ? session.cwd : `${session.cwd} · directory missing`}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
          }}
        >
          <span>{session.runtime === "claude" ? "Claude" : "Codex"}</span>
          <span aria-hidden>·</span>
          <span title={session.sessionId}>{shortWorkerSessionId(session.sessionId)}</span>
          <span aria-hidden>·</span>
          <span>{formatSessionUpdated(session.updatedAt)}</span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <FooterButton onClick={onOpen} disabled={!session.cwdExists || busy || locked}>Open</FooterButton>
        <button
          type="button"
          className="spark-icon-btn"
          onClick={onDelete}
          disabled={busy || locked}
          aria-label="Delete"
          title={`Delete “${session.title}”`}
          onMouseEnter={() => setDeleteHover(true)}
          onMouseLeave={() => setDeleteHover(false)}
          style={{
            cursor: "default",
            color: deleteHover ? "var(--danger)" : "var(--muted)",
            background: deleteHover
              ? "color-mix(in oklch, var(--danger) 12%, transparent)"
              : "transparent",
          }}
        >
          <SessionTrashIcon />
        </button>
      </div>
    </div>
  );
}

function SessionTrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 7h14" />
      <path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.8 7 7.6 18.4a1.5 1.5 0 0 0 1.5 1.4h5.8a1.5 1.5 0 0 0 1.5-1.4L17.2 7" />
    </svg>
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

function workerSessionKey(session: WorkerSessionSummary): string {
  return `${session.runtime}:${session.sessionId}`;
}

function countedSessions(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
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
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
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

  const handleCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await window.spark.updater.check();
      if (result.status === "dev") {
        setCheckResult("Updates are disabled in dev builds.");
      } else if (result.status === "error") {
        setCheckResult(`Check failed: ${result.message ?? "unknown error"}`);
      } else if (result.updateAvailable) {
        // The banner takes over from here (download progress → restart).
        setCheckResult(`Update v${result.version ?? "?"} found — downloading…`);
      } else {
        setCheckResult(`You're up to date (v${version}).`);
      }
    } catch {
      setCheckResult("Check failed.");
    } finally {
      setChecking(false);
    }
  };

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
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={() => void handleCheck()}
          disabled={checking}
          style={{
            appearance: "none",
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "none",
            boxShadow: "var(--lift-hi)",
            padding: "5px 14px",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
            borderRadius: 5,
            cursor: "default",
            opacity: checking ? 0.6 : 1,
          }}
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {checkResult && (
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--muted)" }}>
            {checkResult}
          </span>
        )}
      </div>
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
  /**
   * Optional group heading. Consecutive options sharing a group render once
   * under an uppercase header row (the Cora model-picker look); ungrouped
   * options render flush at the top.
   */
  group?: string;
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
          {options.map((opt, index) => {
            const previous = index > 0 ? options[index - 1] : undefined;
            const showHeader = Boolean(opt.group) && opt.group !== previous?.group;
            return (
              <React.Fragment key={opt.value}>
                {showHeader && (
                  <div
                    role="presentation"
                    style={{
                      padding: "7px 9px 3px",
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      borderTop: "1px solid var(--rule)",
                      marginTop: index > 0 ? 3 : 0,
                    }}
                  >
                    {opt.group}
                  </div>
                )}
                <SelectOption
                  label={opt.label}
                  active={opt.value === value}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                />
              </React.Fragment>
            );
          })}
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

// One liquid-glass tuning slider: 0–200% of the design default. Keep drag state
// local and persist once on release/blur. Sending an IPC preference write for
// every pointer sample forced the whole themed app (including SVG lens filters)
// to repaint dozens of times per second and made Settings feel sticky.
function GlassSliderRow({
  label,
  hint,
  floor = 0,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  /**
   * Minimum stored value. Enforced by clamping onChange, NOT by shrinking the
   * slider's min — every row shares the same 0–200 track so equal values line
   * up thumb-for-thumb regardless of floor.
   */
  floor?: number;
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
        min={0}
        max={200}
        step={5}
        value={draftValue}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(event) =>
          setDraftValue(Math.max(floor, Number(event.currentTarget.value)))
        }
        onPointerUp={(event) => commit(Math.max(floor, Number(event.currentTarget.value)))}
        onPointerCancel={(event) => commit(Math.max(floor, Number(event.currentTarget.value)))}
        onBlur={(event) => commit(Math.max(floor, Number(event.currentTarget.value)))}
        onKeyUp={(event) => commit(Math.max(floor, Number(event.currentTarget.value)))}
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
