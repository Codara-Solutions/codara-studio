import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { FsEntry } from "@shared/types";

interface Props {
  file: FsEntry;
  onDirtyChange?: (path: string, dirty: boolean) => void;
}

export default function EditorPane({ file, onDirtyChange }: Props) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = content !== savedContent;

  useEffect(() => {
    onDirtyChange?.(file.path, dirty);
  }, [dirty, file.path, onDirtyChange]);

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
        setStatus(formatBytes(result.size));
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

  return (
    <div
      style={{
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        flex: 1,
      }}
    >
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
          <EditorMessage text="Loading file…" />
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
                padding: "8px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: 1.5,
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
          flex: "0 0 22px",
          height: 22,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 12px",
          background: "var(--panel)",
          color: "var(--muted)",
          fontSize: 11,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
        {status && (
          <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {status}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {saving && <span>Saving…</span>}
        {dirty && !saving && <span>Modified</span>}
      </div>
    </div>
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
        padding: "8px 10px 8px 12px",
        minWidth: 48,
        maxWidth: 72,
        overflow: "hidden",
        background: "transparent",
        color: "var(--muted-2)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1.5,
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
