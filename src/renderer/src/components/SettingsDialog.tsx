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
  LinkOpenTarget,
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProfileLoginRequest,
  PiSubscriptionPrompt,
  PiSubscriptionProvider,
  PtyResourceSnapshot,
  RunState,
  ShellInfo,
  WorkerSessionMemoryScope,
  WorkerSessionRuntime,
  WorkerSessionSummary,
} from "@shared/types";
import {
  DEFAULT_COPY_BRANCH_SETUP_COMMAND,
  EDITOR_THEME_IDS,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MAX,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MIN,
  AUTOSAVE_DELAY_PRESETS,
  DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES,
  DEFAULT_TOAST_DURATION_MS,
  DEFAULT_WORKSPACE_SWITCH_HUD_MS,
  MAX_WORKSPACE_SWITCH_HUD_MS,
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
import { accountCardReady, type AccountCardView } from "./AccountCard";
import {
  ACCOUNT_PROVIDER_DESCRIPTORS,
  accountProviderDetail,
  type AccountProviderDescriptor,
} from "../lib/account-provider-descriptors";
import { stableAccountCardKeys } from "../lib/account-card-keys";
import RemoteAccessSettings from "./RemoteAccessSettings";
import { CardOverflowMenu } from "./AccountCardPrimitives";
import { CodaraMark, RuntimeMark } from "./BrandMarks";
import { EDITOR_THEME_LABEL } from "./editor-cm/themes";
import packageJson from "../../../../package.json";
import {
  workerSessionMemoryDeleteOption,
  workerSessionMemoryScope,
} from "../lib/worker-session-memory";
import CustomSelect from "./settings/CustomSelect";
import SettingsNav from "./settings/SettingsNav";
import ThemePicker from "./settings/ThemePicker";
import {
  Disclosure,
  EmptyState,
  InlineMessage,
  Kbd,
  Label,
  RangeControl,
  Segmented,
  SettingRow,
  SettingsPage,
  SettingsSection,
  ToggleRow,
  ValueRow,
} from "./settings/SettingsPrimitives";
import {
  searchSettings,
  tabMeta,
  type SettingsSearchEntry,
  type SettingsTab,
} from "./settings/settings-index";

export type { SettingsTab } from "./settings/settings-index";

// Settings is a single in-app dialog: a grouped nav with search on the left,
// one page at a time on the right. Every page is drawn with the primitives
// in ./settings, so rows, sections and controls line up across pages.

// The commit-message picker offers every native model Cora workers may launch
// on, the same roster as the Cora model picker, derived from the shared
// table so a roster change reaches this picker without a second edit.
// Rendered like the Cora picker: friendly names under vendor headers, vendors
// in family-table order.

// "claude-fable-5" -> "Claude Fable 5", "gpt-5.6-sol" -> "GPT-5.6 Sol",
// "grok-4.6" -> "Grok 4.6". Generic title-casing over the id's segments, with
// the gpt prefix uppercased, so there is no per-model table to drift.
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

// Within a vendor group, order by tier like the Cora picker: premium and
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
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const results = useMemo(() => searchSettings(query), [query]);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // A search result picked on another page: scrolled to once that page has
  // rendered the row carrying this anchor.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  // Terminal and API edit a draft that only Save persists; every other page
  // applies each change as it is made. The footer says which, and only the
  // draft pages offer Cancel and Save.
  const isDraftTab = activeTab === "terminal" || activeTab === "api";
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  useEffect(() => {
    setDraft(settings);
    setError(null);
  }, [settings]);

  const selectedShell = useMemo(
    () => shells.find((shell) => shell.id === draft.defaultShellId) ?? defaultShell,
    [defaultShell, draft.defaultShellId, shells],
  );

  // Escape, the close button and Done are the only ways out: the scrim
  // deliberately does nothing, so a click that lands outside the dialog
  // never throws away the page the user was working on. The listener sits on
  // window so it runs after the document-level listeners of menus opened
  // from here: a menu that took the Escape marks it handled, and Settings
  // stays open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The title bar grows a hairline only once the page scrolls under it, so a
  // line cut at the pane's top edge reads as scrolled rather than clipped.
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (pendingAnchor) return;
    contentRef.current?.scrollTo({ top: 0 });
    setScrolled(false);
  }, [renderedTab, searching, pendingAnchor]);

  // Rows behind async data (preferences, accounts) mount a beat after the
  // page, so the lookup retries for a short while before giving up.
  useEffect(() => {
    if (!pendingAnchor || searching || renderedTab !== activeTab) return;
    let frame = 0;
    let tries = 0;
    let flashTimer: number | undefined;
    const find = () => {
      const pane = contentRef.current;
      const target = pane
        ? Array.from(pane.querySelectorAll<HTMLElement>("[data-setting-anchor]")).find(
            (node) => node.dataset.settingAnchor === pendingAnchor,
          )
        : undefined;
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.classList.add("is-flash");
        flashTimer = window.setTimeout(() => target.classList.remove("is-flash"), 1600);
        setPendingAnchor(null);
        return;
      }
      tries += 1;
      if (tries < 60) frame = window.requestAnimationFrame(find);
      else setPendingAnchor(null);
    };
    frame = window.requestAnimationFrame(find);
    return () => {
      window.cancelAnimationFrame(frame);
      if (flashTimer !== undefined) window.clearTimeout(flashTimer);
    };
  }, [pendingAnchor, searching, renderedTab, activeTab]);

  const selectTab = (tab: SettingsTab) => {
    setQuery("");
    setPendingAnchor(null);
    setActiveTab(tab);
  };

  const openResult = (entry: SettingsSearchEntry) => {
    setQuery("");
    setActiveTab(entry.tab);
    setPendingAnchor(entry.title);
  };

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

  const meta = tabMeta(renderedTab);

  return (
    <div className="st-overlay">
      <div className="spark-scrim settings-dialog-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={`settings-dialog-surface${scrolled ? " is-scrolled" : ""}`}
        data-settings-surface
      >
        <SettingsNav
          activeTab={activeTab}
          query={query}
          searchRef={searchRef}
          onQueryChange={setQuery}
          onSelect={selectTab}
        />

        <div
          ref={contentRef}
          className="st-content"
          onScroll={(event) => {
            const next = event.currentTarget.scrollTop > 2;
            if (next !== scrolled) setScrolled(next);
          }}
        >
          {searching ? (
            <SearchResults query={query} results={results} onOpen={openResult} />
          ) : (
            <SettingsPage>
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
              {renderedTab === "agents" && <AgentsSettings onClose={onClose} />}
              {renderedTab === "sessions" && (
                <SessionsSettings onOpenWorkerSession={onOpenWorkerSession} />
              )}
              {renderedTab === "remote-access" && <RemoteAccessSettings />}
              {renderedTab === "keybindings" && <KeybindingsTab />}
              {renderedTab === "runs" && <RunsSettings onOpenRun={onOpenRun} />}
              {renderedTab === "about" && <AboutSettings />}
            </SettingsPage>
          )}
        </div>

        <header className="st-topbar">
          <div className="st-topbar__titles">
            <h2
              className="st-topbar__title"
              data-settings-tab={renderedTab}
              aria-busy={renderedTab !== activeTab}
            >
              {searching ? "Search" : meta.title}
            </h2>
            <p className="st-topbar__desc">
              {searching
                ? results.length === 0
                  ? `Nothing matches “${query.trim()}”.`
                  : `${results.length} ${results.length === 1 ? "result" : "results"} for “${query.trim()}”.`
                : meta.description}
            </p>
          </div>
          <button type="button" className="st-close" aria-label="Close" title="Close" onClick={onClose}>
            <svg
              aria-hidden
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <footer className="st-footer">
          <div className="st-footer__status">
            {error ? (
              <span className="st-footer__error" role="alert">{error}</span>
            ) : isDraftTab ? (
              dirty ? (
                <span className="st-footer__dirty">
                  <span aria-hidden className="st-footer__dot" />
                  Unsaved changes
                </span>
              ) : (
                "Changes on this page apply when you save."
              )
            ) : null}
          </div>
          {isDraftTab ? (
            <>
              <FooterButton onClick={onClose}>Cancel</FooterButton>
              <FooterButton onClick={save} disabled={saving || !dirty} primary={dirty}>
                {saving ? "Saving" : "Save"}
              </FooterButton>
            </>
          ) : (
            <FooterButton onClick={onClose}>Done</FooterButton>
          )}
        </footer>
      </section>
    </div>
  );
}

function SearchResults({
  query,
  results,
  onOpen,
}: {
  query: string;
  results: SettingsSearchEntry[];
  onOpen: (entry: SettingsSearchEntry) => void;
}) {
  const words = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const grouped = useMemo(() => {
    const map = new Map<SettingsTab, SettingsSearchEntry[]>();
    for (const entry of results) {
      const list = map.get(entry.tab) ?? [];
      list.push(entry);
      map.set(entry.tab, list);
    }
    return [...map.entries()];
  }, [results]);
  return (
    <div className="st-page">
      {results.length === 0 ? (
        <EmptyState
          icon={<SearchGlyph />}
          title="No settings found"
          body="Try a shorter or different word, like “theme”, “git” or “account”."
        />
      ) : (
        grouped.map(([tab, entries]) => (
          <SettingsSection key={tab} title={tabMeta(tab).title} plain>
            <div className="st-list">
              {entries.map((entry) => (
                <button
                  key={`${entry.tab}:${entry.title}`}
                  type="button"
                  className="st-list__row st-result"
                  onClick={() => onOpen(entry)}
                >
                  <span className="st-result__text">
                    <span className="st-result__title">
                      <Highlight text={entry.label ?? entry.title} words={words} />
                    </span>
                    <span className="st-result__desc">
                      <Highlight text={entry.desc} words={words} />
                    </span>
                  </span>
                  {/* The group heading already names the page, so a result
                      only adds the section it sits in. */}
                  <span className="st-result__crumb">{entry.section ?? ""}</span>
                  <ChevronRight />
                </button>
              ))}
            </div>
          </SettingsSection>
        ))
      )}
    </div>
  );
}

/** Marks every place a search word appears, case-insensitively. */
function Highlight({ text, words }: { text: string; words: ReadonlyArray<string> }) {
  if (words.length === 0) return <>{text}</>;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="st-mark">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function SearchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="st-chevron">
      <path d="M9 6l6 6-6 6" />
    </svg>
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
    <>
      <SettingsSection title="Shell">
        {shells.length === 0 ? (
          <EmptyState
            title="No terminals detected"
            body="Codara could not find a shell on this computer. Install one, then reopen Settings."
          />
        ) : (
          <SettingRow
            title="Default shell"
            desc="New manual terminals and worker panes open with this shell."
            control={
              <CustomSelect
                ariaLabel="Default shell"
                width={250}
                value={selectedShellId ?? ""}
                options={distinctShells(shells, selectedShellId).map((shell) => ({
                  value: shell.id,
                  label: shell.label,
                  detail: shell.exe,
                }))}
                onChange={onSelect}
              />
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="Output history">
        <NumberRow
          title="Scrollback lines"
          desc={`Lines of output each terminal, worker pane and chat terminal view keeps in memory (${TERMINAL_SCROLLBACK_LINE_LIMIT_MIN.toLocaleString()} to ${TERMINAL_SCROLLBACK_LINE_LIMIT_MAX.toLocaleString()}).`}
          min={TERMINAL_SCROLLBACK_LINE_LIMIT_MIN}
          max={TERMINAL_SCROLLBACK_LINE_LIMIT_MAX}
          value={scrollbackLineLimit}
          onChange={onScrollbackLineLimitChange}
        />
      </SettingsSection>

      <SettingsSection
        title="Resource overview"
        description="Observation only. A quiet terminal can still have a running child process, and Codara never stops terminal work for being quiet."
        live
      >
          <ValueRow title="Live terminals" value={resourceSnapshot?.totals.live ?? "None yet"} />
          <ValueRow title="Visible streams" value={resourceSnapshot?.totals.attached ?? "None yet"} />
          <ValueRow title="Parked or headless" value={resourceSnapshot?.totals.detached ?? "None yet"} />
          <ValueRow
            title="Buffered output"
            desc={
              resourceError
                ? "Resource inventory is temporarily unavailable."
                : resourceSnapshot?.totals.remote
                  ? `Includes ${resourceSnapshot.totals.remote} remote terminal${resourceSnapshot.totals.remote === 1 ? "" : "s"}. CPU and resident memory are not estimated yet.`
                  : "CPU and resident memory are not estimated yet."
            }
            value={
              resourceSnapshot
                ? formatResourceBytes(
                    resourceSnapshot.totals.tailBytes +
                      resourceSnapshot.totals.detachedBacklogBytes +
                      resourceSnapshot.totals.pendingBytes,
                  )
                : "None yet"
            }
          />
          {/* A fact, not a setting: it sits with the other read-only rows
              so the page has no heading without a row under it. */}
          <ValueRow
            title="Run panes"
            desc="Temporary worker panes close when their run settles; service panes stay until the run is deleted. A failed close is retried."
            value="Closed automatically"
          />
      </SettingsSection>
    </>
  );
}

/**
 * On merged-/usr systems /etc/shells lists every shell under both /bin and
 * /usr/bin, which are the same file. The picker shows one of each, keeping
 * whichever the saved setting points at so the selection never vanishes.
 */
function distinctShells(shells: ShellInfo[], selectedId: string | null): ShellInfo[] {
  const keyOf = (shell: ShellInfo) => {
    const match = /^\/(?:usr\/)?bin\/([^/]+)$/.exec(shell.exe);
    return match ? `bin:${match[1]}` : `exe:${shell.exe}`;
  };
  const chosen = new Map<string, ShellInfo>();
  for (const shell of shells) {
    const key = keyOf(shell);
    const kept = chosen.get(key);
    if (!kept || shell.id === selectedId) chosen.set(key, shell);
  }
  const keep = new Set(chosen.values());
  return shells.filter((shell) => keep.has(shell));
}

function formatResourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
  const coraModels = draft.openRouterCoraModels;

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
    <>
      <SettingsSection
        title="OpenRouter"
        description="One key for inline edits, optional commit drafts and your favorite Cora models."
        plain
      >
        <div className="st-fields">
          <Label
            text="OpenRouter API key"
            hint={
              checkMessage ? (
                <span
                  role={checkMessage.tone === "error" ? "alert" : "status"}
                  className={checkMessage.tone === "error" ? "st-text-danger" : "st-text-ok"}
                >
                  {checkMessage.text}
                </span>
              ) : (
                "Stored on this computer. Check it to verify the key and your Cora models."
              )
            }
            hintAction={
              <button
                type="button"
                className="spark-btn"
                disabled={checking || !draft.openRouterApiKey.trim()}
                onClick={() => void checkOpenRouter()}
              >
                {checking ? "Checking…" : "Check key and models"}
              </button>
            }
          >
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
            />
          </Label>
          <Label
            text="Inline edit and commit model"
            hint="Used for ghost-text completions, inline edits and OpenRouter commit drafts."
          >
            <input
              className="spark-input spark-mono"
              type="text"
              value={draft.openRouterModel}
              onChange={(event) => onChange({ ...draft, openRouterModel: event.currentTarget.value })}
              placeholder="google/gemini-flash-latest"
            />
          </Label>
          <div className="st-field" data-setting-anchor="Models for Cora">
            <div className="st-field__label">Models for Cora</div>
            {coraModels.length > 0 ? (
              <div className="st-model-list">
                {coraModels.map((modelId, index) => (
                  <span key={`${index}:${coraModels.length}`} className="st-input-group">
                    <input
                      className="spark-input spark-mono"
                      aria-label={`OpenRouter Cora model ${index + 1}`}
                      type="text"
                      value={modelId}
                      onChange={(event) => replaceCoraModel(index, event.currentTarget.value)}
                      placeholder="anthropic/claude-sonnet-4.5"
                    />
                    <button
                      type="button"
                      className="spark-icon-btn st-icon-btn"
                      aria-label={`Remove OpenRouter Cora model ${index + 1}`}
                      title="Remove"
                      onClick={() => removeCoraModel(index)}
                    >
                      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="st-field__hint st-field__hint--row">
              <span>
                {coraModels.length > 0
                  ? "Verified entries appear under OpenRouter in Cora's model selector."
                  : "None yet. Added models appear under OpenRouter in Cora's model selector once the key is checked."}
              </span>
              <button
                type="button"
                className="spark-btn"
                onClick={() => onChange({
                  ...draft,
                  openRouterCoraModels: [...draft.openRouterCoraModels, ""],
                  openRouterVerifiedKeyHash: "",
                })}
              >
                Add model
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Git commit messages"
        description="Automatic picks a fast model on your first usable subscription. Native models run on their own subscription; OpenRouter uses the model above."
        plain
      >
        <div className="st-fields">
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
      </SettingsSection>
    </>
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

function presetHint<T extends { value: number; hint: string }>(
  presets: ReadonlyArray<T>,
  value: number,
): string | undefined {
  return presets.find((preset) => preset.value === value)?.hint;
}

function GeneralSettings({
  workspaceCwd,
}: {
  workspaceCwd?: string | null;
}) {
  const { theme, setTheme } = useTheme();
  const { preferences, hydrated, setPreference } = usePreferences();
  const hudMs = preferences.workspaceSwitchHudMs ?? DEFAULT_WORKSPACE_SWITCH_HUD_MS;
  const toastMs = preferences.toastDurationMs ?? DEFAULT_TOAST_DURATION_MS;
  const fetchMinutes =
    preferences.gitAutoFetchIntervalMinutes ?? DEFAULT_GIT_AUTO_FETCH_INTERVAL_MINUTES;
  const [glassTuningOpen, setGlassTuningOpen] = useState(false);
  return (
    <>
      <SettingsSection title="Getting started">
        <SettingRow
          title="Setup and guided tour"
          desc="Set up local tools, connect an agent account and take a tour of the studio."
          control={
            <button
              type="button"
              className="spark-btn"
              aria-label="Open setup and guided tour"
              onClick={() => window.dispatchEvent(new CustomEvent("spark:open-onboarding"))}
            >
              Open guide
            </button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Appearance">
        <SettingRow title="Theme" stacked>
          <ThemePicker value={theme} onChange={setTheme} />
        </SettingRow>
        {hydrated ? (
          <ToggleRow
            title="Liquid glass"
            desc="Translucent frame, tabs, buttons, composer, menus, dialogs and toasts. Off gives a solid, opaque look. Always off when the system reduces transparency."
            checked={preferences.glassEffects !== false}
            onChange={(v) => void setPreference("glassEffects", v)}
          />
        ) : null}
        {hydrated && preferences.glassEffects !== false ? (
          <SettingRow
            title="Fine-tune glass"
            desc="How strong each part of the material is, as a share of the default."
            control={
              // The chevron carries open or closed, so the button itself
              // never has to look pressed to say so.
              <button
                type="button"
                className="spark-btn st-expand-btn"
                aria-expanded={glassTuningOpen}
                onClick={() => setGlassTuningOpen((open) => !open)}
              >
                {glassTuningOpen ? "Hide" : "Adjust"}
                <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            }
          >
            {glassTuningOpen ? (
              <div className="st-subrows">
                <GlassSliderRow
                  label="Tint"
                  hint="Lower is clearer"
                  // Floor at 10%: veil 0 + blur 0 leaves menus as border-only
                  // outlines over live content, which reads as a rendering bug.
                  floor={10}
                  value={preferences.glassVeil ?? 100}
                  onChange={(v) => void setPreference("glassVeil", v)}
                />
                <GlassSliderRow
                  label="Blur"
                  hint="Frost behind floating surfaces"
                  value={preferences.glassBlur ?? 100}
                  onChange={(v) => void setPreference("glassBlur", v)}
                />
                <GlassSliderRow
                  label="Refraction"
                  hint="How much menu edges bend light"
                  value={preferences.glassRefraction ?? 100}
                  onChange={(v) => void setPreference("glassRefraction", v)}
                />
                <GlassSliderRow
                  label="Fringe"
                  hint="Color split along the edge"
                  value={preferences.glassChroma ?? 100}
                  onChange={(v) => void setPreference("glassChroma", v)}
                />
                <div className="st-subrows__foot">
                  <button
                    type="button"
                    className="spark-btn"
                    onClick={() => {
                      void setPreference("glassVeil", 100);
                      void setPreference("glassBlur", 100);
                      void setPreference("glassRefraction", 100);
                      void setPreference("glassChroma", 100);
                    }}
                  >
                    Reset to defaults
                  </button>
                </div>
              </div>
            ) : null}
          </SettingRow>
        ) : null}
      </SettingsSection>

      {hydrated ? (
        <>
          <SettingsSection title="Window">
            <ToggleRow
              title="Keep running in the background"
              desc="Closing the window hides Codara Studio to the tray so automations keep running. Quit from the tray menu."
              checked={preferences.keepRunningInBackground !== false}
              onChange={(v) => void setPreference("keepRunningInBackground", v)}
            />
            <ToggleRow
              title="Open local dev servers automatically"
              desc="Open a localhost URL an agent or terminal prints in a browser tab. When off, a link chip appears instead."
              checked={Boolean(preferences.autoOpenPreview)}
              onChange={(v) => void setPreference("autoOpenPreview", v)}
            />
            <SettingRow
              title="Open links in"
              desc="Where links you click in terminals, Cora, markdown and GitHub open. Local files and Open in Codara browser actions always stay in Codara."
              control={
                <div data-setting="link-open-target">
                  <CustomSelect
                    ariaLabel="Open links in"
                    width={190}
                    value={preferences.linkOpenTarget ?? "system"}
                    options={[
                      { value: "system", label: "Default browser" },
                      { value: "studio", label: "Codara browser" },
                    ]}
                    onChange={(v) => void setPreference("linkOpenTarget", v as LinkOpenTarget)}
                  />
                </div>
              }
            />
            <SettingRow
              title="Workspace switch badge"
              desc="After a switch, shows the workspace and branch your next message goes to."
              control={
                <RangeControl
                  ariaLabel="Workspace switch badge duration"
                  min={0}
                  max={MAX_WORKSPACE_SWITCH_HUD_MS}
                  step={250}
                  value={hudMs}
                  display={
                    hudMs === 0
                      ? "Off"
                      : `${(hudMs / 1000).toFixed(hudMs % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, "")} s`
                  }
                  onChange={(next) => void setPreference("workspaceSwitchHudMs", next)}
                />
              }
            />
          </SettingsSection>

          <SettingsSection
            title="Agent worktrees"
            description="Claude Code, Codex and Cora can create git worktrees of their own repository through the Codara Studio tools and remove them once merged. Every change is logged in ~/.codarastudio/logs/worktree-audit.jsonl."
          >
            <ToggleRow
              title="Let agents create and remove worktrees"
              desc="Removal needs proof the branch is merged, no local changes and nothing running in the worktree. It never forces, and the last commit stays recoverable for 30 days. When off, agents can still list worktrees."
              checked={preferences.agentWorktreesEnabled !== false}
              onChange={(v) => void setPreference("agentWorktreesEnabled", v)}
            />
            <ToggleRow
              title="Let agents remove worktrees I created"
              desc="When off, agents only remove worktrees an agent created. The same merge and safety checks apply either way."
              checked={preferences.agentsMayRemoveUserWorktrees === true}
              onChange={(v) => void setPreference("agentsMayRemoveUserWorktrees", v)}
            />
          </SettingsSection>

          <SettingsSection title="Tabs">
            <ToggleRow
              title="Middle-click to close tabs"
              desc="Close a workspace tab with the mouse wheel button."
              checked={preferences.closeTabsOnMiddleClick}
              onChange={(v) => void setPreference("closeTabsOnMiddleClick", v)}
            />
          </SettingsSection>

          <SettingsSection
            title="Notifications"
            description="When a run, or a Claude or Codex CLI in a terminal, is blocked or finishes while you are away. Nothing fires for the chat or terminal you are already watching."
          >
            <ToggleRow
              title="In-app toast"
              desc="A card in the top right while Codara Studio is focused. Click it to jump to the chat or terminal."
              checked={preferences.notificationChannels.inApp}
              onChange={(v) =>
                void setPreference("notificationChannels", {
                  ...preferences.notificationChannels,
                  inApp: v,
                })
              }
            />
            {preferences.notificationChannels.inApp ? (
              <SettingRow
                title="Toast duration"
                desc={`${presetHint(TOAST_DURATION_PRESETS, toastMs) ?? ""} A toast that times out stays unread in the bell.`}
                control={
                  <Segmented
                    ariaLabel="Toast duration"
                    options={TOAST_DURATION_PRESETS}
                    value={toastMs}
                    onChange={(next) => void setPreference("toastDurationMs", next)}
                  />
                }
              />
            ) : null}
            <ToggleRow
              title="Native OS notification"
              desc="A system alert, only while Codara Studio is minimized or in the background, so it never doubles up with the toast."
              checked={preferences.notificationChannels.native}
              onChange={(v) =>
                void setPreference("notificationChannels", {
                  ...preferences.notificationChannels,
                  native: v,
                })
              }
            />
            <ToggleRow
              title="Sound"
              desc="A short chime: one for needs you, one for done."
              checked={preferences.notificationChannels.sound}
              onChange={(v) =>
                void setPreference("notificationChannels", {
                  ...preferences.notificationChannels,
                  sound: v,
                })
              }
            />
            <ToggleRow
              title="Dock badge and taskbar flash"
              desc="The macOS dock badge or Windows taskbar flash. Clears when you focus Codara Studio."
              checked={preferences.notificationChannels.osCues}
              onChange={(v) =>
                void setPreference("notificationChannels", {
                  ...preferences.notificationChannels,
                  osCues: v,
                })
              }
            />
          </SettingsSection>

          <SettingsSection
            title="Git"
            description="Background fetch keeps ahead and behind counts and the history graph current: one fetch per repository, at most two at a time, never while offline."
          >
            <ToggleRow
              title="Fetch remotes in the background"
              desc="When off, the Fetch button is the only network activity."
              checked={preferences.gitAutoFetchEnabled !== false}
              onChange={(v) => void setPreference("gitAutoFetchEnabled", v)}
            />
            {preferences.gitAutoFetchEnabled !== false ? (
              <>
                <SettingRow
                  title="Fetch interval"
                  desc={presetHint(GIT_AUTO_FETCH_INTERVAL_PRESETS, fetchMinutes)}
                  control={
                    <Segmented
                      ariaLabel="Auto-fetch interval"
                      options={GIT_AUTO_FETCH_INTERVAL_PRESETS}
                      value={fetchMinutes}
                      onChange={(next) => void setPreference("gitAutoFetchIntervalMinutes", next)}
                    />
                  }
                />
                <ToggleRow
                  title="Notify me when teammates push"
                  desc="One quiet alert per repository, checked with your signed-in gh account so your own merges never count. GitHub remotes only."
                  checked={preferences.notifyTeammatePushes !== false}
                  onChange={(v) => void setPreference("notifyTeammatePushes", v)}
                />
                <ToggleRow
                  title="Notify me when a pull request is opened"
                  desc="One alert with a chime when someone opens, reopens or readies a pull request. Drafts stay quiet."
                  checked={preferences.notifyPullRequests !== false}
                  onChange={(v) => void setPreference("notifyPullRequests", v)}
                />
              </>
            ) : null}
            <GithubWebhookSettings />
            {workspaceCwd ? <CopyBranchSetupField workspaceCwd={workspaceCwd} /> : null}
            {workspaceCwd ? <AgentWorktreeIgnoredField workspaceCwd={workspaceCwd} /> : null}
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}

// GitHub push webhooks: instant git triggers instead of the 3-minute fetch
// cadence. The webhook URL (carrying its secret path token) is the user's to
// paste once; it is remembered locally, never bundled with the app.
function GithubWebhookSettings() {
  const [url, setUrl] = useState<string>(() => {
    try {
      return window.localStorage.getItem("codara.githubWebhookUrl") ?? "";
    } catch {
      return "";
    }
  });
  const [copied, setCopied] = useState(false);
  const [advanced, setAdvanced] = useState(() => url.trim().length > 0);
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
    <SettingRow
      title="Instant git triggers"
      desc="With the Codara Studio GitHub App installed, pushes reach git-triggered automations in seconds. Only a content-free push signal passes through it. Without it, the background fetch picks pushes up within minutes."
      control={
        <button
          type="button"
          className="spark-btn"
          onClick={() => {
            void window.spark.openExternal(
              "https://github.com/apps/codara-studio/installations/new",
            );
          }}
        >
          Install GitHub App
        </button>
      }
    >
      <button
        type="button"
        className="st-disclosure"
        aria-expanded={advanced}
        onClick={() => setAdvanced((open) => !open)}
      >
        <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
        Use a custom webhook receiver
      </button>
      {advanced ? (
        <span className="st-input-group st-indent">
          <input
            className="spark-input spark-mono"
            aria-label="Custom webhook receiver URL"
            value={url}
            onChange={(e) => save(e.target.value)}
            placeholder="https://studio.codarasolutions.com/hooks/github/…"
          />
          <button type="button" className="spark-btn" onClick={copy} disabled={!url.trim()}>
            {copied ? "Copied" : "Copy URL"}
          </button>
        </span>
      ) : null}
    </SettingRow>
  );
}


// The "Use the Active account in your terminal" feature was removed: plain
// `claude` keeps its chats, settings, agents, and commands inside the config
// directory that setting redirected, so switching accounts made the terminal
// lose all of that state. This note only appears while the block the old
// feature added is still in the user's shell startup file, and tells them how
// to delete it themselves. Codara no longer edits shell startup files at all.
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
    <InlineMessage tone="info">
      The "Use the Active account in your terminal" setting was removed because it
      made plain <code className="spark-mono">claude</code> lose its chats and
      settings. To finish tidying up, open{" "}
      <code className="spark-mono">{leftover.profilePath}</code> and delete the
      lines from <code className="spark-mono">{leftover.markerBegin}</code>{" "}
      through <code className="spark-mono">{leftover.markerEnd}</code>.
    </InlineMessage>
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
    <SettingRow
      title="Copy-branch setup command"
      desc="Runs in a new copy-branch worktree to restore what git does not track. Leave blank for none. Saved for this repository."
      stacked
    >
      <input
        className="spark-input spark-mono"
        aria-label="Setup command"
        type="text"
        value={text}
        spellCheck={false}
        placeholder="For example pnpm install"
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          }
        }}
      />
    </SettingRow>
  );
}

// Ignored files an agent may delete with a merged worktree for this repo, on
// top of the built-in build output and caches (node_modules/, dist/, ...).
// Anything else ignored, such as .env.local, blocks an agent's removal.
function AgentWorktreeIgnoredField({ workspaceCwd }: { workspaceCwd: string }) {
  const { preferences, hydrated, setPreference } = usePreferences();
  const stored = preferences.agentWorktreeRegenerableIgnoredByRepo?.[workspaceCwd] ?? [];
  const [text, setText] = useState<string>(stored.join(", "));

  useEffect(() => {
    setText((preferences.agentWorktreeRegenerableIgnoredByRepo?.[workspaceCwd] ?? []).join(", "));
  }, [workspaceCwd, preferences.agentWorktreeRegenerableIgnoredByRepo]);

  if (!hydrated) return null;

  const commit = () => {
    const patterns = text
      .split(/[,\n]/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    const next = { ...(preferences.agentWorktreeRegenerableIgnoredByRepo ?? {}) };
    if (patterns.length === 0) delete next[workspaceCwd];
    else next[workspaceCwd] = patterns;
    void setPreference("agentWorktreeRegenerableIgnoredByRepo", next);
  };

  return (
    <SettingRow
      title="Agent worktrees: also regenerable"
      desc="Ignored files an agent may delete with a merged worktree, besides build output and caches. Anything else ignored blocks removal. Saved for this repository."
      stacked
    >
      <input
        className="spark-input spark-mono"
        aria-label="Also regenerable"
        type="text"
        value={text}
        spellCheck={false}
        placeholder="For example .gradle-cache/, *.log"
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          }
        }}
      />
    </SettingRow>
  );
}

function EditorSettings() {
  const { preferences, hydrated, setPreference } = usePreferences();
  if (!hydrated) {
    return <div className="st-loading">Loading preferences…</div>;
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
    <>
      <SettingsSection title="Editing">
        <ToggleRow
          title="Vim mode"
          desc="Modal editing with the :w, :q, :wq and :x commands."
          checked={preferences.vimMode}
          onChange={(v) => void setPreference("vimMode", v)}
        />
        <SettingRow
          title="Editor theme"
          desc="Syntax colors in the file editor."
          control={
            <CustomSelect
              ariaLabel="Editor theme"
              width={220}
              value={preferences.editorTheme}
              options={EDITOR_THEME_IDS.map((id) => ({
                value: id,
                label: EDITOR_THEME_LABEL[id],
              }))}
              onChange={(v) => void setPreference("editorTheme", v as EditorThemeId)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Saving">
        <ToggleRow
          title="Autosave"
          desc="Saves the active file after you stop typing. If an agent changed it on disk, autosave pauses and asks. Ctrl or Cmd+S always saves."
          checked={preferences.autosaveEnabled}
          onChange={(v) => void setPreference("autosaveEnabled", v)}
        />
        {preferences.autosaveEnabled ? (
          <>
            <SettingRow
              title="Autosave delay"
              desc={presetHint(AUTOSAVE_DELAY_PRESETS, currentAutosaveDelayMs) ?? "A custom delay."}
              control={
                <Segmented
                  ariaLabel="Autosave delay"
                  options={AUTOSAVE_DELAY_PRESETS}
                  value={currentAutosaveDelayMs}
                  onChange={(next) => void setPreference("autosaveDelayMs", next)}
                />
              }
            />
            <SettingRow
              title="Custom delay"
              desc="Fine-tune the wait between a quarter second and ten seconds."
              control={
                <RangeControl
                  ariaLabel="Autosave wait time"
                  min={250}
                  max={10000}
                  step={250}
                  value={currentAutosaveDelayMs}
                  display={`${(currentAutosaveDelayMs / 1000).toFixed(currentAutosaveDelayMs % 1000 === 0 ? 0 : 2)} s`}
                  onChange={(next) => void setPreference("autosaveDelayMs", next)}
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Inline AI"
        description="Ghost-text suggestions use the OpenRouter key and model set in API and model."
      >
        <ToggleRow
          title="Inline AI autocomplete"
          desc={
            <>
              Suggestions as you type. <Kbd>Tab</Kbd> accepts, <Kbd>Esc</Kbd> dismisses,{" "}
              <Kbd>Alt+\</Kbd> asks for one.
            </>
          }
          checked={preferences.inlineAutocompleteEnabled}
          onChange={(v) => void setPreference("inlineAutocompleteEnabled", v)}
        />
        <SettingRow
          title="Suggestion timing"
          desc={presetHint(INLINE_AI_DELAY_PRESETS, currentInlineDelayMs) ?? "A custom wait."}
          control={
            <Segmented
              ariaLabel="Inline AI suggestion timing"
              options={INLINE_AI_DELAY_PRESETS}
              value={currentInlineDelayMs}
              onChange={(next) => void setPreference("inlineAutocompleteDelayMs", next)}
            />
          }
        />
        <SettingRow
          title="Custom wait"
          desc="How long a pause in typing must last before a suggestion is requested."
          control={
            <RangeControl
              ariaLabel="Inline AI wait time"
              min={0}
              max={2000}
              step={50}
              value={currentInlineDelayMs}
              display={`${currentInlineDelayMs.toLocaleString()} ms`}
              onChange={(next) => void setPreference("inlineAutocompleteDelayMs", next)}
            />
          }
        />
      </SettingsSection>
    </>
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
export function AccountsSettings({ guided = false, onBusyChange }: {
  guided?: boolean;
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const [overview, setOverview] = useState<PiSubscriptionOverview | null>(null);
  const [loading, setLoading] = useState(true);
  // True once the first status read settled either way: a store that failed
  // has answered too, and the cards the CLI side can still build must show.
  const [overviewSettled, setOverviewSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<PiLoginView | null>(null);
  const guidedLoginRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (guided && login) guidedLoginRef.current?.scrollIntoView({ block: "nearest" });
  }, [guided, login?.status, login?.promptId]);
  useEffect(() => {
    onBusyChange?.(login?.status === "running");
    return () => onBusyChange?.(false);
  }, [login?.status, onBusyChange]);
  const [promptValue, setPromptValue] = useState("");
  const [howSwitchingOpen, setHowSwitchingOpen] = useState(false);
  const [install, setInstall] = useState<PiInstallView | null>(null);
  const [addingProvider, setAddingProvider] = useState<PiSubscriptionProvider | null>(null);
  const [addLabel, setAddLabel] = useState("");
  const [accountMutationId, setAccountMutationId] = useState<string | null>(null);
  const [cliInspection, setCliInspection] =
    useState<NativeCliAccountsInspection | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  // Every id's card key for as long as this list is mounted; see
  // stableAccountCardKeys.
  const cardKeysRef = useRef(new Map<string, string>());
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
      // A live usage re-read after an agent turn; the usage panel listens for
      // it on its own, and there is no login-flow state to touch here.
      if (event.type === "usage") return;
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
    // A sign-in started before this panel mounted (another tab, a closed
    // dialog) keeps running in main; ask for it again so it can be finished
    // or cancelled here instead of blocking every other sign-in.
    void window.spark.piSubscriptions.resumeLogin().catch(() => undefined);
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
    start: () => Promise<PiSubscriptionProfileLoginRequest>,
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
    void start().then((request) => {
      // An already open sign-in for this account answers with its own id and
      // replays its events; either way the panel now cancels the real flow.
      setLogin((current) => current?.requestId === "starting"
        ? { ...current, requestId: request.requestId }
        : current);
    }).catch((err) => {
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

  // A switch closes nothing: new sessions take the account, and a deleted
  // account's folder waits in main for its terminals to exit.
  const makeDefault = (provider: PiSubscriptionProvider, profileId: string): Promise<boolean> =>
    mutateAccount(profileId, () =>
      window.spark.piSubscriptions.makeDefault({ provider, profileId }),
    );

  const deleteAccount = (profileId: string): Promise<boolean> =>
    mutateAccount(profileId, () => window.spark.piSubscriptions.deleteAccount({ profileId }));

  // The System login is only ever read: these record a row for it, hide
  // its offer, or point new sessions back at it.
  const systemMutation = (
    provider: PiSubscriptionProvider,
    mutation: () => Promise<PiSubscriptionOverview>,
  ): Promise<boolean> => mutateAccount(`system:${provider}`, mutation);

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
      // names its terminal half, so nothing is matched here. A card is first
      // keyed by the row id (or the terminal id for a half without a row) and
      // then keeps that key while it gains or loses a half; see
      // stableAccountCardKeys.
      const linked = new Set(
        piProfiles.flatMap((profile) =>
          profile.cliProfileId ? [profile.cliProfileId] : [],
        ),
      );
      const rows = piProfiles.map<AccountCardView>((profile) => {
        const usage = usageByProfile.get(profile.id);
        // Limits are read with Cora's grant, so a System row shows them only
        // once Cora is connected to it.
        const coraHeld = profile.coraHalf !== "none";
        return {
          key: `${provider}:${profile.id}`,
          provider,
          label: profile.label,
          ...(profile.email ? { email: profile.email } : {}),
          ...(usage?.plan ? { plan: usage.plan } : {}),
          // SuperGrok (and any provider with no quota API) reports status ok
          // and zero windows. That is not a failure, so do not render the
          // empty report as a red "no usage windows" error on the card.
          ...(usage && coraHeld && accountCardShowsUsage(usage)
            ? { usage: <UsageEntryBody usage={usage} compact /> }
            : coraHeld
              ? accountUsageNote(usage, usageLoading, descriptor)
              : { usageNote: "Shown once Cora is connected" }),
          coraProfileId: profile.id,
          ...(profile.cliProfileId ? { cliProfileId: profile.cliProfileId } : {}),
          builtIn: profile.builtIn === true,
          active: profile.isDefault,
          cora: {
            connected: profile.connected,
            expired: profile.expired,
            canRefresh: profile.canRefresh,
            ...(profile.error && coraHeld ? { error: profile.error } : {}),
            ...(coraHeld ? {} : { held: false }),
          },
          ...(profile.terminal ? { terminal: profile.terminal } : {}),
          busy: accountMutationId === profile.id,
        };
      });
      // The System row first: it is the CLI's own login on this computer.
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
          ...accountUsageNote(undefined, false, descriptor),
        }));
      // No card is drawn without a row; the System login appears only as
      // its offer line until the user adds it.
      const cards = stableAccountCardKeys([...rows, ...terminalOnly], cardKeysRef.current);
      const systemRow = piProfiles.some((profile) => profile.builtIn);
      const anyActive = piProfiles.some((profile) => profile.isDefault);
      const systemOffer = overview?.systemOffers?.[provider];
      // One rule for every provider, and the row's own: ready is a row that
      // shows Switch, or Active with nothing to fix.
      const ready = cards.filter(accountCardReady).length;
      const footer = cards.length === 0 ? null : `${ready} of ${cards.length} ready`;
      return {
        descriptor,
        detail: accountProviderDetail(descriptor),
        cards,
        ...(footer ? { footer } : {}),
        disabled,
        busy,
        cliError: cliUnavailable || Boolean(cliError && !cliInspection),
        addLabel: addingProvider === provider ? addLabel : "",
        ...(systemOffer ? { systemOffer } : {}),
        systemActive: !anyActive && cards.length > 0 && !systemOffer,
        canUseSystemLogin: anyActive && !systemRow,
      };
    });
  }, [
    accountMutationId,
    addLabel,
    addingProvider,
    busyProvider,
    cliError,
    cliInspection,
    overview,
    usageLoading,
    usageOverview,
  ]);

  // One account, one action each, for every provider. Every mutation goes
  // through the Pi account channels, which switch, share, and delete both
  // halves in the main process; the terminal id is only used for a half
  // that has no row. Cora and the terminal tool switch together and nothing
  // closes: new sessions pick the account up.
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
    onUse: (card) => {
      if (!card.coraProfileId) return;
      void makeDefault(card.provider, card.coraProfileId);
    },
    onAddSystemAccount: (provider) => {
      void systemMutation(provider, () =>
        window.spark.piSubscriptions.addSystemAccount(provider),
      );
    },
    onDismissSystemOffer: (provider) => {
      void systemMutation(provider, () =>
        window.spark.piSubscriptions.dismissSystemOffer(provider),
      );
    },
    onUseSystemLogin: (provider) => {
      void systemMutation(provider, () =>
        window.spark.piSubscriptions.useSystemLogin(provider),
      );
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
    onDelete: (card) => {
      // A System row goes the same way: main drops the row and Cora's grant,
      // leaves the login itself alone, and stops offering it.
      if (card.coraProfileId) {
        void deleteAccount(card.coraProfileId);
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

  if (guided) return (
    <div style={{ display: "grid", gap: 14 }}>
      {overview && overview.runtimeSource !== "user" && (
        <div>
          <p style={{ color: "var(--muted)", fontSize: 12 }}>
            {overview.runtimeInstalled
              ? "Recommended: install Pi, the coding agent Cora runs on, so Cora uses your own copy. Choose your account below either way."
              : "First, install Pi, the coding agent Cora runs on. Once it is installed, choose your account below."}
          </p>
          <PiRuntimeInstallRow
            expectedVersion={overview.runtimeExpectedVersion}
            runtimeError={overview.runtimeError}
            bundledVersion={overview.runtimeSource === "bundled" ? overview.runtimeVersion ?? undefined : undefined}
            install={install}
            onInstall={installRuntime}
          />
        </div>
      )}
      {!overview && loading && <p role="status">Checking account setup…</p>}
      <div className="onboarding-provider-grid">
        {providerViews.filter((view) => view.descriptor.runtime !== "grok").map((view) => {
          const connected = overview?.profiles?.find((profile) => profile.provider === view.descriptor.provider && profile.connected && (!profile.expired || profile.canRefresh));
          const label = view.descriptor.runtime === "codex" ? "ChatGPT" : "Claude";
          return (
            <div className="onboarding-card" key={view.descriptor.provider}>
              <RuntimeMark runtime={view.descriptor.runtime} size={28} />
              <h3>{label}</h3>
              <p>{view.descriptor.runtime === "codex" ? "Use your ChatGPT account with Cora and Codex." : "Use your Claude account with Cora and Claude Code."}</p>
              {connected && <p role="status" style={{ color: "var(--accent)" }}>Connected: {connected.email || connected.label}</p>}
              <button className="spark-btn" disabled={view.disabled || view.busy || login?.status === "running"} onClick={() => addAccount(view.descriptor.provider, "")}>
                Sign in with {label}
              </button>
            </div>
          );
        })}
      </div>
      {login && <div ref={guidedLoginRef}><PiLoginPanel login={login} promptValue={promptValue} onPromptValue={setPromptValue} onSubmitPrompt={submitPrompt} onCancel={() => {
        if (login.status === "running") {
          void window.spark.piSubscriptions.cancel(login.requestId === "starting" ? undefined : login.requestId);
          return;
        }
        setLogin(null);
      }} /></div>}
      {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{error}</p>}
      {cliError && <p role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{cliError}</p>}
    </div>
  );

  return (
    <>
      <SettingsSection anchor="Accounts" plain>
        <div className="st-acct-toolbar">
          <Disclosure
            open={howSwitchingOpen}
            anchor="How switching works"
            onToggle={() => setHowSwitchingOpen((open) => !open)}
          >
            How switching works
          </Disclosure>
          <span data-setting-anchor="Add account">
            <AccountAddPicker providers={providerViews} actions={accountActions} />
          </span>
        </div>
        {howSwitchingOpen ? (
          <div className="st-acct-how">
            <p>
              Every account is one sign-in for Cora and its terminal tool. The Active account is used by new Codara terminals and new Cora chats.
            </p>
            <p>
              Sign-ins for Cora and for the Claude Code, Codex and Grok terminals that Codara opens. They stay inside Codara. Your own logins and settings, and every terminal outside Codara, are never changed.
            </p>
            <p>
              Only Codara uses an account you add here. A row marked as your own login is the login on this computer: Codara uses it as it is and never changes it.
            </p>
            <dl>
              {providerViews.map((view) => (
                <React.Fragment key={view.descriptor.provider}>
                  <dt>{view.descriptor.label}</dt>
                  <dd>{view.detail}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        ) : null}
        {!accountsReady ? (
          <div className="st-loading">Loading accounts…</div>
        ) : (
          <AccountCards providers={providerViews} actions={accountActions} />
        )}
        {!overview && loading ? <RuntimeDiagnosticSkeleton /> : null}

        <TerminalAccountLeftoverNote />

        {login ? (
          <PiLoginPanel
            login={login}
            promptValue={promptValue}
            onPromptValue={setPromptValue}
            onSubmitPrompt={submitPrompt}
            onCancel={() => {
              if (login.status === "running") {
                void window.spark.piSubscriptions.cancel(login.requestId === "starting" ? undefined : login.requestId);
              } else {
                setLogin(null);
              }
            }}
          />
        ) : null}

        {error ? <InlineMessage tone="danger" role="alert">{error}</InlineMessage> : null}

        {cliError ? <InlineMessage tone="danger" role="alert">{cliError}</InlineMessage> : null}
      </SettingsSection>

      <SettingsSection title="Limits and runtime">
        {/* Limits live inside each account above; this row re-reads them. */}
        {overview?.runtimeInstalled ? (
          <SettingRow
            title="Usage limits"
            desc={
              usageError ? (
                <span className="st-text-danger">{usageError}</span>
              ) : (
                "Limits come straight from each provider. Claude's are re-checked every 15 minutes."
              )
            }
            control={
              <FooterButton onClick={() => loadUsage(true)} disabled={usageLoading}>
                {usageLoading ? "Checking…" : "Refresh limits"}
              </FooterButton>
            }
          />
        ) : null}
        {overview?.runtimeSource === "user" ? (
          <ValueRow
            title="Pi runtime"
            desc={
              <>
                Cora runs on your Pi, the same pi your terminals run; update it with npm whenever you like
                {overview.runtimeTestedVersion &&
                overview.runtimeVersion !== overview.runtimeTestedVersion
                  ? ` (Codara is tested with ${overview.runtimeTestedVersion})`
                  : ""}
                . Each account keeps its own private sign-in, and they all share the
                same Cora chats.
              </>
            }
            value={overview.runtimeVersion ? `v${overview.runtimeVersion}` : "Installed"}
            mono
          />
        ) : overview ? (
          <SettingRow
            title="Pi runtime"
            desc="Each account keeps its own private sign-in, and they all share the same Cora chats."
          >
            <PiRuntimeInstallRow
              expectedVersion={overview.runtimeExpectedVersion}
              runtimeError={overview.runtimeError}
              bundledVersion={overview.runtimeSource === "bundled" ? overview.runtimeVersion ?? undefined : undefined}
              install={install}
              onInstall={installRuntime}
            />
          </SettingRow>
        ) : null}
        <SettingRow
          title="Claude Extra Usage"
          desc="Pro and Max plans used outside Anthropic's own apps can draw on Extra Usage, billed on top of the plan. Codara never switches you to a paid API key; for a hard limit, turn Extra Usage off."
          control={
            <FooterButton
              onClick={() => void window.spark.openInSystemBrowser(CLAUDE_USAGE_SETTINGS_URL)}
            >
              Open Claude settings
            </FooterButton>
          }
        />
      </SettingsSection>
    </>
  );
}

/**
 * The missing-runtime state. Cora runs on the Pi the user installed (the
 * same `pi` their terminals run), so this row makes installing it a single
 * click; updating it later is the user's own `npm install -g`.
 */
function PiRuntimeInstallRow({
  expectedVersion,
  runtimeError,
  bundledVersion,
  install,
  onInstall,
}: {
  expectedVersion: string;
  runtimeError?: string;
  /** Set while Cora runs on the bundled Pi: installing is then a recommendation. */
  bundledVersion?: string;
  install: PiInstallView | null;
  onInstall: () => void;
}) {
  const running = install?.status === "running";
  const failed = install?.status === "failed";
  const recommended = bundledVersion !== undefined;
  const tone = failed ? "danger" : running || recommended ? "info" : "danger";
  return (
    <div aria-live="polite" className={`st-callout st-callout--${tone}`}>
      <div className="st-callout__text">
        <span className="st-callout__title">
          {running ? "Installing Pi…" : recommended ? "Install Pi for Cora and your terminals" : "Cora needs Pi"}
        </span>
        <span className={`st-callout__body${failed ? " st-text-danger" : ""}`}>
          {install?.message ||
            (recommended
              ? runtimeError && !/not installed/i.test(runtimeError)
                ? `${runtimeError} Until then Cora uses Codara's built-in Pi ${bundledVersion}.`
                : `Cora is using Codara's built-in Pi ${bundledVersion} for now. With your own Pi (${expectedVersion} or newer), Cora runs on it, you choose when to update it, and the same pi works in any terminal.`
              : runtimeError ||
                `Cora's chats, planning and workers run on Pi ${expectedVersion} or newer, the coding agent you can also run as pi in any terminal.`)}
        </span>
        {!running ? (
          <span className="st-callout__code">
            npm install -g @earendil-works/pi-coding-agent
          </span>
        ) : null}
      </div>
      <FooterButton onClick={onInstall} disabled={running} primary={!recommended}>
        {running ? "Installing…" : failed ? "Retry install" : "Install Pi"}
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
  const cancelled = login.status === "cancelled";
  const tone = done ? "ok" : failed ? "danger" : cancelled ? "muted" : "info";
  const select = login.prompt?.type === "select" ? login.prompt : null;
  const textPrompt = login.prompt && login.prompt.type !== "select" ? login.prompt : null;
  return (
    <div aria-live="polite" className={`st-callout st-callout--${tone} st-callout--stack`}>
      <div className="st-callout__text">
        <span className="st-callout__title">
          {login.status === "running" ? <span aria-hidden className="st-spinner" /> : null}
          {done ? "Account connected" : failed ? "Could not sign in" : cancelled ? "Sign-in cancelled" : "Signing in to this account"}
        </span>
        <span className="st-callout__body">{login.message}</span>
      </div>

      {login.deviceCode ? (
        <div className="st-device-code spark-mono">{login.deviceCode}</div>
      ) : null}

      {select ? (
        <div className="st-callout__actions">
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
          className="st-input-group"
        >
          <input
            autoFocus
            className="spark-input spark-mono"
            type={textPrompt.type === "secret" ? "password" : "text"}
            value={promptValue}
            onChange={(event) => onPromptValue(event.currentTarget.value)}
            placeholder={textPrompt.placeholder || "Paste the code from your browser"}
          />
          <button type="submit" className="spark-btn is-primary" disabled={!promptValue.trim()}>
            Continue
          </button>
        </form>
      ) : null}

      <div className="st-callout__actions">
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

// Where a Claude plan's Extra Usage is switched on or off.
const CLAUDE_USAGE_SETTINGS_URL = "https://claude.ai/settings/usage";

/** True when the account has meters of its own to draw. */
function accountCardShowsUsage(usage: UsageEntry): boolean {
  return usage.windows.length > 0 || usage.limitReached === true;
}

/**
 * What a card's empty meters say when it has no reading: the row keeps its
 * meter rows either way, so every account reads the same.
 */
function accountUsageNote(
  usage: UsageEntry | undefined,
  loading: boolean,
  descriptor: AccountProviderDescriptor,
): Pick<AccountCardView, "usageNote" | "usageMessage"> {
  if (!descriptor.reportsUsage) return { usageNote: `Not reported by ${descriptor.label}` };
  if (!usage) return { usageNote: loading ? "Checking…" : "Not available" };
  if (usage.status === "ok") return { usageNote: "Not reported" };
  if (usage.status === "not_connected") return { usageNote: "Not available" };
  return {
    usageNote: "Not available",
    usageMessage: usage.message || "Could not read usage limits.",
  };
}

// Accounts, plus a way into the Capability Center. The fast-mode toggle used
// to sit here; it now lives on the composer's flash button, next to the model
// it applies to.
function AgentsSettings({ onClose }: { onClose: () => void }) {
  // Settings closes first so two modals never stack and fight over focus and
  // Escape. Nothing on this tab is a draft, so closing loses nothing.
  const openCapabilities = (tab: "mcp" | "workers") => {
    onClose();
    window.dispatchEvent(new CustomEvent("spark:open-capabilities", { detail: { tab } }));
  };
  return (
    <>
      <AccountsSettings />

      <SettingsSection title="Tools">
        <SettingRow
          title="Capability Center"
          desc="MCP servers, skills, Cora profiles and memory, and the worker models Cora may use. Also behind the Tools button in the Cora composer."
          control={
            <span className="st-button-pair">
              <button type="button" className="spark-btn" onClick={() => openCapabilities("workers")}>
                Worker models
              </button>
              <button type="button" className="spark-btn" onClick={() => openCapabilities("mcp")}>
                Open Capability Center
              </button>
            </span>
          }
        />
      </SettingsSection>
    </>
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
  // Edit against a local draft and only parse+clamp+commit on blur/Enter:
  // clamping every keystroke would turn a partially-typed "90" into the min
  // (e.g. 600) and make the field impossible to clear while retyping.
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);
  const commit = (raw: string) => {
    const next = Number(raw.replace(/[\s,.'\u00a0\u202f]/g, ""));
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
          className="spark-input st-number"
          aria-label={title}
          type="text"
          inputMode="numeric"
          value={editing ? draft : value.toLocaleString()}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            setDraft(String(value));
            setEditing(true);
          }}
          onBlur={(e) => {
            setEditing(false);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
          }}
        />
      }
    />
  );
}

function RuntimeDiagnosticSkeleton() {
  return <div className="st-loading">Checking runtimes: detecting the Claude and Codex CLIs…</div>;
}

// Wrapper that hydrates preferences and forwards them to the keybindings
// editor. Kept here so the section follows the same import/colocation
// pattern as the other Settings tabs.
function KeybindingsTab() {
  const { preferences, setPreference, hydrated } = usePreferences();
  if (!hydrated) {
    return <div className="st-loading">Loading…</div>;
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
    <>
      <SettingsSection title="Restore">
        {hydrated ? (
          <ToggleRow
            title="Resume running agent sessions when Codara reopens"
            desc="Reopens terminal tabs that still had Claude Code, Codex, Grok or Pi running and resumes their exact session. A pane whose shell dies under a live agent resumes in place."
            checked={preferences.restoreAgentSessions === true}
            onChange={(next) => void setPreference("restoreAgentSessions", next)}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Agent sessions"
        description="Claude and Codex sessions from every local project. Opening one switches to its workspace, or adds the workspace first."
        plain
      >
        <div className="st-toolbar">
          <span className="st-search st-search--inline">
            <span className="st-search__icon">
              <SearchGlyphSmall />
            </span>
            <input
              className="st-search__input"
              type="text"
              aria-label="Filter sessions"
              value={filter}
              disabled={bulkBusy}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter by title, directory, or session id"
            />
          </span>
          <CustomSelect
            ariaLabel="Filter sessions by provider"
            width={140}
            value={runtimeFilter}
            disabled={bulkBusy}
            options={[
              { value: "all", label: "All agents" },
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
            ]}
            onChange={(next) => setRuntimeFilter(next as "all" | WorkerSessionRuntime)}
          />
          <button
            type="button"
            className="spark-icon-btn st-icon-btn"
            aria-label="Refresh sessions"
            title="Refresh"
            disabled={bulkBusy}
            onClick={() => void refresh()}
          >
            <RefreshGlyph />
          </button>
        </div>

        {error ? <SessionManagerMessage tone="danger">{error}</SessionManagerMessage> : null}
        {notice ? <SessionManagerMessage tone="info">{notice}</SessionManagerMessage> : null}

        {pendingDelete ? (
          <div
            role="alertdialog"
            aria-label="Confirm session deletion"
            className="st-callout st-callout--danger st-callout--stack"
          >
            <div className="st-callout__text">
              <span className="st-callout__title">
                {pendingDelete.kind === "one"
                  ? `Permanently delete “${pendingDelete.session.title}”?`
                  : `Permanently delete ${countedSessions(pendingDelete.sessions.length)}?`}
              </span>
              <span className="st-callout__body">
                {pendingDelete.kind === "one"
                  ? "This removes the local transcript and cannot be undone. Close a running copy of the session before deleting it."
                  : "This removes each local transcript and cannot be undone. Close any running copies of these sessions before deleting them."}
              </span>
            </div>
            {pendingDelete.kind === "one" &&
            workerSessionMemoryDeleteOption(pendingDelete.session.runtime) ? (
              <label className={`st-check${deleteMemory ? " is-danger" : ""}`}>
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
              <div className="st-callout__body">
                Local agent memory is kept. Delete a session individually to also remove its memory.
              </div>
            ) : null}
            <div className="st-callout__actions st-callout__actions--end">
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

        <div className="st-list">
          <div className="st-list__head">
            <label className="st-check">
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
              />
              <span aria-hidden>Select all</span>
            </label>
            {selected.size > 0 ? (
              <span className="st-list__count">{selected.size} selected</span>
            ) : null}
            <span className="st-list__spacer" />
            <span className="st-list__count">
              {sessions ? `${filtered.length} of ${sessions.length} sessions` : ""}
            </span>
            <button
              type="button"
              className={`spark-btn st-btn-quiet${selected.size > 0 ? " is-danger" : ""}`}
              disabled={selected.size === 0 || locked}
              onClick={() => {
                setPendingDelete({ kind: "many", sessions: selectedSessions });
                setDeleteMemory(false);
                setNotice(null);
              }}
            >
              Delete selected
            </button>
          </div>
          <div className="st-list__scroll">
            {sessions === null ? (
              <EmptyState title="Reading local session stores…" />
            ) : filtered.length === 0 ? (
              sessions.length === 0 ? (
                <EmptyState
                  icon={<SessionsGlyph />}
                  title="No local agent sessions found."
                  body="Sessions you run with Claude Code or Codex in any project show up here."
                />
              ) : (
                <EmptyState
                  title="No sessions match that filter."
                  action={
                    <button
                      type="button"
                      className="spark-btn"
                      onClick={() => {
                        setFilter("");
                        setRuntimeFilter("all");
                      }}
                    >
                      Clear filter
                    </button>
                  }
                />
              )
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
        </div>
      </SettingsSection>
    </>
  );
}

function SearchGlyphSmall() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  );
}

function SessionsGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="11" rx="2.5" />
      <path d="M8 16v3l4-3" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="12" x2="13" y2="12" />
    </svg>
  );
}

function RunsGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2.5-6 4 13 2.5-7H21" />
    </svg>
  );
}

/** The last two segments of a path, so rows stay short; the full path is the tooltip. */
function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join("/")}`;
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
  // Anywhere on the row toggles it. The checkbox is a 13px target in a list
  // you are meant to sweep through, so the row body carries the same action,
  // except where the click belongs to a real control (Open, the row menu, the
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
      onClick={toggleFromRow}
      className={`st-list__row st-session${selected ? " is-selected" : ""}${locked ? " is-locked" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={locked}
        aria-label={`Select session “${session.title}”`}
        onChange={(event) => onToggleSelect(event.currentTarget.checked)}
      />
      <span aria-hidden className={`st-session__mark is-${session.runtime}`}>
        <RuntimeMark runtime={session.runtime} size={14} />
      </span>
      <div className="st-session__text">
        <div title={session.title} className="st-session__title">
          {session.title}
        </div>
        <div className="st-session__meta">
          <span title={session.cwd} className={session.cwdExists ? undefined : "st-text-danger"}>
            {session.cwdExists ? shortPath(session.cwd) : `${shortPath(session.cwd)}, directory missing`}
          </span>
          <span aria-hidden>·</span>
          <span>{formatSessionUpdated(session.updatedAt)}</span>
          <span aria-hidden>·</span>
          <span title={session.sessionId} className="st-session__id">
            {shortWorkerSessionId(session.sessionId)}
          </span>
        </div>
      </div>
      <div className="st-row-actions">
        <FooterButton onClick={onOpen} disabled={!session.cwdExists || busy || locked}>Open</FooterButton>
        {/* Delete lives in the row menu and still asks before anything goes,
            so a stray click on a dense list never reaches a transcript. */}
        <CardOverflowMenu
          label={`More actions for “${session.title}”`}
          groups={[
            [
              {
                id: "copy-id",
                label: "Copy session ID",
                disabled: false,
                run: () => {
                  void window.spark.clipboard.writeText(session.sessionId).catch(() => undefined);
                },
              },
            ],
            [
              {
                id: "delete",
                label: "Delete session…",
                danger: true,
                disabled: busy || locked,
                run: onDelete,
              },
            ],
          ]}
          onClose={() => undefined}
        />
      </div>
    </div>
  );
}

function SessionTrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
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
  return (
    <InlineMessage tone={tone} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </InlineMessage>
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
      // re-fetch instead of patching in place, which avoids a parallel state
      // tree, and the list rarely exceeds a hundred items.
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
    // (click to arm, click again to confirm), never a native OS dialog.
    setBusyId(run.id);
    setError(null);
    try {
      await window.spark.orchestration.deleteRun(run.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusyId(null);
  };

  const empty = runs !== null && runs.length === 0;

  return (
    <SettingsSection
      title="All runs"
      description="Open a run to inspect it on the canvas. Delete removes its artifact directory."
      plain
    >
      {empty ? null : (
        <div className="st-toolbar">
          <span className="st-search st-search--inline">
            <span className="st-search__icon">
              <SearchGlyphSmall />
            </span>
            <input
              className="st-search__input"
              type="text"
              aria-label="Filter runs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by id, title, or workspace"
            />
          </span>
          <button
            type="button"
            className="spark-icon-btn st-icon-btn"
            aria-label="Refresh runs"
            title="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshGlyph />
          </button>
        </div>
      )}

      {error ? <InlineMessage tone="danger" role="alert">{error}</InlineMessage> : null}

      {runs === null ? (
        <div className="st-loading">Loading runs…</div>
      ) : empty ? (
        <EmptyState
          icon={<RunsGlyph />}
          title="No runs yet."
          body="Runs you start from Cora, or from a plan file in the explorer, are listed here for every workspace."
          action={
            <button type="button" className="spark-btn" onClick={() => void refresh()}>
              Check again
            </button>
          }
        />
      ) : (
        <div className="st-list">
          <div className="st-list__head">
            <span className="st-list__count">
              {filtered.length === runs.length
                ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}`
                : `${filtered.length} of ${runs.length}`}
            </span>
          </div>
          <div className="st-list__scroll">
            {filtered.length === 0 ? (
              <EmptyState
                title="No runs match that filter."
                action={
                  <button type="button" className="spark-btn" onClick={() => setFilter("")}>
                    Clear filter
                  </button>
                }
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
        </div>
      )}
    </SettingsSection>
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
  const live = status === "running" || status === "planning" || status === "reviewing";
  // Two-step delete: first click arms, second click confirms. Disarms when the
  // pointer leaves the button group, so a stray click never deletes a run.
  const [armed, setArmed] = useState(false);
  return (
    <div className="st-list__row st-run">
      <span
        aria-hidden
        className={`st-run__dot${live ? " is-live" : ""}`}
        style={{ background: statusColor }}
      />
      <div className="st-run__text">
        <div className="st-run__title-line">
          <span title={run.title} className="st-run__title">
            {run.title}
          </span>
          <span className="st-run__status" style={{ color: statusColor }}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </span>
        </div>
        <div className="st-run__meta">
          {workspaceName ? <span>{workspaceName}</span> : null}
          {workspaceName ? <span aria-hidden>·</span> : null}
          <span>{created}</span>
          <span aria-hidden>·</span>
          <span title={run.id} className="st-session__id">{run.id}</span>
        </div>
      </div>
      <div
        className="st-row-actions"
        onMouseLeave={() => setArmed(false)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setArmed(false);
        }}
      >
        <FooterButton onClick={onOpen}>Open</FooterButton>
        {armed ? (
          <DangerButton onClick={() => {
            setArmed(false);
            onDelete();
          }} disabled={busy}>
            Confirm delete
          </DangerButton>
        ) : (
          <button
            type="button"
            className="spark-icon-btn st-icon-btn st-icon-btn--danger"
            aria-label="Delete"
            title={`Delete “${run.title}”`}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setArmed(true);
            }}
          >
            <SessionTrashIcon />
          </button>
        )}
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

function formatRunCreated(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  // "2026-05-10 18:29": short and unambiguous; the row already shows the
  // run id for disambiguation if two runs share a creation minute.
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AboutSettings() {
  const [platform, setPlatform] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.spark.app.platform().then((p) => {
      if (alive) setPlatform(p);
    });
    void window.spark.app.globalConfigCleanupNotice().then(
      (notice) => {
        if (alive) setCleanupNotice(notice);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  const version = import.meta.env.VITE_APP_VERSION ?? packageJson.version;

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
        // The banner takes over from here (download progress, then restart).
        setCheckResult(`Update v${result.version ?? "?"} found. Downloading…`);
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
    <>
      <div className="st-about">
        <span className="st-about__mark" aria-hidden>
          <CodaraMark size={26} />
        </span>
        <span className="st-about__text">
          <span className="st-about__name">Codara Studio</span>
          <span className="st-about__tag">
            A terminal multiplexer with agent orchestration, driven by Cora.
          </span>
        </span>
      </div>
      <SettingsSection title="Details">
        <ValueRow title="Version" value={`v${version}`} mono />
        <ValueRow title="Platform" value={platform || "Detecting…"} mono />
        <ValueRow title="App ID" value="com.codara.app" mono />
        <SettingRow
          title="Software update"
          desc={checkResult ?? "See whether a newer version of Codara Studio is available."}
          control={
            <button
              type="button"
              className="spark-btn"
              onClick={() => void handleCheck()}
              disabled={checking}
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
          }
        />
        {cleanupNotice ? (
          <SettingRow title="Earlier versions" desc={cleanupNotice} />
        ) : null}
      </SettingsSection>
    </>
  );
}

// One liquid-glass tuning slider: 0 to 200% of the design default. Keep drag
// state local and persist once on release/blur. Sending an IPC preference
// write for every pointer sample forced the whole themed app (including SVG
// lens filters) to repaint dozens of times per second and made Settings feel
// sticky.
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
   * slider's min: every row shares the same 0 to 200 track so equal values
   * line up thumb-for-thumb regardless of floor.
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
    const clamped = Math.max(floor, next);
    setDraftValue(clamped);
    if (clamped !== committedValue.current) {
      committedValue.current = clamped;
      onChange(clamped);
    }
  };

  return (
    <div className="st-subrow">
      <span className="st-subrow__text">
        <span className="st-subrow__label">{label}</span>
        <span className="st-subrow__hint">{hint}</span>
      </span>
      <RangeControl
        ariaLabel={`${label}: ${hint}`}
        min={0}
        max={200}
        step={5}
        value={draftValue}
        display={`${draftValue}%`}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(next) => setDraftValue(Math.max(floor, next))}
        onCommit={commit}
      />
    </div>
  );
}
