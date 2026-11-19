// The tab's network log in DevTools protocol form, from Firefox's webRequest
// events. Firefox reports a request only to an extension with access to its
// site, so a tab shared with access to its own site shows that site's
// requests; other sites' need access to all sites. Measured in Firefox 160:
// onSendHeaders carries the request headers, onBeforeRedirect the redirect
// response, onResponseStarted the status line, headers, address and cache
// flag, and a redirect keeps its request id. Cookies come out as Chrome's
// do (lib/policy.js redactCdpEvent) unless the tab's cookie switch is on.
// No browser.* here, so the tests run it in Node.

import { mainFrameId } from "./navigation.js";

const TYPES = {
  main_frame: "Document",
  sub_frame: "Document",
  stylesheet: "Stylesheet",
  script: "Script",
  image: "Image",
  imageset: "Image",
  font: "Font",
  media: "Media",
  xmlhttprequest: "Fetch",
  websocket: "WebSocket",
  ping: "Ping",
  csp_report: "CSPViolationReport",
};

/** The protocol's resource type for a webRequest type. */
export function resourceType(type) {
  return TYPES[type] ?? "Other";
}

/** webRequest's header list as the protocol's object; repeated names are joined by newlines, as Chrome does. */
export function headerObject(list) {
  const out = {};
  for (const header of Array.isArray(list) ? list : []) {
    if (typeof header?.name !== "string") continue;
    const value = typeof header.value === "string" ? header.value : "";
    out[header.name] = header.name in out ? `${out[header.name]}\n${value}` : value;
  }
  return out;
}

/** The protocol's frame id for a webRequest frame of a tab. */
export function frameIdOf(details) {
  return details.frameId === 0 ? mainFrameId(details.tabId) : `firefox-frame-${details.tabId}-${details.frameId}`;
}

/**
 * Whether Codara may see a request of a tab: never one to a blocked site
 * (stricter than Chrome, which lists a page's requests to any site), nor
 * one from a page or frame on one, or inside a frame of one.
 */
export function requestVisible(details, isBlocked) {
  if (!Number.isInteger(details?.tabId) || details.tabId < 0 || typeof details.url !== "string" || isBlocked(details.url)) return false;
  if (typeof details.documentUrl === "string" && isBlocked(details.documentUrl)) return false;
  return !(Array.isArray(details.frameAncestors) && details.frameAncestors.some((frame) => typeof frame?.url === "string" && isBlocked(frame.url)));
}

function responseOf(details) {
  const headers = headerObject(details.responseHeaders);
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const line = typeof details.statusLine === "string" ? details.statusLine : "";
  const statusText = line.split(" ").slice(2).join(" ");
  return {
    url: details.url,
    status: details.statusCode,
    statusText,
    headers,
    mimeType: contentType.split(";")[0].trim(),
    protocol: line.split(" ")[0].toLowerCase(),
    ...(typeof details.ip === "string" ? { remoteIPAddress: details.ip } : {}),
    fromDiskCache: details.fromCache === true,
  };
}

/**
 * Network.requestWillBeSent for a request (its headers when Firefox sent
 * them; a cached load has none), with the redirect response that led to
 * it. `loaderId` is the tab's document the request belongs to.
 */
export function requestEvent(details, { headers, redirect, loaderId }) {
  return [
    "Network.requestWillBeSent",
    {
      requestId: String(details.requestId),
      loaderId,
      documentURL: details.type === "main_frame" ? details.url : (details.documentUrl ?? details.url),
      request: { url: details.url, method: details.method, headers: headerObject(headers) },
      timestamp: details.timeStamp / 1000,
      wallTime: details.timeStamp / 1000,
      initiator: { type: "other" },
      type: resourceType(details.type),
      frameId: frameIdOf(details),
      ...(redirect ? { redirectResponse: responseOf(redirect) } : {}),
    },
  ];
}

export function responseEvent(details, loaderId) {
  return [
    "Network.responseReceived",
    { requestId: String(details.requestId), loaderId, timestamp: details.timeStamp / 1000, type: resourceType(details.type), response: responseOf(details), frameId: frameIdOf(details) },
  ];
}

export function finishedEvent(details) {
  return ["Network.loadingFinished", { requestId: String(details.requestId), timestamp: details.timeStamp / 1000 }];
}

export function failedEvent(details) {
  const error = typeof details.error === "string" ? details.error : "failed";
  return [
    "Network.loadingFailed",
    { requestId: String(details.requestId), timestamp: details.timeStamp / 1000, type: resourceType(details.type), errorText: error, canceled: error === "NS_BINDING_ABORTED" },
  ];
}
