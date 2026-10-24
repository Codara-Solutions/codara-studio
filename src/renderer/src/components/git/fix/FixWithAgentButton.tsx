import React, { Suspense, lazy, useCallback, useRef, useState } from "react";
import type { GitFixKind } from "@shared/git-fix";
import { isRemotePath } from "@shared/remote";

// The "Fix with agent" buttons in Source Control. The dialog (what the agent
// receives and where it goes) loads on first click, so the panel itself stays
// as light as it was.

const FixWithAgentDialog = lazy(() => import("./FixWithAgentDialog"));

export interface FixWithAgentButtonProps {
  cwd: string;
  kind: GitFixKind;
  label: string;
  title: string;
  /** "hook" only: what the failed commit printed, and its message. */
  output?: string;
  commitMessage?: string;
  /** Danger tint for buttons that sit in an error strip. */
  tone?: "default" | "danger";
  /**
   * The problem is gone (a refresh shows the checks re-running): the button
   * hides, but a dialog already open stays until the user closes it.
   */
  hidden?: boolean;
}

export default function FixWithAgentButton({
  cwd,
  kind,
  label,
  title,
  output,
  commitMessage,
  tone = "default",
  hidden = false,
}: FixWithAgentButtonProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    // Back to the button that opened it, for keyboard users.
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);
  const accent = tone === "danger" ? "var(--danger)" : "var(--accent-text)";
  // The context is read with local git and gh; remote workspaces come later.
  if (isRemotePath(cwd) || (hidden && !open)) return null;
  return (
    <>
      {hidden ? null : (
        <button
          ref={buttonRef}
          type="button"
          title={title}
          aria-haspopup="dialog"
          data-git-fix={kind}
          onClick={() => setOpen(true)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            appearance: "none",
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 8px",
            borderRadius: 6,
            border: hover
              ? `1px solid color-mix(in oklch, ${accent} 55%, var(--rule-strong))`
              : "1px solid var(--rule-strong)",
            background: hover ? `color-mix(in oklch, ${accent} 12%, transparent)` : "transparent",
            color: hover ? accent : "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            fontSize: 10.5,
            fontWeight: 650,
            cursor: "default",
          }}
        >
          <SparkGlyph />
          {label}
        </button>
      )}
      {open ? (
        <Suspense fallback={null}>
          <FixWithAgentDialog
            cwd={cwd}
            kind={kind}
            output={output}
            commitMessage={commitMessage}
            onClose={close}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function SparkGlyph(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden fill="none">
      <path
        d="M8 1.5l1.6 4.1 4.1 1.6-4.1 1.6L8 12.9 6.4 8.8 2.3 7.2l4.1-1.6L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
