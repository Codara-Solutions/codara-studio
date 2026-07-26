import { useEffect, useRef, useState } from "react";
import type { RemoteAuthPromptRequest } from "@shared/remote";

// Global listener for main-process SSH auth prompts. Mounted once near the
// App root; main broadcasts remote:authPrompt when a connection needs a
// password or key passphrase, and this renders a modal that sends the answer
// back. One prompt at a time (connections serialize their own auth), so a
// single-slot queue is enough.
export default function RemoteAuthPrompt() {
  const [request, setRequest] = useState<RemoteAuthPromptRequest | null>(null);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return window.spark.remote.onAuthPrompt((req) => {
      setRequest(req);
      setValue("");
      setRemember(false);
    });
  }, []);

  useEffect(() => {
    if (request) inputRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const submit = (cancelled: boolean) => {
    window.spark.remote.answerAuthPrompt({
      requestId: request.requestId,
      value: cancelled ? null : value,
      remember: !cancelled && remember,
    });
    setRequest(null);
    setValue("");
    setRemember(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="SSH authentication"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // No backdrop-filter here, see RemoteConnectDialog: this is the
        // glass form's PARENT, so filtering it makes it a backdrop root and
        // the form frosts an empty interior. Sibling scrim instead.
        background: "transparent",
      }}
      onClick={() => submit(true)}
    >
      <div className="spark-scrim" style={{ position: "absolute", inset: 0, zIndex: 0 }} />
      <form
        className="spark-glass"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
        style={{
          position: "relative",
          zIndex: 1,
          width: 380,
          maxWidth: "90vw",
          padding: 20,
          borderRadius: 12,
          display: "grid",
          gap: 12,
        }}
      >
        <div className="spark-eyebrow" style={{ color: "var(--accent)" }}>
          SSH · {request.hostId}
        </div>
        <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>{request.message}</div>
        <input
          ref={inputRef}
          className="spark-input"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={request.kind === "passphrase" ? "Key passphrase" : "Password"}
          style={{ width: "100%", boxSizing: "border-box" }}
        />
        {request.canRemember && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-dim)" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this computer (encrypted)
          </label>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button type="button" className="spark-btn" onClick={() => submit(true)}>
            Cancel
          </button>
          <button type="submit" className="spark-btn is-primary">
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
