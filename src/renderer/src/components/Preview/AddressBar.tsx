import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// AddressBar is the chrome for a preview tab: back/forward, reload, URL
// input, ports preset dropdown, open-in-system-browser, open-devtools.
//
// The ports list is curated for common dev servers; clicking probes the
// port via fetch (no-cors) before navigating. This avoids the awkward
// "click a port and stare at a connection-refused error page" UX when
// nothing is running there yet.

type PortPreset = {
  port: number;
  label: string;
};

const PORT_PRESETS: readonly PortPreset[] = [
  { port: 5173, label: "Vite" },
  { port: 5174, label: "Vite (alt)" },
  { port: 3000, label: "Next.js / Express" },
  { port: 3001, label: "Next.js (alt)" },
  { port: 4173, label: "Vite preview" },
  { port: 4200, label: "Angular" },
  { port: 4321, label: "Astro" },
  { port: 5500, label: "Live Server" },
  { port: 6006, label: "Storybook" },
  { port: 8080, label: "Webpack / Vue CLI" },
  { port: 8081, label: "Metro" },
  { port: 8000, label: "Django / FastAPI" },
  { port: 8888, label: "Jupyter" },
  { port: 5000, label: "Flask" },
  { port: 9000, label: "Misc" },
  { port: 9229, label: "Node debug" },
];

export interface AddressBarHandle {
  focus: () => void;
}

interface Props {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onSubmit: (url: string) => void;
  onReload: () => void;
  onBack: () => void;
  onForward: () => void;
  onOpenDevTools: () => void;
  onOpenExternal: (url: string) => void;
}

const AddressBar = forwardRef<AddressBarHandle, Props>(function AddressBar(
  {
    url,
    canGoBack,
    canGoForward,
    onSubmit,
    onReload,
    onBack,
    onForward,
    onOpenDevTools,
    onOpenExternal,
  },
  ref,
) {
  const [draft, setDraft] = useState(url);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkingPort, setCheckingPort] = useState<number | null>(null);
  const [portsOpen, setPortsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const portsAnchor = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(url);
  }, [url]);

  // Auto-focus the URL input on first mount when no URL is set, so the
  // "+ preview" button drops the user straight into a typing-ready state.
  // We do not refocus on subsequent renders — that would steal focus when
  // the user navigates back to an empty tab while working elsewhere.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!url) inputRef.current?.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      },
    }),
    [],
  );

  useEffect(() => {
    if (!portsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        portsAnchor.current &&
        e.target instanceof Node &&
        !portsAnchor.current.contains(e.target)
      ) {
        setPortsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPortsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [portsOpen]);

  const submit = () => {
    const next = normalizeUrl(draft);
    if (!next) {
      setNotice("Enter a URL or pick a port preset.");
      return;
    }
    setNotice(null);
    onSubmit(next);
  };

  const tryPort = async (port: number) => {
    setNotice(null);
    setCheckingPort(port);
    const target = `http://localhost:${port}`;
    const ok = await probeUrl(target);
    setCheckingPort(null);
    setPortsOpen(false);
    if (!ok) {
      setNotice(`No server listening on :${port}.`);
      return;
    }
    setDraft(target);
    onSubmit(target);
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      <div
        style={{
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px",
        }}
      >
        <ChromeButton
          label="←"
          title="Back"
          disabled={!canGoBack}
          onClick={onBack}
        />
        <ChromeButton
          label="→"
          title="Forward"
          disabled={!canGoForward}
          onClick={onForward}
        />
        <ChromeButton label="↻" title="Reload" onClick={onReload} />
        <div ref={portsAnchor} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setPortsOpen((o) => !o)}
            title="Common dev-server ports"
            style={{
              appearance: "none",
              background: "color-mix(in oklch, var(--ink) 2%, transparent)",
              border: "1px solid var(--rule-soft)",
              color: "var(--ink-dim)",
              padding: "0 8px",
              height: 22,
              borderRadius: 4,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              cursor: "default",
            }}
          >
            Ports
          </button>
          {portsOpen && (
            <div
              style={{
                position: "absolute",
                top: 26,
                left: 0,
                zIndex: 50,
                background: "var(--panel-2)",
                border: "1px solid var(--rule-strong)",
                borderRadius: 6,
                boxShadow: "var(--shadow-2)",
                minWidth: 240,
                maxHeight: 320,
                overflow: "auto",
              }}
            >
              {PORT_PRESETS.map((p) => (
                <button
                  key={p.port}
                  type="button"
                  onClick={() => void tryPort(p.port)}
                  style={{
                    appearance: "none",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "8px 12px",
                    color: "var(--ink)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    cursor: "default",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--hover-strong)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <span style={{ flex: 1 }}>{p.label}</span>
                  <span
                    style={{
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                    }}
                  >
                    {checkingPort === p.port ? "checking…" : `:${p.port}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(url);
              inputRef.current?.blur();
            }
          }}
          placeholder="http://localhost:3000"
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            minWidth: 0,
            height: 22,
            padding: "0 8px",
            background: "color-mix(in oklch, var(--ink) 3%, transparent)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 4,
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            outline: "none",
          }}
        />
        <ChromeButton
          label="↗"
          title="Open in system browser"
          disabled={!url}
          onClick={() => onOpenExternal(url)}
        />
        <ChromeButton
          label="{}"
          title="Open Chromium DevTools"
          onClick={onOpenDevTools}
        />
      </div>
      {notice ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 12px",
            background: "color-mix(in oklch, var(--accent) 8%, transparent)",
            color: "var(--ink-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
          }}
        >
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
            {notice}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{
              appearance: "none",
              background: "transparent",
              border: "none",
              color: "var(--muted)",
              fontSize: 10,
              cursor: "default",
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
});

function ChromeButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: "none",
        width: 24,
        height: 22,
        background: "transparent",
        border: "1px solid var(--rule-soft)",
        borderRadius: 4,
        color: disabled ? "var(--muted)" : "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        cursor: "default",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(900),
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:|\/|$)/.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export default AddressBar;
