import React from "react";

// Class component because hooks can't catch render errors. The whole point
// is to wrap the entire App tree so a crash in any descendant lands here
// instead of producing the all-black "renderer unmounted" state. The
// recovery surface gives the user a way out without command-line.

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to renderer console so DevTools captures it. Main process
    // listeners (uncaughtException etc.) won't see this — it's a renderer
    // exception, not a Node one.
    console.error("[error-boundary] caught render error", error, info);
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
    if (!this.state.error) return this.props.children;

    const detail = this.state.error.stack ?? this.state.error.message ?? String(this.state.error);

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--bg, #0b0b0d)",
          color: "var(--ink, #e5e5e5)",
          display: "flex",
          flexDirection: "column",
          padding: "48px 56px",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          overflow: "auto",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: "#e06c75" }}>
          Something broke during render
        </div>
        <div style={{ fontSize: 13, color: "var(--muted, #9ca3af)", marginTop: 6, maxWidth: 720, lineHeight: 1.55 }}>
          The renderer caught an exception before the UI could mount. The most common cause is corrupt persisted tab/workspace state. Use the buttons below to recover. The error is also in DevTools (Ctrl+Shift+I → Console).
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
          <button
            type="button"
            onClick={this.reload}
            style={{
              appearance: "none",
              background: "transparent",
              border: "1px solid var(--rule-strong, #4b5563)",
              borderRadius: 6,
              color: "var(--ink, #e5e5e5)",
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "default",
            }}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={this.clearAndReload}
            style={{
              appearance: "none",
              background: "color-mix(in oklch, #e06c75 14%, transparent)",
              border: "1px solid color-mix(in oklch, #e06c75 50%, var(--rule-strong, #4b5563))",
              borderRadius: 6,
              color: "var(--ink, #e5e5e5)",
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "default",
            }}
          >
            Clear state and reload
          </button>
        </div>

        <pre
          style={{
            marginTop: 28,
            padding: "16px 18px",
            background: "color-mix(in oklch, #ffffff 4%, transparent)",
            border: "1px solid var(--rule-soft, #2a2a30)",
            borderRadius: 8,
            color: "var(--ink-dim, #9ca3af)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11,
            lineHeight: 1.55,
            overflow: "auto",
            maxWidth: "100%",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {detail}
        </pre>
      </div>
    );
  }
}
