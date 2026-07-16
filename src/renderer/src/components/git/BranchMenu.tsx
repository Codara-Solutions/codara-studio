import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitBranch, GitBranchList, GitOpResult } from "@shared/types";
import { InlineInput } from "../file-icons/InlineInput";
import { BranchIcon, CheckoutIcon, IconButton, Spinner } from "./git-ui";

interface Props {
  cwd: string;
  /** Called after any branch mutation so the panel re-reads git state. */
  onChanged: () => void;
  /** Bumped by the panel after any git mutation — re-read on change. */
  refreshKey?: number;
  disabled?: boolean;
}

// Branch control for the Source Control panel: shows the current branch and
// opens a picker to switch / create / rename / delete / merge branches over
// window.spark.git.{branches,checkoutBranch,…}. Destructive actions (delete /
// force-delete) use the in-app two-step "click again to confirm" pattern —
// never window.confirm. Every successful mutation calls onChanged() so the rest
// of the panel re-reads git state.
export default function BranchMenu({
  cwd,
  onChanged,
  refreshKey,
  disabled = false,
}: Props): React.ReactElement | null {
  const [list, setList] = useState<GitBranchList | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // The branch action currently in flight (by name), so its row can show a
  // spinner and the rest of the menu can lock.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs keep the async callbacks reading live values without re-subscribing
  // or capturing a stale cwd / list after a workspace switch.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const target = cwdRef.current;
    setLoading(true);
    try {
      const next = await window.spark.git.branches(target);
      if (cwdRef.current === target) setList(next);
    } finally {
      if (cwdRef.current === target) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [cwd, refreshKey, refresh]);

  const closeMenu = useCallback((): void => {
    setOpen(false);
    setFilter("");
    setCreating(false);
    setRenaming(false);
    setError(null);
  }, []);

  // Reset transient UI whenever the workspace changes underneath us.
  useEffect(() => {
    setOpen(false);
    setFilter("");
    setCreating(false);
    setRenaming(false);
    setBusy(null);
    setError(null);
  }, [cwd]);

  // Dismiss the popover on outside click / Escape — same pattern the commit
  // history menu uses. The opening click is stopped at the trigger so it never
  // reaches this listener.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closeMenu]);

  // Run one branch mutation: lock the menu, surface failures inline, refresh on
  // success (which also bumps the panel-wide version via onChanged).
  const runAction = useCallback(
    async (id: string, fn: () => Promise<GitOpResult>): Promise<boolean> => {
      if (busy) return false;
      setBusy(id);
      setError(null);
      try {
        const result = await fn();
        if (!result.ok) {
          setError(result.error);
          return false;
        }
        await refresh();
        onChanged();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh, onChanged],
  );

  const handleSwitch = useCallback(
    (branch: GitBranch): void => {
      if (branch.current) return;
      const cwdNow = cwdRef.current;
      if (branch.isRemote) {
        // Switching to a remote-tracking ref: create + check out a local branch
        // that tracks it (origin/feat → feat). If a local branch of that name
        // already exists, git refuses the create and we surface the message.
        const localName = branch.name.replace(/^[^/]+\//, "");
        void runAction(`switch:${branch.name}`, () =>
          window.spark.git.createBranch(cwdNow, localName, {
            checkout: true,
            startPoint: branch.name,
          }),
        ).then((ok) => {
          if (ok) closeMenu();
        });
      } else {
        void runAction(`switch:${branch.name}`, () =>
          window.spark.git.checkoutBranch(cwdNow, branch.name),
        ).then((ok) => {
          if (ok) closeMenu();
        });
      }
    },
    [runAction, closeMenu],
  );

  const handleCreate = useCallback(
    (name: string): void => {
      setCreating(false);
      const trimmed = name.trim();
      if (!trimmed) return;
      const cwdNow = cwdRef.current;
      // Branch from the current HEAD (no explicit start point) and check it out.
      void runAction(`create:${trimmed}`, () =>
        window.spark.git.createBranch(cwdNow, trimmed, { checkout: true }),
      ).then((ok) => {
        if (ok) closeMenu();
      });
    },
    [runAction, closeMenu],
  );

  const handleRename = useCallback(
    (oldName: string, newName: string): void => {
      setRenaming(false);
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return;
      const cwdNow = cwdRef.current;
      void runAction(`rename:${oldName}`, () =>
        window.spark.git.renameBranch(cwdNow, oldName, trimmed),
      );
    },
    [runAction],
  );

  const handleDelete = useCallback(
    (branch: GitBranch, force: boolean): void => {
      const cwdNow = cwdRef.current;
      void runAction(`delete:${branch.name}`, () =>
        window.spark.git.deleteBranch(cwdNow, branch.name, force),
      );
    },
    [runAction],
  );

  const handleMerge = useCallback(
    (branch: GitBranch): void => {
      const cwdNow = cwdRef.current;
      void runAction(`merge:${branch.name}`, () =>
        window.spark.git.mergeBranch(cwdNow, branch.name),
      ).then((ok) => {
        if (ok) closeMenu();
      });
    },
    [runAction, closeMenu],
  );

  const local = list?.local ?? [];
  const remote = list?.remote ?? [];
  const currentName = list?.current;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (b: GitBranch): boolean => !q || b.name.toLowerCase().includes(q);
    return { local: local.filter(match), remote: remote.filter(match) };
  }, [filter, local, remote]);

  if (!list || !list.isRepo) return null;

  const label = currentName ?? (list.detached ? "detached HEAD" : "no branch");
  const locked = disabled || busy !== null;

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      {/* Current-branch trigger */}
      <button
        type="button"
        title={
          list.detached
            ? "HEAD is detached — pick a branch to move it again"
            : currentName
              ? `On branch ${currentName} — click to switch or manage branches`
              : "Manage branches"
        }
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setError(null);
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) {
            // Branch refs commonly change outside Codara (terminal git, an
            // agent, another worktree). The menu's mount-time snapshot can be
            // arbitrarily old, so opening it is an explicit freshness boundary:
            // refresh the shared status/ahead-behind header and, through its
            // gitVersion bump, this menu's branch rows as well.
            onChanged();
          }
        }}
        style={{
          appearance: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          height: 30,
          padding: "0 8px 0 10px",
          border: "none",
          borderBottom: "none",
          background: open ? "color-mix(in oklch, var(--ink) 4%, transparent)" : "transparent",
          color: "var(--ink-dim)",
          cursor: "default",
          textAlign: "left",
          opacity: disabled ? 0.6 : 1,
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        <span style={{ color: list.detached ? "var(--warn)" : "var(--muted)", display: "inline-flex" }}>
          <BranchIcon />
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 600,
            color: list.detached ? "var(--warn)" : "var(--ink-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {currentName && <CurrentTrack branch={local.find((b) => b.current)} />}
        <span style={{ flex: 1 }} />
        {(loading || busy) && <Spinner size={11} />}
        <Caret open={open} />
      </button>

      {open && (
        <div
          className="spark-glass"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 6,
            right: 6,
            zIndex: 60,
            borderRadius: 8,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            maxHeight: 420,
          }}
        >
          {/* Filter / search */}
          <div style={{ padding: 8, borderBottom: "1px solid var(--rule)" }}>
            <input
              autoFocus
              value={filter}
              placeholder="Filter branches…"
              spellCheck={false}
              disabled={locked}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filter) {
                  e.stopPropagation();
                  setFilter("");
                }
              }}
              style={{
                appearance: "none",
                width: "100%",
                height: 26,
                padding: "0 8px",
                background: "var(--bg)",
                border: "1px solid var(--rule)",
                borderRadius: 6,
                boxShadow: "var(--well)",
                color: "var(--ink)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                outline: "none",
              }}
            />
          </div>

          {error && <ErrorLine text={error} onDismiss={() => setError(null)} />}

          <div style={{ overflowY: "auto", overflowX: "hidden", flex: 1, minHeight: 0 }}>
            {/* Local branches */}
            <GroupLabel text="Local" count={local.length} />
            {filtered.local.length === 0 ? (
              <Empty text={filter ? "No matches." : "No local branches."} />
            ) : (
              filtered.local.map((branch) =>
                renaming && branch.current ? (
                  <div
                    key={`l:${branch.name}`}
                    style={{ padding: "3px 10px 3px 12px", display: "flex" }}
                  >
                    <InlineInput
                      initial={branch.name}
                      placeholder="New branch name"
                      onCommit={(value) => handleRename(branch.name, value)}
                      onCancel={() => setRenaming(false)}
                    />
                  </div>
                ) : (
                  <BranchRow
                    key={`l:${branch.name}`}
                    branch={branch}
                    currentName={currentName}
                    busyId={busy}
                    locked={locked}
                    onSwitch={handleSwitch}
                    onStartRename={() => {
                      setError(null);
                      setRenaming(true);
                    }}
                    onDelete={handleDelete}
                    onMerge={handleMerge}
                  />
                ),
              )
            )}

            {/* Remote branches (collapsible) */}
            {remote.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setRemotesOpen((v) => !v)}
                  style={{
                    appearance: "none",
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    height: 24,
                    padding: "0 10px",
                    marginTop: 2,
                    border: "none",
                    borderTop: "1px solid var(--rule)",
                    background: "transparent",
                    color: "var(--muted)",
                    cursor: "default",
                    textAlign: "left",
                  }}
                >
                  <Caret open={remotesOpen} />
                  <span
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      fontWeight: 800,
                      textTransform: "uppercase",
                    }}
                  >
                    Remote
                  </span>
                  <span style={{ flex: 1 }} />
                  <Count value={remote.length} />
                </button>
                {remotesOpen &&
                  (filtered.remote.length === 0 ? (
                    <Empty text={filter ? "No matches." : "No remote branches."} />
                  ) : (
                    filtered.remote.map((branch) => (
                      <BranchRow
                        key={`r:${branch.name}`}
                        branch={branch}
                        currentName={currentName}
                        busyId={busy}
                        locked={locked}
                        onSwitch={handleSwitch}
                        onStartRename={() => undefined}
                        onDelete={handleDelete}
                        onMerge={handleMerge}
                      />
                    ))
                  ))}
              </>
            )}
          </div>

          {/* Footer: create branch from current HEAD */}
          <div style={{ borderTop: "1px solid var(--rule)", padding: 6 }}>
            {creating ? (
              <div style={{ padding: "2px 4px", display: "flex" }}>
                <InlineInput
                  initial=""
                  placeholder={currentName ? `New branch from ${currentName}` : "New branch name"}
                  onCommit={handleCreate}
                  onCancel={() => setCreating(false)}
                />
              </div>
            ) : (
              <FooterButton
                disabled={locked}
                onClick={() => {
                  setError(null);
                  setCreating(true);
                }}
              >
                <PlusGlyph />
                <span>Create branch…</span>
              </FooterButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── One branch row ───────────────────────────────────────────────────────────

const BranchRow = React.memo(function BranchRow({
  branch,
  currentName,
  busyId,
  locked,
  onSwitch,
  onStartRename,
  onDelete,
  onMerge,
}: {
  branch: GitBranch;
  currentName: string | undefined;
  busyId: string | null;
  locked: boolean;
  onSwitch: (b: GitBranch) => void;
  onStartRename: (b: GitBranch) => void;
  onDelete: (b: GitBranch, force: boolean) => void;
  onMerge: (b: GitBranch) => void;
}) {
  const [hover, setHover] = useState(false);
  // Delete confirm ladder: idle → armed (click again to delete) → if git
  // refuses an unmerged branch, the row offers an explicit force step.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isCurrent = branch.current;
  const rowBusy =
    busyId === `switch:${branch.name}` ||
    busyId === `delete:${branch.name}` ||
    busyId === `merge:${branch.name}` ||
    busyId === `rename:${branch.name}`;

  const reset = (): void => {
    setHover(false);
    setConfirmDelete(false);
  };

  const short = branch.isRemote ? branch.name.replace(/^[^/]+\//, "") : branch.name;
  const remotePrefix = branch.isRemote ? branch.name.slice(0, branch.name.length - short.length) : "";

  return (
    <div
      onClick={() => {
        if (!locked && !isCurrent) onSwitch(branch);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={reset}
      title={
        isCurrent
          ? `Current branch ${branch.name}`
          : branch.isRemote
            ? `Switch to ${branch.name} (creates a local tracking branch)`
            : `Switch to ${branch.name}`
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minHeight: 24,
        padding: "0 8px 0 12px",
        cursor: "default",
        background: isCurrent
          ? "color-mix(in oklch, var(--accent) 12%, transparent)"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, transparent)"
            : "transparent",
        boxShadow: isCurrent ? "inset 2px 0 0 var(--accent)" : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          width: 14,
          color: isCurrent ? "var(--accent)" : "var(--muted-2)",
        }}
      >
        {isCurrent ? <CheckGlyph /> : <BranchIcon />}
      </span>

      <span style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "baseline", gap: 4, overflow: "hidden" }}>
        {remotePrefix && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted-2)",
              flex: "0 0 auto",
            }}
          >
            {remotePrefix}
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: isCurrent ? 700 : 500,
            color: isCurrent ? "var(--ink)" : "var(--ink-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {short}
        </span>
      </span>

      {/* Ahead / behind badges (local branches with an upstream) */}
      {!hover && <TrackBadges ahead={branch.ahead} behind={branch.behind} />}

      {/* Hover actions — fixed-ish slot so the row doesn't reflow much */}
      <span
        onClick={(e) => e.stopPropagation()}
        style={{ display: "inline-flex", alignItems: "center", gap: 1, flex: "0 0 auto" }}
      >
        {rowBusy ? (
          <span style={{ display: "inline-flex", padding: "0 4px" }}>
            <Spinner size={11} />
          </span>
        ) : hover && !locked ? (
          <>
            {!isCurrent && !branch.isRemote && (
              <IconButton title={`Merge ${branch.name} into ${currentName ?? "current"}`} size={20} onClick={() => onMerge(branch)}>
                <MergeGlyph />
              </IconButton>
            )}
            {isCurrent && (
              <IconButton title="Rename branch" size={20} onClick={() => onStartRename(branch)}>
                <PencilGlyph />
              </IconButton>
            )}
            {!isCurrent && !branch.isRemote && (
              <IconButton
                title={confirmDelete ? "Click again to delete" : "Delete branch"}
                danger
                active={confirmDelete}
                size={20}
                onClick={() => {
                  if (confirmDelete) {
                    onDelete(branch, false);
                    setConfirmDelete(false);
                  } else {
                    setConfirmDelete(true);
                  }
                }}
              >
                <TrashGlyph />
              </IconButton>
            )}
          </>
        ) : null}
      </span>
    </div>
  );
});

// ── Small presentational pieces ───────────────────────────────────────────────

function CurrentTrack({ branch }: { branch?: GitBranch }): React.ReactElement | null {
  if (!branch || (branch.ahead === 0 && branch.behind === 0)) return null;
  return <TrackBadges ahead={branch.ahead} behind={branch.behind} />;
}

function TrackBadges({ ahead, behind }: { ahead: number; behind: number }): React.ReactElement | null {
  if (ahead === 0 && behind === 0) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flex: "0 0 auto",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        color: "var(--muted)",
      }}
    >
      {ahead > 0 && (
        <span title={`${ahead} ahead of upstream`} style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          {ahead}
          <ArrowUp />
        </span>
      )}
      {behind > 0 && (
        <span title={`${behind} behind upstream`} style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          {behind}
          <ArrowDown />
        </span>
      )}
    </span>
  );
}

function GroupLabel({ text, count }: { text: string; count: number }): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 22,
        padding: "0 10px",
        color: "var(--muted)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.1em",
          fontWeight: 800,
          textTransform: "uppercase",
        }}
      >
        {text}
      </span>
      <span style={{ flex: 1 }} />
      <Count value={count} />
    </div>
  );
}

function Count({ value }: { value: number }): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        color: "var(--muted-2)",
      }}
    >
      {String(value).padStart(2, "0")}
    </span>
  );
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div style={{ padding: "5px 12px 7px", color: "var(--muted-2)", fontSize: 11 }}>{text}</div>;
}

function FooterButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const lit = hover && !disabled;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        height: 28,
        padding: "0 8px",
        border: "1px solid var(--rule)",
        borderRadius: 6,
        background: lit ? "var(--accent-soft)" : "transparent",
        color: disabled ? "var(--muted-2)" : "var(--ink-dim)",
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 650,
        opacity: disabled ? 0.6 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function ErrorLine({ text, onDismiss }: { text: string; onDismiss: () => void }): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        margin: "8px 8px 0",
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
        background: "var(--danger-soft)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          lineHeight: 1.5,
          color: "color-mix(in oklch, var(--danger) 80%, var(--ink))",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 84,
          overflow: "auto",
        }}
      >
        {text}
      </span>
      <button
        type="button"
        title="Dismiss"
        onClick={onDismiss}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          border: "none",
          background: "transparent",
          color: "var(--danger)",
          cursor: "default",
          fontSize: 12,
          lineHeight: 1,
          padding: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ── Local icons (14×14, 1.2px stroke, currentColor) ────────────────────────────

function localSvg(children: React.ReactNode, strokeWidth = 1.2): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function Caret({ open }: { open: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform var(--motion-fast) var(--ease-out)",
        color: "var(--muted)",
      }}
    >
      {localSvg(<path d="M3.5 5.5 7 9l3.5-3.5" />, 1.3)}
    </span>
  );
}

function CheckGlyph(): React.ReactElement {
  return localSvg(<path d="M3 7.4 6 10.4 11.2 4" />, 1.5);
}

function PlusGlyph(): React.ReactElement {
  return localSvg(<path d="M7 3.2v7.6M3.2 7h7.6" />, 1.5);
}

function TrashGlyph(): React.ReactElement {
  return localSvg(
    <>
      <path d="M3 4h8" />
      <path d="M5.4 4V2.8h3.2V4" />
      <path d="M4.2 4l.5 7.2h4.6L9.8 4" />
      <path d="M6 6v3.4M8 6v3.4" />
    </>,
  );
}

function PencilGlyph(): React.ReactElement {
  return localSvg(
    <>
      <path d="M9 2.5 11.5 5 5.5 11H3V8.5Z" />
      <path d="M8.2 3.3 10.7 5.8" />
    </>,
  );
}

function MergeGlyph(): React.ReactElement {
  return localSvg(
    <>
      <circle cx="3.5" cy="3.5" r="1.5" />
      <circle cx="3.5" cy="10.5" r="1.5" />
      <circle cx="10.5" cy="10.5" r="1.5" />
      <path d="M3.5 5v4" />
      <path d="M3.5 7.5c0-1.6 1.4-2.4 3.4-2.6 2-.2 3.4-1 3.6-2.4" />
      <path d="M10.5 4.2V9" />
    </>,
  );
}

function ArrowUp(): React.ReactElement {
  return (
    <svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 11V3.6M4 6.6 7 3.6l3 3" />
    </svg>
  );
}

function ArrowDown(): React.ReactElement {
  return (
    <svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3v7.4M4 7.4 7 10.4l3-3" />
    </svg>
  );
}
