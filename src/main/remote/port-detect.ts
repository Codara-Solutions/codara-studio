// Pure helpers of SSH port forwarding (port-forwarding.ts): local URLs in a
// remote terminal's output, the remote host's listening TCP ports, and the
// local port a forward binds. No I/O, so scripts/test-remote-port-forward.cjs
// covers them directly.

import type { ListeningRemotePort, RemotePortListing } from "@shared/port-forwarding";
import { completeLines, findLocalUrls } from "../servers/detect";

// Codara reaches the remote through sshd only and listens on nothing there.
// Keep any port a later remote helper of Codara binds in this set.
export const CODARA_REMOTE_PORTS: ReadonlySet<number> = new Set([22]);

// The listening-port poll forwards only ports in [1024, 32768): below is the
// system's, above is where the kernels hand out ephemeral ports (Linux from
// 32768, macOS from 49152), used by language servers, debuggers and agent
// CLIs' sign-in callbacks rather than by dev servers. Terminal output can
// still name any of them.
const FIRST_UNPRIVILEGED_PORT = 1024;
const FIRST_EPHEMERAL_PORT = 32_768;

// Agent CLIs listen for their own sign-in callbacks; sshd is the transport.
const IGNORED_PROCESS = /^(?:sshd|ssh-agent|claude|codex|grok)$/i;

const NEARBY_PORTS = 10;
// 80 becomes 8080, 443 becomes 8443 when a low port cannot be bound locally.
const LOW_PORT_OFFSET = 8000;
const SCAN_CARRY = 4_096;

// ── Terminal output ──────────────────────────────────────────────────────────

export interface TerminalPortUrl {
  port: number;
  /** The host as printed: localhost, 127.0.0.1, ::1, app.localhost (0.0.0.0 and :: read as localhost). */
  host: string;
  scheme: "http" | "https";
  /** Path and query as printed, "/" when none. */
  path: string;
}

/** Local URLs with an explicit port in finished lines of terminal output. */
export function terminalPortUrls(text: string): TerminalPortUrl[] {
  const found: TerminalPortUrl[] = [];
  const seen = new Set<number>();
  for (const { url } of findLocalUrls(text)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    // "http://localhost/" names no port of its own; :80 printed explicitly does.
    if (!/^https?:\/\/[^/]*:\d+/i.test(url)) continue;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (seen.has(port)) continue;
    seen.add(port);
    found.push({
      port,
      host: parsed.hostname.replace(/^\[|\]$/g, ""),
      scheme: parsed.protocol === "https:" ? "https" : "http",
      path: `${parsed.pathname || "/"}${parsed.search}`,
    });
  }
  return found;
}

/**
 * Feeds one pane's output stream and returns the URLs on lines that ended.
 * A URL on the last line may still be arriving ("http://localhost:5" then
 * "173/"), so that line waits for the next chunk.
 */
export class TerminalPortScanner {
  private carry = "";

  push(chunk: string): TerminalPortUrl[] {
    const text = this.carry + chunk;
    const complete = completeLines(text);
    this.carry = text.slice(complete.length).slice(-SCAN_CARRY);
    // Agent CLIs redraw their screens many times a second; only output that
    // can hold a URL is parsed.
    if (!complete.includes("://")) return [];
    return terminalPortUrls(complete);
  }
}

// ── Listening ports on the remote host ───────────────────────────────────────

/**
 * Run with `sh -s` and this as stdin, so the user's login shell (fish, csh)
 * never parses it. Prints "@<tool>" then that tool's listing, or "@none".
 * Linux: ss, else netstat, else /proc/net/tcp; macOS and BSD: lsof, else
 * netstat. A tool that prints nothing (ss without netlink access) falls
 * through to the next.
 */
export const REMOTE_LISTEN_SCRIPT = `has() { command -v "$1" >/dev/null 2>&1; }
out() { if [ -n "$2" ]; then printf '@%s\\n%s\\n' "$1" "$2"; exit 0; fi; }
case "$(uname -s 2>/dev/null)" in
  Darwin|*BSD|DragonFly)
    if has lsof; then out lsof "$(lsof -nP +c 0 -iTCP -sTCP:LISTEN 2>/dev/null)"; fi
    if has netstat; then out netstat "$(netstat -an -p tcp 2>/dev/null)"; fi
    ;;
  *)
    if has ss; then out ss "$(ss -ltnpH 2>/dev/null || ss -ltnp 2>/dev/null)"; fi
    if has netstat; then out netstat "$(netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null)"; fi
    if [ -r /proc/net/tcp ]; then out proc "$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null)"; fi
    if has lsof; then out lsof "$(lsof -nP +c 0 -iTCP -sTCP:LISTEN 2>/dev/null)"; fi
    ;;
esac
echo @none
`;

export interface ListeningPorts {
  listing: Exclude<RemotePortListing, "pending">;
  ports: ListeningRemotePort[];
}

interface RawListen {
  address: string;
  port: number;
  process?: string;
  pid?: number;
}

/** "[::1]:5173", "127.0.0.53%lo:53", ":::22", "*:8080" (colon form, ss and Linux netstat). */
function splitColon(value: string): { address: string; port: number } | null {
  const match = /^(.*):(\d{1,5})$/.exec(value);
  if (!match) return null;
  return { address: cleanAddress(match[1]), port: Number(match[2]) };
}

/** "127.0.0.1.5173", "::1.5173", "*.8080" (dot form, BSD and macOS netstat). */
function splitDot(value: string): { address: string; port: number } | null {
  const match = /^(.*)\.(\d{1,5})$/.exec(value);
  if (!match) return null;
  return { address: cleanAddress(match[1]), port: Number(match[2]) };
}

function cleanAddress(raw: string): string {
  const address = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return address || "*";
}

function parseSs(lines: string[]): RawListen[] {
  const out: RawListen[] = [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    const state = tokens.indexOf("LISTEN");
    if (state < 0 || tokens.length < state + 4) continue;
    const local = splitColon(tokens[state + 3]);
    if (!local) continue;
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push({ ...local, ...(users ? { process: users[1], pid: Number(users[2]) } : {}) });
  }
  return out;
}

function parseNetstat(lines: string[]): RawListen[] {
  const out: RawListen[] = [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (!/^tcp/i.test(tokens[0] ?? "") || !tokens.includes("LISTEN")) continue;
    const local = tokens[3] ?? "";
    // Linux prints host:port, BSD and macOS host.port ("::1.5173").
    const parsed = /:(\d{1,5})$/.test(local) ? splitColon(local) : splitDot(local);
    if (!parsed) continue;
    const program = /^(\d+)\/(\S+)$/.exec(tokens[tokens.indexOf("LISTEN") + 1] ?? "");
    out.push({ ...parsed, ...(program ? { pid: Number(program[1]), process: program[2] } : {}) });
  }
  return out;
}

function parseLsof(lines: string[]): RawListen[] {
  const out: RawListen[] = [];
  for (const line of lines) {
    const match = /^(\S+)\s+(\d+)\s.*\sTCP\s+(\S+)\s+\(LISTEN\)/.exec(line);
    if (!match) continue;
    const local = splitColon(match[3]);
    if (!local) continue;
    // lsof writes a space inside a command name as \x20.
    const process = match[1].replace(/\\x([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    out.push({ ...local, process, pid: Number(match[2]) });
  }
  return out;
}

function procIpv4(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes.reverse().map((byte) => parseInt(byte, 16)).join(".");
}

function procIpv6(hex: string): string {
  // Four 32-bit words, each in host (little-endian) byte order.
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse());
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(parseInt(`${bytes[i]}${bytes[i + 1]}`, 16).toString(16));
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    return `::ffff:${procIpv4(words[3] ?? "")}`;
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestLength < 2) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
}

function parseProc(lines: string[]): RawListen[] {
  const out: RawListen[] = [];
  for (const line of lines) {
    const match = /^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+[0-9A-F]+:[0-9A-F]{4}\s+([0-9A-F]{2})\s/i.exec(line);
    // 0A is TCP_LISTEN.
    if (!match || match[3].toUpperCase() !== "0A") continue;
    const address = match[1].length === 8 ? procIpv4(match[1]) : match[1].length === 32 ? procIpv6(match[1]) : null;
    if (!address) continue;
    out.push({ address, port: parseInt(match[2], 16) });
  }
  return out;
}

/** The output of REMOTE_LISTEN_SCRIPT as one entry per port, in port order. */
export function parseListeningPorts(output: string): ListeningPorts {
  const lines = output.split(/\r?\n/);
  const markerAt = lines.findIndex((line) => /^@(ss|netstat|lsof|proc|none)\s*$/.test(line));
  const marker = markerAt >= 0 ? lines[markerAt].trim().slice(1) : "none";
  const body = markerAt >= 0 ? lines.slice(markerAt + 1) : [];
  const listing = marker as ListeningPorts["listing"];
  const raw =
    listing === "ss"
      ? parseSs(body)
      : listing === "netstat"
        ? parseNetstat(body)
        : listing === "lsof"
          ? parseLsof(body)
          : listing === "proc"
            ? parseProc(body)
            : [];
  const byPort = new Map<number, ListeningRemotePort>();
  for (const entry of raw) {
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65_535) continue;
    const current = byPort.get(entry.port) ?? { port: entry.port, addresses: [] };
    if (!current.addresses.includes(entry.address)) current.addresses.push(entry.address);
    if (entry.process && !current.process) current.process = entry.process;
    if (entry.pid && !current.pid) current.pid = entry.pid;
    byPort.set(entry.port, current);
  }
  return { listing, ports: [...byPort.values()].sort((a, b) => a.port - b.port) };
}

// ── What to forward, and where ───────────────────────────────────────────────

function isIpv4Loopback(address: string): boolean {
  return /^127\./.test(address) || /^::ffff:127\./i.test(address);
}

function isWildcard(address: string): boolean {
  return address === "*" || address === "0.0.0.0" || address === "::";
}

/**
 * The address the remote end of a forward connects to. A server bound to an
 * IPv4 loopback or wildcard address gets 127.0.0.1, one only on ::1 (Vite on
 * some Node versions) gets ::1, one bound to a single interface gets that
 * address. With nothing listed, the URL's own host decides, and "localhost"
 * lets sshd try each address it resolves to.
 */
export function forwardTargetHost(addresses: readonly string[], printedHost?: string): string {
  if (addresses.some((address) => isIpv4Loopback(address) || address === "*" || address === "0.0.0.0")) {
    return "127.0.0.1";
  }
  if (addresses.some((address) => address === "::1" || address === "::")) return "::1";
  const specific = addresses.find((address) => address && !isWildcard(address));
  if (specific) return specific;
  const host = (printedHost ?? "").toLowerCase();
  if (host === "127.0.0.1" || host === "::1") return host;
  return "localhost";
}

export interface RemotePortContext {
  /** The SSH port of the host's config. */
  sshPort: number | null;
}

/** May a port named in terminal output be forwarded? Everything but SSH and Codara's own. */
export function terminalPortAllowed(port: number, context: RemotePortContext): boolean {
  return port >= 1 && port <= 65_535 && port !== context.sshPort && !CODARA_REMOTE_PORTS.has(port);
}

/** Is a port that started listening on the host one to forward without being asked? */
export function listeningPortAutoForwards(entry: ListeningRemotePort, context: RemotePortContext): boolean {
  if (entry.port < FIRST_UNPRIVILEGED_PORT || entry.port >= FIRST_EPHEMERAL_PORT) return false;
  if (!terminalPortAllowed(entry.port, context)) return false;
  return !(entry.process && IGNORED_PROCESS.test(entry.process));
}

/** Is a listening port worth offering in the Ports list? */
export function listeningPortOffered(entry: ListeningRemotePort, context: RemotePortContext): boolean {
  if (entry.port < FIRST_UNPRIVILEGED_PORT || !terminalPortAllowed(entry.port, context)) return false;
  return !(entry.process && /^sshd$/i.test(entry.process));
}

/**
 * Local ports to try for a remote port, in order: the one a restored forward
 * had, the same number, the next ten, for a port below 1024 the same plus
 * 8000 and its next ten, then 0 (any free port the system picks).
 */
export function candidateLocalPorts(
  remotePort: number,
  options: { preferred?: number | null; reserved?: ReadonlySet<number> } = {},
): number[] {
  const reserved = options.reserved ?? new Set<number>();
  const out: number[] = [];
  const add = (port: number) => {
    if (Number.isInteger(port) && port >= 1 && port <= 65_535 && !reserved.has(port) && !out.includes(port)) {
      out.push(port);
    }
  };
  if (options.preferred) add(options.preferred);
  add(remotePort);
  for (let offset = 1; offset <= NEARBY_PORTS; offset += 1) add(remotePort + offset);
  if (remotePort < FIRST_UNPRIVILEGED_PORT) {
    for (let offset = 0; offset <= NEARBY_PORTS; offset += 1) add(remotePort + LOW_PORT_OFFSET + offset);
  }
  out.push(0);
  return out;
}

/**
 * Binds the first candidate that works. `bind` resolves null when a port is
 * taken; the result is null only when every candidate, 0 included, failed.
 */
export async function bindFirstFree<T>(
  candidates: readonly number[],
  bind: (port: number) => Promise<T | null>,
): Promise<{ port: number; value: T } | null> {
  for (const port of candidates) {
    const value = await bind(port);
    if (value !== null) return { port, value };
  }
  return null;
}

/** The URL for a forward's local port, keeping the scheme and path the server printed. */
export function localForwardUrl(scheme: "http" | "https", localPort: number, path = "/"): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${scheme}://localhost:${localPort}${suffix}`;
}
