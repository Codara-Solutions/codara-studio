// SSH port forwarding for remote workspaces, shared by main
// (src/main/remote/port-forwarding.ts) and the Ports list in the status bar
// (components/remote/PortsChip.tsx). Forwards belong to a host, not to one
// workspace: two workspaces on the same machine see the same remote ports.

/** How a forward came to exist. */
export type PortForwardSource =
  /** A localhost URL printed in one of the host's terminals. */
  | "terminal"
  /** A port that started listening on the host after it connected. */
  | "listening"
  /** An agent opened http://localhost:<port> with codara_preview_navigate. */
  | "agent"
  /** Forwarded by hand from the Ports list. */
  | "manual";

/**
 * active: the local port accepts connections.
 * waiting: the SSH connection dropped; the forward comes back when it reconnects.
 * failed: no local port could be opened.
 */
export type PortForwardState = "active" | "waiting" | "failed";

export interface ForwardedPort {
  remotePort: number;
  /** The address the remote machine connects to, such as localhost or 127.0.0.1. */
  remoteHost: string;
  /** Null while waiting for a connection or after a failure. */
  localPort: number | null;
  /** http://localhost:<localPort> plus the path the server printed, when active. */
  localUrl: string | null;
  source: PortForwardSource;
  state: PortForwardState;
  /** The listening process when the host reports it, such as "node (4121)". */
  process?: string;
  /** Its command line when known, such as "node node_modules/.bin/vite". */
  command?: string;
  error?: string;
}

/** A TCP port listening on the remote host. */
export interface ListeningRemotePort {
  port: number;
  /** Every address it is bound to: 127.0.0.1, ::1, 0.0.0.0, ::, * or a specific one. */
  addresses: string[];
  process?: string;
  pid?: number;
}

/** Which tool listed the host's ports: none when it has none we know, pending before the first answer. */
export type RemotePortListing = "ss" | "netstat" | "lsof" | "proc" | "none" | "pending";

export interface PortsSnapshot {
  hostId: string;
  connected: boolean;
  forwards: ForwardedPort[];
  /** Listening on the host but not forwarded (ports below 1024 and the SSH port left out). */
  available: ListeningRemotePort[];
  listing: RemotePortListing;
}

/** Sent when Codara forwards a port on its own, so the renderer can offer to open it. */
export interface PortForwardNotice {
  hostId: string;
  remotePort: number;
  localPort: number;
  url: string;
}
