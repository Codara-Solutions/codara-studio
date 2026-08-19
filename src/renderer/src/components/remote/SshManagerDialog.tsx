import { useCallback, useEffect, useState } from "react";
import type {
  RemoteBrowseResult,
  RemoteConnectionStatus,
  RemoteHostConfig,
} from "@shared/remote";
import { isValidHostId } from "@shared/remote";
import type { SshKeyInfo } from "@shared/ssh-keys";
import BrowsePane from "./BrowsePane";
import SshKeysTab from "./SshKeysTab";

interface Props {
  onClose: () => void;
  // Called with the chosen host + absolute POSIX path when the user picks a
  // remote folder. App turns this into an ssh:// workspace.
  onPick: (host: RemoteHostConfig, remotePath: string) => void;
}

// SSH manager: Servers tab (host registry + connect/browse to open an ssh://
// workspace) and Keys tab. Replaces the old RemoteConnectDialog. Auth happens
// through the global RemoteAuthPrompt (main broadcasts prompts during connect).
export default function SshManagerDialog({ onClose, onPick }: Props) {
  const [tab, setTab] = useState<"servers" | "keys">("servers");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="SSH manager"
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
          width: 640,
          maxWidth: "94vw",
          height: "min(560px, 84vh)",
          padding: 20,
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="spark-eyebrow" style={{ color: "var(--accent-text)" }}>
            SSH
          </span>
          <TabButton label="Servers" active={tab === "servers"} onClick={() => setTab("servers")} />
          <TabButton label="Keys" active={tab === "keys"} onClick={() => setTab("keys")} />
          <span style={{ flex: 1 }} />
          <button type="button" className="spark-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {tab === "servers" ? <ServersTab onPick={onPick} /> : <SshKeysTab />}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={active ? "spark-btn is-primary" : "spark-btn"}
      style={{ fontSize: 12, padding: "3px 12px" }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

type Stage = "list" | "browse";

function ServersTab({ onPick }: { onPick: (host: RemoteHostConfig, remotePath: string) => void }) {
  const [stage, setStage] = useState<Stage>("list");
  const [hosts, setHosts] = useState<RemoteHostConfig[]>([]);
  // null = form closed; { initial: undefined } = adding; { initial: host } = editing.
  const [form, setForm] = useState<{ initial?: RemoteHostConfig } | null>(null);
  const [activeHost, setActiveHost] = useState<RemoteHostConfig | null>(null);
  const [status, setStatus] = useState<RemoteConnectionStatus | null>(null);
  const [browse, setBrowse] = useState<RemoteBrowseResult | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Per-host "Test" results, keyed by host id. Only hosts the user tested get
  // an entry; live status broadcasts keep existing entries fresh.
  const [testStatus, setTestStatus] = useState<Record<string, RemoteConnectionStatus>>({});

  const refreshHosts = useCallback(() => {
    void window.spark.remote.listHosts().then(setHosts);
  }, []);
  useEffect(refreshHosts, [refreshHosts]);
  useEffect(() => window.spark.remote.onStatus((s) => {
    setTestStatus((prev) => (prev[s.hostId] ? { ...prev, [s.hostId]: s } : prev));
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

  const testConnection = useCallback(async (host: RemoteHostConfig) => {
    setTestStatus((prev) => ({ ...prev, [host.id]: { hostId: host.id, state: "connecting" } }));
    const st = await window.spark.remote.connect(host.id);
    setTestStatus((prev) => ({ ...prev, [host.id]: st }));
  }, []);

  if (stage === "browse") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1 }}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>Pick a folder on {activeHost?.id}</span>
        <BrowsePane
          status={status}
          browse={browse}
          browsing={browsing}
          onUp={() => browse?.parent != null && void navigate(browse.parent)}
          onOpen={(path) => void navigate(path)}
          onBack={() => {
            setStage("list");
            setBrowse(null);
          }}
          onChoose={() => {
            if (activeHost && browse) onPick(activeHost, browse.path);
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1 }}>
      <div style={{ overflow: "auto", display: "grid", gap: 6, minHeight: 0 }}>
        {hosts.length === 0 && !form && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 2px" }}>
            No SSH hosts yet. Add one below, or entries from ~/.ssh/config appear here automatically.
          </div>
        )}
        {hosts.map((host) => {
          const test = testStatus[host.id];
          return (
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
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{host.id}</span>
                  {host.source === "ssh-config" && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 999,
                        border: "1px solid var(--rule)",
                        color: "var(--muted)",
                      }}
                    >
                      ssh config
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                  {host.username}@{host.host}:{host.port}
                </div>
                {test?.state === "connecting" && (
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>connecting…</div>
                )}
                {test?.state === "connected" && (
                  <div style={{ fontSize: 11, color: "var(--ok)" }}>✓ connected</div>
                )}
                {test?.state === "error" && (
                  <div style={{ fontSize: 11, color: "var(--danger)" }}>{test.error}</div>
                )}
              </div>
              <button
                type="button"
                className="spark-btn"
                style={{ fontSize: 11, padding: "3px 8px" }}
                onClick={() => void testConnection(host)}
              >
                Test
              </button>
              {host.source === "manual" && (
                <button
                  type="button"
                  className="spark-btn"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  onClick={() => setForm({ initial: host })}
                >
                  Edit
                </button>
              )}
              {host.source === "manual" && (
                <button
                  type="button"
                  className="spark-btn"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  onClick={() => void window.spark.remote.deleteHost(host.id).then(setHosts)}
                >
                  Remove
                </button>
              )}
              <button
                type="button"
                className="spark-btn is-primary"
                style={{ fontSize: 11, padding: "3px 10px" }}
                onClick={() => void connectAndBrowse(host, null)}
              >
                Open as workspace…
              </button>
            </div>
          );
        })}
      </div>
      {form ? (
        <HostForm
          // Keyed by edit target: field state lives in mount-time useState
          // initializers, so switching Edit targets (or Edit ↔ Add) must
          // remount the form rather than show the previous host's values.
          key={form.initial?.id ?? "__new__"}
          initial={form.initial}
          existingIds={hosts.map((h) => h.id)}
          onCancel={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            refreshHosts();
          }}
        />
      ) : (
        <button
          type="button"
          className="spark-btn"
          onClick={() => setForm({})}
          style={{ alignSelf: "flex-start" }}
        >
          + Add host
        </button>
      )}
    </div>
  );
}

function HostForm({
  initial,
  existingIds,
  onCancel,
  onSaved,
}: {
  /** When set, edit mode: the id is identity — Name is disabled. */
  initial?: RemoteHostConfig;
  existingIds: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [port, setPort] = useState(initial ? String(initial.port) : "22");
  const [identityFile, setIdentityFile] = useState(initial?.identityFile ?? "");
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKeyInfo[] | null>(null);
  const [keyPickerOpen, setKeyPickerOpen] = useState(false);

  const save = async () => {
    const trimmedId = id.trim();
    if (!isValidHostId(trimmedId)) {
      setError("Name may only contain letters, numbers, dot, dash, underscore.");
      return;
    }
    if (!initial && existingIds.includes(trimmedId)) {
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

  const openKeyPicker = () => {
    if (keys === null) void window.spark.sshKeys.list().then(setKeys);
    setKeyPickerOpen((open) => !open);
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
        {field(
          "Name",
          <input
            className="spark-input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="vps1"
            disabled={Boolean(initial)}
          />,
        )}
        {field("Port", <input className="spark-input" value={port} onChange={(e) => setPort(e.target.value)} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
        {field("Host", <input className="spark-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.7" />)}
        {field("User", <input className="spark-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />)}
      </div>
      {field(
        "Private key (optional)",
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="spark-input"
            style={{ flex: 1, minWidth: 0 }}
            value={identityFile}
            onChange={(e) => setIdentityFile(e.target.value)}
            placeholder="~/.ssh/id_ed25519 — leave blank to use defaults or a password"
          />
          <button type="button" className="spark-btn" onClick={openKeyPicker}>
            Choose…
          </button>
        </div>,
      )}
      {keyPickerOpen && (
        // The select only writes into the free-text input above, which stays
        // the source of truth for identityFile.
        <select
          className="spark-input"
          value={keys?.some((k) => k.privateKeyPath === identityFile) ? identityFile : ""}
          onChange={(e) => {
            if (e.target.value) setIdentityFile(e.target.value);
          }}
        >
          <option value="">Custom path…</option>
          {(keys ?? [])
            .filter((k) => k.hasPrivateKey)
            .map((k) => (
              <option key={k.privateKeyPath} value={k.privateKeyPath}>
                {k.privateKeyPath}
              </option>
            ))}
        </select>
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
