import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An MP4 recording of a page while it scrolls, through the real recorder and
// encoder (the agent's preview.record, which the Record button shares),
// judged frame by frame against lossless screenshots of the same scroll
// positions. The page is small text at 9 to 12 px on white, on a light
// gradient and on a dark radial one, scrolled slowly, then fast, then at a
// medium speed. A bar of black and white squares pinned to its corner spells
// the scroll position in binary, so every decoded frame names the screenshot
// it must match. Only the worst frame counts: a still frame is easy, a frame
// in the middle of a scroll is where H.264 at too few bits turns text into
// blocks.
//
// Measured on Linux (OpenH264) on an 886x830 tab:
// - as camera video (before): worst frame 23.8 dB, worst block 29.9, and
//   from the fast scroll to the end every frame stayed near 24 dB, since a
//   page that stops sends no more frames to sharpen;
// - as screen content (now): worst frame 36.5 dB, worst block 8.7, the
//   same as the first keyframe; half the bytes (6.0 MB a minute, was 12.5).
// RECORD_SCROLL_OUT=<dir> keeps the video, the worst frame, every reference
// screenshot and the per-frame numbers.
//
// Runs locally with the other recorder specs (npx playwright test
// tests/e2e/preview-record-scroll.spec.ts, after npm run build); CI's macOS
// job runs unit suites only.

const BITS = 13;
const BIT = 16;
const PAD = 4;
/** The pinned code's corner, left out of every comparison. */
const CODE = { width: PAD * 2 + BITS * BIT + 4, height: PAD * 2 + BIT + 4 };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Record scroll</title>
<style>
html{scrollbar-width:none}
::-webkit-scrollbar{display:none}
html,body{margin:0}
body{font-family:system-ui,sans-serif;background:#fff;color:#1d2330}
#code{position:fixed;left:0;top:0;display:flex;padding:${PAD}px;background:#808080;z-index:9}
#code i{display:block;width:${BIT}px;height:${BIT}px;background:#000}
#code i.on{background:#fff}
.band{height:200px;background:linear-gradient(100deg,#f6f8fc,#dfe7f7 35%,#b8c7ea 70%,#8fa6dc)}
.light{padding:20px 32px;background:linear-gradient(180deg,#ffffff,#eef2fa)}
.dark{padding:20px 32px;background:radial-gradient(ellipse at 30% 30%,#2c3458 0%,#141a33 45%,#070912 80%);color:#d7deea}
p{margin:0 0 6px;max-width:1000px}
.s9{font-size:9px;line-height:1.4}.s10{font-size:10px;line-height:1.4}.s11{font-size:11px;line-height:1.4}.s12{font-size:12px;line-height:1.45}
.muted{color:#6b7385}.dark .muted{color:#9aa6bd}
code{font:11px ui-monospace,monospace}
</style></head><body>
<div id="code"></div>
<div id="page"></div>
<script>
const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat 0123456789 duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur".split(" ");
let seed = 3;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const paragraph = (n) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(" ");
let html = "";
for (let s = 0; s < 6; s += 1) {
  html += '<div class="band"></div><div class="' + (s % 2 ? "dark" : "light") + '">';
  for (const size of [9, 10, 11, 12]) for (let k = 0; k < 3; k += 1) html += '<p class="s' + size + (k === 1 ? " muted" : "") + '">' + paragraph(60) + "</p>";
  html += "<p><code>const value = items.filter((item) =&gt; item.size &gt; 12).map(String); // {[ ]} @#%&amp;*</code></p></div>";
}
document.getElementById("page").innerHTML = html;
const code = document.getElementById("code");
for (let i = 0; i < ${BITS}; i += 1) code.append(document.createElement("i"));
const show = (y) => { for (let i = 0; i < ${BITS}; i += 1) code.children[i].className = (y >> i) & 1 ? "on" : ""; };
const go = (y) => { scrollTo(0, y); show(y); };
show(0);
// Still, slow, still, fast, still, medium, still: one position per paint.
const plan = [];
let y = 0;
const hold = (ms) => plan.push({ y, ms });
const scroll = (steps, dy) => { for (let i = 0; i < steps; i += 1) { y += dy; plan.push({ y, ms: 0 }); } };
hold(700); scroll(40, 8); hold(600); scroll(25, 40); hold(600); scroll(30, 16); hold(1000);
window.positions = [...new Set([0, ...plan.map((step) => step.y)])];
window.go = go;
window.runScroll = async () => {
  for (const step of plan) {
    go(step.y);
    await new Promise((done) => requestAnimationFrame(() => done()));
    if (step.ms) await new Promise((done) => setTimeout(done, step.ms));
  }
};
</script>
</body></html>`;

/** Decodes the MP4 in the tab and compares each frame with the screenshot its code names. */
const JUDGE = `async ({ video: src, refs, code, bits, bit, pad }) => {
  // The recorder's MP4: one track, every sample in one chunk (video-mux.ts).
  const file = new DataView(await (await fetch(src)).arrayBuffer());
  const boxes = (from, to) => {
    const found = {};
    for (let at = from; at + 8 <= to; ) {
      const size = file.getUint32(at);
      const type = String.fromCharCode(file.getUint8(at + 4), file.getUint8(at + 5), file.getUint8(at + 6), file.getUint8(at + 7));
      found[type] = { start: at + 8, end: at + size };
      at += size;
    }
    return found;
  };
  let level = boxes(0, file.byteLength);
  for (const name of ["moov", "trak", "mdia", "minf", "stbl"]) level = boxes(level[name].start, level[name].end);
  const stbl = level;
  // stsd: a full box with an entry count, then avc1, whose 78-byte header precedes avcC.
  const avc1 = boxes(stbl.stsd.start + 8, stbl.stsd.end).avc1;
  const avcC = boxes(avc1.start + 78, avc1.end).avcC;
  const description = new Uint8Array(file.buffer, avcC.start, avcC.end - avcC.start).slice();
  const hex = (i) => description[i].toString(16).padStart(2, "0");
  const count = file.getUint32(stbl.stsz.start + 8);
  const sizes = Array.from({ length: count }, (_, i) => file.getUint32(stbl.stsz.start + 12 + i * 4));
  const keys = new Set(Array.from({ length: file.getUint32(stbl.stss.start + 4) }, (_, i) => file.getUint32(stbl.stss.start + 8 + i * 4) - 1));
  let offset = file.getUint32(stbl.stco.start + 8);
  const frames = [];
  let failure = null;
  const decoder = new VideoDecoder({ output: (frame) => frames.push(frame), error: (error) => { failure = error; } });
  decoder.configure({ codec: "avc1." + hex(1) + hex(2) + hex(3), description });
  for (let i = 0; i < count; i += 1) {
    decoder.decode(new EncodedVideoChunk({ type: keys.has(i) ? "key" : "delta", timestamp: i, data: new Uint8Array(file.buffer, offset, sizes[i]) }));
    offset += sizes[i];
  }
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  const width = frames[0].displayWidth;
  const height = frames[0].displayHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  const references = new Map();
  const reference = async (y) => {
    if (!references.has(y)) {
      const image = new Image();
      image.src = refs[y];
      await image.decode();
      scratchContext.drawImage(image, 0, 0);
      references.set(y, scratchContext.getImageData(0, 0, width, height).data);
    }
    return references.get(y);
  };
  const results = [];
  let worst = null;
  for (const [slot, decoded] of frames.entries()) {
    context.drawImage(decoded, 0, 0);
    decoded.close();
    const frame = context.getImageData(0, 0, width, height).data;
    let y = 0;
    for (let i = 0; i < bits; i += 1) {
      const p = ((pad + bit / 2) * width + pad + i * bit + bit / 2) * 4;
      if (0.299 * frame[p] + 0.587 * frame[p + 1] + 0.114 * frame[p + 2] > 128) y |= 1 << i;
    }
    if (!refs[y]) {
      results.push({ slot, y, psnr: null });
      continue;
    }
    const truth = await reference(y);
    let sum = 0;
    let count = 0;
    let worstBlock = 0;
    for (let row = 0; row < height; row += 1) {
      for (let col = row < code.height ? code.width : 0; col < width; col += 1) {
        const p = (row * width + col) * 4;
        for (let c = 0; c < 3; c += 1) {
          const d = frame[p + c] - truth[p + c];
          sum += d * d;
        }
        count += 3;
      }
    }
    // The largest error of an 8x8 block's mean: a block in a gradient.
    for (let by = Math.ceil(code.height / 8) * 8; by + 8 <= height; by += 8) {
      for (let bx = 0; bx + 8 <= width; bx += 8) {
        for (let c = 0; c < 3; c += 1) {
          let s = 0;
          for (let row = by; row < by + 8; row += 1) for (let col = bx; col < bx + 8; col += 1) s += frame[(row * width + col) * 4 + c] - truth[(row * width + col) * 4 + c];
          worstBlock = Math.max(worstBlock, Math.abs(s) / 64);
        }
      }
    }
    const mse = sum / count;
    const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
    results.push({ slot, y, psnr: +psnr.toFixed(2), worstBlock: +worstBlock.toFixed(2) });
    if (!worst || psnr < worst.psnr) worst = { psnr, slot, y, frame: canvas.toDataURL("image/png") };
  }
  return { width, height, samples: count, results, worst };
}`;

const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", png: "image/png" };

function startFixture() {
  const files = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const file = url.pathname.startsWith("/file/") ? files.get(url.pathname.slice(6)) : undefined;
    if (file) {
      res.writeHead(200, { "content-type": MEDIA_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(url.pathname === "/player" ? "<!doctype html><title>Player</title><body style='margin:0;background:#000'></body>" : PAGE);
  });
  return new Promise<{ url: string; serve: (name: string, path: string) => string; close: () => Promise<void> }>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done({
        url: `http://127.0.0.1:${port}/`,
        serve: (name, path) => {
          files.set(name, path);
          return `/file/${name}`;
        },
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

/**
 * The worst frame's floor, in dB over the whole frame (RGB, against the
 * lossless screenshot): 23.8 before, 36.5 now. Below about 30 the 9 px text
 * smears into its neighbours.
 */
const MIN_WORST_PSNR = 34;
/** The worst 8x8 block mean error, where squares show in a gradient: 29.9 before, 8.7 now. */
const MAX_WORST_BLOCK = 14;

const OUT = process.env.RECORD_SCROLL_OUT;

test("recordings: an MP4 of a scrolling page keeps small text and gradients sharp in every frame", async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(join(tmpdir(), "codara-record-scroll-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspaceDir);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-record",
    workspaces: [{ id: "ws-record", name: "Record scroll", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startFixture();
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const { rpcRaw } = require("../../cli/lib/rpc.cjs");
  const request = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Record scroll", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 960));
    const tabId = (await request("preview.navigate", { url: fixture.url })).tabId as string;
    await request("preview.wait_for", { tabId, selector: "#code i" });
    // In view, as a user records it: a hidden tab paints (and scrolls) at a crawl.
    await page.locator("[data-tab-id]").filter({ hasText: new URL(fixture.url).host }).first().click();
    const evaluate = async (code: string, timeoutMs?: number) => (await request("preview.evaluate", { tabId, code, awaitPromise: true }, timeoutMs)).value;
    // The pane settles into the larger window before anything is recorded.
    await expect.poll(async () => {
      const before = await evaluate("innerHeight");
      await new Promise((done) => setTimeout(done, 500));
      return before === (await evaluate("innerHeight"));
    }, { timeout: 20_000 }).toBe(true);
    const dpr = (await evaluate("devicePixelRatio")) as number;
    expect(dpr, "positions in the code are CSS pixels; this spec records a 1x screen").toBe(1);

    await request("preview.record", { tabId, format: "mp4" });
    await new Promise((done) => setTimeout(done, 300));
    await evaluate("window.runScroll()", 60_000);
    const video = await request("preview.record", { tabId, stop: true }, 120_000);
    expect(video).toMatchObject({ format: "mp4", mimeType: "video/mp4" });
    expect(video.note).toBeUndefined();

    // A lossless screenshot of every position the page passed through.
    const positions = (await evaluate("window.positions")) as number[];
    const refs: Record<number, string> = {};
    const shots: Record<number, string> = {};
    for (const y of positions) {
      await evaluate(`(() => { window.go(${y}); return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(scrollY)))); })()`);
      const shot = await request("preview.screenshot", { tabId, format: "png", maxWidth: video.size.width + 2 });
      shots[y] = shot.path;
      refs[y] = fixture.serve(`ref-${y}.png`, shot.path);
    }

    await request("preview.navigate", { tabId, url: `${fixture.url}player` });
    // A page evaluation answers within 30 s: the judging runs on in the page
    // and is collected when it is done.
    const input = { video: fixture.serve("recording.mp4", video.path), refs, code: CODE, bits: BITS, bit: BIT, pad: PAD };
    await evaluate(`(() => { window.judging = (${JUDGE})(${JSON.stringify(input)}).then((value) => ({ value }), (error) => ({ error: String(error) })); return true; })()`);
    const done: { outcome?: { value?: unknown; error?: string } | null } = {};
    await expect.poll(async () => {
      done.outcome = (await evaluate("Promise.race([window.judging, new Promise((done) => setTimeout(() => done(null), 5000))])")) as { value?: unknown; error?: string } | null;
      return Boolean(done.outcome);
    }, { timeout: 240_000, intervals: [0] }).toBe(true);
    if (done.outcome?.error) throw new Error(done.outcome.error);
    const judged = done.outcome?.value as {
      width: number;
      height: number;
      samples: number;
      results: Array<{ slot: number; y: number; psnr: number | null; worstBlock?: number }>;
      worst: { psnr: number; slot: number; y: number; frame: string } | null;
    };
    const measured = judged.results.filter((result) => result.psnr !== null) as Array<{ slot: number; y: number; psnr: number; worstBlock: number }>;
    const summary = {
      bytes: video.bytes,
      mbPerMinute: +((video.bytes / 1_000_000) / (video.durationMs / 60_000)).toFixed(2),
      frames: video.frames,
      durationMs: video.durationMs,
      size: video.size,
      decoded: judged.results.length,
      unreadable: judged.results.length - measured.length,
      worstPsnr: judged.worst ? +judged.worst.psnr.toFixed(2) : null,
      worstAt: judged.worst ? { slot: judged.worst.slot, y: judged.worst.y } : null,
      worstBlock: Math.max(...measured.map((result) => result.worstBlock)),
      meanPsnr: +(measured.reduce((sum, result) => sum + result.psnr, 0) / Math.max(1, measured.length)).toFixed(2),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, "recording.mp4"), readFileSync(video.path));
      writeFileSync(join(OUT, "metrics.json"), JSON.stringify({ summary, results: judged.results }, null, 2));
      mkdirSync(join(OUT, "references"), { recursive: true });
      for (const [y, path] of Object.entries(shots)) writeFileSync(join(OUT, "references", `${y}.png`), readFileSync(path));
      if (judged.worst) {
        writeFileSync(join(OUT, "worst-frame.png"), Buffer.from(judged.worst.frame.split(",")[1], "base64"));
        writeFileSync(join(OUT, "worst-reference.png"), readFileSync(shots[judged.worst.y]));
      }
    }

    expect(judged.width).toBe(video.size.width);
    // Every frame names its position, and most positions of the scroll were recorded.
    expect(summary.unreadable, "every decoded frame carries a readable position").toBe(0);
    expect(new Set(measured.map((result) => result.y)).size, "the scroll was recorded, not just its ends").toBeGreaterThanOrEqual(30);
    expect(summary.worstPsnr!, "the worst frame of the scroll keeps small text").toBeGreaterThanOrEqual(MIN_WORST_PSNR);
    expect(summary.worstBlock, "no blocks in the gradients while scrolling").toBeLessThanOrEqual(MAX_WORST_BLOCK);
  } finally {
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
