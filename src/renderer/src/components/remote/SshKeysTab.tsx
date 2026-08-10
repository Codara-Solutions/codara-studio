import { useCallback, useEffect, useRef, useState } from "react";
import type { SshKeyInfo } from "@shared/ssh-keys";

// Electron wraps errors thrown in ipcMain handlers with a noisy prefix; strip
// it so the user sees the handler's actual message.
function ipcErrorText(err: unknown): string {
  return String(err)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^Error:\s*/, "");
}

// Keys tab of the SSH manager: lists ~/.ssh keys, generates/imports/deletes
// keys, and walks the user through installing a public key on a server or
// provider.
export default function SshKeysTab() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Amber styling for import warnings, plain for informational notices.
  const [noticeIsWarning, setNoticeIsWarning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [helperFor, setHelperFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(() => {
    void window.spark.sshKeys.list().then(setKeys).catch((e) => setError(ipcErrorText(e)));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyPublicKey = (key: SshKeyInfo) => {
    if (key.publicKey == null) return;
    void navigator.clipboard.writeText(key.publicKey);
    setCopiedFor(key.name);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedFor(null), 1500);
  };

  const importKey = async () => {
    setError(null);
    const p = await window.spark.dialog.openSshKey();
    if (!p) return;
    setBusy(true);
    try {
      const result = await window.spark.sshKeys.import(p);
      refresh();
      if (result.warning) {
        setNotice(result.warning);
        setNoticeIsWarning(true);
      } else {
        setNotice(`Imported ${result.key.name}.`);
        setNoticeIsWarning(false);
      }
    } catch (e) {
      setError(ipcErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (name: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await window.spark.sshKeys.delete(name);
      setHelperFor((cur) => (cur === name ? null : cur));
      refresh();
    } catch (e) {
      setError(ipcErrorText(e));
    } finally {
      // Clear the strip on failure too so the user isn't stuck in confirm mode.
      setConfirmDelete(null);
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1 }}>
      <div style={{ overflow: "auto", display: "grid", gap: 6, minHeight: 0 }}>
        {keys.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 2px" }}>
            No SSH keys in ~/.ssh yet. Generate one below, or import an existing key file.
          </div>
        )}
        {keys.map((key) => (
          <div key={key.name} style={{ display: "grid", gap: 6 }}>
            {confirmDelete === key.name ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--danger)",
                  background: "var(--danger-soft)",
                }}
              >
                <div style={{ flex: 1, fontSize: 12, color: "var(--ink)" }}>
                  Delete <b>{key.name}</b> and its public key? Servers that trust this key will stop
                  accepting logins with it — make sure you have another way in. This cannot be undone.
                </div>
                <button type="button" className="spark-btn" disabled={busy} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="spark-btn"
                  style={{ color: "var(--danger)" }}
                  disabled={busy}
                  onClick={() => void doDelete(key.name)}
                >
                  Delete key
                </button>
              </div>
            ) : (
              <div
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
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{key.name}</span>
                    {!key.hasPrivateKey && <WarningChip label="no private key" />}
                    {key.publicKey == null && <WarningChip label="no public key" />}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {[key.type, key.fingerprint].filter(Boolean).join("  ") || "—"}
                  </div>
                </div>
                <button
                  type="button"
                  className="spark-btn"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  disabled={key.publicKey == null}
                  onClick={() => copyPublicKey(key)}
                >
                  {copiedFor === key.name ? "Copied ✓" : "Copy public key"}
                </button>
                <button
                  type="button"
                  className="spark-btn"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  disabled={key.publicKey == null}
                  onClick={() => setHelperFor((cur) => (cur === key.name ? null : key.name))}
                >
                  Setup…
                </button>
                <button
                  type="button"
                  className="spark-btn"
                  style={{ fontSize: 11, padding: "3px 8px", color: "var(--danger)" }}
                  disabled={busy}
                  onClick={() => setConfirmDelete(key.name)}
                >
                  Delete
                </button>
              </div>
            )}
            {helperFor === key.name && key.publicKey != null && <SetupHelper keyInfo={key} />}
          </div>
        ))}
      </div>
      {error && <div style={{ color: "var(--danger)", fontSize: 11 }}>{error}</div>}
      {notice && (
        <div style={{ color: noticeIsWarning ? "var(--warn, var(--muted))" : "var(--muted)", fontSize: 11 }}>
          {notice}
        </div>
      )}
      {generating ? (
        <GenerateForm
          existingNames={keys.map((k) => k.name)}
          onCancel={() => setGenerating(false)}
          onCreated={() => {
            setGenerating(false);
            refresh();
            setNotice("Key created. Use Setup… to install it on a server.");
            setNoticeIsWarning(false);
          }}
        />
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="spark-btn"
            disabled={busy}
            onClick={() => {
              setError(null);
              setNotice(null);
              setGenerating(true);
            }}
          >
            Generate key
          </button>
          <button type="button" className="spark-btn" disabled={busy} onClick={() => void importKey()}>
            Import key…
          </button>
        </div>
      )}
    </div>
  );
}

function WarningChip({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 999,
        border: "1px solid var(--warn, var(--rule))",
        color: "var(--warn, var(--muted))",
      }}
    >
      {label}
    </span>
  );
}

// POSIX-safe single-quoting: the public key's comment field is free text (and
// may come from an imported third-party key), so a bare '${…}' would let a
// single quote break out of the echo command.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function SetupHelper({ keyInfo }: { keyInfo: SshKeyInfo }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--rule)",
        background: "var(--panel)",
        display: "grid",
        gap: 8,
        fontSize: 12,
      }}
    >
      <div style={{ color: "var(--ink)" }}>
        Your <b>public</b> key is safe to share — paste it wherever the server or provider asks for an SSH key:
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", display: "grid", gap: 4 }}>
        <li>
          <b>DigitalOcean:</b> Settings → Security → “Add SSH Key” → paste, then pick it when creating a droplet.
        </li>
        <li>
          <b>GitHub:</b> Settings → SSH and GPG keys → “New SSH key” → paste.
        </li>
        <li>
          <b>Any server you can already reach:</b> run the command below on it (adds the key to that user’s
          authorized keys):
        </li>
      </ul>
      <CopyableCode text={`echo ${shQuote(keyInfo.publicKey ?? "")} >> ~/.ssh/authorized_keys`} />
      <div style={{ color: "var(--muted-2)", fontSize: 11 }}>
        Never share the private half ({keyInfo.name}) — it stays on this machine.
      </div>
    </div>
  );
}

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          padding: "6px 8px",
          borderRadius: 6,
          border: "1px solid var(--rule)",
          background: "var(--bg)",
          color: "var(--ink)",
        }}
      >
        {text}
      </code>
      <button
        type="button"
        className="spark-btn"
        style={{ fontSize: 11, padding: "3px 8px", flexShrink: 0 }}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

function GenerateForm({
  existingNames,
  onCancel,
  onCreated,
}: {
  existingNames: string[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState(existingNames.includes("id_ed25519") ? "id_ed25519_codara" : "id_ed25519");
  const [passphrase, setPassphrase] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await window.spark.sshKeys.generate({
        name: name.trim(),
        passphrase: passphrase || undefined,
        comment: comment || undefined,
      });
      onCreated();
    } catch (e) {
      setError(ipcErrorText(e));
      setBusy(false);
    }
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
      {field(
        "Name",
        <input className="spark-input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />,
      )}
      {field(
        "Passphrase",
        <div style={{ display: "grid", gap: 3 }}>
          <input
            className="spark-input"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
          />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            Optional — protects the key file; you'll be asked for it when connecting
          </span>
        </div>,
      )}
      {field(
        "Comment",
        <input
          className="spark-input"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={busy}
        />,
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 11 }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="spark-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="spark-btn is-primary"
          disabled={busy || !name.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Generating…" : "Generate"}
        </button>
      </div>
    </div>
  );
}
