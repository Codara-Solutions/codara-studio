// The wire format between Codara and its browser extension
// (extensions/chrome/). One WebSocket per browser profile at
// ws://127.0.0.1:<port>/codara-chrome; every frame is one JSON object.
//
//   ext -> {type:"hello", protocol, browser, extension, linkId?, nonce?, pair, pairCommit?}
//   codara -> {type:"challenge", nonce, proof}                 known linkId
//   ext -> {type:"auth", proof}
//   codara -> {type:"welcome", protocol, linkId, app}          the proof matched
//   codara -> {type:"pairing", key}                            pair asked, not paired
//   ext -> {type:"pair_key", key}
//   codara -> {type:"paired", linkId, app}                     the user allowed it
//   codara -> {type:"denied", message} | {type:"unpaired"}     then close
//
// The token never crosses the socket. Pairing is an ECDH exchange (P-256):
// the extension commits to its key in the hello and reveals it only after
// Codara sent its own, and both sides show a code made from both keys, so a
// program relaying the exchange (one on an earlier port of the range) gets
// two different codes and cannot pick keys that make them agree. Both sides
// derive the token from the shared secret. Later connections prove the
// pairing both ways with an HMAC over both nonces (linkProof); the extension
// checks Codara's proof before it answers.
//
// Every frame after welcome or paired is sealed with AES-256-GCM under a key
// derived from the pairing secret and that handshake's nonces (or keys), one
// counter per direction (LinkSealer). A program relaying the handshake can
// neither read the session nor add, drop, replay or reorder a frame: the
// first frame that does not open ends the link.
//
// After that the extension reports the tabs the user shared ("tabs"),
// relays chrome.debugger events ("cdp_event", "detached") and answers
// Codara's requests ({id, type, ...} -> {id, result} | {id, error}). Codara
// tells it which agent used a tab ("usage") and can revoke the pairing.

import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CHROME_LINK_PROTOCOL = 2;
export const CHROME_LINK_PORTS: readonly number[] = [47615, 47616, 47617, 47618, 47619];
export const CHROME_LINK_PATH = "/codara-chrome";
/** chrome-extension://<32 letters a-p>; Edge, Brave and the other Chromium browsers send the same. */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
export const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export interface ChromeBrowserInfo {
  name: string;
  version: string;
}

/** A tab the user shared, as the extension reports it. A blocked tab carries no URL or title. */
export interface ChromeTabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  attached: boolean;
  blocked: boolean;
  /** The user allowed cookie and storage access for this tab. */
  storage: boolean;
  openedByAgent: boolean;
}

export type ChromeRequestType = "attach" | "detach" | "cdp" | "open" | "close" | "activate";

export interface ExtensionHello {
  type: "hello";
  protocol: number;
  browser: ChromeBrowserInfo;
  extension: { id: string; version: string };
  linkId?: string;
  nonce?: string;
  pair?: boolean;
}

export const LINK_NONCE = /^[0-9a-f]{32,128}$/;

/**
 * HMAC-SHA256 keyed by the pairing secret (the hex SHA-256 of the token,
 * which is what Codara stores). `role` keeps Codara's proofs from ever
 * serving as the extension's. extensions/chrome/lib/policy.js computes the
 * same.
 */
export function linkProof(secretHex: string, role: "codara" | "browser", first: string, second: string): string {
  return createHmac("sha256", secretHex).update(`${role}|${first}|${second}`).digest("hex");
}

export function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

/** An uncompressed P-256 public key, hex. */
export const LINK_PUBLIC_KEY = /^04[0-9a-f]{128}$/;
export const LINK_COMMIT = /^[0-9a-f]{64}$/;

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** What the extension sends in its hello before it reveals its key. */
export function pairCommitment(extensionKey: string): string {
  return sha256(`codara-pair-commit|${extensionKey}`).toString("hex");
}

/** "483 921": six digits from both keys, grouped so both screens read the same at a glance. */
export function pairingCode(extensionKey: string, codaraKey: string): string {
  const digits = String(sha256(`codara-pair-code|${extensionKey}|${codaraKey}`).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** The token both sides derive from the ECDH shared secret (hex). */
export function pairedToken(sharedHex: string, extensionKey: string, codaraKey: string): string {
  return createHmac("sha256", sharedHex).update(`codara-pair-token|${extensionKey}|${codaraKey}`).digest("hex");
}

/** The session key for the frames after a handshake, from the pairing secret (hex SHA-256 of the token). */
export function linkSessionKey(secretHex: string, first: string, second: string): Buffer {
  return createHmac("sha256", secretHex).update(`codara-session|${first}|${second}`).digest();
}

export class LinkSealError extends Error {}

/**
 * AES-256-GCM over each frame. The IV is the sender's direction and its
 * frame count, so a frame opens only as the next one from the other side.
 * extensions/chrome/lib/link-client.js does the same with WebCrypto.
 */
export class LinkSealer {
  private sent = 0n;
  private received = 0n;

  constructor(private readonly key: Buffer, private readonly role: "codara" | "browser") {}

  private iv(role: "codara" | "browser", count: bigint): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(role === "codara" ? 0 : 1, 0);
    iv.writeBigUInt64BE(count, 4);
    return iv;
  }

  seal(message: Record<string, unknown>): string {
    const cipher = createCipheriv("aes-256-gcm", this.key, this.iv(this.role, this.sent++));
    const body = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ sealed: body.toString("base64") });
  }

  /** The next frame from the other side; throws LinkSealError for anything else. */
  open(frame: unknown): Record<string, unknown> {
    const sealed = frame && typeof frame === "object" ? (frame as { sealed?: unknown }).sealed : undefined;
    if (typeof sealed !== "string") throw new LinkSealError("an unsealed frame");
    const body = Buffer.from(sealed, "base64");
    if (body.length < 16) throw new LinkSealError("a short frame");
    let text: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, this.iv(this.role === "codara" ? "browser" : "codara", this.received));
      decipher.setAuthTag(body.subarray(body.length - 16));
      text = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      throw new LinkSealError("a frame that does not open");
    }
    this.received += 1n;
    const message = JSON.parse(text) as unknown;
    if (!message || typeof message !== "object") throw new LinkSealError("a frame that is not an object");
    return message as Record<string, unknown>;
  }
}

/** A short id for one paired browser, used in chrome:<linkId>/<tabId>. */
export function linkIdFor(browserName: string, taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const base = browserName.toLowerCase().replace(/^(google|microsoft)\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "browser";
  for (;;) {
    const id = `${base}-${Math.floor(random() * 0x10000).toString(16).padStart(4, "0")}`;
    if (!taken.has(id)) return id;
  }
}

export function sanitizeBrowserInfo(value: unknown): ChromeBrowserInfo {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (input: unknown, max: number) => (typeof input === "string" ? input.replace(/[^\w .()-]/g, "").slice(0, max) : "");
  return { name: text(raw.name, 40) || "Chromium", version: text(raw.version, 24) };
}

export function sanitizeTabs(value: unknown): ChromeTabInfo[] {
  if (!Array.isArray(value)) return [];
  const out: ChromeTabInfo[] = [];
  for (const raw of value.slice(0, 1000)) {
    if (!raw || typeof raw !== "object") continue;
    const tab = raw as Record<string, unknown>;
    if (typeof tab.tabId !== "number" || !Number.isInteger(tab.tabId) || tab.tabId < 0) continue;
    out.push({
      tabId: tab.tabId,
      windowId: typeof tab.windowId === "number" ? tab.windowId : -1,
      url: typeof tab.url === "string" ? tab.url.slice(0, 4096) : "",
      title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "",
      active: tab.active === true,
      attached: tab.attached === true,
      blocked: tab.blocked === true,
      storage: tab.storage === true,
      openedByAgent: tab.openedByAgent === true,
    });
  }
  return out;
}
