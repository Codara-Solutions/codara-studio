// Raw CDP: does Debugger.setSkipAllPauses survive a navigation?
const http = require("node:http");
const path = require("node:path");
const { startCdpChromium } = require(path.join(process.cwd(), "scripts/fixtures/cdp-chromium.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/debugger" ? `<script>window.reached = false; setTimeout(() => { debugger; window.reached = true; }, 50);</script>` : `<p>app</p>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromium = await startCdpChromium();
  const { targetId } = await chromium.newPage(`${origin}/app`);
  const t = chromium.transportFor(targetId);
  const events = [];
  t.onEvent((method, params) => { if (/Debugger.paused|Debugger.resumed|Target/.test(method)) events.push(method + (params.reason ? `:${params.reason}` : "")); });
  await t.attach();
  t.onEvent((method, params) => { if (/Debugger.paused|Debugger.resumed|Target/.test(method)) events.push(method + (params.reason ? `:${params.reason}` : "")); });
  await sleep(500);
  const ev = async (expression) => (await t.send("Runtime.evaluate", { expression, returnByValue: true, timeout: 2000 })).result.value;
  console.log("enable", JSON.stringify(await t.send("Debugger.enable", {})).slice(0, 80));
  console.log("skip", JSON.stringify(await t.send("Debugger.setSkipAllPauses", { skip: true }).catch((e) => e.message)));
  await t.send("Page.navigate", { url: `${origin}/debugger` });
  await sleep(800);
  const reached = await Promise.race([ev("window.reached"), sleep(3000).then(() => "evaluate hung (paused)")]);
  console.log("same-tab navigate: reached =", reached, "events:", events.join(","));
  await t.send("Debugger.resume").catch(() => {});
  server.close();
  await chromium.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
