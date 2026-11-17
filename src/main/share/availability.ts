// Where the share service is, and whether Studio may offer Share as link at
// all. No sodium and no Electron import: ipc.ts reads the status at startup
// without loading the signing stack, and the unit suite reads it directly.

import { SHARE_UNAVAILABLE_MESSAGE, type ShareStatus } from "../../shared/share";

// The production address of the codara-share service (docs/share-links.md).
export const DEFAULT_SHARE_BASE_URL = "https://share.codarasolutions.com";

// Turn on only once DEFAULT_SHARE_BASE_URL resolves and answers GET /health.
// While it is off, Studio hides Share as link and refuses agent offers, unless
// CODARA_SHARE_URL names another instance (tests, staging, a local service).
export const SHARE_SERVICE_LIVE = false;

// Tests and staging point Studio at another instance with this variable.
export const SHARE_URL_ENV = "CODARA_SHARE_URL";

// The service base URL: the env override, or the constant while the service is
// live. An override must be https, except plain http on a loopback address for
// local instances.
export function shareBaseUrl(env: NodeJS.ProcessEnv = process.env, live: boolean = SHARE_SERVICE_LIVE): string {
  const raw = (env[SHARE_URL_ENV] ?? "").trim();
  if (!raw) {
    if (!live) throw new Error(SHARE_UNAVAILABLE_MESSAGE);
    return DEFAULT_SHARE_BASE_URL;
  }
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

export function shareServiceStatus(
  env: NodeJS.ProcessEnv = process.env,
  live: boolean = SHARE_SERVICE_LIVE,
): ShareStatus {
  try {
    shareBaseUrl(env, live);
    return { available: true };
  } catch (err) {
    return { available: false, message: err instanceof Error ? err.message : SHARE_UNAVAILABLE_MESSAGE };
  }
}
