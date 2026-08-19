import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  BackIcon,
  CloseIcon,
  DevToolsIcon,
  DrawIcon,
  ExternalLinkIcon,
  ForwardIcon,
  GlobeIcon,
  InspectIcon,
  LockIcon,
  ReloadIcon,
} from "../icons";

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
  inspecting: boolean;
  drawing: boolean;
  onSubmit: (url: string) => void;
  // Shift-click triggers a hard reload (ignore HTTP cache). Plain click is a
  // normal reload. The reload button forwards the click's shift state via
  // this opts object so the parent can route to the correct webview method.
  onReload: (opts: { ignoreCache: boolean }) => void;
  onBack: () => void;
  onForward: () => void;
  onOpenDevTools: () => void;
  onOpenExternal: (url: string) => void;
  onToggleInspect: () => void;
  onToggleDraw: () => void;
}

const AddressBar = forwardRef<AddressBarHandle, Props>(function AddressBar(
  {
    url,
    canGoBack,
    canGoForward,
    inspecting,
    drawing,
    onSubmit,
    onReload,
    onBack,
    onForward,
    onOpenDevTools,
    onOpenExternal,
    onToggleInspect,
    onToggleDraw,
  },
  ref,
) {
  const [draft, setDraft] = useState(url);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkingPort, setCheckingPort] = useState<number | null>(null);
  const [portsOpen, setPortsOpen] = useState(false);
  // Drives the Safari-style address display: when unfocused we render a
  // styled URL (dimmed scheme + emphasized host); on focus the raw editable
  // draft is shown so the user can edit the full string.
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const portsAnchor = useRef<HTMLDivElement | null>(null);

  // Parse the resting URL into scheme / host / rest so the unfocused pill can
  // dim the scheme and emphasize the host (the Safari "emphasized domain"
  // treatment). Falls back to the raw draft when it isn't a parseable URL.
  const parsed = parseAddress(draft);
  const isSecure = parsed?.scheme === "https";

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
        boxShadow: "var(--lift-hi)",
      }}
    >
      <div
        style={{
          height: 38,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 8px",
        }}
      >
        {/* Navigation cluster: back / forward / reload grouped inside one
            subtly-bordered, recessed affordance so the three nav controls
            read as a unit (Safari toolbar idiom) rather than three loose
            boxes. */}
        <Cluster>
          <ChromeButton
            label={<BackIcon size={13} />}
            title="Back"
            disabled={!canGoBack}
            onClick={onBack}
          />
          <ChromeButton
            label={<ForwardIcon size={13} />}
            title="Forward"
            disabled={!canGoForward}
            onClick={onForward}
          />
          <ChromeButton
            label={<ReloadIcon size={13} />}
            title="Reload (Shift+click for hard reload, ignore cache)"
            onClick={(e) => onReload({ ignoreCache: e.shiftKey })}
          />
        </Cluster>

        <div ref={portsAnchor} style={{ position: "relative", flex: "0 0 auto" }}>
          <button
            type="button"
            className="spark-btn"
            onClick={() => setPortsOpen((o) => !o)}
            title="Common dev-server ports"
            aria-pressed={portsOpen}
            style={{
              height: 28,
              padding: "0 10px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              // Reflect the open state with accent ink on a soft fill, matching
              // the .spark-icon-btn.is-active idiom — no extra border/glow.
              color: portsOpen ? "var(--accent-text)" : "var(--ink-dim)",
              background: portsOpen ? "var(--accent-soft)" : undefined,
              borderColor: portsOpen ? "var(--accent-edge)" : undefined,
            }}
          >
            Ports
          </button>
          {portsOpen && (
            <div
              className="spark-menu spark-fade-in"
              style={{
                position: "absolute",
                top: 34,
                left: 0,
                zIndex: 50,
                minWidth: 240,
                maxHeight: 320,
                overflow: "auto",
              }}
            >
              <div className="spark-eyebrow" style={{ padding: "6px 8px 7px" }}>
                Dev-server ports
              </div>
              {PORT_PRESETS.map((p) => {
                const checking = checkingPort === p.port;
                return (
                  <button
                    key={p.port}
                    type="button"
                    className="spark-menu-item"
                    onClick={() => void tryPort(p.port)}
                    style={{ gap: 10 }}
                  >
                    <span style={{ flex: 1 }}>{p.label}</span>
                    {checking ? (
                      <span
                        style={{
                          color: "var(--accent-text)",
                          fontFamily: "var(--font-mono)",
                          fontVariantNumeric: "tabular-nums",
                          fontSize: 10,
                        }}
                      >
                        checking…
                      </span>
                    ) : (
                      <span className="spark-kbd">:{p.port}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Address pill — the single highest-leverage "reads as a browser"
            element. Leading security glyph (lock for https, globe for http),
            then either the styled resting URL (dimmed scheme + emphasized
            host) or, on focus, the raw editable input. The input is always
            mounted so width never shifts; only its opacity toggles, holding
            zero layout shift between display and edit states. */}
        <div
          onMouseDown={(e) => {
            // Clicking anywhere on the pill (the gutter, the styled overlay)
            // focuses the real input and selects all, like a browser's
            // address bar. Skip when the click already lands on the input.
            if (e.target !== inputRef.current) {
              e.preventDefault();
              const el = inputRef.current;
              if (el) {
                el.focus();
                el.select();
              }
            }
          }}
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 7,
            height: 28,
            padding: "0 10px",
            background: "var(--bg)",
            border: `1px solid ${focused ? "var(--accent-edge)" : "var(--rule-soft)"}`,
            borderRadius: "var(--radius-surface, 7px)",
            boxShadow: focused ? "var(--focus-ring)" : "var(--well)",
            cursor: "text",
            transition:
              "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
          }}
        >
          {/* Security glyph — lock (https) vs globe (http). Muted at rest so
              it sits quietly until the host carries the eye. */}
          <span
            aria-hidden
            title={
              !draft
                ? undefined
                : isSecure
                  ? "Secure connection (https)"
                  : "Not secure (http)"
            }
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 14,
              height: 14,
              color: isSecure ? "var(--ok)" : "var(--muted)",
            }}
          >
            {isSecure ? <LockIcon size={13} /> : <GlobeIcon size={13} />}
          </span>

          <div style={{ position: "relative", flex: 1, minWidth: 0, height: "100%" }}>
            {/* Styled resting URL — hidden (but space-reserving) while editing
                so there is no advance change between view and edit. */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                whiteSpace: "nowrap",
                overflow: "hidden",
                opacity: focused ? 0 : 1,
                pointerEvents: "none",
                transition: "opacity var(--motion-fast) var(--ease-out)",
              }}
            >
              {parsed ? (
                <>
                  <span style={{ color: "var(--muted)" }}>{parsed.scheme}://</span>
                  <span style={{ color: "var(--ink)" }}>{parsed.host}</span>
                  <span style={{ color: "var(--muted)" }}>{parsed.rest}</span>
                </>
              ) : (
                <span style={{ color: draft ? "var(--ink)" : "var(--muted-2)" }}>
                  {draft || "http://localhost:3000"}
                </span>
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
              onFocus={(e) => {
                setFocused(true);
                e.currentTarget.select();
              }}
              onBlur={() => setFocused(false)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                padding: 0,
                background: "transparent",
                border: "none",
                color: "var(--ink)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                outline: "none",
                // Hidden while resting so the styled overlay above shows
                // through; focus reveals it for editing. Caret/selection only
                // matter when focused, so opacity is the right lever here.
                opacity: focused ? 1 : 0,
              }}
            />
          </div>
        </div>

        {/* Tools cluster: inspect / draw toggles + open-external + devtools,
            grouped like the nav cluster so the toolbar reads as two clean
            affordances rather than a row of loose boxes. */}
        <Cluster>
          <ChromeButton
            label={<InspectIcon size={13} />}
            title={inspecting ? "Stop inspecting (Esc)" : "Inspect an element"}
            disabled={!url}
            active={inspecting}
            onClick={onToggleInspect}
          />
          <ChromeButton
            label={<DrawIcon size={13} />}
            title={drawing ? "Exit draw mode" : "Draw on the page"}
            disabled={!url}
            active={drawing}
            onClick={onToggleDraw}
          />
          <ChromeButton
            label={<ExternalLinkIcon size={13} />}
            title="Open in system browser"
            disabled={!url}
            onClick={() => onOpenExternal(url)}
          />
          <ChromeButton
            label={<DevToolsIcon size={13} />}
            title="Open Chromium DevTools"
            onClick={onOpenDevTools}
          />
        </Cluster>
      </div>
      {notice ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 8px 5px 12px",
            background: "var(--info-soft)",
            color: "var(--ink-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            borderTop: "1px solid var(--rule-soft)",
            // A thin info edge carries the status; the band itself stays a
            // calm tint rather than a loud full wash.
            boxShadow: "inset 3px 0 0 var(--info)",
          }}
        >
          <span
            aria-hidden
            style={{
              flex: "0 0 auto",
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--info)",
            }}
          />
          <span
            className="spark-eyebrow"
            style={{ color: "var(--info)", flex: "0 0 auto" }}
          >
            Note
          </span>
          <span
            style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={notice}
          >
            {notice}
          </span>
          <button
            type="button"
            className="spark-icon-btn"
            onClick={() => setNotice(null)}
            title="Dismiss"
            aria-label="Dismiss"
            style={{ ["--spark-icon-btn-size" as string]: "18px" }}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
});

// Groups a small run of ChromeButtons into one bordered, recessed affordance —
// the Safari "toolbar cluster" idiom. The cluster carries the single hairline
// + well; the buttons inside stay transparent at rest, so the row reads as two
// clean affordances instead of eight loose boxes.
function Cluster({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        height: 28,
        padding: "0 3px",
        border: "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-surface, 7px)",
        background: "var(--bg)",
        boxShadow: "var(--well)",
      }}
    >
      {children}
    </div>
  );
}

function ChromeButton({
  label,
  title,
  disabled,
  active,
  onClick,
}: {
  label: React.ReactNode;
  title: string;
  disabled?: boolean;
  active?: boolean;
  // Accepts the click event so callers can observe modifier keys (e.g.
  // Shift-click on Reload triggers reloadIgnoringCache). Callers that don't
  // care can simply ignore the argument.
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  // Built on .spark-icon-btn: transparent at rest, ink-tint on hover, ink-13%
  // on press, accent-soft fill + accent ink when .is-active. `active` marks
  // toggle buttons (Inspect / Draw) as "on" without a border/glow stack. The
  // utility brings the focus-visible ring and disabled opacity for free.
  return (
    <button
      type="button"
      className={`spark-icon-btn${active ? " is-active" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={active ? true : undefined}
      disabled={disabled}
      onClick={onClick}
      style={{ ["--spark-icon-btn-size" as string]: "22px" }}
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

// Split a resting URL into scheme / host / rest for the Safari-style address
// display (dimmed scheme, emphasized host, dimmed path+query). Returns null
// for anything that isn't a parseable http(s) URL so the caller can fall back
// to rendering the raw draft.
function parseAddress(
  raw: string,
): { scheme: string; host: string; rest: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(trimmed);
  if (!m) return null;
  const [, scheme, host, rest] = m;
  if (!host) return null;
  return { scheme: scheme.toLowerCase(), host, rest };
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
