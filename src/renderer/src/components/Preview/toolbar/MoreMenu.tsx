import { useRef, useState, type ReactNode } from "react";

import AnchoredMenu from "../../chat/composer/AnchoredMenu";
import { DevToolsIcon, ExternalLinkIcon } from "../../icons";
import { DevicesIcon } from "../capture/icons";
import { CheckIcon, CopyIcon, FullScreenIcon, MoreIcon } from "./icons";

// The tools used now and then, behind one More button: the sizes view and
// full screen, the ways to hand the tab to an agent or another browser, and
// DevTools. What is used every few minutes (Point, Comment, Record) stays on
// the toolbar with a word next to its icon.

interface Props {
  url: string;
  tabId: string | null;
  responsive: boolean;
  fullScreen: boolean;
  onToggleResponsive: () => void;
  onToggleFullScreen: () => void;
  onCopyTabId: (detail: "id" | "full") => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
}

function Item({
  icon,
  label,
  hint,
  checked,
  disabled,
  onSelect,
  title,
}: {
  icon: ReactNode;
  label: string;
  hint?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      className="spark-menu-item"
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      <span className="bp-menu__icon">{icon}</span>
      <span className="bp-menu__label">{label}</span>
      {checked ? <span className="bp-menu__icon" style={{ color: "var(--accent-text)" }}><CheckIcon size={12} /></span> : null}
      {hint ? <span className="bp-menu__hint">{hint}</span> : null}
    </button>
  );
}

export default function MoreMenu({
  url,
  tabId,
  responsive,
  fullScreen,
  onToggleResponsive,
  onToggleFullScreen,
  onCopyTabId,
  onOpenExternal,
  onOpenDevTools,
}: Props) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="bp-tool"
        data-testid="preview-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More browser tools"
        title="Sizes, full screen, copy the tab for an agent, DevTools"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon size={13} />
        <span className="bp-tool__label">More</span>
      </button>
      <AnchoredMenu
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        className="spark-menu bp-menu"
        role="menu"
        ariaLabel="More browser tools"
        placement="below"
        align="end"
        menuItems
      >
        <div style={{ width: 300 }}>
          <div className="bp-menu__head">View</div>
          <Item
            icon={<DevicesIcon size={13} />}
            label="Phone, tablet and desktop"
            checked={responsive}
            disabled={!url}
            onSelect={run(onToggleResponsive)}
          />
          <Item
            icon={<FullScreenIcon size={13} />}
            label={fullScreen ? "Leave full screen" : "Full screen"}
            hint={<span className="spark-kbd">F11</span>}
            onSelect={run(onToggleFullScreen)}
          />
          {tabId ? (
            <>
              <div className="bp-menu__head">Share</div>
              <Item
                icon={<CopyIcon size={13} />}
                label="Copy tab id for an agent"
                hint={tabId}
                title={`Copies ${tabId}, which agents pass as tabId`}
                onSelect={run(() => onCopyTabId("id"))}
              />
              <Item
                icon={<CopyIcon size={13} />}
                label="Copy id, URL and session"
                onSelect={run(() => onCopyTabId("full"))}
              />
            </>
          ) : null}
          <Item
            icon={<ExternalLinkIcon size={13} />}
            label="Open in system browser"
            disabled={!url}
            onSelect={run(onOpenExternal)}
          />
          <div className="bp-menu__rule" />
          <Item
            icon={<DevToolsIcon size={13} />}
            label="Developer tools"
            hint={<span className="spark-kbd">F12</span>}
            disabled={!url}
            onSelect={run(onOpenDevTools)}
          />
        </div>
      </AnchoredMenu>
    </>
  );
}
