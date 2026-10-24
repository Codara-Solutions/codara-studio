import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, UIEvent } from "react";
import {
  SESSION_SEARCH_AGENT_LABEL,
  normalizeSessionSearchPreferences,
  relativeAge,
  sessionQueryTerms,
  sessionSearchProgressLine,
  type SessionSearchAgent,
  type SessionSearchHit,
  type SessionSearchScope,
  type SessionSearchStatus,
} from "@shared/session-search";
import { usePreferences } from "../../preferences/usePreferences";
import AnchoredMenu from "../chat/composer/AnchoredMenu";
import { ReloadIcon } from "../icons";
import { RAIL_VIEW_PANEL_ID } from "../agent-board/railView";
import SessionAgentMark from "./SessionAgentMark";
import { SnippetText, TermsText } from "./SessionHighlight";
import SessionTranscriptDialog from "./SessionTranscriptDialog";
import { copySessionId, revealSessionTranscript } from "./session-actions";
import { useSessionSearchHost, useSessionSearchRequest } from "./sessionSearchStore";
import { publishSessionSearchStatus, useSessionSearchStatus } from "./useSessionSearchStatus";
import "./session-search.css";

// The rail's Sessions view: every past agent session on this computer,
// searched by what was said in it. With no query it lists the most recent
// ones. A click resumes the session in a new tab of its workspace; the "…"
// menu views the transcript, copies the session id or reveals the file.

const PAGE = 40;
const DEBOUNCE_MS = 120;
/** While a pass runs, results refresh this often so new sessions appear. */
const LIVE_REFRESH_MS = 3_000;
const SCOPE_KEY = "codara.sessions.scope";
const AGENTS_KEY = "codara.sessions.agents";

const SCOPES: { id: SessionSearchScope; label: string; hint: string }[] = [
  { id: "workspace", label: "Workspace", hint: "Sessions in this workspace's folder" },
  { id: "project", label: "Project", hint: "Sessions in every worktree of this repository" },
  { id: "all", label: "All", hint: "Every session on this computer" },
];

function readScope(): SessionSearchScope {
  try {
    const value = window.localStorage.getItem(SCOPE_KEY);
    return value === "workspace" || value === "all" ? value : "project";
  } catch {
    return "project";
  }
}

function readAgentFilter(): SessionSearchAgent[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(AGENTS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is SessionSearchAgent => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* remembering the choice is best-effort */
  }
}

function folderName(cwd: string | null): string {
  if (!cwd) return "";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function statusLine(status: SessionSearchStatus): string {
  if (status.phase === "paused") {
    return status.pausedReason === "battery"
      ? "Indexing waits while this computer is on battery"
      : "Indexing waits while this computer is busy";
  }
  if (status.phase === "error") return status.error ?? "The session index stopped";
  return sessionSearchProgressLine(status);
}

/** Requests the view applied, so a remount never replays an old one. */
let appliedRequestNonce = 0;

export default function SessionSearchList() {
  const host = useSessionSearchHost();
  const request = useSessionSearchRequest();
  const { status, loaded } = useSessionSearchStatus();
  const { preferences, setPreference } = usePreferences();
  const prefs = normalizeSessionSearchPreferences(preferences.sessionSearch);

  const [query, setQuery] = useState("");
  const [scope, setScopeState] = useState<SessionSearchScope>(readScope);
  const [agentFilter, setAgentFilterState] = useState<SessionSearchAgent[]>(readAgentFilter);
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<SessionSearchHit | null>(null);
  const [transcript, setTranscript] = useState<{ hit: SessionSearchHit; notice: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const agentBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const sequence = useRef(0);
  // The query the shown rows answer, and an Enter pressed before they caught up.
  const hitsQueryRef = useRef<string | null>(null);
  const openFirstRef = useRef(false);
  const openRef = useRef<(hit: SessionSearchHit) => void>(() => undefined);

  const hasWorkspace = host.workspaceCwd !== null;
  const effectiveScope: SessionSearchScope = hasWorkspace ? scope : "all";
  const enabledAgents = prefs.agents;
  const activeAgents = useMemo(
    () => agentFilter.filter((agent) => enabledAgents.includes(agent)),
    [agentFilter, enabledAgents],
  );
  const agentsKey = activeAgents.join(",");
  const terms = useMemo(() => sessionQueryTerms(query), [query]);

  const setScope = (next: SessionSearchScope) => {
    setScopeState(next);
    remember(SCOPE_KEY, next);
  };
  const setAgentFilter = (next: SessionSearchAgent[]) => {
    setAgentFilterState(next);
    remember(AGENTS_KEY, JSON.stringify(next));
  };

  const run = useCallback(
    async (offset: number) => {
      const id = ++sequence.current;
      setLoading(true);
      try {
        const result = await window.spark.sessionSearch.search({
          query,
          scope: effectiveScope,
          cwd: host.workspaceCwd,
          agents: agentsKey ? (agentsKey.split(",") as SessionSearchAgent[]) : null,
          limit: PAGE,
          offset,
        });
        if (id !== sequence.current) return;
        setHits((current) => (offset === 0 ? result.hits : [...current, ...result.hits]));
        hitsQueryRef.current = query;
        if (openFirstRef.current && offset === 0) {
          openFirstRef.current = false;
          if (result.hits[0]) openRef.current(result.hits[0]);
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
    [query, effectiveScope, host.workspaceCwd, agentsKey],
  );

  // A new query, scope, folder or agent filter starts from the top.
  useEffect(() => {
    if (!status.enabled && loaded) return;
    const timer = window.setTimeout(() => void run(0), query ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [run, query, status.enabled, loaded]);

  // Opening the view brings the index up to date when it is stale.
  useEffect(() => {
    void window.spark.sessionSearch.refresh(false).then(publishSessionSearchStatus, () => undefined);
  }, []);

  // While a pass runs, the first page follows it; a finished pass refreshes once.
  const indexing = status.phase === "indexing";
  const scrolledPastFirstPage = hits.length > PAGE;
  useEffect(() => {
    if (!indexing || scrolledPastFirstPage) return;
    const timer = window.setInterval(() => void run(0), LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [indexing, scrolledPastFirstPage, run]);
  const lastSyncAt = status.lastSyncAt;
  useEffect(() => {
    if (lastSyncAt !== null && !scrolledPastFirstPage) void run(0);
    // Only a finished pass triggers this; `run` changing has its own effect.
  }, [lastSyncAt]);

  // The jump palette's "Search agent sessions" lands here.
  useEffect(() => {
    if (!request || request.nonce <= appliedRequestNonce) return;
    appliedRequestNonce = request.nonce;
    openFirstRef.current = false;
    setQuery(request.query);
    setScopeState(request.scope);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [request]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [note]);

  const open = (hit: SessionSearchHit) => {
    if (hit.agent !== "cora" && !hit.cwdExists) {
      setTranscript({
        hit,
        notice: hit.cwd
          ? `The folder ${hit.cwd} is no longer on this computer, so this session cannot be resumed. Its transcript is below, read only.`
          : "This session has no folder to resume in. Its transcript is below, read only.",
      });
      return;
    }
    host.openSession?.(hit);
  };
  openRef.current = open;

  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-session-row]") ?? [])];

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (hitsQueryRef.current === query) {
        if (hits[0]) open(hits[0]);
      } else {
        // The rows are still those of an earlier query: open the first of this one's.
        openFirstRef.current = true;
      }
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    const index = all.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      all[Math.min(all.length - 1, index + 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else all[index - 1]?.focus();
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    if (!hasMore || loading) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) void run(hits.length);
  };

  const refresh = () => {
    void window.spark.sessionSearch.refresh(true).then(publishSessionSearchStatus, () => undefined);
  };

  if (loaded && !status.enabled) {
    return (
      <div id={RAIL_VIEW_PANEL_ID} role="tabpanel" aria-labelledby="rail-view-tab-sessions" className="ss-panel">
        <div className="ss-empty">
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
        </div>
      </div>
    );
  }

  const filterLabel =
    activeAgents.length === 0
      ? "All agents"
      : activeAgents.length === 1
        ? SESSION_SEARCH_AGENT_LABEL[activeAgents[0]]
        : `${activeAgents.length} agents`;
  const firstBuildRunning = status.firstBuild && (indexing || status.phase === "paused");

  return (
    <div
      id={RAIL_VIEW_PANEL_ID}
      role="tabpanel"
      aria-labelledby="rail-view-tab-sessions"
      className="ss-panel"
      data-testid="session-search"
    >
      <div className="ss-controls">
        <div className="ss-search">
          <input
            ref={inputRef}
            type="search"
            className="ss-search__input"
            aria-label="Search agent sessions"
            placeholder="Search sessions"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              openFirstRef.current = false;
              setQuery(event.currentTarget.value);
            }}
            onKeyDown={onInputKey}
          />
          <button
            ref={agentBtnRef}
            type="button"
            className={`ss-filter-btn${activeAgents.length > 0 ? " is-active" : ""}`}
            aria-haspopup="menu"
            aria-expanded={agentMenuOpen}
            title="Agents to show"
            onClick={() => setAgentMenuOpen((open) => !open)}
          >
            {filterLabel}
          </button>
          <button
            type="button"
            className="spark-icon-btn ss-refresh"
            aria-label="Refresh sessions"
            title="Read new sessions now"
            disabled={indexing}
            onClick={refresh}
          >
            <span className={indexing ? "ss-spin" : undefined} style={{ display: "inline-flex" }}>
              <ReloadIcon size={12} />
            </span>
          </button>
          <AnchoredMenu
            anchorRef={agentBtnRef}
            open={agentMenuOpen}
            onClose={() => setAgentMenuOpen(false)}
            className="spark-menu"
            role="menu"
            ariaLabel="Agents to show"
            placement="below"
            align="end"
          >
            <div className="ss-menu">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={activeAgents.length === 0}
                className={`spark-menu-item${activeAgents.length === 0 ? " is-active" : ""}`}
                onClick={() => {
                  setAgentFilter([]);
                  setAgentMenuOpen(false);
                }}
              >
                All agents
              </button>
              {enabledAgents.map((agent) => {
                const checked = activeAgents.includes(agent);
                return (
                  <button
                    key={agent}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className={`spark-menu-item${checked ? " is-active" : ""}`}
                    onClick={() =>
                      setAgentFilter(checked ? activeAgents.filter((item) => item !== agent) : [...activeAgents, agent])
                    }
                  >
                    <SessionAgentMark agent={agent} size={12} />
                    {SESSION_SEARCH_AGENT_LABEL[agent]}
                  </button>
                );
              })}
            </div>
          </AnchoredMenu>
        </div>
        <div className="spark-segmented is-wrap ss-scopes" role="tablist" aria-label="Sessions from">
          {SCOPES.map((entry) => {
            const disabled = entry.id !== "all" && !hasWorkspace;
            const selected = entry.id === effectiveScope;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={disabled}
                title={disabled ? "Open a workspace to narrow the search to it" : entry.hint}
                className={`spark-segmented-item${selected ? " is-selected" : ""}`}
                onClick={() => setScope(entry.id)}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
        <div className="ss-status" role="status" aria-live="polite" data-session-search-phase={status.phase}>
          {note ?? statusLine(status)}
        </div>
      </div>

      <div
        ref={listRef}
        className="ss-list"
        role="list"
        aria-label="Agent sessions"
        aria-busy={loading}
        onKeyDown={onListKey}
        onScroll={onScroll}
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
                  ? "No agent sessions on this computer yet."
                  : effectiveScope === "workspace"
                    ? "No agent sessions in this workspace yet."
                    : "No agent sessions in this project yet."}
              </p>
            )}
          </div>
        ) : null}
        {hits.map((hit) => (
          <div key={hit.key} role="listitem" className="ss-row-wrap">
            <button
              type="button"
              className={`ss-row${hit.agent !== "cora" && !hit.cwdExists ? " is-gone" : ""}`}
              data-session-row={hit.key}
              data-session-agent={hit.agent}
              title={hit.cwd ?? undefined}
              onClick={() => open(hit)}
              onContextMenu={(event) => {
                event.preventDefault();
                menuAnchorRef.current =
                  event.currentTarget.parentElement?.querySelector<HTMLElement>(".ss-row__more") ?? event.currentTarget;
                setMenuFor(hit);
              }}
            >
              <span className="ss-row__head">
                <SessionAgentMark agent={hit.agent} />
                <span className="ss-row__title">
                  <TermsText text={hit.title} terms={terms} />
                </span>
              </span>
              {hit.snippet ? (
                <span className="ss-row__snippet">
                  {hit.snippetRole === "user" ? <span className="ss-row__who">You: </span> : null}
                  <SnippetText snippet={hit.snippet} />
                </span>
              ) : null}
              <span className="ss-row__meta">
                {[
                  relativeAge(hit.lastAt, now),
                  // Ahead of the folder name, which is the first to be cut off.
                  hit.agent !== "cora" && !hit.cwdExists ? "folder gone" : "",
                  `${hit.messageCount} ${hit.messageCount === 1 ? "message" : "messages"}`,
                  folderName(hit.cwd),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            <button
              type="button"
              className="ss-row__more"
              aria-label={`More for ${hit.title}`}
              aria-haspopup="menu"
              aria-expanded={menuFor?.key === hit.key}
              onClick={(event) => {
                menuAnchorRef.current = event.currentTarget;
                setMenuFor((current) => (current?.key === hit.key ? null : hit));
              }}
            >
              ⋯
            </button>
          </div>
        ))}
        {hasMore ? <div className="ss-more">{loading ? "Loading…" : ""}</div> : null}
      </div>

      <AnchoredMenu
        anchorRef={menuAnchorRef}
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        className="spark-menu"
        role="menu"
        ariaLabel="Session actions"
        placement="below"
        align="end"
      >
        {menuFor ? (
          <RowMenu
            hit={menuFor}
            onDone={() => setMenuFor(null)}
            onOpen={open}
            onTranscript={(hit) => setTranscript({ hit, notice: null })}
            onNote={setNote}
          />
        ) : null}
      </AnchoredMenu>

      {transcript ? (
        <SessionTranscriptDialog
          sessionKey={transcript.hit.key}
          sessionId={transcript.hit.sessionId}
          query={query}
          notice={transcript.notice}
          onClose={() => setTranscript(null)}
        />
      ) : null}
    </div>
  );
}

function RowMenu({
  hit,
  onDone,
  onOpen,
  onTranscript,
  onNote,
}: {
  hit: SessionSearchHit;
  onDone: () => void;
  onOpen: (hit: SessionSearchHit) => void;
  onTranscript: (hit: SessionSearchHit) => void;
  onNote: (note: string) => void;
}) {
  const item = (label: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="spark-menu-item"
      onClick={() => {
        onDone();
        action();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="ss-menu">
      {hit.agent === "cora" || hit.cwdExists
        ? item(hit.agent === "cora" ? "Open chat" : "Resume in a new tab", () => onOpen(hit))
        : null}
      {item("View transcript", () => onTranscript(hit))}
      {item("Copy session id", () => void copySessionId(hit.sessionId).then(onNote))}
      {item("Reveal transcript", () => void revealSessionTranscript(hit.key).then(onNote))}
    </div>
  );
}
