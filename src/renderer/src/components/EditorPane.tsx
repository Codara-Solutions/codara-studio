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
        outline: active ? "1px solid var(--accent)" : "none",
        outlineOffset: -1,
      }}
    >
      <div
        style={{
          height: 36,
          flex: "0 0 36px",
          display: "flex",
          alignItems: "stretch",
          borderBottom: "1px solid var(--rule)",
          background: active ? "var(--panel-2)" : "var(--panel)",
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
            borderRight: "1px solid var(--rule)",
            background: "var(--bg)",
            color: "var(--ink)",
            fontSize: 12,
            fontWeight: 700,
            position: "relative",
          }}
          title={file.path}
        >
          <span
            style={{
              position: "absolute",
              top: -1,
              left: 0,
              right: 0,
              height: 2,
              background: "var(--accent)",
            }}
          />
          <FileIcon ext={file.ext} />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {file.name}
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
            borderLeft: "1px solid var(--rule)",
            color: dirty && !error ? "var(--ink)" : "var(--muted)",
            padding: "0 14px",
            fontFamily: "inherit",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            cursor: "default",
          }}
        >
          {saving ? "SAVING" : "SAVE"}
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
            borderLeft: "1px solid var(--rule)",
            color: "var(--muted)",
            width: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            cursor: "default",
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
          gap: 14,
          padding: "4px 10px",
          borderTop: "1px solid var(--rule)",
          background: "var(--panel)",
          color: "var(--muted)",
          fontSize: 10,
          letterSpacing: "0.04em",
        }}
      >
        <span>{dirty ? "UNSAVED" : "SAVED"}</span>
        <span>{lineCount} lines</span>
        {status && <span>{status}</span>}
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
        borderRight: "1px solid var(--rule)",
        background: "var(--panel)",
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
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
