import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { FsEntry } from "@shared/types";
import { CloseIcon, FileIcon } from "./icons";

interface Props {
  file: FsEntry;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

export default function EditorPane({ file, active, onActivate, onClose }: Props) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = content !== savedContent;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSaving(false);
    setError(null);
    setStatus(null);
    setContent("");
    setSavedContent("");

    (async () => {
      try {
        const result = await window.spark.fs.readText(file.path);
        if (cancelled) return;
        setContent(result.content);
        setSavedContent(result.content);
        setStatus(`${formatBytes(result.size)} loaded`);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.path]);

  const save = useCallback(async () => {
    if (saving || loading || error) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await window.spark.fs.writeText(file.path, content);
      setContent(result.content);
      setSavedContent(result.content);
      setStatus(`${formatBytes(result.size)} saved`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [content, error, file.path, loading, saving]);

  const lineCount = useMemo(() => Math.max(1, content.split("\n").length), [content]);

  // Split file name into base + extension so we can render the extension in mono
  // while the human-readable base sits in sans, matching the hybrid type rule.
  const dotIdx = file.name.lastIndexOf(".");
  const nameBase = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name;
  const nameExt = dotIdx > 0 ? file.name.slice(dotIdx) : "";

  return (
    <section
      onMouseDown={onActivate}
      style={{
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        border: active ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        boxShadow: active ? "0 0 0 1px var(--accent-edge)" : "none",
        transition: "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <div
        style={{
          height: 36,
          flex: "0 0 36px",
          display: "flex",
          alignItems: "stretch",
          borderBottom: "1px solid var(--rule-soft)",
          background: active ? "var(--panel-2)" : "var(--panel)",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        <div
          style={{
            minWidth: 0,
            maxWidth: "70%",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            borderRight: "1px solid var(--rule-soft)",
            background: "var(--bg)",
            color: "var(--ink)",
            fontSize: 12,
            position: "relative",
          }}
          title={file.path}
        >
          {active && (
            <span
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 1.5,
                background: "var(--accent)",
                boxShadow: "0 0 12px var(--accent-glow)",
              }}
            />
          )}
          <FileIcon ext={file.ext} />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
            }}
          >
            {nameBase}
            {nameExt && (
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 400, color: "var(--ink-dim)" }}>
                {nameExt}
              </span>
            )}
          </span>
          {dirty && <span style={{ color: "var(--accent)" }}>*</span>}
        </div>

        <div style={{ flex: 1 }} />

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void save();
          }}
          disabled={!dirty || saving || loading || Boolean(error)}
          title="Save"
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            borderLeft: "1px solid var(--rule-soft)",
            color: dirty && !error ? "var(--ink)" : "var(--muted)",
            padding: "0 14px",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "default",
            transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            if (dirty && !error) e.currentTarget.style.background = "var(--hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {saving ? "Saving" : "Save"}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close editor"
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            borderLeft: "1px solid var(--rule-soft)",
            color: "var(--muted)",
            width: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            cursor: "default",
            transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--hover)";
            e.currentTarget.style.color = "var(--ink-dim)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--muted)";
          }}
        >
          <CloseIcon />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          position: "relative",
          background: "var(--bg)",
        }}
      >
        {loading ? (
          <EditorMessage text="Loading file..." />
        ) : error ? (
          <EditorMessage text={error} danger />
        ) : (
          <>
            <LineGutter count={lineCount} />
            <textarea
              value={content}
              spellCheck={false}
              onChange={(e) => setContent(e.currentTarget.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                resize: "none",
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--ink)",
                padding: "12px 14px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre",
                overflow: "auto",
                tabSize: 2,
              }}
            />
          </>
        )}
      </div>

      <div
        style={{
          flex: "0 0 auto",
          minHeight: 26,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "4px 12px",
          borderTop: "1px solid var(--rule-soft)",
          background: "var(--panel)",
          color: "var(--muted)",
          fontSize: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: dirty ? "var(--accent)" : "var(--muted)",
          }}
        >
          {dirty ? "UNSAVED" : "SAVED"}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          {lineCount} lines
        </span>
        {status && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            {status}
          </span>
        )}
      </div>
    </section>
  );
}

function LineGutter({ count }: { count: number }) {
  const labels = useMemo(
    () => Array.from({ length: count }, (_, i) => i + 1).join("\n"),
    [count],
  );
  return (
    <pre
      aria-hidden="true"
      style={{
        margin: 0,
        padding: "12px 8px 12px 12px",
        minWidth: 46,
        maxWidth: 68,
        overflow: "hidden",
        borderRight: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1.55,
        textAlign: "right",
        userSelect: "none",
      }}
    >
      {labels}
    </pre>
  );
}

function EditorMessage({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: danger ? "var(--danger)" : "var(--muted)",
        fontSize: 12,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
