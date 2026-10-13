"use strict";
// A small site for the browser DevTools tools (network detail, emulation,
// storage), shared by scripts/test-browser-devtools.cjs and
// tests/e2e/preview-devtools.spec.ts. The secrets it hands out (a session
// cookie and a bearer token) never appear in its own HTML, so a check that
// they are redacted cannot be fooled by a response body that quotes them.
//
//   const site = await startDevtoolsSite();   // site.origin, site.close()

const http = require("node:http");

const SESSION_COOKIE = "secret-session";
const BEARER = "tok-123";
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function route(req, res) {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html", "set-cookie": `sid=${SESSION_COOKIE}; Path=/; HttpOnly` });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>devtools fixture</title>
<h1>Fixture</h1><img src="/pixel.png" alt="pixel"><script>
  window.__done = Promise.allSettled([
    fetch("/api/data.json").then((r) => r.json()),
    fetch("/api/missing").then((r) => r.text()),
    fetch("/redirect").then((r) => r.text()),
    fetch("/api/echo", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ["tok", "123"].join("-") }, body: JSON.stringify({ hello: "world" }) }).then((r) => r.text()),
    fetch("http://127.0.0.1:9/unreachable"),
  ]).then(() => true);
</script>`);
    return;
  }
  if (url.pathname === "/api/data.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [1, 2, 3], big: "x".repeat(6000) }));
    return;
  }
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/api/data.json?via=redirect" });
    res.end();
    return;
  }
  if (url.pathname === "/api/echo") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: body }));
    });
    return;
  }
  if (url.pathname === "/pixel.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PIXEL);
    return;
  }
  if (url.pathname === "/slow") {
    // Still in flight when a test navigates the page away.
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("slow");
    }, 5_000).unref();
    return;
  }
  if (url.pathname === "/ua") {
    // A phone lays out a page without a viewport meta tag 980px wide.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>ua</title><body>${String(req.headers["user-agent"] ?? "").replace(/</g, "")}</body>`);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not here");
}

async function startDevtoolsSite() {
  const server = http.createServer(route);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

module.exports = { startDevtoolsSite, SESSION_COOKIE, BEARER, PIXEL_BYTES: PIXEL.length };
