import { useEffect, useRef, useState } from "react";

import type { DevServerStatus } from "@shared/servers";
import AnchoredMenu from "../../chat/composer/AnchoredMenu";
import { serverForUrl, serverUrl } from "./address";
import { ChevronDownIcon } from "./icons";
import { BROWSER_MENU_Z } from "../fullScreen";

// The dev servers this workspace runs, at the left end of the address pill.
// It names the server the tab shows, and its menu opens any other one. It
// takes the place of a list of guessed ports: Codara already knows which
// servers run (src/main/servers/), and a port typed alone ("5173") opens
// localhost.

interface Props {
  workspaceId: string | null;
  url: string;
  onOpen: (url: string) => void;
}

function running(server: DevServerStatus): boolean {
  return server.state === "running" || server.state === "pane" || server.health === "up";
}

export default function ServerChip({ workspaceId, url, onOpen }: Props) {
  const [servers, setServers] = useState<DevServerStatus[]>([]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const api = window.spark?.servers;
    if (!api || !workspaceId) return;
    let cancelled = false;
    const load = () => {
      void api
        .status(workspaceId)
        .then((snapshot) => {
          if (!cancelled) setServers(snapshot.servers.filter((server) => running(server) && serverUrl(server)));
        })
        .catch(() => {});
    };
    load();
    const off = api.onChanged((change) => {
      if (change.workspaceId === workspaceId) load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [workspaceId]);

  if (servers.length === 0) return null;
  const current = serverForUrl(servers, url);
  const label = current ? current.id : servers.length === 1 ? servers[0].id : `${servers.length} servers`;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="bp-server"
        data-testid="preview-servers"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `Dev server ${current.id}. Open another dev server` : "Open a dev server of this workspace"}
        title={current ? `${current.command} (${serverUrl(current)})` : "Dev servers running in this workspace"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`bp-dot${current?.health === "up" || (!current && servers.some((s) => s.health === "up")) ? " is-up" : ""}`} aria-hidden />
        <span className="bp-server__name">{label}</span>
        <ChevronDownIcon />
      </button>
      <AnchoredMenu
        zIndex={BROWSER_MENU_Z}
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        className="spark-menu bp-menu"
        role="menu"
        ariaLabel="Dev servers"
        placement="below"
        menuItems
      >
        <div style={{ width: 300 }}>
          <div className="bp-menu__head">Dev servers in this workspace</div>
          {servers.map((server) => {
            const target = serverUrl(server)!;
            return (
              <button
                key={server.id}
                type="button"
                role="menuitem"
                className={`spark-menu-item${server === current ? " is-active" : ""}`}
                title={server.command}
                onClick={() => {
                  setOpen(false);
                  onOpen(target);
                }}
              >
                <span className="bp-menu__icon"><span className={`bp-dot${server.health === "up" ? " is-up" : ""}`} /></span>
                <span className="bp-menu__label">{server.id}</span>
                <span className="bp-menu__hint">{target.replace(/^https?:\/\//, "")}</span>
              </button>
            );
          })}
          <div className="bp-menu__note">Type a port such as 3000 in the address bar to open any other local server.</div>
        </div>
      </AnchoredMenu>
    </>
  );
}
