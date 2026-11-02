import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, UIEvent } from "react";
import { createPortal } from "react-dom";
import {
  SESSION_NAME_MAX,
  SESSION_SEARCH_AGENT_LABEL,
  cleanSessionName,
  normalizeSessionSearchPreferences,
  relativeAge,
  sessionDayGroup,
  sessionLengthLabel,
  sessionQueryTerms,
  type SessionMatchKind,
  type SessionPreview,
  type SessionSearchAgent,
  type SessionSearchHit,
  type SessionSearchScope,
} from "@shared/session-search";
import type { WorkerSessionSummary } from "@shared/types";
import { usePreferences } from "../../preferences/usePreferences";
import { keyBelongsToOtherModal } from "../../shortcuts/modal-keys";
import AnchoredMenu from "../chat/composer/AnchoredMenu";
import { PencilIcon, PinIcon, ReloadIcon } from "../icons";
import SessionAgentMark from "./SessionAgentMark";
import { SnippetText, TermsText } from "./SessionHighlight";
import SessionTranscriptDialog from "./SessionTranscriptDialog";
import { copySessionId, revealSessionTranscript } from "./session-actions";
import {
  SESSION_SCOPES,
  SESSION_AGENTS_KEY,
  SESSION_SCOPE_KEY,
  folderName,
  readSessionAgents,
  readSessionScope,
  rememberSessionChoice,
  sessionStatusLine,
} from "./session-list-shared";
import {
  bumpSessionLabels,
  useSessionLabelsRevision,
  useSessionSearchHost,
  type WorkerSessionsOffer,
} from "./sessionSearchStore";
import { publishSessionSearchStatus, useSessionSearchStatus } from "./useSessionSearchStatus";
import "./session-search.css";

// The session picker: past agent sessions in a list, beside the end of the
// highlighted conversation. One box searches names and what either side said,
// and each result says which of those matched. Opened from the + menu and its
// chord, the rail's button (on this workspace), the jump palette (on what was
// typed there), and in front of a Claude, Codex or Grok worker being opened.
// There, nothing is selected at first and Enter starts the worker, so history
// never costs more than one key and a session is only resumed on purpose.

const PAGE = 50;
const DEBOUNCE_MS = 120;
const PREVIEW_DEBOUNCE_MS = 60;
const LIVE_REFRESH_MS = 3_000;
const PAGE_KEY_ROWS = 8;
const MATCH_LEAD_CHARS = 90;
const MENU_Z_INDEX = 130;

const canDelete = (hit: SessionSearchHit) => hit.agent === "claude" || hit.agent === "codex" || hit.agent === "grok";
const canFork = (hit: SessionSearchHit) => canDelete(hit) && hit.cwdExists;
const isGone = (hit: SessionSearchHit) => hit.agent !== "cora" && !hit.cwdExists;

function matchLabel(kind: SessionMatchKind, agent: SessionSearchAgent): string {
  if (kind === "name") return "Name";
  return kind === "user" ? "You" : SESSION_SEARCH_AGENT_LABEL[agent];
}

function RenameField({
  value,
  onSave,
  onCancel,
}: {
  value: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  // Enter takes focus away, and the blur that follows must not save twice.
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = () => {
    if (finished.current) return;
    finished.current = true;
    onSave(ref.current?.value ?? value);
  };

  return (
    <input
      ref={ref}
      className="sp-rename"
      aria-label="Session name"
      data-testid="session-picker-rename"
      maxLength={SESSION_NAME_MAX}
      spellCheck={false}
      defaultValue={value}
      onBlur={save}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          finished.current = true;
          onCancel();
        }
      }}
    />
  );
}

export default function SessionPicker({
  onClose,
  initialQuery = "",
  initialScope,
  offer = null,
}: {
  onClose: () => void;
  initialQuery?: string;
  /** Where this opening looks. Only a click on a scope is remembered for next time. */
  initialScope?: SessionSearchScope;
  offer?: WorkerSessionsOffer | null;
}) {
  const host = useSessionSearchHost();
  const labelsRevision = useSessionLabelsRevision();
  const { status, loaded } = useSessionSearchStatus();
  const { preferences, setPreference } = usePreferences();
  const prefs = normalizeSessionSearchPreferences(preferences.sessionSearch);

  const [query, setQuery] = useState(initialQuery);
  const [scope, setScopeState] = useState<SessionSearchScope>(() => initialScope ?? readSessionScope());
  const [agentFilter, setAgentFilterState] = useState<SessionSearchAgent[]>(() =>
    offer ? [offer.runtime] : readSessionAgents(),
  );
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The session a confirm is for and the files that check found for it: kept
  // together, because the selection can move while the check runs.
  const [deleting, setDeleting] = useState<{ hit: SessionSearchHit; session: WorkerSessionSummary } | null>(null);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<{ hit: SessionSearchHit; notice: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const sequence = useRef(0);
  const restoreFocusRef = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  const chosenRef = useRef(false);
  // What the shown rows answer, and an Enter pressed before they caught up.
  const hitsAnswerRef = useRef<string | null>(null);
  const enterPendingRef = useRef<string | null>(null);
  const primaryRef = useRef<(hit: SessionSearchHit) => void>(() => undefined);
  // Deleted here but still in the index until the pass that notices is done.
  const deletedRef = useRef(new Set<string>());

  // A worker opens in its pane's folder, which need not be the workspace's.
  const scopeCwd = offer?.cwd ?? host.workspaceCwd;
  const hasWorkspace = scopeCwd !== null;
  const effectiveScope: SessionSearchScope = hasWorkspace ? scope : "all";
  const enabledAgents = prefs.agents;
  const activeAgents = useMemo(
    () => agentFilter.filter((item) => enabledAgents.includes(item)),
    [agentFilter, enabledAgents],
  );
  const agentsKey = activeAgents.join(",");
  const terms = useMemo(() => sessionQueryTerms(query), [query]);
  const searching = terms.length > 0;
  const answerKey = `${query}\n${effectiveScope}\n${agentsKey}\n${scopeCwd ?? ""}`;
  const selected = hits.find((hit) => hit.key === selectedKey) ?? null;
  const selectedOpen = selected ? (host.isSessionOpen?.(selected) ?? false) : false;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;

  const setScope = (next: SessionSearchScope) => {
    setScopeState(next);
    rememberSessionChoice(SESSION_SCOPE_KEY, next);
  };
  const toggleAgent = (item: SessionSearchAgent) => {
    const next = activeAgents.includes(item) ? activeAgents.filter((entry) => entry !== item) : [...activeAgents, item];
    setAgentFilterState(next);
    rememberSessionChoice(SESSION_AGENTS_KEY, JSON.stringify(next));
  };

  const firstToShow = useCallback(
    (rows: SessionSearchHit[], typed: boolean): string | null => {
      if (typed) return rows[0]?.key ?? null;
      if (offer) return null;
      // Pinned rows lead the list, but the likely next step is the latest
      // session that can actually be resumed from here.
      const likely = rows.find((hit) => !hit.pinned && !isGone(hit) && !host.isSessionOpen?.(hit));
      return (likely ?? rows[0])?.key ?? null;
    },
    [host, offer],
  );

  const run = useCallback(
    async (offset: number) => {
      const id = ++sequence.current;
      setLoading(true);
      try {
        const result = await window.spark.sessionSearch.search({
          query,
          scope: effectiveScope,
          cwd: scopeCwd,
          agents: agentsKey ? (agentsKey.split(",") as SessionSearchAgent[]) : null,
          limit: PAGE,
          offset,
          pinnedFirst: true,
          wideSnippets: true,
        });
        if (id !== sequence.current) return;
        const found = result.hits.filter((hit) => !deletedRef.current.has(hit.key));
        setHits((current) => (offset === 0 ? found : [...current, ...found]));
        if (offset === 0) {
          const sameAnswer = hitsAnswerRef.current === answerKey;
          setSelectedKey((current) =>
            sameAnswer && (found.some((hit) => hit.key === current) || (offer !== null && current === null))
              ? current
              : firstToShow(found, sessionQueryTerms(query).length > 0),
          );
          hitsAnswerRef.current = answerKey;
          // An earlier search can answer while this one waits out its debounce.
          if (enterPendingRef.current === answerKey) {
            enterPendingRef.current = null;
            if (found[0]) primaryRef.current(found[0]);
          }
        }
        setHasMore(result.hasMore);
        setSearched(true);
        setNow(Date.now());
        publishSessionSearchStatus(result.status);
      } catch {
        if (id === sequence.current) setSearched(true);
      } finally {
        if (id === sequence.current) setLoading(false);
      }
    },
    [query, effectiveScope, scopeCwd, agentsKey, answerKey, firstToShow, offer],
  );

  useEffect(() => {
    if (enterPendingRef.current !== answerKey) enterPendingRef.current = null;
  }, [answerKey]);

  useEffect(() => {
    if (!status.enabled && loaded) return;
    const timer = window.setTimeout(() => void run(0), query ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [run, query, status.enabled, loaded]);

  useEffect(() => {
    void window.spark.sessionSearch.refresh(false).then(publishSessionSearchStatus, () => undefined);
  }, []);

  const indexing = status.phase === "indexing";
  const pastFirstPage = hits.length > PAGE;
  useEffect(() => {
    if (!indexing || pastFirstPage) return;
    const timer = window.setInterval(() => void run(0), LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [indexing, pastFirstPage, run]);
  const lastSyncAt = status.lastSyncAt;
  useEffect(() => {
    if (lastSyncAt !== null && !pastFirstPage) void run(0);
    // Only a finished pass triggers this; `run` changing has its own effect.
  }, [lastSyncAt]);

  // Another surface changed a label while this one was open.
  const seenRevision = useRef(labelsRevision);
  useEffect(() => {
    if (seenRevision.current === labelsRevision) return;
    seenRevision.current = labelsRevision;
    if (!pastFirstPage) void run(0);
  }, [labelsRevision, pastFirstPage, run]);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(
    () => () => {
      if (chosenRef.current) return;
      const previous = restoreFocusRef.current;
      if (!(previous instanceof HTMLElement) || previous === document.body) return;
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        const lost = !active || active === document.body;
        if (lost && previous.isConnected) previous.focus({ preventScroll: true });
      });
    },
    [],
  );

  // A new selection cancels what the last one had going, and a field that
  // goes away must not leave the keyboard on nothing.
  useEffect(() => {
    setRenaming((was) => {
      if (was) window.requestAnimationFrame(() => inputRef.current?.focus());
      return false;
    });
    setDeleting(null);
    setMenuOpen(false);
  }, [selectedKey]);

  useEffect(() => {
    if (!selectedKey) {
      setPreview(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void window.spark.sessionSearch.preview(selectedKey).then(
        (value) => {
          if (alive) setPreview(value);
        },
        () => {
          if (alive) setPreview(null);
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [selectedKey]);

  // The end of the conversation is the part worth seeing first.
  useLayoutEffect(() => {
    if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
  }, [preview]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [note]);

  useLayoutEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    if (deleting) cancelDeleteRef.current?.focus();
  }, [deleting]);

  const focusSearch = () => window.requestAnimationFrame(() => inputRef.current?.focus());

  const finish = (action: () => void) => {
    chosenRef.current = true;
    onClose();
    action();
  };

  const showTranscript = (hit: SessionSearchHit, notice: string | null) => {
    // A key with focus on nothing belongs to the dialog opened last.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setTranscript({ hit, notice });
  };

  const resumesInPane = (hit: SessionSearchHit) =>
    offer?.placement === "pane" && !isGone(hit) && !host.isSessionOpen?.(hit) && !!host.canSplitSession?.(hit);

  const startNew = () => {
    if (offer) finish(offer.startNew);
  };

  const primary = (hit: SessionSearchHit) => {
    if (isGone(hit) && !host.isSessionOpen?.(hit)) {
      showTranscript(
        hit,
        hit.cwd
          ? `The folder ${hit.cwd} is no longer on this computer, so this session cannot be resumed. Its transcript is below, read only.`
          : "This session has no folder to resume in. Its transcript is below, read only.",
      );
      return;
    }
    finish(() => (resumesInPane(hit) ? host.splitSession?.(hit) : host.openSession?.(hit)));
  };
  primaryRef.current = primary;

  const moveSelection = (delta: number) => {
    if (hits.length === 0) return;
    const index = hits.findIndex((hit) => hit.key === selectedKey);
    const wanted = (index < 0 ? -1 : index) + delta;
    // Above the first row is back to starting new.
    if (offer && wanted < 0) {
      setSelectedKey(null);
      return;
    }
    const next = Math.max(0, Math.min(hits.length - 1, wanted));
    setSelectedKey(hits[next].key);
    if (hasMore && !loading && next >= hits.length - 3) void run(hits.length);
  };

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      moveSelection(event.key === "PageDown" ? PAGE_KEY_ROWS : -PAGE_KEY_ROWS);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const current = hitsAnswerRef.current === answerKey;
      if (event.altKey) {
        if (current && selected && canFork(selected)) finish(() => host.forkSession?.(selected));
      } else if (offer && (searching ? current && !selected && hits.length > 0 : !current || !selected)) {
        // Rows still catching up with an empty box must not turn this into a resume.
        startNew();
      } else if (!current) {
        // The rows are still those of an earlier query: open the first of this one's.
        enterPendingRef.current = answerKey;
      } else if (selected) {
        primary(selected);
      }
    }
  };

  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const escapeRef = useRef<() => void>(() => undefined);
  escapeRef.current = () => {
    if (deleting) {
      setDeleting(null);
      focusSearch();
    } else if (query) {
      enterPendingRef.current = null;
      setQuery("");
      focusSearch();
    } else {
      onClose();
    }
  };
  const hasSelectionRef = useRef(false);
  hasSelectionRef.current = selected !== null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "Escape" && event.key !== "F2") || keyBelongsToOtherModal(event, dialogRef.current)) return;
      // The field and the menu see this key after this capture handler, and it is theirs.
      if (renamingRef.current || menuOpenRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") escapeRef.current();
      else if (hasSelectionRef.current) setRenaming(true);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const refreshIndex = () => {
    void window.spark.sessionSearch.refresh(true).then(publishSessionSearchStatus, () => undefined);
    focusSearch();
  };

  const onListScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    if (!hasMore || loading) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) void run(hits.length);
  };

  // A Cora chat has a name of its own, which other surfaces and agents change
  // too, so a label beside it would go stale and hide theirs. The index learns
  // the new name from the run on the pass this starts, whose end refreshes the rows.
  const renameChat = async (hit: SessionSearchHit, name: string) => {
    setHits((rows) => rows.map((row) => (row.key === hit.key ? { ...row, title: name } : row)));
    try {
      await window.spark.orchestration.renameRun({ runId: hit.sessionId, title: name });
      void window.spark.sessionSearch.refresh(true).then(publishSessionSearchStatus, () => undefined);
    } catch {
      setNote("Could not save the name");
      void run(0);
    }
  };

  const applyName = async (hit: SessionSearchHit, raw: string) => {
    setRenaming(false);
    focusSearch();
    const own = hit.originalTitle ?? hit.title;
    const clean = cleanSessionName(raw);
    if (hit.agent === "cora") {
      if (clean && clean !== hit.title) await renameChat(hit, clean);
      return;
    }
    const name = !clean || clean === own ? null : clean;
    if ((name ?? own) === hit.title) return;
    setHits((rows) =>
      rows.map((row) =>
        row.key === hit.key ? { ...row, title: name ?? own, originalTitle: name ? own : null } : row,
      ),
    );
    try {
      await window.spark.sessionSearch.setLabel(hit.key, { name });
      bumpSessionLabels();
    } catch {
      setNote("Could not save the name");
      void run(0);
    }
  };

  const togglePin = async (hit: SessionSearchHit) => {
    try {
      await window.spark.sessionSearch.setLabel(hit.key, { pinned: !hit.pinned });
      setNote(hit.pinned ? "Unpinned" : "Pinned");
      bumpSessionLabels();
    } catch {
      setNote("Could not save the pin");
    }
    focusSearch();
  };

  // Delete can only remove what Settings' session list resolves, which leaves
  // out archived sessions and other accounts' homes. Found out before asking,
  // so nobody confirms a delete that cannot happen.
  const askToDelete = async (hit: SessionSearchHit) => {
    setBusy(true);
    try {
      const sessions = await window.spark.agentSession.listAll();
      if (selectedKeyRef.current !== hit.key) return;
      const session = sessions.find((item) => item.runtime === hit.agent && item.sessionId === hit.sessionId);
      if (session) setDeleting({ hit, session });
      else setNote("This session can't be deleted from here. Its transcript is unchanged.");
    } catch {
      setNote("Could not check this session's files");
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async ({ hit, session }: { hit: SessionSearchHit; session: WorkerSessionSummary }) => {
    setBusy(true);
    try {
      const result = await window.spark.agentSession.delete({
        runtime: session.runtime,
        nativeClaudeProfileId: session.nativeClaudeProfileId,
        nativeCodexProfileId: session.nativeCodexProfileId,
        nativeGrokProfileId: session.nativeGrokProfileId,
        sessionId: session.sessionId,
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
        memoryScope: "none",
      });
      deletedRef.current.add(hit.key);
      await window.spark.sessionSearch.setLabel(hit.key, { name: null, pinned: false }).catch(() => undefined);
      const index = hits.findIndex((row) => row.key === hit.key);
      const rest = hits.filter((row) => row.key !== hit.key);
      setHits(rest);
      setSelectedKey((rest[index] ?? rest[index - 1])?.key ?? null);
      setNote(result.warnings.length > 0 ? result.warnings.join(" ") : "Session deleted");
      void window.spark.sessionSearch.refresh(true).then(publishSessionSearchStatus, () => undefined);
      bumpSessionLabels();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not delete this session");
    } finally {
      setBusy(false);
      setDeleting(null);
      focusSearch();
    }
  };

  const layer = (body: React.ReactNode) =>
    createPortal(
      <div className="ss-dialog-layer" role="presentation" onMouseDown={onClose}>
        <div className="spark-scrim spark-scrim--clear spark-scrim--palette" style={{ zIndex: 0 }} />
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={offer ? `${SESSION_SEARCH_AGENT_LABEL[offer.runtime]} sessions` : "Resume a session"}
          data-testid="session-picker"
          className="ss-dialog sp-dialog spark-glass--strong spark-overlay-surface"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {body}
        </section>
      </div>,
      document.body,
    );

  if (loaded && !status.enabled) {
    return layer(
      <div className="ss-empty sp-off">
        <p>Agent session search is off.</p>
        <p className="ss-empty__sub">
          Turn it on to search what you and your agents said in past Claude, Codex, Grok, Pi and Cora sessions. The
          index stays on this computer.
        </p>
        <button
          type="button"
          className="spark-btn is-primary"
          onClick={() => void setPreference("sessionSearch", { ...prefs, enabled: true })}
        >
          Turn on
        </button>
      </div>,
    );
  }

  const sessionsNoun =
    activeAgents.length === 1 ? `${SESSION_SEARCH_AGENT_LABEL[activeAgents[0]]} sessions` : "agent sessions";
  let lastHeading: string | null = null;
  const firstBuildRunning = status.firstBuild && (indexing || status.phase === "paused");

  return (
    <>
      {layer(
        <>
          <div className="sp-left">
            <div className="sp-controls">
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                className="sp-search"
                aria-label="Search session names and what was said"
                aria-expanded
                aria-controls="sp-listbox"
                aria-activedescendant={selected ? `sp-row-${selected.key}` : undefined}
                placeholder="Search names and what was said"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onInputKey}
              />
              <div className="spark-segmented is-wrap sp-scopes" role="tablist" aria-label="Sessions from">
                {SESSION_SCOPES.map((entry) => {
                  const disabled = entry.id !== "all" && !hasWorkspace;
                  const isSelected = entry.id === effectiveScope;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      disabled={disabled}
                      title={disabled ? "Open a workspace to narrow the search to it" : entry.hint}
                      className={`spark-segmented-item${isSelected ? " is-selected" : ""}`}
                      onClick={() => {
                        setScope(entry.id);
                        focusSearch();
                      }}
                    >
                      {entry.label}
                    </button>
                  );
                })}
              </div>
              <div className="sp-agents" role="group" aria-label="Agent">
                {enabledAgents.map((item) => {
                  const on = activeAgents.includes(item);
                  return (
                    <button
                      key={item}
                      type="button"
                      className={`sp-agent${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      title={SESSION_SEARCH_AGENT_LABEL[item]}
                      onClick={() => {
                        toggleAgent(item);
                        focusSearch();
                      }}
                    >
                      <SessionAgentMark agent={item} size={12} />
                      {SESSION_SEARCH_AGENT_LABEL[item]}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="spark-icon-btn sp-refresh"
                  aria-label="Refresh sessions"
                  title="Read new sessions now"
                  data-testid="session-picker-refresh"
                  disabled={indexing}
                  onClick={refreshIndex}
                >
                  <span className={indexing ? "ss-spin" : undefined} style={{ display: "inline-flex" }}>
                    <ReloadIcon size={12} />
                  </span>
                </button>
              </div>
            </div>

            {offer ? (
              <button
                type="button"
                className={`sp-new${selected ? "" : " is-selected"}`}
                data-testid="session-picker-new"
                onMouseDown={(event) => event.preventDefault()}
                onClick={startNew}
              >
                <SessionAgentMark agent={offer.runtime} />
                <span className="sp-new__title">New session</span>
                <span className="sp-new__where">{folderName(offer.cwd)}</span>
              </button>
            ) : null}

            <div
              ref={listRef}
              id="sp-listbox"
              className="sp-list"
              role="listbox"
              aria-label="Agent sessions"
              aria-busy={loading}
              onScroll={onListScroll}
            >
              {hits.length === 0 && searched ? (
                <div className="ss-empty">
                  {firstBuildRunning ? (
                    <p>Indexing your agent sessions…</p>
                  ) : query.trim() ? (
                    <>
                      <p>No sessions match “{query.trim()}”.</p>
                      {effectiveScope !== "all" ? (
                        <button type="button" className="ss-link" onClick={() => setScope("all")}>
                          Search every project
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <p>
                      {effectiveScope === "all"
                        ? `No ${sessionsNoun} on this computer yet.`
                        : effectiveScope === "workspace"
                          ? `No ${sessionsNoun} in this workspace yet.`
                          : `No ${sessionsNoun} in this project yet.`}
                    </p>
                  )}
                </div>
              ) : null}
              {hits.map((hit) => {
                const heading = searching ? null : hit.pinned ? "Pinned" : sessionDayGroup(hit.lastAt, now);
                const showHeading = heading !== null && heading !== lastHeading;
                lastHeading = heading;
                const said = hit.matches.find((match) => match.kind !== "name") ?? hit.matches[0] ?? null;
                return (
                  <div key={hit.key} role="presentation">
                    {showHeading ? (
                      <div className="sp-heading" role="presentation">
                        {heading}
                      </div>
                    ) : null}
                    <div
                      id={`sp-row-${hit.key}`}
                      role="option"
                      aria-selected={hit.key === selectedKey}
                      className={`sp-row${hit.key === selectedKey ? " is-selected" : ""}${isGone(hit) ? " is-gone" : ""}`}
                      data-session-row={hit.key}
                      data-session-agent={hit.agent}
                      data-match-kinds={hit.matches.map((match) => match.kind).join(" ")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setSelectedKey(hit.key);
                        inputRef.current?.focus();
                      }}
                      onDoubleClick={() => primary(hit)}
                    >
                      <span className="sp-row__head">
                        <SessionAgentMark agent={hit.agent} />
                        <span className="sp-row__title">
                          <TermsText text={hit.title} terms={terms} />
                        </span>
                        {hit.pinned && searching ? (
                          <span className="sp-row__pin" aria-label="Pinned">
                            <PinIcon size={10} />
                          </span>
                        ) : null}
                        <span className="sp-row__age">{relativeAge(hit.lastAt, now)}</span>
                      </span>
                      {searching && said ? (
                        <span className="sp-row__line">
                          <span className="sp-row__who">{matchLabel(said.kind, hit.agent)}: </span>
                          <SnippetText snippet={said.snippet} />
                        </span>
                      ) : (
                        <span className="sp-row__line sp-row__line--meta">
                          {[isGone(hit) ? "folder gone" : "", folderName(hit.cwd), hit.branch ?? ""]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {hasMore ? <div className="ss-more">{loading ? "Loading…" : ""}</div> : null}
            </div>

            <div className="sp-status" role="status" aria-live="polite" data-session-search-phase={status.phase}>
              {note ?? sessionStatusLine(status)}
            </div>
          </div>

          {selected ? (
            <div className="sp-detail" data-testid="session-picker-detail">
              <header className="sp-detail__head">
                <div className="sp-detail__title">
                  <SessionAgentMark agent={selected.agent} size={15} />
                  {renaming ? (
                    <RenameField
                      key={selected.key}
                      value={selected.title}
                      onSave={(name) => void applyName(selected, name)}
                      onCancel={() => {
                        setRenaming(false);
                        focusSearch();
                      }}
                    />
                  ) : (
                    <>
                      <h2>{selected.title}</h2>
                      <button
                        type="button"
                        className="spark-icon-btn"
                        aria-label="Rename"
                        title="Rename (F2)"
                        onClick={() => setRenaming(true)}
                      >
                        <PencilIcon size={12} />
                      </button>
                    </>
                  )}
                </div>
                {selected.originalTitle ? (
                  <div className="sp-detail__was">
                    <span className="sp-detail__was-text">Was: {selected.originalTitle}</span>
                    {selected.agent !== "cora" ? (
                      <button
                        type="button"
                        className="ss-link"
                        onClick={() => void applyName(selected, selected.originalTitle ?? "")}
                      >
                        Use original
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <dl className="sp-facts">
                  <div>
                    <dt>Agent</dt>
                    <dd>
                      {[SESSION_SEARCH_AGENT_LABEL[selected.agent], selected.model].filter(Boolean).join(" · ")}
                    </dd>
                  </div>
                  {selected.cwd ? (
                    <div>
                      <dt>Folder</dt>
                      <dd title={selected.cwd}>{folderName(selected.cwd)}</dd>
                    </div>
                  ) : null}
                  {selected.branch ? (
                    <div>
                      <dt>Branch</dt>
                      <dd>{selected.branch}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Length</dt>
                    <dd>
                      {[
                        `${selected.messageCount} ${selected.messageCount === 1 ? "message" : "messages"}`,
                        sessionLengthLabel(selected.startedAt, selected.lastAt),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </dd>
                  </div>
                  <div>
                    <dt>Last</dt>
                    <dd>{relativeAge(selected.lastAt, now) || "unknown"}</dd>
                  </div>
                </dl>
                {selectedOpen ? (
                  <p className="sp-detail__notice">Open in a tab now, so resuming goes there.</p>
                ) : isGone(selected) ? (
                  <p className="sp-detail__notice">
                    Its folder is no longer on this computer, so it can be read but not resumed.
                  </p>
                ) : null}
              </header>

              {searching && selected.matches.length > 0 ? (
                <section className="sp-matches" aria-label="What matched" data-testid="session-picker-matches">
                  {selected.matches.map((match) => (
                    <div key={match.kind} className="sp-match" data-match-kind={match.kind}>
                      <span className="sp-match__kind">{matchLabel(match.kind, selected.agent)}</span>
                      <span className="sp-match__text">
                        <SnippetText snippet={match.snippet} lead={MATCH_LEAD_CHARS} />
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}

              <div ref={tailRef} className="sp-tail" data-testid="session-picker-tail">
                {preview?.key === selected.key ? (
                  <>
                    {preview.total > preview.messages.length ? (
                      <div className="sp-earlier">
                        {preview.total - preview.messages.length} earlier{" "}
                        {preview.total - preview.messages.length === 1 ? "message" : "messages"}
                      </div>
                    ) : null}
                    {preview.messages.map((message, index) => (
                      <div key={index} className={`sp-msg is-${message.role}`}>
                        <TermsText text={message.text} terms={terms} />
                      </div>
                    ))}
                  </>
                ) : null}
              </div>

              {deleting?.hit.key === selected.key ? (
                <footer className="sp-actions sp-actions--confirm" data-testid="session-picker-confirm-delete">
                  <span className="sp-actions__ask">Delete this session's transcript from this computer?</span>
                  <button
                    ref={cancelDeleteRef}
                    type="button"
                    className="spark-btn"
                    disabled={busy}
                    onClick={() => {
                      setDeleting(null);
                      focusSearch();
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="spark-btn is-danger"
                    disabled={busy}
                    onClick={() => void deleteSession(deleting)}
                  >
                    Delete
                  </button>
                </footer>
              ) : (
                <footer className="sp-actions">
                  <button type="button" className="spark-btn is-primary" onClick={() => primary(selected)}>
                    {selected.agent === "cora"
                      ? "Open chat"
                      : selectedOpen
                        ? "Go to its tab"
                        : isGone(selected)
                          ? "View transcript"
                          : resumesInPane(selected)
                            ? "Resume in a new pane"
                            : "Resume in a new tab"}
                    <kbd className="spark-kbd sp-actions__kbd">Enter</kbd>
                  </button>
                  {canFork(selected) ? (
                    <button
                      type="button"
                      className="spark-btn"
                      title="A new session from this one's history (Alt+Enter)"
                      onClick={() => finish(() => host.forkSession?.(selected))}
                    >
                      Fork
                    </button>
                  ) : null}
                  {!selectedOpen && !resumesInPane(selected) && host.canSplitSession?.(selected) ? (
                    <button
                      type="button"
                      className="spark-btn"
                      title="Resume it in a new pane beside this one"
                      onClick={() => finish(() => host.splitSession?.(selected))}
                    >
                      Split here
                    </button>
                  ) : null}
                  <span className="sp-actions__gap" />
                  <button type="button" className="spark-btn" onClick={() => showTranscript(selected, null)}>
                    Whole transcript
                  </button>
                  <button
                    ref={moreRef}
                    type="button"
                    className="spark-icon-btn"
                    aria-label="More actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    ⋯
                  </button>
                </footer>
              )}
            </div>
          ) : offer ? (
            <div className="sp-detail sp-detail--new">
              <div className="sp-new-detail">
                <SessionAgentMark agent={offer.runtime} size={20} />
                <h2>New {SESSION_SEARCH_AGENT_LABEL[offer.runtime]} session</h2>
                <p title={offer.cwd ?? undefined}>In {folderName(offer.cwd)}</p>
                {hits.length > 0 ? <p>Or press ↓ to pick up an earlier session from the list.</p> : null}
              </div>
              <footer className="sp-actions">
                <button type="button" className="spark-btn is-primary" onClick={startNew}>
                  Start session
                  <kbd className="spark-kbd sp-actions__kbd">Enter</kbd>
                </button>
              </footer>
            </div>
          ) : (
            <div className="sp-detail sp-detail--empty" />
          )}
        </>,
      )}

      <AnchoredMenu
        anchorRef={moreRef}
        open={menuOpen && selected !== null}
        onClose={() => setMenuOpen(false)}
        className="spark-menu"
        role="menu"
        ariaLabel="Session actions"
        placement="above"
        align="end"
        zIndex={MENU_Z_INDEX}
        menuItems
      >
        {selected ? (
          <div className="ss-menu">
            {[
              {
                label: selected.pinned ? "Unpin" : "Pin",
                run: () => void togglePin(selected),
              },
              { label: "Rename", run: () => setRenaming(true) },
              { label: "Copy session id", run: () => void copySessionId(selected.sessionId).then(setNote) },
              { label: "Reveal transcript", run: () => void revealSessionTranscript(selected.key).then(setNote) },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="spark-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  item.run();
                }}
              >
                {item.label}
              </button>
            ))}
            {canDelete(selected) && !selectedOpen ? (
              <button
                type="button"
                role="menuitem"
                className="spark-menu-item is-danger"
                onClick={() => {
                  setMenuOpen(false);
                  void askToDelete(selected);
                }}
              >
                Delete…
              </button>
            ) : null}
          </div>
        ) : null}
      </AnchoredMenu>

      {transcript ? (
        <SessionTranscriptDialog
          sessionKey={transcript.hit.key}
          sessionId={transcript.hit.sessionId}
          query={query}
          notice={transcript.notice}
          onClose={() => {
            setTranscript(null);
            focusSearch();
          }}
        />
      ) : null}
    </>
  );
}
