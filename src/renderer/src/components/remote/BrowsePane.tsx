import type { RemoteBrowseResult, RemoteConnectionStatus } from "@shared/remote";

// Remote folder browser pane (SFTP listing) shown after a host connects.
// Extracted from the old RemoteConnectDialog; used by SshManagerDialog.
export default function BrowsePane({
  status,
  browse,
  browsing,
  onUp,
  onOpen,
  onBack,
  onChoose,
}: {
  status: RemoteConnectionStatus | null;
  browse: RemoteBrowseResult | null;
  browsing: boolean;
  onUp: () => void;
  onOpen: (path: string) => void;
  onBack: () => void;
  onChoose: () => void;
}) {
  const connecting = status?.state === "connecting" || (browsing && !browse);
  const error = status?.state === "error" ? status.error : browse?.error;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--ink-dim)",
        }}
      >
        <button type="button" className="spark-btn" style={{ padding: "2px 8px" }} onClick={onUp} disabled={!browse?.parent}>
          ↑
        </button>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {browse?.path ?? "…"}
        </span>
      </div>

      <div
        style={{
          border: "1px solid var(--rule)",
          borderRadius: 8,
          background: "var(--panel)",
          minHeight: 220,
          maxHeight: 320,
          overflow: "auto",
        }}
      >
        {connecting && <PaneMsg text="Connecting…" />}
        {!connecting && error && <PaneMsg text={error} danger />}
        {!connecting && !error && browse && browse.entries.length === 0 && <PaneMsg text="Empty folder." />}
        {!connecting &&
          !error &&
          browse?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => entry.isDir && onOpen(entry.path)}
              disabled={!entry.isDir}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "6px 12px",
                border: "none",
                background: "transparent",
                color: entry.isDir ? "var(--ink)" : "var(--muted-2)",
                cursor: entry.isDir ? "pointer" : "default",
                fontSize: 12.5,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span aria-hidden style={{ color: entry.isDir ? "var(--accent-text)" : "var(--muted-2)" }}>
                {entry.isDir ? "▸" : "·"}
              </span>
              {entry.name}
            </button>
          ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button type="button" className="spark-btn" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="spark-btn is-primary"
          onClick={onChoose}
          disabled={!browse || Boolean(error) || connecting}
        >
          Open this folder
        </button>
      </div>
    </div>
  );
}

function PaneMsg({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div style={{ padding: 16, fontSize: 12, color: danger ? "var(--danger)" : "var(--muted)" }}>{text}</div>
  );
}
