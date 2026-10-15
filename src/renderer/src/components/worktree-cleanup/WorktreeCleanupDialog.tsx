import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LARGE_BYTES,
  DEFAULT_STALE_DAYS,
  filterWorktreeRows,
  formatBytes,
  keepRowOrder,
  orderDrifted,
  plural,
  removalOutlook,
  rowPositions,
  sortWorktreeRows,
  type WorktreeCleanupRemoveResult,
  type WorktreeCleanupRow,
  type WorktreeCleanupScan,
  type WorktreeRemovalCheck,
  type WorktreeSize,
  type WorktreeSortKey,
} from "@shared/worktree-cleanup";
import { Spinner } from "../git/git-ui";
import { WorktreeRow } from "./WorktreeRow";
import { checkKey, isReady, ResultsView, ReviewView, type Confirmation } from "./WorktreeReview";
import "./worktree-cleanup.css";

// The worktree cleanup screen. Lists every worktree of the repositories
// behind the user's workspaces with size, last activity, git state and pull
// request, lets the user filter and pick, then runs the full check with a
// confirmation per item that holds work, and removes under the same guarded
// removal agents use (src/main/worktree-cleanup/). Sizes arrive in the
// background as they are measured.

const STALE_CHOICES = [7, 14, 30, 60, 90];
const LARGE_CHOICES = [100 * 1024 * 1024, DEFAULT_LARGE_BYTES, 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024];

// The thresholds and sort the user picked last, for the next open in this
// window. Not a setting: nothing is saved.
const remembered: { staleDays: number; largeBytes: number; sort: WorktreeSortKey; deleteMergedBranches: boolean } = {
  staleDays: DEFAULT_STALE_DAYS,
  largeBytes: DEFAULT_LARGE_BYTES,
  sort: "size",
  deleteMergedBranches: true,
};

type View = "list" | "review" | "results";

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function newerSize(listed: WorktreeSize | null, measured: WorktreeSize | undefined): WorktreeSize | null {
  if (!measured) return listed;
  if (!listed || measured.measuredAt >= listed.measuredAt) return measured;
  return listed;
}

function reviewStatus(checks: WorktreeRemovalCheck[] | null, ready: number): string {
  if (!checks) return "";
  const blocked = checks.filter((check) => check.blockers.length).length;
  const waiting = checks.length - ready - blocked;
  if (!blocked && !waiting) return "Each removal checks the worktree again first and stops if anything changed.";
  return [
    waiting ? `${plural(waiting, "worktree")} ${waiting === 1 ? "waits" : "wait"} for your confirmation` : null,
    blocked ? `${plural(blocked, "worktree")} cannot be removed` : null,
  ]
    .filter(Boolean)
    .join(", ")
    .concat(". Only the ready ones are removed.");
}

function SortHeader({
  label,
  sortKey,
  sort,
  drifted,
  onSort,
  className,
}: {
  label: string;
  sortKey: WorktreeSortKey;
  sort: WorktreeSortKey;
  /** Values changed since the rows were sorted; a click sorts them again. */
  drifted: boolean;
  onSort: (key: WorktreeSortKey) => void;
  className?: string;
}): React.ReactElement {
  const active = sort === sortKey;
  const stale = active && drifted;
  return (
    <span
      role="columnheader"
      className={className}
      // Size runs largest first; activity runs oldest first; names run A to Z.
      aria-sort={active ? (sortKey === "size" ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className={`wtc-sort${active ? " is-active" : ""}${stale ? " is-stale" : ""}`}
        title={stale ? "Sizes changed since this sort. Click to sort again." : undefined}
        aria-label={stale ? `${label}, sort again` : undefined}
        onClick={() => onSort(sortKey)}
      >
        {label}
      </button>
    </span>
  );
}

export default function WorktreeCleanupDialog({
  workspaceId,
  onClose,
}: {
  /** The workspace whose repository the list starts filtered to. */
  workspaceId: string | null;
  onClose: () => void;
}): React.ReactElement {
  const [scan, setScan] = useState<WorktreeCleanupScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, WorktreeSize>>(() => new Map());
  const [measuring, setMeasuring] = useState({ pending: 0, budgetSpent: false });
  const [now, setNow] = useState(() => Date.now());

  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [mergedOnly, setMergedOnly] = useState(false);
  const [staleOn, setStaleOn] = useState(false);
  const [staleDays, setStaleDays] = useState(remembered.staleDays);
  const [largeOn, setLargeOn] = useState(false);
  const [largeBytes, setLargeBytes] = useState(remembered.largeBytes);
  const [sort, setSort] = useState<WorktreeSortKey>(remembered.sort);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const [view, setView] = useState<View>("list");
  const [checks, setChecks] = useState<WorktreeRemovalCheck[] | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, Confirmation>>({});
  const [deleteMergedBranches, setDeleteMergedBranches] = useState(remembered.deleteMergedBranches);
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<WorktreeCleanupRemoveResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mounted = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstScan = useRef(true);
  const scanSeq = useRef(0);
  const reviewSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++scanSeq.current;
    setLoading(true);
    setError(null);
    try {
      const next = await window.spark.worktreeCleanup.scan();
      if (!mounted.current || seq !== scanSeq.current) return;
      setScan(next);
      setNow(Date.now());
      if (firstScan.current) {
        firstScan.current = false;
        const owner = workspaceId ? next.repos.find((entry) => entry.workspaceIds.includes(workspaceId)) : undefined;
        setRepo(owner && next.repos.length > 1 ? owner.root : null);
      }
      const ids = new Set(next.rows.map((row) => row.id));
      setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
      const queued = await window.spark.worktreeCleanup.measure({});
      if (mounted.current) setMeasuring({ pending: queued.pending, budgetSpent: false });
    } catch (err) {
      if (mounted.current && seq === scanSeq.current) setError(errorMessage(err));
    } finally {
      if (mounted.current && seq === scanSeq.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const stop = window.spark.worktreeCleanup.onSize((event) => {
      if (event.measured) {
        const { id, size } = event.measured;
        setSizes((current) => new Map(current).set(id, size));
      }
      setMeasuring({ pending: event.pending, budgetSpent: Boolean(event.budgetSpent) });
    });
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    return () => {
      mounted.current = false;
      // Focus goes back where it was when the screen opened.
      if (opener?.isConnected) opener.focus();
      stop();
      // Measuring is for this screen; what landed stays cached.
      void window.spark.worktreeCleanup.stopMeasuring().catch(() => undefined);
    };
  }, [load]);

  // A row keeps its object until its own size changes, so a size landing
  // repaints that row only, not the whole list (WorktreeRow is memoized).
  const sizedRows = useRef(new WeakMap<WorktreeCleanupRow, WorktreeCleanupRow>());
  const rows = useMemo<WorktreeCleanupRow[]>(
    () =>
      (scan?.rows ?? []).map((row) => {
        const size = newerSize(row.size, sizes.get(row.id));
        if (size === row.size) return row;
        const known = sizedRows.current.get(row);
        if (known?.size === size) return known;
        const next = { ...row, size };
        sizedRows.current.set(row, next);
        return next;
      }),
    [scan, sizes],
  );
  const repos = scan?.repos ?? [];
  const repoNames = useMemo(() => new Map(repos.map((entry) => [entry.root, entry.name])), [repos]);
  const outlooks = useMemo(() => new Map(rows.map((row) => [row.id, removalOutlook(row)])), [rows]);

  // The order is taken when the user sorts or the list is read again, and
  // kept while sizes land, so rows never move under the pointer mid-pick.
  // A click on the active column sorts again with the sizes measured since.
  const [sortRound, setSortRound] = useState(0);
  const sorted = useMemo(() => sortWorktreeRows(rows, sort), [rows, sort]);
  const orderKey = `${sort}\u0000${scan?.scannedAt ?? 0}\u0000${sortRound}`;
  const order = useRef<{ key: string; positions: Map<string, number> }>({ key: "", positions: new Map() });
  if (order.current.key !== orderKey) order.current = { key: orderKey, positions: rowPositions(sorted) };
  const ordered = useMemo(() => keepRowOrder(sorted, order.current.positions), [sorted, orderKey]);
  const sortDrifted = useMemo(() => orderDrifted(ordered, sorted), [ordered, sorted]);

  const visible = useMemo(
    () =>
      filterWorktreeRows(
        ordered,
        {
          query,
          repo,
          merged: mergedOnly,
          staleDays: staleOn ? staleDays : null,
          largeBytes: largeOn ? largeBytes : null,
        },
        now,
      ),
    [ordered, query, repo, mergedOnly, staleOn, staleDays, largeOn, largeBytes, now],
  );
  const selectable = useMemo(() => visible.filter((row) => !outlooks.get(row.id)?.blocked), [visible, outlooks]);
  // What you see is what you remove: rows a filter hides drop out of the pick.
  const picked = useMemo(() => selectable.filter((row) => selected.has(row.id)), [selectable, selected]);
  const pickedBytes = picked.reduce((total, row) => total + (row.size?.bytes ?? 0), 0);
  const pickedUnmeasured = picked.some((row) => !row.size || !row.size.complete);
  const filtersOn = Boolean(query.trim() || repo || mergedOnly || staleOn || largeOn);
  const linkedBytes = rows.reduce((total, row) => total + (row.isMain ? 0 : (row.size?.bytes ?? 0)), 0);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openPullRequest = useCallback((url: string) => {
    void window.spark.openInSystemBrowser(url).catch(() => undefined);
  }, []);

  const copy = useCallback((text: string) => {
    void window.spark.clipboard
      .writeText(text)
      .then(() => mounted.current && setNotice("Copied."))
      .catch(() => undefined);
  }, []);

  const allPicked = selectable.length > 0 && picked.length === selectable.length;
  const somePicked = picked.length > 0 && !allPicked;
  const headerCheck = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheck.current) headerCheck.current.indeterminate = somePicked;
  }, [somePicked]);

  const toggleAll = (): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPicked) for (const row of selectable) next.delete(row.id);
      else for (const row of selectable) next.add(row.id);
      return next;
    });
  };

  const pickMergedAndClean = (): void => {
    setSelected(
      new Set(
        selectable
          .filter((row) => {
            const outlook = outlooks.get(row.id);
            return row.merge.state === "merged" && outlook && !outlook.needsDirtyConfirm && !outlook.needsUnmergedConfirm;
          })
          .map((row) => row.id),
      ),
    );
  };

  const changeSort = useCallback((key: WorktreeSortKey) => {
    setSort(key);
    setSortRound((round) => round + 1);
    remembered.sort = key;
  }, []);

  const clearFilters = (): void => {
    setQuery("");
    setRepo(null);
    setMergedOnly(false);
    setStaleOn(false);
    setLargeOn(false);
  };

  const measureAgain = (): void => {
    const ids = visible.filter((row) => !row.missing).map((row) => row.id);
    void window.spark.worktreeCleanup
      .measure({ ids, force: true })
      .then((queued) => mounted.current && setMeasuring({ pending: queued.pending, budgetSpent: false }))
      .catch((err) => mounted.current && setError(errorMessage(err)));
  };

  const review = async (): Promise<void> => {
    const targets = picked.map((row) => ({ repoRoot: row.repoRoot, path: row.path }));
    if (!targets.length) return;
    // Back, then review again: only the latest check may fill the step.
    const seq = ++reviewSeq.current;
    setView("review");
    setChecks(null);
    setConfirmations({});
    setError(null);
    try {
      const next = await window.spark.worktreeCleanup.check(targets);
      if (mounted.current && seq === reviewSeq.current) setChecks(next);
    } catch (err) {
      if (!mounted.current || seq !== reviewSeq.current) return;
      setError(errorMessage(err));
      setView("list");
    }
  };

  const readyChecks = useMemo(
    () => (checks ?? []).filter((check) => isReady(check, confirmations[checkKey(check)])),
    [checks, confirmations],
  );

  const remove = async (): Promise<void> => {
    if (!readyChecks.length || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const next = await window.spark.worktreeCleanup.remove({
        items: readyChecks.map((check) => {
          const confirmation = confirmations[checkKey(check)];
          return {
            repoRoot: check.repoRoot,
            path: check.path,
            fingerprint: check.fingerprint,
            confirmDirty: Boolean(confirmation?.dirty),
            confirmUnmerged: Boolean(confirmation?.unmerged),
          };
        }),
        deleteMergedBranches,
      });
      if (!mounted.current) return;
      setResult(next);
      setView("results");
      setSelected(new Set());
      void load();
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setRemoving(false);
    }
  };

  const backToList = useCallback(() => {
    reviewSeq.current += 1;
    setView("list");
    setChecks(null);
    setResult(null);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (removing) return;
      event.preventDefault();
      if (view === "review") backToList();
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, removing, backToList, onClose]);

  // A new step starts at its top, with focus inside the dialog rather than
  // on the button that just went away.
  const firstView = useRef(true);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (view !== "list") dialogRef.current?.focus();
  }, [view]);

  // Tab and Shift+Tab stay inside the dialog.
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const rowsByTarget = useMemo(() => new Map(rows.map((row) => [checkKey(row), row])), [rows]);
  const notes: string[] = [];
  for (const entry of repos) {
    if (entry.error) notes.push(`${entry.name}: ${entry.error}`);
  }
  const noPullRequests = repos.filter((entry) => entry.pullRequests === "unavailable" && !entry.error);
  if (noPullRequests.length) {
    notes.push(
      `Pull requests are unknown for ${noPullRequests.map((entry) => entry.name).join(", ")}: no GitHub remote, or the GitHub CLI is missing, signed out or did not answer.`,
    );
  }
  if (scan && !scan.processScan) {
    notes.push("Running programs are not checked on this system. Close what runs in a worktree before removing it.");
  }

  const measuringText =
    measuring.pending > 0
      ? `Measuring sizes, ${measuring.pending} left`
      : measuring.budgetSpent
        ? "Size measuring stopped at its time limit"
        : null;

  return (
    <div
      className="spark-scrim wtc-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !removing) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wtc-title"
        tabIndex={-1}
        className="spark-glass--strong spark-overlay-surface wtc-dialog"
        onKeyDown={trapTab}
      >
        <header className="wtc-header">
          <div className="wtc-title-line">
            <h2 id="wtc-title">
              {view === "list" ? "Worktrees" : view === "review" ? "Review removal" : "Removal done"}
            </h2>
            {loading && view === "list" ? <Spinner size={12} /> : null}
            <span className="wtc-summary" role="status">
              {view === "list" && scan
                ? `${plural(rows.length, "worktree")} in ${plural(repos.length, "repository", "repositories")}${
                    linkedBytes ? `, ${formatBytes(linkedBytes)} outside the main checkouts` : ""
                  }`
                : ""}
            </span>
            <button type="button" className="spark-icon-btn wtc-close" aria-label="Close" title="Close" onClick={onClose} disabled={removing}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {view === "list" ? (
            <div className="wtc-toolbar">
              <input
                ref={searchRef}
                className="spark-input wtc-search"
                type="search"
                placeholder="Search branch, folder or pull request"
                aria-label="Search worktrees"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {repos.length > 1 ? (
                <select
                  className="spark-select wtc-repo"
                  aria-label="Repository"
                  value={repo ?? ""}
                  onChange={(event) => setRepo(event.target.value || null)}
                >
                  <option value="">All repositories</option>
                  {repos.map((entry) => (
                    <option key={entry.root} value={entry.root} title={entry.root}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className={`wtc-chip${mergedOnly ? " is-on" : ""}`}
                aria-pressed={mergedOnly}
                onClick={() => setMergedOnly((value) => !value)}
              >
                Merged
              </button>
              <span className={`wtc-chip-group${staleOn ? " is-on" : ""}`}>
                <button type="button" className="wtc-chip" aria-pressed={staleOn} onClick={() => setStaleOn((value) => !value)}>
                  Stale for
                </button>
                <select
                  aria-label="Days without activity"
                  value={staleDays}
                  onChange={(event) => {
                    const days = Number(event.target.value);
                    setStaleDays(days);
                    remembered.staleDays = days;
                    setStaleOn(true);
                  }}
                >
                  {STALE_CHOICES.map((days) => (
                    <option key={days} value={days}>
                      {`${days} days`}
                    </option>
                  ))}
                </select>
              </span>
              <span className={`wtc-chip-group${largeOn ? " is-on" : ""}`}>
                <button type="button" className="wtc-chip" aria-pressed={largeOn} onClick={() => setLargeOn((value) => !value)}>
                  Larger than
                </button>
                <select
                  aria-label="Size threshold"
                  value={largeBytes}
                  onChange={(event) => {
                    const bytes = Number(event.target.value);
                    setLargeBytes(bytes);
                    remembered.largeBytes = bytes;
                    setLargeOn(true);
                  }}
                >
                  {LARGE_CHOICES.map((bytes) => (
                    <option key={bytes} value={bytes}>
                      {formatBytes(bytes)}
                    </option>
                  ))}
                </select>
              </span>
              <span className="wtc-toolbar-spacer" />
              <button type="button" className="spark-btn" onClick={() => void load()} disabled={loading}>
                Refresh
              </button>
              <button type="button" className="spark-btn" onClick={measureAgain} disabled={!visible.length}>
                Measure sizes again
              </button>
            </div>
          ) : null}
          {view === "list" && (measuringText || notes.length) ? (
            <div className="wtc-notes">
              {measuringText ? (
                <div className="wtc-note">
                  {measuring.pending > 0 ? <Spinner size={10} /> : null}
                  <span>{measuringText}</span>
                </div>
              ) : null}
              {notes.map((note) => (
                <div key={note} className="wtc-note">
                  {note}
                </div>
              ))}
            </div>
          ) : null}
          {error ? (
            <div className="wtc-error" role="alert">
              {error}
            </div>
          ) : null}
        </header>

        <div className="wtc-body" ref={bodyRef}>
          {view === "list" ? (
            !scan ? (
              <div className="wtc-empty" role="status">
                {loading ? <Spinner size={14} /> : null}
                <span>{loading ? "Reading worktrees…" : "The worktrees could not be read."}</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="wtc-empty">No worktrees found. Open a Git repository as a workspace to see its worktrees here.</div>
            ) : (
              <div role="grid" aria-label="Worktrees" aria-rowcount={visible.length} className="wtc-grid">
                <div role="row" className="wtc-row wtc-row--head">
                  <span role="columnheader" className="wtc-cell-check">
                    <input
                      ref={headerCheck}
                      type="checkbox"
                      aria-label="Select every worktree shown that can be removed"
                      title="Select every worktree shown that can be removed"
                      checked={allPicked}
                      disabled={!selectable.length}
                      onChange={toggleAll}
                    />
                  </span>
                  <SortHeader label="Worktree" sortKey="name" sort={sort} drifted={sortDrifted} onSort={changeSort} />
                  <SortHeader
                    label="Last activity"
                    sortKey="activity"
                    sort={sort}
                    drifted={sortDrifted}
                    onSort={changeSort}
                    className="wtc-cell-num"
                  />
                  <SortHeader
                    label="Size"
                    sortKey="size"
                    sort={sort}
                    drifted={sortDrifted}
                    onSort={changeSort}
                    className="wtc-cell-num"
                  />
                </div>
                {visible.length === 0 ? (
                  <div className="wtc-empty">
                    <span>Nothing matches these filters.</span>
                    <button type="button" className="spark-btn" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </div>
                ) : (
                  visible.map((row) => (
                    <WorktreeRow
                      key={row.id}
                      row={row}
                      checked={selected.has(row.id)}
                      blocked={outlooks.get(row.id)?.blocked ?? null}
                      measuring={measuring.pending > 0}
                      now={now}
                      showRepo={repos.length > 1 && !repo}
                      onToggle={toggle}
                      onOpenPullRequest={openPullRequest}
                    />
                  ))
                )}
              </div>
            )
          ) : view === "review" ? (
            <ReviewView
              checks={checks}
              rows={rowsByTarget}
              confirmations={confirmations}
              onConfirm={(key, change) =>
                setConfirmations((current) => ({
                  ...current,
                  [key]: { ...(current[key] ?? { dirty: false, unmerged: false }), ...change },
                }))
              }
              deleteMergedBranches={deleteMergedBranches}
              onDeleteMergedBranches={(value) => {
                setDeleteMergedBranches(value);
                remembered.deleteMergedBranches = value;
              }}
            />
          ) : result ? (
            <ResultsView result={result} repoNames={repoNames} onCopy={copy} />
          ) : null}
        </div>

        <footer className="wtc-footer">
          {view === "list" ? (
            <>
              <span className="wtc-footer-text" role="status">
                {picked.length
                  ? `${plural(picked.length, "worktree")} selected${
                      pickedBytes ? `, ${pickedUnmeasured ? "at least " : ""}${formatBytes(pickedBytes)} to free` : ""
                    }`
                  : filtersOn && scan
                    ? `${visible.length} of ${rows.length} shown`
                    : ""}
              </span>
              <button type="button" className="spark-btn" onClick={pickMergedAndClean} disabled={!selectable.length}>
                Select merged and clean
              </button>
              <button type="button" className="spark-btn is-primary" onClick={() => void review()} disabled={!picked.length}>
                {picked.length ? `Review removal of ${picked.length}` : "Review removal"}
              </button>
            </>
          ) : view === "review" ? (
            <>
              <span className="wtc-footer-text" role="status">
                {reviewStatus(checks, readyChecks.length)}
              </span>
              {removing ? <Spinner size={12} /> : null}
              <button type="button" className="spark-btn" onClick={backToList} disabled={removing}>
                Back
              </button>
              <button
                type="button"
                className="spark-btn is-danger"
                onClick={() => void remove()}
                disabled={!readyChecks.length || removing}
              >
                {readyChecks.length ? `Remove ${plural(readyChecks.length, "worktree")}` : "Remove"}
              </button>
            </>
          ) : (
            <>
              <span className="wtc-footer-text" role="status">
                {notice ?? ""}
              </span>
              <button type="button" className="spark-btn" onClick={backToList}>
                Back to the list
              </button>
              <button type="button" className="spark-btn is-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
