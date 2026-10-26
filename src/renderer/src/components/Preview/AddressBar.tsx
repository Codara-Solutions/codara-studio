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
  CommentIcon,
  ForwardIcon,
  GlobeIcon,
  InspectIcon,
  LockIcon,
  ReloadIcon,
} from "../icons";
import { IS_MAC } from "../../shortcuts/platform";
import MoreMenu from "./toolbar/MoreMenu";
import ServerChip from "./toolbar/ServerChip";
import { ExitFullScreenIcon, FullScreenIcon } from "./toolbar/icons";
import TabsChip from "./tabs-memory/TabsChip";
import { normalizeUrl } from "./toolbar/address";
import "./browser-pane.css";

const MOD_LABEL = IS_MAC ? "Cmd" : "Ctrl";

// AddressBar is the browser pane's toolbar (DESIGN.md, "Browser pane"):
// back, forward and reload; the address pill with the workspace's dev
// servers at its left end; the tools used every few minutes with a word next
// to each (Point, Comment, Record); a More menu for the rest; the tabs and
// memory chip; and full screen. In a narrow pane the words drop and the
// icons, tooltips and accessible names stay.

export interface AddressBarHandle {
  focus: () => void;
}

interface Props {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The element picker or its composer is open. */
  pointing: boolean;
  /** Comment mode is on. */
  commenting: boolean;
  /** The id agents pass as tabId, or null outside a registered tab. */
  tabId: string | null;
  workspaceId: string | null;
  /** The phone, tablet and desktop view is open. */
  responsive: boolean;
  /** The pane fills the window (or the whole display). */
  fullScreen: boolean;
  onSubmit: (url: string) => void;
  // Shift-click triggers a hard reload (ignore HTTP cache). Plain click is a
  // normal reload. The reload button forwards the click's shift state via
  // this opts object so the parent can route to the correct webview method.
  onReload: (opts: { ignoreCache: boolean }) => void;
  onBack: () => void;
  onForward: () => void;
  onOpenDevTools: () => void;
  onOpenExternal: (url: string) => void;
  onTogglePoint: () => void;
  onToggleComment: () => void;
  onToggleResponsive: () => void;
  onToggleFullScreen: () => void;
  /** "id" copies the bare id; "full" adds the URL, title and who drives the tab. */
  onCopyTabId: (detail: "id" | "full") => void;
  /** The Record tool, rendered after Comment. */
  recordTool?: React.ReactNode;
}

const AddressBar = forwardRef<AddressBarHandle, Props>(function AddressBar(
  {
    url,
    canGoBack,
    canGoForward,
    pointing,
    commenting,
    tabId,
    workspaceId,
    responsive,
    fullScreen,
    onSubmit,
    onReload,
    onBack,
    onForward,
    onOpenDevTools,
    onOpenExternal,
    onTogglePoint,
    onToggleComment,
    onToggleResponsive,
    onToggleFullScreen,
    onCopyTabId,
    recordTool,
  },
  ref,
) {
  const [draft, setDraft] = useState(url);
  const [notice, setNotice] = useState<string | null>(null);
  // Drives the Safari-style address display: when unfocused we render a
  // styled URL (dimmed scheme + emphasized host); on focus the raw editable
  // draft is shown so the user can edit the full string.
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  const submit = () => {
    const next = normalizeUrl(draft);
    if (!next) {
      setNotice("Enter a URL, or a port such as 3000 for a local server.");
      return;
    }
    setNotice(null);
    setDraft(next);
    onSubmit(next);
  };

  return (
    <div className="bp-toolbar" data-testid="preview-toolbar">
      <div className="bp-toolbar__row">
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
          <ServerChip
            workspaceId={workspaceId}
            url={url}
            onOpen={(target) => {
              setNotice(null);
              setDraft(target);
              onSubmit(target);
            }}
          />
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
                  // Handled here, so the pane's own Esc listener skips it.
                  if (fullScreen) onToggleFullScreen();
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
                // The pill carries the focus ring; the app-wide input ring
                // would draw a second box inside it.
                boxShadow: "none",
                // Hidden while resting so the styled overlay above shows
                // through; focus reveals it for editing. Caret/selection only
                // matter when focused, so opacity is the right lever here.
                opacity: focused ? 1 : 0,
              }}
            />
          </div>
        </div>

        <ToolButton
          icon={<InspectIcon size={13} />}
          label="Point"
          title={pointing ? "Stop pointing (Esc)" : `Point at an element to send to an agent (${MOD_LABEL}+Shift+E)`}
          disabled={!url}
          active={pointing}
          onClick={onTogglePoint}
        />
        <ToolButton
          icon={<CommentIcon size={13} />}
          label="Comment"
          title={commenting ? "Stop commenting (Esc)" : `Comment on the page (${MOD_LABEL}+Shift+X)`}
          disabled={!url}
          active={commenting}
          onClick={onToggleComment}
        />
        {recordTool}
        <MoreMenu
          url={url}
          tabId={tabId}
          responsive={responsive}
          fullScreen={fullScreen}
          onToggleResponsive={onToggleResponsive}
          onToggleFullScreen={onToggleFullScreen}
          onCopyTabId={onCopyTabId}
          onOpenExternal={() => onOpenExternal(url)}
          onOpenDevTools={onOpenDevTools}
        />
        <span className="bp-sep" aria-hidden />
        <TabsChip tabId={tabId} workspaceId={workspaceId} />
        <button
          type="button"
          className={`bp-tool bp-tool--icon${fullScreen ? " is-active" : ""}`}
          data-testid="preview-fullscreen"
          aria-pressed={fullScreen}
          aria-label={fullScreen ? "Leave full screen" : "Full screen"}
          title={fullScreen ? "Leave full screen (Esc)" : "Full screen: fill the Codara window (F11)"}
          onClick={onToggleFullScreen}
        >
          {fullScreen ? <ExitFullScreenIcon size={13} /> : <FullScreenIcon size={13} />}
        </button>
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

// A toolbar tool with its word next to the icon. The aria-label carries the
// full description, so the name stays when a narrow pane drops the word.
function ToolButton({
  icon,
  label,
  title,
  disabled,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`bp-tool${active ? " is-active" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={active ? true : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="bp-tool__label">{label}</span>
    </button>
  );
}

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

export default AddressBar;
