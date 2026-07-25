import { useCallback, useEffect, useState } from "react";
import type {
  RemoteBrowseResult,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";
import { isValidHostId, makeRemotePath } from "@shared/remote";

interface Props {
  onClose: () => void;
  // Called with the chosen host + absolute POSIX path when the user picks a
  // remote folder. App turns this into an ssh:// workspace.
  onPick: (host: RemoteHostConfig, remotePath: string) => void;
}

type Stage = "hosts" | "browse";

// Modal for "Add remote workspace": pick (or add) an SSH host, connect, then
// browse the host's filesystem over SFTP and choose a folder. Auth happens
// through the global RemoteAuthPrompt (main broadcasts prompts during connect).
export default function RemoteConnectDialog({ onClose, onPick }: Props) {
  const [stage, setStage] = useState<Stage>("hosts");
  const [hosts, setHosts] = useState<RemoteHostConfig[]>([]);
  const [adding, setAdding] = useState(false);
  const [activeHost, setActiveHost] = useState<RemoteHostConfig | null>(null);
  const [status, setStatus] = useState<RemoteConnectionStatus | null>(null);
  const [browse, setBrowse] = useState<RemoteBrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const refreshHosts = useCallback(() => {
    void window.spark.remote.listHosts().then(setHosts);
  }, []);
  useEffect(refreshHosts, [refreshHosts]);
  useEffect(() => window.spark.remote.onStatus((s) => {
    setStatus((prev) => (prev && prev.hostId === s.hostId ? s : s.hostId === activeHost?.id ? s : prev));
  }), [activeHost]);

  const connectAndBrowse = useCallback(async (host: RemoteHostConfig, path: string | null) => {
    setActiveHost(host);
    setStage("browse");
    setBrowsing(true);
    setStatus({ hostId: host.id, state: "connecting" });
    const st = await window.spark.remote.connect(host.id);
    setStatus(st);
    if (st.state !== "connected") {
      setBrowsing(false);
      return;
    }
    const result = await window.spark.remote.browse(host.id, path);
    setBrowse(result);
    setBrowsing(false);
  }, []);

  const navigate = useCallback(
    async (path: string) => {
      if (!activeHost) return;
      setBrowsing(true);
      const result = await window.spark.remote.browse(activeHost.id, path);
      setBrowse(result);
      setBrowsing(false);
    },
    [activeHost],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add remote workspace"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 350,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // NO backdrop-filter on this overlay. It is the dialog's PARENT, and a
        // backdrop-filter ancestor becomes a backdrop root, the glass dialog
        // inside would then frost this overlay's own empty interior instead of
        // the workbench, painting flat. The blur belongs on a sibling scrim
        // (the `.spark-scrim` element below), which is what every other dialog
        // in the app does.
        background: "transparent",
      }}
    >
      <div className="spark-scrim" style={{ position: "absolute", inset: 0, zIndex: 0 }} />
      <div
        className="spark-glass"
        onClick={(e) => e.stopPropagation()}
        style={{
          // Above the sibling scrim, which is the only other positioned child.
          position: "relative",
          zIndex: 1,
          width: 520,
          maxWidth: "92vw",
          maxHeight: "80vh",
          padding: 20,
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="spark-eyebrow" style={{ color: "var(--accent)" }}>
            Remote workspace
          </span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {stage === "hosts" ? "Choose an SSH host" : `Pick a folder on ${activeHost?.id}`}
          </span>
        </div>

        {stage === "hosts" && (
          <HostList
            hosts={hosts}
            adding={adding}
            onAdd={() => setAdding(true)}
            onCancelAdd={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              refreshHosts();
            }}
            onDelete={(id) => void window.spark.remote.deleteHost(id).then(setHosts)}
            onConnect={(host) => void connectAndBrowse(host, null)}
          />
        )}

        {stage === "browse" && (
          <BrowsePane
            status={status}
            browse={browse}
            browsing={browsing}
            onUp={() => browse?.parent != null && void navigate(browse.parent)}
            onOpen={(path) => void navigate(path)}
            onBack={() => {
              setStage("hosts");
              setBrowse(null);
            }}
            onChoose={() => {
              if (activeHost && browse) onPick(activeHost, browse.path);
            }}
          />
        )}
      </div>
    </div>
  );
}

function HostList({
  hosts,
  adding,
  onAdd,
  onCancelAdd,
  onSaved,
  onDelete,
  onConnect,
}: {
  hosts: RemoteHostConfig[];
  adding: boolean;
  onAdd: () => void;
  onCancelAdd: () => void;
  onSaved: () => void;
  onDelete: (id: string) => void;
  onConnect: (host: RemoteHostConfig) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
      <div style={{ overflow: "auto", display: "grid", gap: 6, minHeight: 0 }}>
        {hosts.length === 0 && !adding && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 2px" }}>
            No SSH hosts found in ~/.ssh/config. Add one below.
          </div>
        )}
        {hosts.map((host) => (
          <div
            key={host.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--rule)",
              background: "var(--panel)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{host.id}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                {host.username}@{host.host}:{host.port}
                {host.source === "ssh-config" ? " · ssh config" : ""}
              </div>
            </div>
            {host.source === "manual" && (
              <button
                type="button"
                className="spark-btn"
                style={{ fontSize: 11, padding: "3px 8px" }}
                onClick={() => onDelete(host.id)}
              >
                Remove
              </button>
            )}
            <button
              type="button"
              className="spark-btn is-primary"
              style={{ fontSize: 11, padding: "3px 10px" }}
              onClick={() => onConnect(host)}
            >
              Connect
            </button>
          </div>
        ))}
      </div>
      {adding ? (
        <AddHostForm onCancel={onCancelAdd} onSaved={onSaved} existingIds={hosts.map((h) => h.id)} />
      ) : (
        <button type="button" className="spark-btn" onClick={onAdd} style={{ alignSelf: "flex-start" }}>
          + Add host
        </button>
      )}
    </div>
  );
}

function AddHostForm({
  onCancel,
  onSaved,
  existingIds,
}: {
  onCancel: () => void;
  onSaved: () => void;
  existingIds: string[];
}) {
  const [id, setId] = useState("");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("22");
  const [identityFile, setIdentityFile] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmedId = id.trim();
    if (!isValidHostId(trimmedId)) {
      setError("Name may only contain letters, numbers, dot, dash, underscore.");
      return;
    }
    if (existingIds.includes(trimmedId)) {
      setError("A host with that name already exists.");
      return;
    }
    if (!host.trim() || !username.trim()) {
      setError("Host and username are required.");
      return;
    }
    await window.spark.remote.saveHost({
      id: trimmedId,
      host: host.trim(),
      username: username.trim(),
      port: Number(port) || 22,
      identityFile: identityFile.trim() || undefined,
      source: "manual",
    });
    onSaved();
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: "grid", gap: 3 }}>
      <span style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}>
        {label}
      </span>
      {node}
    </label>
  );

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--rule)",
        background: "var(--panel)",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {field("Name", <input className="spark-input" value={id} onChange={(e) => setId(e.target.value)} placeholder="vps1" />)}
        {field("Port", <input className="spark-input" value={port} onChange={(e) => setPort(e.target.value)} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
        {field("Host", <input className="spark-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.7" />)}
        {field("User", <input className="spark-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />)}
      </div>
      {field(
        "Private key (optional)",
        <input
          className="spark-input"
          value={identityFile}
          onChange={(e) => setIdentityFile(e.target.value)}
          placeholder="~/.ssh/id_ed25519 — leave blank to use defaults or a password"
        />,
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 11 }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="spark-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="spark-btn is-primary" onClick={() => void save()}>
          Save host
        </button>
      </div>
    </div>
  );
}

function BrowsePane({
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
              <span aria-hidden style={{ color: entry.isDir ? "var(--accent)" : "var(--muted-2)" }}>
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
