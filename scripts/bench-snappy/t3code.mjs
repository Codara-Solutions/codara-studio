// t3code adapter for the snappiness benchmark, so Studio can be compared with
// it flow by flow. t3code is untrusted code here: it runs only inside the
// bubblewrap sandbox in t3code/, which sees $T3CODE_BENCH_DIR and nothing of
// the user's home or sign-ins. Its agent is a fake `pi` that streams the same
// text at the same rate as Studio's replay. Prepare the folder once with
// t3code/setup.sh, then build the profile with `compare.mjs --build-profile`.

import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatMarkdown, streamChunks } from "./fixtures.mjs";
import {
  clickAndPaint,
  cpuOver,
  installProbes,
  localPage,
  measureStream,
  memorySnapshot,
  pickFrames,
  pixelLatency,
  round,
  sleep,
  startRecording,
  stopRecording,
  summarize,
  untilPainted,
  visibleText,
  waitForFile,
} from "./lib.mjs";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright");
const HERE = join(dirname(fileURLToPath(import.meta.url)), "t3code");
const T = process.env.T3CODE_BENCH_DIR;
const HOME = T && join(T, "home");
const TEMPLATE = T && join(T, "profile-template");
const STATE = [".t3", ".config/t3code-v2", ".cache/t3code"];
const MODEL = "openrouter/deepseek/deepseek-v4-flash";
export const WORKSPACES = 40;
const work = (index) => join(HOME, "work", `ws-${String(index).padStart(2, "0")}`);

function requireDir() {
  if (!T) throw new Error("set T3CODE_BENCH_DIR (see scripts/bench-snappy/t3code/setup.sh)");
}

function t3cli(...args) {
  return execFileSync(join(HERE, "sandbox.sh"), ["node", join(T, "repo/apps/server/dist/bin.mjs"), ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, T3CODE_BENCH_DIR: T },
  });
}

function writeStream(chunks) {
  writeFileSync(join(HOME, "bin", "stream.json"), JSON.stringify({ chunks }));
}
function splitBy4(text) {
  const chunks = [];
  for (let at = 0; at < text.length; at += 4) chunks.push(text.slice(at, at + 4));
  return chunks;
}
// The fake pi reads its rate per turn, so seeding can run fast and the
// measured turns at 150 deltas a second without restarting t3code.
const setRate = (rate) => writeFileSync(join(HOME, "bin", "rate.txt"), String(rate));

function resetState() {
  for (const dir of STATE) rmSync(join(HOME, dir), { recursive: true, force: true });
}

// Every run starts from the same saved state: 40 projects with their threads.
export function prepare() {
  requireDir();
  if (!existsSync(join(TEMPLATE, "ids.json"))) throw new Error("no t3code profile: run compare.mjs --build-profile first");
  resetState();
  for (const dir of STATE) if (existsSync(join(TEMPLATE, dir))) cpSync(join(TEMPLATE, dir), join(HOME, dir), { recursive: true });
  return null;
}

export function disposeFixture() {}

export async function launch() {
  requireDir();
  const spawnedAt = Date.now();
  const app = await _electron.launch({
    executablePath: join(HERE, "electron.sh"),
    args: ["dist-electron/boot.cjs"],
    env: { DISPLAY: process.env.DISPLAY, T3CODE_BENCH_DIR: T },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  const firstWindowMs = Date.now() - spawnedAt;
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded");
  // Usable: the sidebar is drawn and the main view takes input, which is the
  // composer once a project exists and the first-run screen before.
  const usableAt = await untilPainted(
    page,
    () => {
      const shown = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const sidebar = document.querySelector('[aria-label="Search threads"]');
      const composer = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(shown);
      const firstRun = [...document.querySelectorAll("button")].find((el) => shown(el) && el.textContent.trim() === "Start without a project");
      return Boolean(shown(sidebar) && (composer || firstRun));
    },
    null,
    45_000,
  );
  const timing = await page.evaluate((usable) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const composer = [...document.querySelectorAll('[contenteditable="true"], textarea')].some((el) => el.getBoundingClientRect().width > 0);
    return { timeOrigin: performance.timeOrigin, usableEpoch: performance.timeOrigin + usable, domContentLoaded: nav?.domContentLoadedEventEnd ?? null, surface: composer ? "composer" : "first-run" };
  }, usableAt);
  await installProbes(page);
  const cdp = await page.context().newCDPSession(page);
  return {
    app,
    page,
    cdp,
    pid: app.process().pid,
    startup: {
      firstWindowMs,
      rendererNavStartMs: round(timing.timeOrigin - spawnedAt),
      domContentLoadedMs: round(timing.timeOrigin - spawnedAt + (timing.domContentLoaded ?? 0)),
      usableMs: round(timing.usableEpoch - spawnedAt),
      surface: timing.surface,
    },
  };
}

export async function close(session) {
  await session.app.close().catch(() => {});
}

// One-time profile, mirroring Studio's fixture: 40 projects, each with a
// kickoff thread (t3code's sidebar lists threads, so this is its 40-row
// rail), two short threads to switch between, one to stream into and a
// 60-turn thread. ws-00 also gets Studio's 3,000-file folder and 2 MB file.
export async function buildProfile() {
  requireDir();
  resetState();
  mkdirSync(join(HOME, ".t3", "userdata"), { recursive: true });
  writeFileSync(
    join(HOME, ".t3", "userdata", "settings.json"),
    JSON.stringify({ providerInstances: { pi: { driver: "pi", enabled: true, config: { enabled: true, binaryPath: join(HOME, "bin", "pi") } } } }, null, 2),
  );
  for (let index = 0; index < WORKSPACES; index += 1) {
    const dir = work(index);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ws-${index}\n`);
    writeFileSync(join(dir, `only-ws-${String(index).padStart(2, "0")}.txt`), "x\n");
    writeFileSync(join(dir, "src", "index.ts"), "export const ready = true;\n");
  }
  mkdirSync(join(work(0), "many"), { recursive: true });
  for (let index = 0; index < 3000; index += 1) writeFileSync(join(work(0), "many", `file-${String(index).padStart(4, "0")}.ts`), `export const n = ${index};\n`);
  const lines = [];
  for (let index = 0; lines.join("\n").length < 2_000_000; index += 1) {
    lines.push(`export function generated${index}(value: number): number {`, `  return value * ${index} + ${index % 7};`, "}", "");
  }
  writeFileSync(join(work(0), "big.ts"), lines.join("\n"));

  const session = await launch();
  await sleep(4000);
  const closeButton = session.page.getByRole("button", { name: "Close", exact: true });
  if (await closeButton.count()) await closeButton.first().click().catch(() => {});
  setRate(1_000_000);
  for (let index = 0; index < WORKSPACES; index += 1) t3cli("project", "add", work(index), "--title", `project-ws-${String(index).padStart(2, "0")}`);
  const start = (project, message, title) => JSON.parse(t3cli("thread", "start", project, message, "--title", title, "--provider", "pi", "--model", MODEL, "--wait", "--json"));
  const ids = {};
  writeStream(splitBy4("Short reply only-ws-00 marker. " + chatMarkdown(3, 300)));
  ids.switchA = start(work(0), "Switch A", "Switch A");
  writeStream(splitBy4("Short reply only-ws-07 marker. " + chatMarkdown(5, 300)));
  ids.switchB = start(work(7), "Switch B", "Switch B");
  writeStream(splitBy4(chatMarkdown(0, 300) + "\n\nAnswer 1 for stream"));
  ids.stream = start(work(0), "Question 1: how should we make the composer faster?", "Streaming reply");
  for (let index = 1; index < WORKSPACES; index += 1) {
    if (index === 7) continue;
    writeStream(splitBy4(`Short reply for project ${index}. ` + chatMarkdown(index, 200)));
    start(work(index), `Project ${index} kickoff`, `Project ${index} kickoff`);
  }
  writeStream(splitBy4(`${chatMarkdown(0, 1500)}\n\nAnswer 1 for long60`));
  ids.long = start(work(0), "Question 1: how should we make the composer faster?", "Long history");
  const longId = ids.long.threadId ?? ids.long.id ?? ids.long.thread?.id;
  for (let index = 1; index < 60; index += 1) {
    writeStream(splitBy4(`${chatMarkdown(index, 1500)}\n\nAnswer ${index + 1} for long60`));
    t3cli("thread", "send", longId, `Question ${index + 1}: how should we make the ${index % 2 ? "rail" : "composer"} faster?`, "--wait");
  }
  await sleep(2000);
  await close(session);
  rmSync(TEMPLATE, { recursive: true, force: true });
  for (const dir of STATE) if (existsSync(join(HOME, dir))) cpSync(join(HOME, dir), join(TEMPLATE, dir), { recursive: true });
  writeFileSync(join(TEMPLATE, "ids.json"), JSON.stringify(ids, null, 2));
  setRate(150);
  return ids;
}

const row = (title) => `[data-testid="sidebar-row-card"][aria-label^="${title},"]`;

async function openThread(page, title, marker) {
  await page.locator(row(title)).first().click();
  if (marker) await page.getByText(marker).first().waitFor({ timeout: 20_000 });
  await sleep(500);
}

// The ghostty terminal draws on a canvas in the bottom drawer: the tallest
// visible canvas below the top third of the window.
async function terminalCanvas(page) {
  const handle = await page.evaluateHandle(() => {
    const canvases = [...document.querySelectorAll("canvas")].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 200 && r.height > 50 && r.top > window.innerHeight / 3;
    });
    canvases.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
    return canvases[0] ?? null;
  });
  return handle.asElement();
}

async function openTerminal(page) {
  if (!(await terminalCanvas(page))) await page.getByRole("button", { name: /^Toggle terminal drawer/ }).first().click();
  await sleep(1500);
  const canvas = await terminalCanvas(page);
  if (!canvas) throw new Error("no terminal canvas");
  return canvas;
}

async function openRightTab(page, label) {
  const shown = label === "Files" ? "file-tree-container" : "[placeholder='Search or enter URL']";
  if (!(await page.locator("file-tree-container, [placeholder='Search or enter URL']").count())) {
    await page.getByRole("button", { name: /^Toggle right panel/ }).first().click();
    await sleep(800);
  }
  if (await page.locator(`${shown} >> visible=true`).count()) return;
  const direct = page.locator("button").filter({ hasText: new RegExp(`^${label}`) });
  if (await direct.count()) await direct.first().dispatchEvent("click");
  else {
    // The titlebar controls overlay this trigger, so it is opened from the
    // keyboard; each surface has a one-letter shortcut in the menu.
    await page.getByRole("button", { name: "Add panel surface" }).first().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menu").first().waitFor({ timeout: 5_000 });
    await page.keyboard.press(label[0].toLowerCase());
    await sleep(500);
    if (!(await page.locator(`${shown} >> visible=true`).count()) && (await page.getByRole("menu").count()) > 1) await page.keyboard.press("Enter");
  }
  await page.locator(`${shown} >> visible=true`).first().waitFor({ timeout: 15_000 });
  await sleep(800);
}

// The Files panel renders its tree in an open shadow root.
const waitForTreeItem = (page, path) =>
  page.waitForFunction((path) => document.querySelector("file-tree-container")?.shadowRoot?.querySelector(`[data-item-path="${path}"]`), path, { timeout: 15_000 });

async function clickTreeAndPaint(page, path, predicate, arg) {
  return page.evaluate(
    async ({ path, source, arg }) => {
      const check = new Function("arg", `return (${source})(arg);`);
      const target = document.querySelector("file-tree-container")?.shadowRoot?.querySelector(`[data-item-path="${path}"]`);
      if (!target) throw new Error(`missing tree item ${path}`);
      const started = performance.now();
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
      target.click();
      await new Promise((resolve, reject) => {
        const poll = () => {
          if (check(arg)) return resolve();
          if (performance.now() - started > 15_000) return reject(new Error(`timed out after ${path}`));
          requestAnimationFrame(poll);
        };
        poll();
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return performance.now() - started;
    },
    { path, source: predicate.toString(), arg },
  );
}

const treeShows = (path) => {
  const el = document.querySelector("file-tree-container")?.shadowRoot?.querySelector(`[data-item-path="${path}"]`);
  return Boolean(el && el.getBoundingClientRect().height > 0);
};

async function wheel(page, steps, deltaY) {
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, deltaY);
    await sleep(16);
  }
}

export const flows = {
  // Sidebar clicks between two threads in two projects, timed until the
  // destination's own reply text is painted.
  async workspaceSwitch(session, _fixture, { repeats = 12 } = {}) {
    const { page } = session;
    await openThread(page, "Switch A", "only-ws-00 marker");
    const times = [];
    await startRecording(page);
    for (let index = 0; index < repeats; index += 1) {
      const [title, marker] = index % 2 === 0 ? ["Switch B", "only-ws-07 marker"] : ["Switch A", "only-ws-00 marker"];
      times.push(await clickAndPaint(page, row(title), visibleText, marker));
      await sleep(250);
    }
    const frames = await stopRecording(page);
    return { switchMs: summarize(times), raw: times.map((v) => round(v)), longTasks: frames.longTasks, longTaskMs: frames.longTaskMs, worstLongTaskMs: frames.worstLongTaskMs };
  },

  async composerTyping(session) {
    const { page, cdp } = session;
    const composer = page.locator('[data-testid="composer-editor"]:visible').first();
    await composer.click();
    await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
    await startRecording(page);
    await page.keyboard.type("Refactor the workspace switcher so the explorer paints from cache first, ".repeat(2), { delay: 35 });
    const inPage = await stopRecording(page);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await sleep(300);
    const box = await composer.boundingBox();
    const pixels = await pixelLatency(page, cdp, {
      region: { x: box.x, y: box.y, width: box.width, height: box.height },
      keys: "abcdefghijklmnopqrst".split(""),
      gapMs: 150,
    });
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    return { keyToFrameMs: inPage.keyMs, longTasks: inPage.longTasks, longTaskMs: inPage.longTaskMs, keyToPixelsMs: pixels.pixelMs, pixelMissed: pixels.missed, idleFramesPerSec: pixels.idleFramesPerSec };
  },

  async terminalTyping(session) {
    const { page, cdp } = session;
    const screen = await openTerminal(page);
    await screen.click({ force: true });
    await sleep(800);
    const box = await screen.boundingBox();
    const pixels = await pixelLatency(page, cdp, {
      region: { x: box.x, y: box.y, width: box.width, height: box.height },
      keys: "abcdefghijklmnopqrst".split(""),
      gapMs: 220,
    });
    await page.keyboard.press("Control+U");
    return { keyToPixelsMs: pixels.pixelMs, pixelMissed: pixels.missed, idleFramesPerSec: pixels.idleFramesPerSec };
  },

  // The 60-turn thread (120 messages, the same markdown as Studio's): open it
  // from the sidebar, then scroll it top to bottom with the wheel.
  async chatOpenScroll(session) {
    const { page } = session;
    await openThread(page, "Switch A", "only-ws-00 marker");
    const openMs = await clickAndPaint(page, row("Long history"), (text) => document.body.innerText.includes(text), "Answer 60 for long60");
    await sleep(1000);
    const box = await page.locator('[data-testid="composer-editor"]:visible').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y - 200);
    const dom = await page.evaluate(() => document.querySelectorAll("*").length);
    await startRecording(page);
    await wheel(page, 60, -400);
    await wheel(page, 60, 400);
    const scroll = await stopRecording(page);
    return { openMs: round(openMs), domNodes: dom, scroll: pickFrames(scroll) };
  },

  // Expand a folder of 3,000 files in the Files panel, scroll it, collapse it.
  async explorer(session) {
    const { page } = session;
    await openThread(page, "Switch A", "only-ws-00 marker");
    await openRightTab(page, "Files");
    await waitForTreeItem(page, "README.md");
    const expandMs = await clickTreeAndPaint(page, "many/", treeShows, "many/file-0000.ts");
    const box = await page.locator("file-tree-container").boundingBox();
    await page.mouse.move(box.x + 60, box.y + 120);
    await startRecording(page);
    await wheel(page, 50, 300);
    const scroll = await stopRecording(page);
    await page.mouse.wheel(0, -100_000);
    await sleep(300);
    const collapseMs = await clickTreeAndPaint(page, "many/", (path) => !document.querySelector("file-tree-container")?.shadowRoot?.querySelector(`[data-item-path="${path}"]`), "many/file-0000.ts");
    return { expandMs: round(expandMs), collapseMs: round(collapseMs), scroll: pickFrames(scroll) };
  },

  // Open the 2 MB TypeScript file from the Files panel, then scroll it.
  // t3code previews only the first 1 MB of it; Studio opens all of it.
  async bigFile(session) {
    const { page } = session;
    await openThread(page, "Switch A", "only-ws-00 marker");
    await openRightTab(page, "Files");
    await waitForTreeItem(page, "big.ts");
    const openMs = await clickTreeAndPaint(page, "big.ts", () => {
      const roots = [document, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
      return roots.some((root) => [...root.querySelectorAll("pre, code, [data-line], div")].some((el) => el.childElementCount < 50 && el.textContent.includes("generated0(") && el.getBoundingClientRect().height > 0));
    });
    await sleep(500);
    // The preview is virtualized and sits under the panel's breadcrumb, left
    // of the file tree.
    await page.mouse.move(1060, 450);
    await startRecording(page);
    await wheel(page, 60, 600);
    const scroll = await stopRecording(page);
    return { openMs: round(openMs), scroll: pickFrames(scroll) };
  },

  // Navigate the Browser panel to a small local page three times; timed from
  // Enter in the address bar until the webview has finished loading. Studio's
  // flow opens a new tab each time, which also creates the webview.
  async browserPane(session) {
    const { page } = session;
    const server = await localPage();
    try {
      await openRightTab(page, "Browser");
      const results = [];
      for (let index = 0; index < 3; index += 1) {
        const url = `${server.url}?n=${index}`;
        const address = page.getByPlaceholder("Search or enter URL").first();
        await address.click();
        await address.fill(url);
        results.push(
          await page.evaluate(async (url) => {
            const input = [...document.querySelectorAll('input[placeholder="Search or enter URL"]')].find((el) => el.getBoundingClientRect().width > 0);
            const started = performance.now();
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            input.form?.requestSubmit?.();
            await new Promise((resolve, reject) => {
              const poll = () => {
                const view = [...document.querySelectorAll("webview")].find((el) => {
                  try {
                    return el.getURL() === url && !el.isLoading() && el.getBoundingClientRect().width > 0;
                  } catch {
                    return false;
                  }
                });
                if (view) return resolve();
                if (performance.now() - started > 20_000) return reject(new Error("browser never loaded"));
                requestAnimationFrame(poll);
              };
              poll();
            });
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
            return performance.now() - started;
          }, url),
        );
        await sleep(500);
      }
      const memory = memorySnapshot(session.pid);
      return { openMs: summarize(results), raw: results.map((v) => round(v)), memoryWithTabs: { totalPssMb: memory.totalPssMb, byKind: memory.byKind } };
    } finally {
      server.close();
    }
  },

  // Same command and marker file as Studio's terminalBusy.
  async terminalBusy(session) {
    const { page, pid } = session;
    const screen = await openTerminal(page);
    await screen.click({ force: true });
    const marker = join(HOME, "bench-busy-done");
    rmSync(marker, { force: true });
    await startRecording(page);
    const cpu = cpuOver(pid, 6_000);
    const started = Date.now();
    await page.keyboard.type("seq 1 200000; touch ~/bench-busy-done\n");
    const done = (await waitForFile(marker, 60_000)) !== null;
    const elapsed = Date.now() - started;
    const output = await stopRecording(page);
    const box = await screen.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await startRecording(page);
    await wheel(page, 60, -500);
    const scroll = await stopRecording(page);
    await page.keyboard.press("Control+L");
    return { printMs: done ? elapsed : null, cpuFirst6s: await cpu, output: pickFrames(output), scroll: pickFrames(scroll) };
  },

  // Same text, chunking and rate as Studio's chatStream; here a real turn
  // runs through t3code's server and its Pi adapter, with the fake pi
  // writing the deltas and the time it sent the last one.
  async chatStream(session, _fixture, { totalChars = 24_000, deltasPerSecond = 150 } = {}) {
    const { page } = session;
    await openThread(page, "Streaming reply", "Answer 1 for stream");
    const base = streamChunks(totalChars, 4);
    const tag = String(Date.now()).slice(-6);
    const head = `Stream opening ${tag}. `;
    const tail = `Stream closing ${tag}.`;
    const chunks = [head, ...base.chunks, "\n\n", tail];
    writeStream(chunks);
    setRate(deltasPerSecond);
    const lastDelta = join(HOME, "bin", "last-delta.txt");
    rmSync(lastDelta, { force: true });
    await page.locator('[data-testid="composer-editor"]:visible').first().click();
    await page.keyboard.type("Question 2: stream a long answer");
    return measureStream(session, {
      chunks,
      head,
      tail,
      deltasPerSecond,
      send: async () => {
        await page.getByRole("button", { name: "Submit message" }).first().click();
        await waitForFile(lastDelta, Math.ceil((chunks.length / deltasPerSecond) * 1000) + 60_000);
        return Number(readFileSync(lastDelta, "utf8").trim());
      },
    });
  },

  // t3code's agents are chat threads, so its version of "5 agents working" is
  // five threads streaming at once (150 deltas/s each) while another thread
  // is on screen. Studio's flow runs five terminal agents instead; the CPU
  // numbers answer the same question, not the same workload.
  async agents(session, _fixture, { count = 5 } = {}) {
    const { page, pid } = session;
    await openThread(page, "Switch A", "only-ws-00 marker");
    writeStream(splitBy4(streamChunks(60_000, 4).text));
    setRate(150);
    const children = [];
    for (let index = 0; index < count; index += 1) {
      const args = ["node", join(T, "repo/apps/server/dist/bin.mjs"), "thread", "start", work(20 + index), `Agent ${index + 1} task`, "--title", `Agent ${index + 1}`, "--provider", "pi", "--model", MODEL];
      children.push(spawn(join(HERE, "sandbox.sh"), args, { stdio: "ignore", env: { ...process.env, T3CODE_BENCH_DIR: T } }));
    }
    await sleep(8_000);
    const cpu = await cpuOver(pid, 20_000);
    const memory = memorySnapshot(pid);
    const typing = await flows.composerTyping(session);
    await openThread(page, `Agent ${count}`);
    await sleep(2_000);
    const cpuOneVisible = await cpuOver(pid, 10_000);
    for (const child of children) child.kill();
    return { agents: count, cpu, cpuOneVisible, memory: { totalPssMb: memory.totalPssMb, byKind: memory.byKind, processCount: memory.processCount }, composerWhileAgents: typing };
  },
};
