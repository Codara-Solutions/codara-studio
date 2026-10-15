// Wire format for the share service (the codara-share repository). Pure Node:
// no Electron import, so the unit suite can sign and build requests directly.
//
// Every /v1 request carries the share key, a millisecond timestamp, a
// 24-byte one-time nonce and an Ed25519 signature over:
//
//   codara-share-auth-v1
//   <METHOD>
//   <request target as sent, path and query>
//   <lowercase hex SHA-256 of the body>
//   <timestamp>
//   <nonce>
//   <public key>

import { createHash, randomBytes } from "node:crypto";
import sodium from "sodium-native";
import {
  SHARE_PAGE_ID_PATTERN,
  type ShareExpiryDays,
} from "../../shared/share";

// TODO(owner): confirm the production domain at deploy time. This is a
// placeholder until the codara-share service is deployed next to the relay.
export const DEFAULT_SHARE_BASE_URL = "https://share.codarasolutions.com";

// Tests and staging point Studio at another instance with this variable.
export const SHARE_URL_ENV = "CODARA_SHARE_URL";

const AUTH_DOMAIN = "codara-share-auth-v1";
const NONCE_BYTES = 24;

export interface ShareSigner {
  publicKey: Buffer;
  secretKey: Buffer;
  publicKeyB64: string;
}

export interface ShareHttpRequest {
  url: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body?: Buffer;
}

export interface RemotePage {
  id: string;
  path: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

// The service base URL: the constant, or the env override. An override must
// be https, except plain http on a loopback address for local instances.
export function shareBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[SHARE_URL_ENV] ?? "").trim();
  if (!raw) return DEFAULT_SHARE_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${SHARE_URL_ENV} is not a valid URL.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${SHARE_URL_ENV} must use https (plain http only on a loopback address).`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`${SHARE_URL_ENV} must be a plain base URL.`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function bodySha256(body: Buffer | undefined): string {
  return createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
}

export function canonicalShareMessage(input: {
  method: string;
  target: string;
  bodySha256: string;
  timestamp: number;
  nonce: string;
  key: string;
}): Buffer {
  return Buffer.from(
    [
      AUTH_DOMAIN,
      input.method.toUpperCase(),
      input.target,
      input.bodySha256,
      String(input.timestamp),
      input.nonce,
      input.key,
    ].join("\n"),
    "utf8",
  );
}

export function signShareRequest(
  signer: ShareSigner,
  input: { method: string; target: string; body?: Buffer; timestamp?: number; nonce?: string },
): Record<string, string> {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? randomBytes(NONCE_BYTES).toString("base64");
  const message = canonicalShareMessage({
    method: input.method,
    target: input.target,
    bodySha256: bodySha256(input.body),
    timestamp,
    nonce,
    key: signer.publicKeyB64,
  });
  const signature = Buffer.alloc(64);
  sodium.crypto_sign_detached(signature, message, signer.secretKey);
  return {
    "x-codara-key": signer.publicKeyB64,
    "x-codara-timestamp": String(timestamp),
    "x-codara-nonce": nonce,
    "x-codara-signature": signature.toString("base64"),
  };
}

function signed(
  base: string,
  signer: ShareSigner,
  method: ShareHttpRequest["method"],
  target: string,
  body?: Buffer,
  extraHeaders: Record<string, string> = {},
): ShareHttpRequest {
  return {
    url: `${base}${target}`,
    method,
    headers: { ...extraHeaders, ...signShareRequest(signer, { method, target, ...(body ? { body } : {}) }) },
    ...(body ? { body } : {}),
  };
}

export function createPageRequest(
  base: string,
  signer: ShareSigner,
  html: string,
  ttlDays: ShareExpiryDays,
): ShareHttpRequest {
  return signed(base, signer, "POST", `/v1/pages?ttlDays=${ttlDays}`, Buffer.from(html, "utf8"), {
    "content-type": "text/html; charset=utf-8",
  });
}

export function listPagesRequest(base: string, signer: ShareSigner): ShareHttpRequest {
  return signed(base, signer, "GET", "/v1/pages");
}

export function deletePageRequest(base: string, signer: ShareSigner, id: string): ShareHttpRequest {
  assertPageId(id);
  return signed(base, signer, "DELETE", `/v1/pages/${id}`);
}

export function setExpiryRequest(
  base: string,
  signer: ShareSigner,
  id: string,
  ttlDays: ShareExpiryDays,
): ShareHttpRequest {
  assertPageId(id);
  return signed(base, signer, "PATCH", `/v1/pages/${id}?ttlDays=${ttlDays}`);
}

// The link is built from Studio's own base URL and a validated id, never from
// a URL the service sends back.
export function pageLink(base: string, id: string): string {
  assertPageId(id);
  return `${base}/p/${id}`;
}

export function parseRemotePage(value: unknown): RemotePage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !SHARE_PAGE_ID_PATTERN.test(v.id)) return null;
  if (v.path !== `/p/${v.id}`) return null;
  for (const key of ["size", "createdAt", "expiresAt"] as const) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  }
  return {
    id: v.id,
    path: v.path,
    size: v.size as number,
    createdAt: v.createdAt as number,
    expiresAt: v.expiresAt as number,
  };
}

export function parseRemotePageList(value: unknown): RemotePage[] | null {
  if (typeof value !== "object" || value === null) return null;
  const pages = (value as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return null;
  const parsed: RemotePage[] = [];
  for (const page of pages) {
    const one = parseRemotePage(page);
    if (one) parsed.push(one);
  }
  return parsed;
}

// What the user reads when the service says no. Plain words, no status codes.
export function shareErrorMessage(status: number, code: string | undefined): string {
  if (status === 401) {
    return "The share service did not accept this request. Check that your computer's clock is right, then try again.";
  }
  if (status === 404) return "That shared page no longer exists.";
  if (status === 413) return "This page is larger than 5 MB, the most a shared page can be.";
  if (status === 429 && code === "page_limit") {
    return "You have reached the limit of shared pages. Delete some in Settings, Shared pages, then try again.";
  }
  if (status === 429 && code === "daily_limit") {
    return "You have shared a lot today. Try again tomorrow.";
  }
  if (status === 429) return "The share service is busy. Wait a minute and try again.";
  if (status === 507) return "The share service is full right now. Try again later.";
  if (status === 503) return "The share service is busy. Try again in a moment.";
  return `The share service could not do that (error ${status}).`;
}

function assertPageId(id: string): void {
  if (!SHARE_PAGE_ID_PATTERN.test(id)) throw new Error("Not a shared page id.");
}
