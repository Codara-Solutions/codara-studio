"use strict";

// A local stand-in for the studio-feedback service (its docs/feedback-api.md),
// for scripts/test-feedback.cjs and the feedback e2e specs. It answers like
// the real one, keeps what it accepted in memory, and can be told to answer
// the next requests with a rate limit, an outage or nothing at all. Started
// with { adminToken } it also serves the admin routes. Tests never call the
// real service.

const http = require("node:http");

const FIELDS = new Set(["message", "kind", "source", "appVersion", "platform", "contact", "installId"]);
const REQUIRED = ["message", "kind", "source", "appVersion", "platform"];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function invalidField(body) {
  if (typeof body.message !== "string") return "message";
  const message = body.message.trim();
  if (!message || [...message].length > 4000 || CONTROL.test(message)) return "message";
  if (!["bug", "idea", "other"].includes(body.kind)) return "kind";
  if (!["user", "agent"].includes(body.source)) return "source";
  if (typeof body.appVersion !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(body.appVersion)) return "appVersion";
  if (typeof body.platform !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(body.platform)) return "platform";
  if (body.contact !== undefined && body.contact !== null) {
    if (typeof body.contact !== "string" || !/^[^\s@<>()"',;:\\[\]]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(body.contact.trim())) return "contact";
  }
  if (body.installId !== undefined && body.installId !== null) {
    if (typeof body.installId !== "string" || !/^[0-9A-Za-z_-]{8,64}$/.test(body.installId)) return "installId";
  }
  return null;
}

function startFeedbackService(options = {}) {
  const state = {
    items: [],
    requests: [],
    // The next request's answer: null (follow the contract), "rate_limited",
    // "unavailable" or "hang" (never answer).
    next: [],
  };
  const hanging = new Set();
  let counter = 0;

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  // The admin routes: Bearer adminToken, or 503 admin_disabled when the fake
  // was started without one. The cursor is the next item's index.
  function admin(req, res, url, raw) {
    if (!options.adminToken) return send(res, 503, { error: "admin_disabled" });
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
    if (!match || match[1] !== options.adminToken) return send(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    if (url.pathname === "/v1/admin/feedback") {
      if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
      const status = url.searchParams.get("status") ?? "open";
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const start = Number(url.searchParams.get("cursor") ?? "0");
      if (!["open", "done", "all"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(start)) {
        return send(res, 400, { error: "invalid_query" });
      }
      const matching = state.items.filter((item) => status === "all" || item.status === status);
      const page = matching.slice(start, start + limit);
      return send(res, 200, { items: page, nextCursor: start + limit < matching.length ? String(start + limit) : null });
    }
    const id = url.pathname.slice("/v1/admin/feedback/".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return send(res, 400, { error: "invalid_id" });
    const index = state.items.findIndex((item) => item.id === id);
    if (req.method === "PATCH") {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      if (!body || !["open", "done"].includes(body.status) || Object.keys(body).length !== 1) return send(res, 400, { error: "invalid_field", field: "status" });
      if (index < 0) return send(res, 404, { error: "not_found" });
      const item = state.items[index];
      item.doneAt = body.status === "done" ? (item.doneAt ?? new Date(Date.UTC(2026, 10, 15, 13)).toISOString()) : null;
      item.status = body.status;
      return send(res, 200, { item });
    }
    if (req.method === "DELETE") {
      if (index < 0) return send(res, 404, { error: "not_found" });
      const [{ message: _message, contact: _contact, ...deleted }] = state.items.splice(index, 1);
      return send(res, 200, { deleted });
    }
    return send(res, 405, { error: "method_not_allowed" }, { Allow: "PATCH, DELETE" });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://localhost");
      state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw });
      const forced = state.next.shift();
      if (forced === "hang") {
        hanging.add(res);
        return;
      }
      if (forced === "rate_limited") return send(res, 429, { error: "rate_limited" }, { "Retry-After": "1500" });
      if (forced === "unavailable") return send(res, 503, { error: "unavailable" });
      if (url.pathname === "/v1/admin/feedback" || url.pathname.startsWith("/v1/admin/feedback/")) {
        return admin(req, res, url, raw);
      }
      if (url.pathname !== "/v1/feedback") return send(res, 404, { error: "not_found" });
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
      if (!/^application\/json(;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) {
        return send(res, 415, { error: "unsupported_media_type" });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "invalid_json" });
      for (const key of Object.keys(body)) if (!FIELDS.has(key)) return send(res, 400, { error: "unknown_field", field: key });
      for (const key of REQUIRED) if (!(key in body)) return send(res, 400, { error: "missing_field", field: key });
      const field = invalidField(body);
      if (field) return send(res, 400, { error: "invalid_field", field });
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      state.items.unshift({
        id,
        createdAt: new Date(Date.UTC(2026, 10, 15, 12, 0, counter)).toISOString(),
        kind: body.kind,
        source: body.source,
        message: body.message.trim(),
        appVersion: body.appVersion,
        platform: body.platform,
        contact: typeof body.contact === "string" ? body.contact.trim() : null,
        installId: body.installId ?? null,
        status: "open",
        doneAt: null,
      });
      send(res, 201, { id });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise((done) => {
            for (const res of hanging) res.destroy();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startFeedbackService };
