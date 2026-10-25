"use strict";
// Pages with known audit and performance problems, served over loopback
// HTTP for scripts/test-browser-insight.cjs and the preview-insight e2e
// spec: /a11y (contrast, labels, alt text, button names), /quality
// (render-blocking script, oversized image, console error, failed request,
// missing meta tags, broken JSON-LD) and /perf (a long task while loading,
// a late layout shift, a slow click handler, a retained array and detached
// DOM nodes).
//
//   const fixture = await startInsightFixture();   // { origin, close }

const http = require("node:http");
const zlib = require("node:zlib");

// A solid-colour PNG, large enough to be "much larger than shown".
function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([(x * 7) & 255, (x * 3) & 255, 160], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAGES = {
  "/a11y": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A11y</title>
    <style>.faint { color: #aaa; background: #fff; font-size: 12px; }</style></head>
    <body><main>
      <h1>Accessibility fixture</h1>
      <p class="faint" id="faint">Barely readable text</p>
      <input id="nolabel" type="text">
      <img src="/pixel.png" width="10" height="10">
      <button id="empty"></button>
      <label for="ok">Name</label><input id="ok" type="text">
    </main></body></html>`,
  "/quality": `<!doctype html><html><head><meta charset="utf-8"><title>Quality</title>
    <script src="/slow.js"></script>
    <script type="application/ld+json">{ not json</script></head>
    <body>
      <h1>Quality fixture</h1>
      <img id="big" src="/big.png" style="width: 100px; height: 75px" alt="Big">
      <a href="/more" id="generic">click here</a>
      <a href="javascript:void(0)" id="jslink">Open</a>
      <script>console.error("fixture failure"); fetch("/missing").catch(() => {});</script>
    </body></html>`,
  "/perf": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Perf</title>
    <style>body { margin: 0; font: 18px sans-serif } h1 { margin: 0 } #content { padding: 8px } #banner { height: 140px; background: #fc0 }</style></head>
    <body>
      <div id="slot"></div>
      <main id="content">
        <h1 id="headline">Performance fixture</h1>
        <p id="story">${"A long paragraph that is the largest piece of text on this page. ".repeat(30)}</p>
        <button id="slow">Slow button</button>
      </main>
      <script>
        // Chromium leaves out a shift within 500 ms of a viewport resize, as it
        // does after input (hadRecentInput). A page in Codara's <webview> gets
        // one as it starts, queued behind the long task below, so a banner
        // 250 ms after the first paint landed on that edge and counted or not
        // by a few milliseconds.
        let resizedAt = 0;
        addEventListener("resize", () => { resizedAt = performance.now(); });
        const begin = performance.now(); while (performance.now() - begin < 120) {}
        // Shifts count only against content already painted.
        new PerformanceObserver((list, observer) => {
          if (!list.getEntriesByName("first-contentful-paint").length) return;
          observer.disconnect();
          const insert = () => {
            const wait = resizedAt + 600 - performance.now();
            if (wait > 0) return void setTimeout(insert, wait);
            const banner = document.createElement("div"); banner.id = "banner"; banner.textContent = "Banner"; document.getElementById("slot").appendChild(banner);
          };
          setTimeout(insert, 250);
        }).observe({ type: "paint", buffered: true });
        document.getElementById("slow").addEventListener("click", () => {
          const start = performance.now(); while (performance.now() - start < 300) {}
          document.getElementById("headline").textContent = "Clicked";
        });
        window.leaky = []; for (let i = 0; i < 20000; i++) window.leaky.push({ index: i, label: "item " + i });
        window.detachedNodes = []; for (let i = 0; i < 5; i++) { const div = document.createElement("div"); document.body.appendChild(div); div.remove(); window.detachedNodes.push(div); }
      </script>
    </body></html>`,
};

function startInsightFixture() {
  const big = png(1600, 1200);
  const pixel = png(10, 10);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (PAGES[url.pathname]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGES[url.pathname]);
    } else if (url.pathname === "/slow.js") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(`window.slowLoaded = true;${" ".repeat(3000)}`);
      }, 600);
    } else if (url.pathname === "/big.png" || url.pathname === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png", "timing-allow-origin": "*" });
      res.end(url.pathname === "/big.png" ? big : pixel);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
  })));
}

module.exports = { startInsightFixture, PAGES };
