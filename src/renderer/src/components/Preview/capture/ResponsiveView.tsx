import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { DEFAULT_CAPTURE_SIZES, type CaptureColorScheme, type CaptureSizePreset } from "@shared/capture";
import { CloseIcon } from "../../icons";

// The responsive view: the tab's page at several sizes side by side, each
// in its own guest laid out at the preset's size and scaled to fit, with
// one light/dark switch, and scrolling and navigation kept in step. It is
// mounted only while the pane is visible and the view is on, so hidden
// tabs never run the extra renderers.

interface EditablePreset extends CaptureSizePreset {
  enabled: boolean;
}

type SchemeChoice = "auto" | "light" | "dark";

const SIZES_KEY = "codara.preview.responsiveSizes";
const SCHEME_KEY = "codara.preview.responsiveScheme";
const SYNC_MARK = "__codara_responsive_scroll__";
const PADDING = 16;
const GAP = 16;
const LABEL_HEIGHT = 22;

function readSizes(): EditablePreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZES_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      const sizes = raw.flatMap((item) => {
        const value = item as Partial<EditablePreset>;
        if (typeof value.width !== "number" || typeof value.height !== "number") return [];
        return [{
          name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 24) : `${value.width}x${value.height}`,
          width: clampSide(value.width),
          height: clampSide(value.height),
          mobile: value.mobile === true,
          enabled: value.enabled !== false,
        }];
      });
      if (sizes.length) return sizes;
    }
  } catch {
    /* stored sizes are a convenience; the defaults stand in */
  }
  return DEFAULT_CAPTURE_SIZES.map((size) => ({ ...size, enabled: true }));
}

function writeSizes(sizes: EditablePreset[]): void {
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
  } catch {
    /* not persisted this time */
  }
}

function readScheme(): SchemeChoice {
  try {
    const value = localStorage.getItem(SCHEME_KEY);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

function clampSide(value: number): number {
  return Math.max(120, Math.min(3840, Math.round(Number.isFinite(value) ? value : 400)));
}

// Reports scroll position as a fraction of the scrollable height (sizes
// differ, so pixels would not line up) and applies one sent by the view.
const SCROLL_SYNC_SCRIPT = `(() => {
  if (window.__codaraResponsiveSync) return;
  window.__codaraResponsiveSync = true;
  let applying = 0;
  let queued = false;
  const max = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
  window.__codaraResponsiveApply = (fraction) => {
    applying = Date.now();
    scrollTo(scrollX, Math.round(fraction * max()));
  };
  addEventListener("scroll", () => {
    if (Date.now() - applying < 120 || queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      const m = max();
      console.debug(${JSON.stringify(SYNC_MARK)} + (m > 0 ? scrollY / m : 0));
    }, 30);
  }, { passive: true });
})();`;

interface FrameWebview extends HTMLElement {
  src: string;
  getURL?: () => string;
  loadURL?: (url: string) => Promise<void>;
  getWebContentsId?: () => number;
  executeJavaScript?: (code: string) => Promise<unknown>;
}

interface FrameHandle {
  webview: FrameWebview | null;
  ready: boolean;
}

interface Props {
  url: string;
  onNavigate: (url: string) => void;
  onClose: () => void;
}

export default function ResponsiveView({ url, onNavigate, onClose }: Props) {
  const [sizes, setSizes] = useState<EditablePreset[]>(readSizes);
  const [scheme, setScheme] = useState<SchemeChoice>(readScheme);
  const [editing, setEditing] = useState(false);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const frames = useRef(new Map<string, FrameHandle>());
  const urlRef = useRef(url);
  urlRef.current = url;

  const shown = useMemo(() => sizes.filter((size) => size.enabled), [sizes]);

  useLayoutEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const measure = () => setArea({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  const scale = useMemo(() => {
    if (!shown.length || !area.width) return 1;
    const totalWidth = shown.reduce((sum, size) => sum + size.width, 0);
    const tallest = Math.max(...shown.map((size) => size.height));
    const byWidth = (area.width - PADDING * 2 - GAP * (shown.length - 1)) / totalWidth;
    const byHeight = (area.height - PADDING * 2 - LABEL_HEIGHT) / tallest;
    return Math.max(0.05, Math.min(1, byWidth, byHeight));
  }, [shown, area]);

  const updateSizes = (next: EditablePreset[]) => {
    setSizes(next);
    writeSizes(next);
  };

  const chooseScheme = (next: SchemeChoice) => {
    setScheme(next);
    try {
      localStorage.setItem(SCHEME_KEY, next);
    } catch {
      /* not persisted this time */
    }
  };

  const onScrolled = useCallback((from: string, fraction: number) => {
    for (const [key, frame] of frames.current) {
      if (key === from || !frame.ready) continue;
      void frame.webview?.executeJavaScript?.(`window.__codaraResponsiveApply && window.__codaraResponsiveApply(${fraction})`).catch(() => {});
    }
  }, []);

  const onFrameNavigated = useCallback((next: string) => {
    if (next && next !== urlRef.current && !next.startsWith("about:")) onNavigate(next);
  }, [onNavigate]);

  return (
    <div
      data-testid="responsive-view"
      style={{ position: "absolute", inset: 0, zIndex: 4, display: "flex", flexDirection: "column", background: "var(--bg)" }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px 6px 12px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "var(--panel)",
          position: "relative",
        }}
      >
        <span className="spark-eyebrow" style={{ flex: "0 0 auto" }}>Sizes</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minWidth: 0, flex: 1 }}>
          {sizes.map((size, index) => (
            <button
              key={`${size.name}-${index}`}
              type="button"
              aria-pressed={size.enabled}
              title={`${size.enabled ? "Hide" : "Show"} ${size.name}`}
              onClick={() => updateSizes(sizes.map((item, i) => (i === index ? { ...item, enabled: !item.enabled } : item)))}
              style={chipStyle(size.enabled)}
            >
              <span>{size.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: size.enabled ? "var(--accent-text)" : "var(--muted)" }}>
                {size.width}x{size.height}
              </span>
            </button>
          ))}
          <button type="button" onClick={() => setEditing((open) => !open)} style={chipStyle(editing)} aria-expanded={editing}>
            Edit sizes
          </button>
        </div>
        <div role="radiogroup" aria-label="Color scheme" style={segmentGroupStyle}>
          {(["auto", "light", "dark"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={scheme === choice}
              onClick={() => chooseScheme(choice)}
              style={segmentStyle(scheme === choice)}
            >
              {choice === "auto" ? "Auto" : choice === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="spark-icon-btn"
          title="Close the responsive view (Esc)"
          aria-label="Close the responsive view"
          onClick={onClose}
          style={{ ["--spark-icon-btn-size" as string]: "22px" }}
        >
          <CloseIcon size={12} />
        </button>
        {editing ? <SizeEditor sizes={sizes} onChange={updateSizes} onClose={() => setEditing(false)} /> : null}
      </div>
      <div
        ref={areaRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: GAP,
          padding: PADDING,
          overflow: "hidden",
        }}
      >
        {shown.length === 0 ? (
          <div className="spark-empty__body" style={{ alignSelf: "center" }}>Pick at least one size above.</div>
        ) : (
          shown.map((size) => {
            const key = `${size.name}:${size.width}x${size.height}`;
            return (
              <ResponsiveFrame
                key={key}
                frameKey={key}
                size={size}
                scale={scale}
                url={url}
                colorScheme={scheme === "auto" ? null : scheme}
                frames={frames.current}
                onScrolled={onScrolled}
                onNavigated={onFrameNavigated}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function ResponsiveFrame({
  frameKey,
  size,
  scale,
  url,
  colorScheme,
  frames,
  onScrolled,
  onNavigated,
}: {
  frameKey: string;
  size: CaptureSizePreset;
  scale: number;
  url: string;
  colorScheme: CaptureColorScheme;
  frames: Map<string, FrameHandle>;
  onScrolled: (from: string, fraction: number) => void;
  onNavigated: (url: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const emulation = useRef({ size, colorScheme });
  emulation.current = { size, colorScheme };
  const callbacks = useRef({ onScrolled, onNavigated });
  callbacks.current = { onScrolled, onNavigated };

  const applyEmulation = useCallback((webview: FrameWebview) => {
    let id: number | undefined;
    try {
      id = webview.getWebContentsId?.();
    } catch {
      return;
    }
    if (typeof id !== "number") return;
    const { size: current, colorScheme: scheme } = emulation.current;
    void window.spark.capture
      ?.frameEmulation({ webContentsId: id, width: current.width, height: current.height, mobile: current.mobile, colorScheme: scheme })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement("webview") as FrameWebview;
    webview.setAttribute("webpreferences", "contextIsolation=yes,backgroundThrottling=no");
    webview.setAttribute("data-responsive-frame", frameKey);
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.border = "0";
    webview.style.background = "white";
    webview.src = url;
    host.appendChild(webview);
    const handle: FrameHandle = { webview, ready: false };
    frames.set(frameKey, handle);
    const onDomReady = () => {
      handle.ready = true;
      setReady(true);
      applyEmulation(webview);
      void webview.executeJavaScript?.(SCROLL_SYNC_SCRIPT).catch(() => {});
    };
    const onConsole = (event: Event) => {
      const message = (event as Event & { message?: string }).message ?? "";
      if (!message.startsWith(SYNC_MARK)) return;
      const fraction = Number(message.slice(SYNC_MARK.length));
      if (Number.isFinite(fraction)) callbacks.current.onScrolled(frameKey, fraction);
    };
    const onNavigate = (event: Event) => {
      const detail = event as Event & { url?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      if (detail.url) callbacks.current.onNavigated(detail.url);
    };
    webview.addEventListener("dom-ready", onDomReady);
    webview.addEventListener("console-message", onConsole);
    webview.addEventListener("did-navigate", onNavigate);
    webview.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("console-message", onConsole);
      webview.removeEventListener("did-navigate", onNavigate);
      webview.removeEventListener("did-navigate-in-page", onNavigate);
      if (frames.get(frameKey) === handle) frames.delete(frameKey);
      webview.remove();
    };
    // The guest is created once per frame; url and emulation changes are
    // applied to it below instead of re-creating it.
  }, []);

  useEffect(() => {
    const handle = frames.get(frameKey);
    const webview = handle?.webview;
    if (!webview || !handle.ready) return;
    let current = "";
    try {
      current = webview.getURL?.() ?? "";
    } catch {
      return;
    }
    if (url && current !== url) void webview.loadURL?.(url).catch(() => {});
  }, [url, frameKey, frames, ready]);

  useEffect(() => {
    const webview = frames.get(frameKey)?.webview;
    if (webview && ready) applyEmulation(webview);
  }, [colorScheme, size.width, size.height, size.mobile, ready, frameKey, frames, applyEmulation]);

  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  return (
    <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 6 }} data-testid="responsive-frame">
      <div style={{ height: LABEL_HEIGHT - 6, display: "flex", alignItems: "baseline", gap: 6, maxWidth: width, overflow: "hidden", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>{size.name}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)" }}>
          {size.width}x{size.height}
          {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}
        </span>
      </div>
      <div
        style={{
          width,
          height,
          overflow: "hidden",
          borderRadius: 6,
          border: "1px solid var(--rule-soft)",
          boxShadow: "var(--lift-hi)",
          background: "white",
          position: "relative",
        }}
      >
        {/* The protocol's own view scaling leaves a guest painting at full
            size inside its box, so the guest keeps the preset's size and the
            embedder shrinks it. */}
        <div
          ref={hostRef}
          style={{ width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}
        />
      </div>
    </div>
  );
}

function SizeEditor({ sizes, onChange, onClose }: { sizes: EditablePreset[]; onChange: (sizes: EditablePreset[]) => void; onClose: () => void }) {
  const update = (index: number, patch: Partial<EditablePreset>) => onChange(sizes.map((size, i) => (i === index ? { ...size, ...patch } : size)));
  return (
    <div
      className="spark-menu spark-fade-in"
      role="dialog"
      aria-label="Edit sizes"
      style={{ position: "absolute", top: 40, left: 12, zIndex: 50, width: 380, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <span className="spark-eyebrow" style={{ flex: 1 }}>Edit sizes</span>
        <button type="button" className="spark-icon-btn" aria-label="Close" title="Close" onClick={onClose} style={{ ["--spark-icon-btn-size" as string]: "18px" }}>
          <CloseIcon size={11} />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 64px 64px auto auto", gap: 6, alignItems: "center", fontSize: 11, color: "var(--muted)" }}>
        <span>Name</span>
        <span>Width</span>
        <span>Height</span>
        <span>Mobile</span>
        <span />
        {sizes.map((size, index) => (
          <SizeRow key={index} size={size} onChange={(patch) => update(index, patch)} onRemove={sizes.length > 1 ? () => onChange(sizes.filter((_, i) => i !== index)) : undefined} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          type="button"
          className="spark-btn"
          disabled={sizes.length >= 6}
          onClick={() => onChange([...sizes, { name: "Custom", width: 1024, height: 768, mobile: false, enabled: true }])}
        >
          Add size
        </button>
        <button type="button" className="spark-btn" onClick={() => onChange(DEFAULT_CAPTURE_SIZES.map((size) => ({ ...size, enabled: true })))}>
          Reset
        </button>
      </div>
    </div>
  );
}

function SizeRow({ size, onChange, onRemove }: { size: EditablePreset; onChange: (patch: Partial<EditablePreset>) => void; onRemove?: () => void }) {
  return (
    <>
      <input aria-label="Name" value={size.name} maxLength={24} onChange={(event) => onChange({ name: event.target.value })} style={inputStyle} />
      <NumberField label="Width" value={size.width} onCommit={(width) => onChange({ width })} />
      <NumberField label="Height" value={size.height} onCommit={(height) => onChange({ height })} />
      <input aria-label="Mobile layout" type="checkbox" checked={size.mobile} onChange={(event) => onChange({ mobile: event.target.checked })} />
      <button
        type="button"
        className="spark-icon-btn"
        aria-label={`Remove ${size.name}`}
        title="Remove"
        disabled={!onRemove}
        onClick={onRemove}
        style={{ ["--spark-icon-btn-size" as string]: "18px" }}
      >
        <CloseIcon size={10} />
      </button>
    </>
  );
}

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed > 0) onCommit(clampSide(parsed));
    else setDraft(String(value));
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
    />
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 24,
  padding: "0 6px",
  border: "1px solid var(--rule-soft)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--ink)",
  fontSize: 11,
  outline: "none",
};

function chipStyle(on: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 24,
    padding: "0 8px",
    borderRadius: 999,
    border: `1px solid ${on ? "var(--accent-edge)" : "var(--rule-soft)"}`,
    background: on ? "var(--accent-soft)" : "transparent",
    color: on ? "var(--ink)" : "var(--ink-dim)",
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const segmentGroupStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  padding: 2,
  gap: 2,
  borderRadius: 7,
  border: "1px solid var(--rule-soft)",
  background: "var(--bg)",
  boxShadow: "var(--well)",
};

function segmentStyle(on: boolean): CSSProperties {
  return {
    height: 20,
    padding: "0 9px",
    borderRadius: 5,
    border: 0,
    background: on ? "var(--panel)" : "transparent",
    boxShadow: on ? "var(--lift-hi)" : "none",
    color: on ? "var(--ink)" : "var(--muted)",
    fontSize: 11,
    fontWeight: on ? 600 : 500,
    cursor: "pointer",
  };
}
