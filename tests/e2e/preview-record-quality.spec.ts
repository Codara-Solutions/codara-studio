import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Browser recordings as the user and agents make them, judged against a
// lossless screenshot of the same page: the record button's MP4 (the
// default) and its menu's GIF, an agent's WebM, all played back or decoded
// and compared region by region. The page is hard on a recorder: a dark
// radial gradient (banding), a photo (palette), small text (sharpness) and
// motion (smoothness).
//
// RECORD_QUALITY_OUT=<dir> keeps the reference, the recordings and their
// metrics; RECORD_QUALITY_DPR=2 records a HiDPI screen; RECORD_QUALITY_PHOTO
// puts a real photo in the page.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const { decodePng, decodeGif, encodePng } = require("../../scripts/fixtures/capture-lib.cjs") as {
  decodePng: (png: Buffer) => Image;
  decodeGif: (gif: Buffer) => { width: number; height: number; frames: Array<{ delay: number; rgba: Uint8Array }> };
  encodePng: (bitmap: Image) => Buffer;
};

interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Record quality</title>
<style>
html,body{margin:0;height:100%}
body{background:radial-gradient(ellipse at 30% 25%,#2c3458 0%,#141a33 40%,#070912 75%,#020306 100%);color:#d7deea;font:12px/1.45 system-ui,sans-serif;overflow:hidden}
#photo{position:absolute;left:24px;top:24px;width:360px;height:203px;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6)}
#text{position:absolute;left:408px;top:24px;width:340px}
#text h1{font-size:15px;margin:0 0 6px;color:#fff}
#text p{margin:0 0 6px;color:#aab4c8}
#lane{position:absolute;left:24px;top:252px;width:724px;height:84px;border-radius:12px;background:rgba(255,255,255,.04)}
#card{position:absolute;left:12px;top:12px;width:120px;height:60px;border-radius:10px;background:linear-gradient(135deg,#6b8cff,#c46bff);animation:slide 2.4s ease-in-out infinite alternate}
#spin{position:absolute;right:20px;top:22px;width:36px;height:36px;border-radius:50%;border:4px solid rgba(255,255,255,.15);border-top-color:#7fd1ff;animation:spin .9s linear infinite}
#clock{position:absolute;left:24px;top:350px;font:600 13px ui-monospace,monospace;color:#9fe0b8}
@keyframes slide{to{transform:translateX(520px)}}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<img id="photo" src="/photo">
<div id="text"><h1>Release notes, build 2026.10</h1>
<p>Recording keeps small text legible: 12 px system UI on a dark background, with antialiased edges that a poor palette turns into blotches.</p>
<p>The quick brown fox jumps over the lazy dog. 0123456789 ({[ ]}) @#%&amp;*</p>
<p>Gradients behind this text should stay smooth, without rings or bands.</p></div>
<div id="lane"><div id="card"></div><div id="spin"></div></div>
<div id="clock">00.0 s</div>
<script>const t0=performance.now();setInterval(()=>{document.getElementById("clock").textContent=((performance.now()-t0)/1000).toFixed(1).padStart(4,"0")+" s"},100)</script>
</body></html>`;

/** A stand-in photo: smooth sky, a soft sun and textured ground. */
function syntheticPhoto(): Buffer {
  const width = 720;
  const height = 405;
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sky = y / height;
      const sun = Math.max(0, 1 - Math.hypot(x - 520, y - 120) / 160);
      const ground = y > 250 + 30 * Math.sin(x / 60);
      const n = noise() * (ground ? 40 : 4);
      const r = ground ? 120 + 60 * Math.sin(x / 13) + n : 30 + 200 * sky + 220 * sun * sun + n;
      const g = ground ? 80 + 30 * Math.sin(y / 9) + n : 50 + 110 * sky + 170 * sun * sun + n;
      const b = ground ? 50 + n : 120 + 60 * (1 - sky) + 90 * sun * sun + n;
      data.set([r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))).concat(255), (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, data });
}

const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", gif: "image/gif" };

function startFixture() {
  const real = process.env.RECORD_QUALITY_PHOTO;
  const photo = real && existsSync(real) ? { type: "image/jpeg", data: readFileSync(real) } : { type: "image/png", data: syntheticPhoto() };
  const files = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    if (url.pathname === "/photo") {
      res.writeHead(200, { "content-type": photo.type, "cache-control": "no-store" });
      res.end(photo.data);
      return;
    }
    const file = url.pathname.startsWith("/file/") ? files.get(url.pathname.slice(6)) : undefined;
    if (file) {
      const ext = file.split(".").pop() ?? "";
      res.writeHead(200, { "content-type": MEDIA_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(url.pathname === "/player" ? "<!doctype html><title>Player</title><body style='margin:0;background:#000'></body>" : PAGE);
  });
  return new Promise<{ url: string; serve: (name: string, path: string) => string; close: () => Promise<void> }>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;
      done({
        url,
        serve: (name, path) => {
          files.set(name, path);
          return `/file/${name}`;
        },
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}

/** Peak signal-to-noise ratio over a region, in dB: above 40 is indistinguishable, below 30 visibly lossy. */
function psnr(a: Image, b: Image, region: Rect): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(a.height, b.height, Math.floor(region.y + region.height)); y += 1) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(a.width, b.width, Math.floor(region.x + region.width)); x += 1) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const d = a.data[i + c] - b.data[j + c];
        sum += d * d;
        count += 1;
      }
    }
  }
  const mse = sum / Math.max(1, count);
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** The largest error of an 8x8 block's mean over a region: a band in a gradient is a run of such blocks. */
function worstBlock(a: Image, b: Image, region: Rect): number {
  let worst = 0;
  for (let by = Math.floor(region.y); by + 8 <= Math.min(a.height, b.height, region.y + region.height); by += 8) {
    for (let bx = Math.floor(region.x); bx + 8 <= Math.min(a.width, b.width, region.x + region.width); bx += 8) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let y = by; y < by + 8; y += 1) for (let x = bx; x < bx + 8; x += 1) sum += a.data[(y * a.width + x) * 4 + c] - b.data[(y * b.width + x) * 4 + c];
        worst = Math.max(worst, Math.abs(sum) / 64);
      }
    }
  }
  return worst;
}

async function selectTab(page: Page, title: string) {
  await page.locator("[data-tab-id]").filter({ hasText: title }).first().click();
}

const OUT = process.env.RECORD_QUALITY_OUT;

test("recordings: a sharp MP4 from the button, a clean GIF from its menu, an agent's WebM", async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(join(tmpdir(), "codara-record-quality-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspaceDir);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-record",
    workspaces: [{ id: "ws-record", name: "Record quality", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startFixture();
  const dpr = process.env.RECORD_QUALITY_DPR;
  const app = await electron.launch({ args: [".", ...(dpr ? [`--force-device-scale-factor=${dpr}`] : [])], env: {
    ...process.env,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const request = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Record quality", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 960));
    const shown = await request("preview.navigate", { url: fixture.url });
    const tabId = shown.tabId as string;
    await request("preview.wait_for", { tabId, selector: "#photo" });
    await selectTab(page, new URL(fixture.url).host);
    const record = page.getByTestId("preview-record");
    await expect(record).toBeVisible();
    await expect.poll(async () => (await request("preview.evaluate", { tabId, code: "document.getElementById('photo').complete" })).value).toBe(true);
    // The pane settles into the larger window before anything is measured.
    const viewportHeight = async () => (await request("preview.evaluate", { tabId, code: "innerHeight" })).value as number;
    await expect.poll(async () => {
      const before = await viewportHeight();
      await new Promise((done) => setTimeout(done, 500));
      return before === (await viewportHeight());
    }, { timeout: 20_000 }).toBe(true);
    const layout = (await request("preview.evaluate", { tabId, code: `(() => {
      const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, photo: rect("photo"), text: rect("text"), lane: rect("lane"), clock: rect("clock") };
    })()` })).value as { viewport: { width: number; height: number }; dpr: number; photo: Rect; text: Rect; lane: Rect; clock: Rect };
    const shot = await request("preview.screenshot", { tabId, format: "png", scale: layout.dpr, maxWidth: Math.round(layout.viewport.width * layout.dpr) });
    const reference = decodePng(readFileSync(shot.path));
    // The viewport at the screen's pixel ratio (rounded either way at 2x).
    expect(Math.abs(reference.width - layout.viewport.width * layout.dpr), "the reference is the viewport, pixel for pixel").toBeLessThanOrEqual(2);
    expect(Math.abs(reference.height - layout.viewport.height * layout.dpr), "the reference is the viewport, pixel for pixel").toBeLessThanOrEqual(2);
    const metrics: Record<string, unknown> = { layout };
    const keep = (name: string, result: { path: string; format: string }) => {
      if (!OUT) return;
      mkdirSync(OUT, { recursive: true });
      copyFileSync(result.path, join(OUT, `${name}.${result.format}`));
    };
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      copyFileSync(shot.path, join(OUT, "reference.png"));
    }
    // Whether the button showed its encoding progress, however briefly.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __recordProgress: string[] }).__recordProgress = seen;
      new MutationObserver(() => {
        const text = document.querySelector("[data-testid='preview-record-progress']")?.textContent;
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    // The button asks Video or GIF first: a video by default.
    await expect(record).toHaveAttribute("data-format", "mp4");
    await record.click();
    await page.getByTestId("preview-record-start").click();
    await expect(record).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(4_000);
    let stoppedAt = Date.now();
    await record.click();
    const saved = page.getByTestId("preview-record-result");
    await expect(saved).toContainText("Recording saved", { timeout: 60_000 });
    const mp4Path = (await saved.getByTestId("preview-record-path").getAttribute("title"))!;
    metrics["mp4-button"] = { format: "mp4", path: mp4Path, encodeMs: Date.now() - stoppedAt };
    expect(mp4Path).toMatch(/\.mp4$/);
    expect(readFileSync(mp4Path).subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect((await page.evaluate(() => (window as unknown as { __recordProgress: string[] }).__recordProgress)).some((text) => /^saving/.test(text))).toBe(true);
    await expect(saved).toContainText("MP4");
    keep("mp4-button", { path: mp4Path, format: "mp4" });

    // Save as copies it where the user picks; Copy puts it (or, on Linux, its path) on the clipboard.
    const savedCopy = join(root, "my recording.mp4");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog;
    }, savedCopy);
    await saved.getByRole("button", { name: "Save as" }).click();
    await expect(saved.getByTestId("preview-record-done")).toHaveText("Saved to my recording.mp4");
    expect(readFileSync(savedCopy).equals(readFileSync(mp4Path))).toBe(true);
    await saved.getByRole("button", { name: "Copy" }).click();
    await expect(saved.getByTestId("preview-record-done")).toHaveText(/^Copied/);
    if (process.platform === "linux") expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(mp4Path);
    await saved.getByRole("button", { name: "Dismiss" }).click();

    // The choice: a GIF, remembered for the next recording.
    // The keyboard picks it: Start has the focus, the arrows switch the
    // format, and Enter on Start records.
    await record.click();
    const chooser = page.getByRole("dialog", { name: "Record this tab" });
    await expect(chooser.getByRole("radiogroup", { name: "Recording format" })).toBeVisible();
    const start = page.getByTestId("preview-record-start");
    await expect(start).toBeFocused();
    await chooser.getByRole("radio", { name: "Video" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(chooser.getByRole("radio", { name: "GIF" })).toBeFocused();
    await expect(chooser.getByRole("radio", { name: "GIF" })).toHaveAttribute("aria-checked", "true");
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(record).toHaveAttribute("aria-pressed", "true");
    await expect(record).toHaveAttribute("data-format", "gif");
    await page.waitForTimeout(4_000);
    stoppedAt = Date.now();
    await record.click();
    await expect(saved).toContainText("Recording saved", { timeout: 60_000 });
    const gifPath = (await saved.getByTestId("preview-record-path").getAttribute("title"))!;
    metrics["gif-menu"] = { format: "gif", path: gifPath, encodeMs: Date.now() - stoppedAt };
    expect(gifPath).toMatch(/\.gif$/);
    keep("gif-menu", { path: gifPath, format: "gif" });
    await saved.getByRole("button", { name: "Dismiss" }).click();
    await expect(record).toHaveAttribute("data-format", "gif");

    // An agent: a WebM, and the default GIF.
    for (const [name, options] of [["webm-agent", { format: "webm" }], ["gif-agent", {}]] as const) {
      await request("preview.record", { tabId, ...options });
      await new Promise((done) => setTimeout(done, 4_000));
      const result = await request("preview.record", { tabId, stop: true }, 120_000);
      metrics[name] = result;
      expect(statSync(result.path).size).toBe(result.bytes);
      expect(result.encodeMs).toBeGreaterThanOrEqual(0);
      expect(result.note).toBeUndefined();
      keep(name, result);
    }
    const webm = metrics["webm-agent"] as { path: string; format: string; mimeType: string; frames: number; durationMs: number; size: { width: number } };
    expect(webm).toMatchObject({ format: "webm", mimeType: "video/webm" });
    expect(readFileSync(webm.path).readUInt32BE(0)).toBe(0x1a45dfa3);
    // Smooth at 1x; a software-rendered 2x screen (RECORD_QUALITY_DPR=2 on a
    // virtual display) paints the whole app far slower than any real one.
    const smooth = layout.dpr === 1 ? 20 : 5;
    expect(webm.frames / (webm.durationMs / 1000), "a video records the animation smoothly").toBeGreaterThanOrEqual(smooth);
    expect(webm.size.width).toBe(Math.min(1920, Math.round(layout.viewport.width * layout.dpr)) & ~1);
    const gifAgent = metrics["gif-agent"] as { format: string; frames: number; durationMs: number; fps: number };
    expect(gifAgent).toMatchObject({ format: "gif", fps: 15 });
    expect(gifAgent.frames / (gifAgent.durationMs / 1000), "a GIF keeps up at 15 fps").toBeGreaterThanOrEqual(smooth / 2);

    // Play the videos back in Chromium: they load, last as long as they
    // were recorded, and their first frame matches the page.
    await request("preview.navigate", { tabId, url: `${fixture.url}player` });
    const play = async (path: string) => {
      const src = fixture.serve(basename(path), path);
      return (await request("preview.evaluate", { tabId, awaitPromise: true, code: `(async () => {
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "auto";
        video.src = ${JSON.stringify(src)};
        document.body.append(video);
        await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error("cannot play: " + (video.error && video.error.message))); });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        const out = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, frame: canvas.toDataURL("image/png") };
        video.remove();
        return out;
      })()` }, 60_000)).value as { width: number; height: number; duration: number; frame: string };
    };
    const scale = (image: Image) => image.width / layout.viewport.width;
    const regions = (image: Image) => {
      const s = scale(image);
      const box = (r: Rect) => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s });
      // The empty gradient below the clock.
      const top = (layout.clock.y + 30) * s;
      return { photo: box(layout.photo), text: box(layout.text), gradient: { x: 0, y: top, width: image.width, height: image.height - top - 2 } };
    };
    const judge = (name: string, image: Image) => {
      const sameScale = Math.abs(scale(image) - reference.width / layout.viewport.width) < 0.01;
      const r = regions(image);
      const quality = sameScale
        ? {
          psnrPhoto: +psnr(image, reference, r.photo).toFixed(2),
          psnrText: +psnr(image, reference, r.text).toFixed(2),
          psnrGradient: +psnr(image, reference, r.gradient).toFixed(2),
          worstGradientBlock: +worstBlock(image, reference, r.gradient).toFixed(2),
        }
        : null;
      metrics[name] = { ...(metrics[name] as object), quality };
      return quality;
    };
    const videos: Record<string, { path: string; durationMs?: number }> = { "mp4-button": { path: mp4Path }, "webm-agent": webm };
    const judged: Array<{ name: string; quality: ReturnType<typeof judge> }> = [];
    for (const [name, info] of Object.entries(videos)) {
      const played = await play(info.path);
      metrics[name] = { durationMs: played.duration * 1000, ...(metrics[name] as object), played: { width: played.width, height: played.height, duration: played.duration } };
      if (info.durationMs) expect(Math.abs(played.duration * 1000 - info.durationMs)).toBeLessThan(300);
      expect(played.duration).toBeGreaterThan(3);
      expect(played.width % 2).toBe(0);
      judged.push({ name, quality: judge(name, decodePng(Buffer.from(played.frame.split(",")[1], "base64"))) });
    }
    for (const name of ["gif-menu", "gif-agent"]) {
      const gif = decodeGif(readFileSync((metrics[name] as { path: string }).path));
      metrics[name] = { durationMs: gif.frames.reduce((sum, frame) => sum + frame.delay * 10, 0), ...(metrics[name] as object) };
      judged.push({ name, quality: judge(name, { width: gif.width, height: gif.height, data: gif.frames[0].rgba }) });
    }
    if (OUT) writeFileSync(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics, null, 2));
    // The GIF this replaces: photo 23.6 dB, text 25.6 dB, bands in the
    // gradient. Linux encodes H.264 with OpenH264, which picks its own
    // (lower) quality; VP9 and the GIF are set to theirs.
    const floors: Record<string, { photo: number; text: number; block: number }> = {
      "mp4-button": { photo: 30, text: 32, block: 6 },
      "webm-agent": { photo: 33, text: 38, block: 4 },
      "gif-menu": { photo: 35, text: 40, block: 1.5 },
      "gif-agent": { photo: 35, text: 40, block: 1.5 },
    };
    for (const { name, quality } of judged) {
      if (!quality) continue;
      expect(quality.psnrPhoto, `${name}: the photo`).toBeGreaterThanOrEqual(floors[name].photo);
      expect(quality.psnrText, `${name}: small text`).toBeGreaterThanOrEqual(floors[name].text);
      expect(quality.worstGradientBlock, `${name}: no bands in the gradient`).toBeLessThanOrEqual(floors[name].block);
    }
  } finally {
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
