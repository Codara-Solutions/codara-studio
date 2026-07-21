import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { PreviewKind } from "./previewKind";
import { pathToFileUrl } from "../../lib/pathToFileUrl";
import { isRemotePath } from "@shared/remote";

// Heavy pdf.js / docx-preview chunks stay out of the eager bundle — same
// pattern as the lazy mermaid renderer in markdown-preview/MermaidBlock.tsx.
const PdfPreview = lazy(() => import("./PdfPreview"));
const DocxPreview = lazy(() => import("./DocxPreview"));

interface Props {
  path: string;
  kind: PreviewKind;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Subtle checkerboard so transparent images/SVGs read against something.
const CHECKER_BG: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, color-mix(in oklab, var(--ink) 5%, transparent) 25%, transparent 25%)," +
    "linear-gradient(-45deg, color-mix(in oklab, var(--ink) 5%, transparent) 25%, transparent 25%)," +
    "linear-gradient(45deg, transparent 75%, color-mix(in oklab, var(--ink) 5%, transparent) 75%)," +
    "linear-gradient(-45deg, transparent 75%, color-mix(in oklab, var(--ink) 5%, transparent) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

// FilePreview — visual host for image / svg / pdf / video / audio / docx files.
// Content loads via file:// URLs (no byte round-trip through IPC), with a
// blob-URL fallback fed by fs:readFileBytes for environments where file://
// subresources are blocked (dev renderer served over http://localhost).
export default function FilePreview({ path, kind }: Props) {
  const [stat, setStat] = useState<{ size: number; mtimeMs: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Blob fallback: pull bytes over IPC and objectURL them when the direct
  // file:// load errors out (and eagerly for remote files, which have no
  // file:// form). Also cleans up the object URL on path change.
  const activateBlobFallback = useCallback(() => {
    void window.spark.fs
      .readFileBytes(path)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
        setBlobUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => setLoadFailed(true));
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setStat(null);
    setMissing(false);
    setDimensions(null);
    setBlobUrl(null);
    setLoadFailed(false);

    const refreshStat = () => {
      void window.spark.fs
        .statFile(path)
        .then((s) => {
          if (!cancelled) {
            setStat(s);
            setMissing(false);
          }
        })
        .catch(() => {
          if (!cancelled) setMissing(true);
        });
    };
    refreshStat();
    // Remote files have no file:// form — load their bytes over IPC into a
    // blob URL straight away instead of waiting for the <img> to error.
    if (isRemotePath(path)) activateBlobFallback();
    // fs:changed only fires for create/delete/rename (content writes are
    // filtered main-side), so this catches deletion/replacement of the
    // previewed file; the mtime doubles as the <img> cache-buster.
    const off = window.spark.fs.onChanged(() => refreshStat());
    return () => {
      cancelled = true;
      off();
    };
  }, [path, activateBlobFallback]);

  useEffect(() => {
    return () => {
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [path]);

  const fileUrl = useMemo(() => {
    const base = pathToFileUrl(path);
    // Query param busts Chromium's cache when the file is replaced on disk.
    return stat ? `${base}?t=${Math.round(stat.mtimeMs)}` : base;
  }, [path, stat]);
  const src = blobUrl ?? fileUrl;

  if (missing) {
    return (
      <div style={hostStyle}>
        <div style={{ margin: "auto", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
          <div className="spark-eyebrow" style={{ marginBottom: 6 }}>
            File not found
          </div>
          This file no longer exists on disk.
        </div>
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div style={{ ...hostStyle, overflow: "hidden" }}>
        <Suspense
          fallback={
            <div style={{ margin: "auto", color: "var(--muted)", fontSize: 12 }}>
              Loading PDF viewer…
            </div>
          }
        >
          <PdfPreview path={path} mtimeMs={stat?.mtimeMs ?? 0} />
        </Suspense>
      </div>
    );
  }

  const caption = (
    <div
      style={{
        flex: "0 0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
        borderTop: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      {dimensions && (
        <span>
          {dimensions.w} × {dimensions.h}
        </span>
      )}
      {stat && <span>{formatBytes(stat.size)}</span>}
    </div>
  );

  if (kind === "image" || kind === "svg") {
    return (
      <div style={hostStyle}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "auto",
            padding: 24,
          }}
        >
          {loadFailed ? (
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              This {kind === "svg" ? "SVG" : "image"} could not be rendered.
            </span>
          ) : (
            <img
              key={src}
              src={src}
              alt={path}
              onLoad={(e) => {
                const img = e.currentTarget;
                setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={() => {
                if (!blobUrl) activateBlobFallback();
                else setLoadFailed(true);
              }}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                borderRadius: 3,
                boxShadow: "0 2px 18px rgba(0,0,0,0.35)",
                ...CHECKER_BG,
              }}
            />
          )}
        </div>
        {caption}
      </div>
    );
  }

  if (kind === "docx") {
    return (
      <div style={{ ...hostStyle, overflow: "hidden" }}>
        <Suspense
          fallback={
            <div style={{ margin: "auto", color: "var(--muted)", fontSize: 12 }}>
              Loading document viewer…
            </div>
          }
        >
          <DocxPreview path={path} mtimeMs={stat?.mtimeMs ?? 0} />
        </Suspense>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div style={hostStyle}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <video
            key={src}
            src={src}
            controls
            onError={() => {
              if (!blobUrl) activateBlobFallback();
              else setLoadFailed(true);
            }}
            style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 4, outline: "none" }}
          />
        </div>
        {caption}
      </div>
    );
  }

  // audio
  return (
    <div style={hostStyle}>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <audio
          key={src}
          src={src}
          controls
          onError={() => {
            if (!blobUrl) activateBlobFallback();
            else setLoadFailed(true);
          }}
          style={{ width: "min(480px, 100%)" }}
        />
      </div>
      {caption}
    </div>
  );
}

const hostStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
};
