import React from "react";
import type { GitStatus, ShellInfo, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
  /** Shared git snapshot for the active workspace (App's useSharedGitStatus). */
  gitStatus: GitStatus | null;
  defaultShell: ShellInfo | null;
  platform: string;
  workerCount: number;
}

// The same two-dot-fork branch glyph as Source Control's BranchIcon, drawn
// inline (git-ui's svg() helper hardcodes its own size/stroke) at status-bar
// scale and currentColor so it inherits the segment's ink.
function BranchGlyph(): React.ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: "0 0 auto" }}
    >
      <circle cx="3.5" cy="3" r="1.6" />
      <circle cx="3.5" cy="11" r="1.6" />
      <circle cx="10.5" cy="4.5" r="1.6" />
      <path d="M3.5 4.6v4.8" />
      <path d="M10.5 6.1c0 2.4-2 3.3-4 3.6" />
    </svg>
  );
}

// Memoized: App passes a memoized `workspace`, the shared git snapshot, the
// `defaultShell`/`platform` state values, and a memoized `workerCount`. So the
// status bar only re-renders when one of those genuinely changes — not on
// every App re-render driven by unrelated state (run polls, color drags,
// orchestration events).
function StatusBar({ workspace, gitStatus, defaultShell, platform, workerCount }: Props) {
  // Branch of the active workspace's repo. Detached HEAD shows the short hash
  // (GitStatus.branch already carries it) marked "detached"; a non-repo or
  // still-loading workspace shows no branch segment at all rather than "—".
  const branch = gitStatus?.isRepo ? gitStatus.branch : undefined;
  const branchSuffix =
    gitStatus?.detached && branch
      ? " (detached)"
      : gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0)
        ? ` ${gitStatus.ahead > 0 ? `↑${gitStatus.ahead}` : ""}${gitStatus.behind > 0 ? `↓${gitStatus.behind}` : ""}`
        : "";

  const items: {
    l: string;
    v: string;
    mono: boolean;
    icon?: React.ReactElement;
    title?: string;
  }[] = [
    { l: "WORKSPACE", v: workspace?.name ?? "—", mono: false },
    ...(branch
      ? [
          {
            l: "BRANCH",
            v: `${branch}${branchSuffix}`,
            mono: true,
            icon: <BranchGlyph />,
            title: gitStatus?.upstream
              ? `${branch} — tracking ${gitStatus.upstream}`
              : branch,
          },
        ]
      : []),
    { l: "PATH", v: workspace?.cwd ?? "—", mono: true },
    { l: "SHELL", v: defaultShell?.label ?? "—", mono: true },
    { l: "OS", v: platform || "—", mono: true },
  ];
  const right = [
    { l: "WORKERS", v: String(workerCount).padStart(2, "0") },
  ];
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 24,
        background: "var(--bg)",
        borderTop: "1px solid var(--rule)",
        boxShadow: "var(--lift-hi)",
        display: "flex",
        alignItems: "stretch",
        color: "var(--ink-dim)",
      }}
    >
      <div
        style={{
          width: 6,
          background: workspace?.color || "var(--accent)",
          // Soft inner highlight so the workspace-color chip reads as a
          // deliberate state marker, not a raw stripe. Token-mix keeps the
          // sheen legible on light themes.
          boxShadow: "inset 0 1px 0 color-mix(in oklab, var(--bg) 35%, transparent)",
          flex: "0 0 6px",
        }}
        title={workspace?.name ? `Workspace: ${workspace.name}` : "No workspace"}
      />
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderRight: "1px solid var(--rule-soft)",
            minWidth: 0,
          }}
        >
          {it.icon ?? (
            <span
              style={{
                color: "var(--muted)",
                fontFamily: "var(--font-sans)",
                fontWeight: 600,
                fontSize: 9,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
              }}
            >
              {it.l}
            </span>
          )}
          <span
            style={{
              color: "var(--ink-dim)",
              fontSize: 10,
              fontFamily: it.mono ? "var(--font-mono)" : "inherit",
              fontWeight: it.mono ? 400 : 500,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 360,
            }}
            title={it.title ?? String(it.v)}
          >
            {it.v}
          </span>
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {right.map((it, i) => (
        <div
          key={i}
          style={{
            padding: "0 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderLeft: "1px solid var(--rule-soft)",
          }}
        >
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
              fontSize: 9,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            {it.l}
          </span>
          <span
            style={{
              color: "var(--ink-dim)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {it.v}
          </span>
        </div>
      ))}
    </div>
  );
}

export default React.memo(StatusBar);
