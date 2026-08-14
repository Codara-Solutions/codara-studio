import React from "react";

// Class component because hooks can't catch render errors. The whole point
// is to wrap the entire App tree so a crash in any descendant lands here
// instead of producing the all-black "renderer unmounted" state. The
// recovery surface gives the user a way out without command-line.
//
// EVERYTHING here is inline-styled against token fallbacks, deliberately. This
// screen's job is to render when the app could not, and a stylesheet that
// failed to load is one of the ways that happens — a class-based design would
// come up unstyled in exactly the case it exists for. Tokens are still read
// first, so on a normal crash it looks like the rest of the app.
//
// The shape is: say what happened in one line, offer the ways out, and keep
// the stack folded away. A wall of trace is not information the person staring
// at it can act on — but it IS what an agent needs, so the primary action
// copies a complete, formatted report rather than making them select it.

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
}

// Best-effort environment for the bug report. Every read is guarded: this runs
// while the app is in a known-broken state, so nothing here may assume that a
// global it wants still exists.
function collectContext(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    out.when = new Date().toISOString();
  } catch {
    /* ignore */
  }
  try {
    // The Electron UA carries app, Electron and Chrome versions plus the
    // platform — everything an agent would otherwise have to ask for, from one
    // string that needs no IPC.
    out.agent = navigator.userAgent;
  } catch {
    /* ignore */
  }
  try {
    // Basename only. The full pathname is the user's home directory, which
    // this report is explicitly meant to be pasted somewhere else.
    const path = window.location.pathname;
    out.entry = window.location.hash || path.slice(path.lastIndexOf("/") + 1);
  } catch {
    /* ignore */
  }
  return out;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false };
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to renderer console so DevTools captures it. Main process
    // listeners (uncaughtException etc.) won't see this — it's a renderer
    // exception, not a Node one.
    console.error("[error-boundary] caught render error", error, info);
    // The component stack is the single most useful thing for whoever fixes
    // this — it names the subtree that blew up, which a JS stack full of
    // minified framework frames often does not.
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentWillUnmount(): void {
    if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
  }

  // A ready-to-paste bug report. Markdown, because the place this is going is a
  // chat with an agent, and fenced blocks keep the stack from being reflowed
  // into soup.
  private report(): string {
    const { error, componentStack } = this.state;
    const context = collectContext();
    const lines = [
      "Codara Studio crashed while rendering.",
      "",
      `**Error:** ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    ];
    if (context.when) lines.push(`**When:** ${context.when}`);
    if (context.entry) lines.push(`**Entry:** ${context.entry}`);
    if (context.agent) lines.push(`**Environment:** ${context.agent}`);
    if (error?.stack) lines.push("", "**Stack**", "```", error.stack.trim(), "```");
    if (componentStack) {
      lines.push("", "**Component stack**", "```", componentStack.trim(), "```");
    }
    return lines.join("\n");
  }

  private copyReport = (): void => {
    const text = this.report();
    const done = () => {
      this.setState({ copied: true });
      if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
      this.copyResetTimer = setTimeout(() => this.setState({ copied: false }), 2000);
    };
    // The async clipboard can be unavailable or rejected depending on focus
    // state; the textarea path is the one that still works in a broken window.
    try {
      void navigator.clipboard.writeText(text).then(done, () => this.copyFallback(text, done));
    } catch {
      this.copyFallback(text, done);
    }
  };

  private copyFallback(text: string, done: () => void): void {
    try {
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand("copy");
      document.body.removeChild(scratch);
      done();
    } catch {
      /* nothing left to try; the details block is still selectable by hand */
    }
  }

  private clearAndReload = (): void => {
    try {
      window.localStorage.clear();
    } catch {
      /* storage may be unavailable; reload anyway */
    }
    window.location.reload();
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error, componentStack, copied } = this.state;
    if (!error) return this.props.children;

    const summary = `${error.name ?? "Error"}: ${error.message || String(error)}`;
    const trace = [error.stack ?? summary, componentStack ? `\nComponent stack:${componentStack}` : ""]
      .join("")
      .trim();

    return (
      <div
        role="alert"
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--bg, #0b0b0d)",
          color: "var(--ink, #e5e5e5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Generous but scrollable: an expanded stack must not trap the
          // buttons off-screen on a short window.
          padding: 32,
          overflow: "auto",
          fontFamily: "var(--font-sans, system-ui, -apple-system, Segoe UI, sans-serif)",
        }}
      >
        <div
          style={{
            width: "min(640px, 100%)",
            // A card, not a full-bleed wall. The crash is one object on the
            // desk, which reads as "a thing went wrong" rather than "the
            // application is gone".
            background: "var(--panel, #141416)",
            border: "1px solid var(--rule-soft, #2a2a30)",
            borderRadius: "var(--radius-surface, 10px)",
            boxShadow: "var(--lift-hi, 0 24px 60px rgba(0,0,0,0.45))",
            padding: "26px 28px",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--danger, #e06c75)",
              marginBottom: 10,
            }}
          >
            Unexpected error
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 650,
              letterSpacing: "-0.01em",
              color: "var(--ink, #e5e5e5)",
            }}
          >
            Codara Studio stopped drawing this window
          </h1>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--muted, #9ca3af)",
            }}
          >
            Your work is on disk — this is the interface, not your files. Reloading
            usually brings it back. If it keeps happening, copy the report and hand it
            to an agent.
          </p>

          {/* The one line worth reading, in the app's mono voice. The rest of
              the trace is one disclosure away, closed by default. */}
          <div
            style={{
              marginTop: 18,
              padding: "10px 12px",
              background: "var(--panel-2, rgba(255,255,255,0.04))",
              border: "1px solid var(--rule-soft, #2a2a30)",
              borderRadius: "var(--radius-control, 7px)",
              color: "var(--ink-dim, #c3c3c9)",
              fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
              fontSize: 12,
              lineHeight: 1.5,
              wordBreak: "break-word",
              // Three lines is enough to identify the fault; the rest is the
              // details block's job. Clamped rather than cropped, so a long
              // message ends in an ellipsis instead of being silently sliced
              // mid-word.
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 3,
              overflow: "hidden",
            }}
          >
            {summary}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
            <FaultButton onClick={this.copyReport} tone="primary">
              {copied ? "Copied" : "Copy report"}
            </FaultButton>
            <FaultButton onClick={this.reload}>Reload</FaultButton>
            <FaultButton onClick={this.clearAndReload} tone="danger">
              Reset and reload
            </FaultButton>
          </div>

          <details style={{ marginTop: 18 }}>
            <summary
              style={{
                cursor: "default",
                fontSize: 12,
                color: "var(--muted, #9ca3af)",
                listStyle: "revert",
                userSelect: "none",
              }}
            >
              Technical details
            </summary>
            <pre
              style={{
                marginTop: 10,
                marginBottom: 0,
                padding: "14px 16px",
                background: "var(--panel-2, rgba(255,255,255,0.04))",
                border: "1px solid var(--rule-soft, #2a2a30)",
                borderRadius: "var(--radius-control, 7px)",
                // Recessed well so the stack trace reads as inset data, not a
                // floating slab. --well is re-tinted per theme so it never
                // looks sooty. Keep the defensive fallback: this file renders
                // in the case where the stylesheet did not load.
                boxShadow: "var(--well, inset 0 1px 2px rgba(0,0,0,0.22))",
                color: "var(--ink-dim, #9ca3af)",
                fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                fontSize: 11,
                lineHeight: 1.55,
                // Bounded, so a deep stack can't push the recovery buttons out
                // of reach; the block scrolls on its own.
                maxHeight: 260,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                userSelect: "text",
              }}
            >
              {trace}
            </pre>
          </details>

          <div
            style={{
              marginTop: 16,
              fontSize: 11,
              color: "var(--muted-2, #6b7280)",
              lineHeight: 1.5,
            }}
          >
            “Reset and reload” clears this window's saved layout (tabs, panel sizes).
            It never touches your workspaces or files.
          </div>
        </div>
      </div>
    );
  }
}

// Buttons carry their own hover state because this screen cannot rely on the
// stylesheet — see the note at the top of the file.
function FaultButton({
  onClick,
  tone = "neutral",
  children,
}: {
  onClick: () => void;
  tone?: "primary" | "neutral" | "danger";
  children: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  const palette = {
    primary: {
      background: hover
        ? "var(--accent, #4f8cff)"
        : "color-mix(in oklch, var(--accent, #4f8cff) 88%, transparent)",
      border: "1px solid color-mix(in oklch, var(--accent, #4f8cff) 60%, transparent)",
      color: "var(--accent-ink, #14110d)",
    },
    neutral: {
      background: hover ? "var(--hover, rgba(255,255,255,0.06))" : "transparent",
      border: "1px solid var(--rule-strong, #4b5563)",
      color: "var(--ink, #e5e5e5)",
    },
    danger: {
      background: hover
        ? "color-mix(in oklch, var(--danger, #e06c75) 22%, transparent)"
        : "var(--danger-soft, color-mix(in oklch, #e06c75 12%, transparent))",
      border: "1px solid color-mix(in oklch, var(--danger, #e06c75) 45%, var(--rule-strong, #4b5563))",
      color: "var(--ink, #e5e5e5)",
    },
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        borderRadius: "var(--radius-control, 7px)",
        padding: "8px 14px",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: "default",
        transition:
          "background var(--motion-fast, 120ms) var(--ease-out, ease-out), border-color var(--motion-fast, 120ms) var(--ease-out, ease-out)",
        ...palette,
      }}
    >
      {children}
    </button>
  );
}
