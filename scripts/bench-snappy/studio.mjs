// Codara Studio adapter for the snappiness benchmark. Every launch gets a
// throwaway HOME and Codara home, so nothing reads or writes the user's real
// ~/.codarastudio, CLI logins or shell config.

import { _electron } from "playwright";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clickAndPaint,
  cpuOver,
  measureStream,
  pickFrames,
  visibleText,
  hotFunctions,
  installProbes,
  localPage,
  memorySnapshot,
  pixelLatency,
  profile,
  traceBreakdown,
  round,
  sleep,
  startRecording,
  stopRecording,
  summarize,
  untilPainted,
  waitForFile,
} from "./lib.mjs";
import { chatMarkdown, fakeAgentSource, streamChunks } from "./fixtures.mjs";

// STUDIO_BENCH_DIR points at another checkout's build, so a fix branch can be
// measured with the same harness without carrying it.
const repo = process.env.STUDIO_BENCH_DIR ? resolve(process.env.STUDIO_BENCH_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WORKSPACES = 40;

export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "codara-snappy-"));
  const home = join(root, "home");
  const userData = join(root, "user-data");
  const bin = join(root, "bin");
  for (const dir of [home, userData, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".bashrc"), "PS1='$ '\n");
  writeFileSync(join(home, ".bash_profile"), "[ -f ~/.bashrc ] && . ~/.bashrc\n");
  writeFileSync(join(home, ".sudo_as_admin_successful"), "");
  const workspaces = [];
  for (let index = 0; index < WORKSPACES; index += 1) {
    const id = `ws-${String(index).padStart(2, "0")}`;
    const cwd = join(root, "workspaces", id);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "README.md"), `# ${id}\n`);
    writeFileSync(join(cwd, `only-${id}.txt`), `${id}\n`);
    writeFileSync(join(cwd, "src", "index.ts"), "export const ready = true;\n");
    workspaces.push({ id, name: `project-${id}`, cwd, color: index % 2 ? "#78A8FF" : "#34D3C3", workers: [] });
  }
  const main = workspaces[0].cwd;
  mkdirSync(join(main, "many"), { recursive: true });
  for (let index = 0; index < 3000; index += 1) {
    writeFileSync(join(main, "many", `file-${String(index).padStart(4, "0")}.ts`), `export const n = ${index};\n`);
  }
  const lines = [];
  for (let index = 0; lines.join("\n").length < 2_000_000; index += 1) {
    lines.push(`export function generated${index}(value: number): number {`, `  return value * ${index} + ${index % 7};`, "}", "");
  }
  writeFileSync(join(main, "big.ts"), lines.join("\n"));
  writeFileSync(
    join(userData, "spark-state.json"),
    JSON.stringify({ workspaces, activeWorkspaceId: workspaces[0].id }, null, 2),
  );
  writeFileSync(join(bin, "fake-agent"), fakeAgentSource(), { mode: 0o755 });
  return { root, home, userData, bin, workspaces };
}

export function disposeFixture(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

function launchEnv(fixture) {
  const env = {
    PATH: `${fixture.bin}:${process.env.PATH}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    DISPLAY: process.env.DISPLAY,
    XDG_SESSION_TYPE: "x11",
    GDK_BACKEND: "x11",
    HOME: fixture.home,
    USER: process.env.USER ?? "bench",
    SHELL: "/bin/bash",
    SPARK_USER_DATA_DIR: fixture.userData,
    CODARA_HOME_DIR: fixture.userData,
    SPARK_HOME_DIR: fixture.userData,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_E2E_BACKGROUND: "1",
    CODARA_E2E_SEED_TERMINAL: "1",
    CODARA_CHROME_LINK: "0",
    CODARA_DISABLE_KEYCHAIN: "1",
    SPARK_ALLOW_MULTI: "1",
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

export async function launch(fixture) {
  const spawnedAt = Date.now();
  const app = await _electron.launch({
    executablePath: join(repo, "node_modules", "electron", "dist", "electron"),
    args: [repo],
    cwd: repo,
    env: launchEnv(fixture),
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  const firstWindowMs = Date.now() - spawnedAt;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState("domcontentloaded");
  // "Usable" means what a user waits for: the rail is drawn and the active
  // surface (a fresh home opens Cora, a restart restores the terminal tab)
  // accepts input.
  const usableAt = await untilPainted(
    page,
    () => {
      const shown = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
      const rail = document.querySelector("[data-workspace-id]");
      const composer = document.querySelector(".composer-shell textarea");
      const terminal = [...document.querySelectorAll(".xterm-screen")].find(shown);
      return Boolean(shown(rail) && ((shown(composer) && !composer.disabled) || terminal));
    },
    null,
    45_000,
  );
  const timing = await page.evaluate((usable) => {
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      timeOrigin: performance.timeOrigin,
      usableEpoch: performance.timeOrigin + usable,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
      surface: document.querySelector(".composer-shell textarea") ? "cora" : "terminal",
    };
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

async function rpc(fixture, method, params) {
  const handshake = JSON.parse(readFileSync(join(fixture.userData, "agent-socket.json"), "utf8"));
  const response = await fetch(`${handshake.url.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${handshake.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export const flows = {
  // Rail clicks between two workspaces, timed until the destination's own
  // Explorer row is painted.
  async workspaceSwitch(session, fixture, { repeats = 12 } = {}) {
    const { page } = session;
    const a = fixture.workspaces[0].id;
    const b = fixture.workspaces[7].id;
    const times = [];
    await startRecording(page);
    for (let index = 0; index < repeats; index += 1) {
      const target = index % 2 === 0 ? b : a;
      times.push(await clickAndPaint(page, `[data-workspace-id="${target}"]`, visibleText, `only-${target}.txt`));
      await sleep(250);
    }
    const frames = await stopRecording(page);
    return { switchMs: summarize(times), raw: times.map((v) => round(v)), longTasks: frames.longTasks, longTaskMs: frames.longTaskMs, worstLongTaskMs: frames.worstLongTaskMs };
  },

  async composerTyping(session) {
    const { page, cdp } = session;
    await openCora(page);
    const composer = page.locator(".composer-shell textarea:visible").first();
    await composer.focus();
    await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
    await startRecording(page);
    await page.keyboard.type("Refactor the workspace switcher so the explorer paints from cache first, ".repeat(2), { delay: 35 });
    const inPage = await stopRecording(page);
    await composer.fill("");
    const box = await composer.boundingBox();
    const pixels = await pixelLatency(page, cdp, {
      region: { x: box.x, y: box.y, width: box.width, height: box.height },
      keys: "abcdefghijklmnopqrst".split(""),
      gapMs: 150,
    });
    await composer.fill("");
    return { keyToFrameMs: inPage.keyMs, longTasks: inPage.longTasks, longTaskMs: inPage.longTaskMs, keyToPixelsMs: pixels.pixelMs, pixelMissed: pixels.missed, idleFramesPerSec: pixels.idleFramesPerSec };
  },

  async terminalTyping(session) {
    const { page, cdp } = session;
    await openTerminalTab(page);
    const screen = page.locator(".xterm-screen:visible").first();
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

  // Cora tab <-> terminal tab in the same workspace.
  async tabSwitch(session, _fixture, { repeats = 10 } = {}) {
    const { page } = session;
    await openCora(page);
    await openTerminalTab(page);
    const coraTab = await tabSelector(page, false);
    const terminalTab = await tabSelector(page, true);
    const times = [];
    for (let index = 0; index < repeats; index += 1) {
      const toCora = index % 2 === 0;
      times.push(
        await clickAndPaint(
          page,
          toCora ? coraTab : terminalTab,
          toCora
            ? () => [...document.querySelectorAll(".composer-shell textarea")].some((el) => el.getBoundingClientRect().width > 0)
            : () => [...document.querySelectorAll(".xterm-screen")].some((el) => el.getBoundingClientRect().width > 0),
        ),
      );
      await sleep(250);
    }
    return { switchMs: summarize(times), raw: times.map((v) => round(v)) };
  },

  // A 120-message chat (about 190 KB of markdown with code and tables):
  // open it from history, then scroll it top to bottom with the wheel.
  async chatOpenScroll(session, fixture) {
    const { page } = session;
    await openCora(page);
    const runId = await seedChat(page, fixture, "Long history", 60);
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    const option = page.getByRole("option").filter({ hasText: "Long history" }).first();
    await option.waitFor({ state: "attached", timeout: 15_000 });
    const lastLine = `Answer 60 for ${runId.slice(-6)}`;
    const openMs = await page.evaluate(
      async ({ text }) => {
        const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes("Long history"));
        const started = performance.now();
        option.click();
        await new Promise((resolve, reject) => {
          const poll = () => {
            if (document.body.innerText.includes(text)) return resolve();
            if (performance.now() - started > 20_000) return reject(new Error("chat never painted"));
            requestAnimationFrame(poll);
          };
          poll();
        });
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        return performance.now() - started;
      },
      { text: lastLine },
    );
    await sleep(1000);
    const column = page.getByTestId("cora-conversation");
    const box = await column.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const dom = await page.evaluate(() => document.querySelectorAll("*").length);
    await startRecording(page);
    for (let step = 0; step < 60; step += 1) {
      await page.mouse.wheel(0, -400);
      await sleep(16);
    }
    for (let step = 0; step < 60; step += 1) {
      await page.mouse.wheel(0, 400);
      await sleep(16);
    }
    const scroll = await stopRecording(page);
    return { openMs: round(openMs), domNodes: dom, scroll: pickFrames(scroll) };
  },

  // Expand a folder of 3,000 files in the Explorer, scroll it, collapse it.
  async explorer(session, fixture) {
    const { page } = session;
    const dir = join(fixture.workspaces[0].cwd, "many");
    await page.locator(`[data-fs-path="${fixture.workspaces[0].cwd}/README.md"]`).waitFor({ timeout: 15_000 });
    const expandMs = await clickAndPaint(page, `[data-fs-path="${dir}"]`, visibleText, "file-0000.ts");
    const row = page.locator(`[data-fs-path="${dir}/file-0000.ts"]`);
    const box = await row.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 40);
    await startRecording(page);
    for (let step = 0; step < 50; step += 1) {
      await page.mouse.wheel(0, 300);
      await sleep(16);
    }
    const scroll = await stopRecording(page);
    await page.mouse.wheel(0, -100_000);
    await sleep(300);
    const collapseMs = await clickAndPaint(page, `[data-fs-path="${dir}"]`, (text) => !document.body.innerText.includes(text), "file-0000.ts");
    return { expandMs: round(expandMs), collapseMs: round(collapseMs), scroll: pickFrames(scroll) };
  },

  // Open a 2 MB TypeScript file from the Explorer, then scroll it.
  async bigFile(session, fixture) {
    const { page } = session;
    const file = join(fixture.workspaces[0].cwd, "big.ts");
    const openMs = await clickAndPaint(page, `[data-fs-path="${file}"]`, () => {
      const content = [...document.querySelectorAll(".cm-content")].find((el) => el.getBoundingClientRect().width > 0);
      return Boolean(content && content.textContent.includes("generated0"));
    });
    const editor = page.locator(".cm-scroller:visible").first();
    const box = await editor.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await startRecording(page);
    for (let step = 0; step < 60; step += 1) {
      await page.mouse.wheel(0, 600);
      await sleep(16);
    }
    const scroll = await stopRecording(page);
    await page.keyboard.press("Control+W").catch(() => {});
    return { openMs: round(openMs), scroll: pickFrames(scroll) };
  },

  // Open a browser tab on a small local page; timed until the page has
  // finished loading in the tab's webview.
  async browserPane(session, fixture) {
    const { page } = session;
    const server = await localPage();
    try {
      const results = [];
      for (let index = 0; index < 3; index += 1) {
        const url = `${server.url}?n=${index}`;
        results.push(
          await page.evaluate(async (url) => {
            const started = performance.now();
            await window.spark.openInNewPreview(url);
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
                if (performance.now() - started > 20_000) return reject(new Error("browser tab never loaded"));
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

  // A command that prints 200,000 lines into the terminal: how long until it
  // has finished, what it costs, and how scrolling the scrollback feels.
  async terminalBusy(session, fixture) {
    const { page, pid } = session;
    await openTerminalTab(page);
    const screen = page.locator(".xterm-screen:visible").first();
    await screen.click({ force: true });
    // The shell touches the marker once seq has exited, which is when the app
    // has drained the pty. The t3code adapter uses the same marker.
    const marker = join(fixture.home, "bench-busy-done");
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
    for (let step = 0; step < 60; step += 1) {
      await page.mouse.wheel(0, -500);
      await sleep(16);
    }
    const scroll = await stopRecording(page);
    await page.keyboard.press("Control+L");
    return { printMs: done ? elapsed : null, cpuFirst6s: await cpu, output: pickFrames(output), scroll: pickFrames(scroll) };
  },

  // Five terminal agents redrawing a TUI ten times a second, opened through
  // the agent socket like a real agent would. Measures what they cost and
  // whether the composer still feels instant next to them.
  async agents(session, fixture, { count = 5 } = {}) {
    const { page, pid } = session;
    const panes = [];
    for (let index = 0; index < count; index += 1) {
      panes.push(await rpc(fixture, "terminal.create", { cwd: fixture.workspaces[0].cwd, command: "fake-agent", title: `agent ${index + 1}` }));
    }
    await sleep(5_000);
    const cpu = await cpuOver(pid, 20_000);
    const memory = memorySnapshot(pid);
    const typing = await flows.composerTyping(session);
    // Bring the last agent's tab to the front: the usual case is one agent on
    // screen and the rest working in the background.
    await page.locator(".spark-tab").filter({ hasText: `agent ${count}` }).first().dispatchEvent("click");
    await sleep(2_000);
    const cpuOneVisible = await cpuOver(pid, 10_000);
    for (const pane of panes) {
      const paneId = pane?.paneId ?? pane?.id;
      if (paneId) await rpc(fixture, "terminal.close", { paneId }).catch(() => {});
    }
    return { agents: count, cpu, cpuOneVisible, memory: { totalPssMb: memory.totalPssMb, byKind: memory.byKind, processCount: memory.processCount }, composerWhileAgents: typing };
  },

  // A long reply streamed the way event-log.ts delivers it: one
  // chat.assistant_block per model delta, flushed to the renderer as one IPC
  // batch every 50 ms. 24k characters in 4-character deltas at 150 deltas a
  // second (a fast model) takes about 40 seconds.
  async chatStream(session, fixture, { totalChars = 24_000, deltasPerSecond = 150 } = {}) {
    const { page, app, cdp, pid } = session;
    await openCora(page);
    // One short exchange, so the live row is in view without scrolling and
    // the virtualized list keeps it mounted.
    const runId = await seedChat(page, fixture, "Streaming reply", 1, 300);
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    await page.getByRole("option").filter({ hasText: "Streaming reply" }).first().dispatchEvent("click");
    await page.getByText(`Answer 1 for ${runId.slice(-6)}`).first().waitFor({ timeout: 15_000 });
    const base = streamChunks(totalChars, 4);
    const head = `Stream opening ${runId.slice(-6)}. `;
    const tail = `Stream closing ${runId.slice(-6)}.`;
    const text = `${head}${base.text}\n\n${tail}`;
    const chunks = [head, ...base.chunks, "\n\n", tail];
    return measureStream(session, {
      chunks,
      head,
      tail,
      deltasPerSecond,
      send: () => replayStream(app, { runId, chunks, deltasPerSecond, workspaceId: fixture.workspaces[0].id }),
    });
  },
};


// Sends the deltas from the main process on event-log's 50 ms cadence, so the
// harness's own round trips never pace the stream. Resolves with the epoch
// time the last batch left main.
async function replayStream(app, { runId, chunks, deltasPerSecond, workspaceId }) {
  return app.evaluate(
    async ({ BrowserWindow, ipcMain }, { runId, chunks, deltasPerSecond, workspaceId }) => {
      const perFlush = Math.max(1, Math.round((deltasPerSecond * 50) / 1000));
      const createdAt = Date.now();
      // The renderer renders a live reply only for a run whose Cora call is
      // "started". No real Pi turn runs here, so the run snapshots main hands
      // the renderer are given that call for the length of the replay.
      const handlers = ipcMain._invokeHandlers;
      const call = {
        id: "spark-bench-stream", runId, mode: "chat", model: "gpt-5.6-sol", status: "started",
        inputMessageIds: [], conversationEpoch: 0, createdAt: new Date(createdAt).toISOString(),
      };
      const patchRun = (run) => {
        if (!run || run.id !== runId) return run;
        const lastUser = [...run.humanMessages].reverse().find((message) => message.author === "user");
        return {
          ...run,
          status: "running",
          sparkCalls: [...(run.sparkCalls ?? []), { ...call, inputMessageIds: lastUser ? [lastUser.id] : [] }],
          humanMessages: run.humanMessages.map((message) =>
            message === lastUser ? { ...message, backendTurnId: call.id, deliveryState: "acknowledged", intent: "turn" } : message,
          ),
        };
      };
      const originals = {};
      for (const channel of ["orchestration:getRun", "orchestration:listRuns"]) {
        const original = handlers.get(channel);
        originals[channel] = original;
        handlers.set(channel, async (...args) => {
          const result = await original(...args);
          return Array.isArray(result) ? result.map(patchRun) : patchRun(result);
        });
      }
      globalThis.__benchRestoreRunHandlers = () => {
        for (const [channel, original] of Object.entries(originals)) handlers.set(channel, original);
      };
      // Stream events never refresh the run list, so one status event makes
      // the renderer fetch the patched snapshot before the deltas start.
      const kick = { id: "evt-bench-kick", timestamp: new Date().toISOString(), eventVersion: 1, workspaceId, runId, type: "run.status_updated", payload: { status: "running" } };
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("orchestration:event", kick);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let sequence = 100_000;
      for (let at = 0; at < chunks.length; at += perFlush) {
        const events = chunks.slice(at, at + perFlush).map((text) => {
          sequence += 1;
          return {
            id: `evt-bench-${sequence}`,
            timestamp: new Date().toISOString(),
            eventVersion: 1,
            sequence,
            workspaceId,
            runId,
            sparkCallId: "spark-bench-stream",
            type: "chat.assistant_block",
            payload: { kind: "assistant_block", messageId: "bench-stream", text, conversationEpoch: 0 },
          };
        });
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send("orchestration:events-batch", events);
        const next = createdAt + ((at + perFlush) / deltasPerSecond) * 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())));
      }
      return Date.now();
    },
    { runId, chunks, deltasPerSecond, workspaceId },
  );
}

async function seedChat(page, fixture, title, pairs, answerChars = 1500) {
  const workspace = fixture.workspaces[0];
  const answers = Array.from({ length: pairs }, (_, index) => chatMarkdown(index, answerChars));
  return page.evaluate(
    async ({ workspace, title, answers }) => {
      const spark = window.spark;
      const run = await spark.orchestration.createRun({ workspaceId: workspace.id, workspaceName: workspace.name, cwd: workspace.cwd, title });
      const tag = run.id.slice(-6);
      for (let index = 0; index < answers.length; index += 1) {
        await spark.orchestration.addRunMessage({ runId: run.id, author: "user", kind: "note", message: `Question ${index + 1}: how should we make the ${index % 2 ? "rail" : "composer"} faster?` });
        await spark.orchestration.addRunMessage({ runId: run.id, author: "spark", kind: "note", message: `${answers[index]}\n\nAnswer ${index + 1} for ${tag}` });
      }
      return run.id;
    },
    { workspace, title, answers },
  );
}

// Main-strip tabs carry .spark-tab; the Cora tab is titled after its chat, so
// it is found as the one that is not the terminal tab.
async function tabSelector(page, terminal) {
  return page.evaluate((terminal) => {
    const tabs = [...document.querySelectorAll(".spark-tab")].filter((el) => el.getBoundingClientRect().width > 0);
    const tab = tabs.find((el) => /terminal/i.test(el.textContent ?? "") === terminal);
    if (!tab) throw new Error(`no ${terminal ? "terminal" : "Cora"} tab`);
    const name = terminal ? "terminal" : "cora";
    tab.setAttribute("data-bench-tab", name);
    return `[data-bench-tab="${name}"]`;
  }, terminal);
}

async function openCora(page) {
  const composer = page.locator(".composer-shell textarea:visible").first();
  if (await composer.isVisible().catch(() => false)) return;
  const tab = page.locator(".spark-tab").filter({ hasNotText: /terminal/i }).first();
  if (await tab.count()) await tab.dispatchEvent("click");
  else await page.getByRole("button", { name: "New Cora chat" }).first().click();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
}

async function openTerminalTab(page) {
  await page.locator(".spark-tab").filter({ hasText: /terminal/i }).first().dispatchEvent("click");
  await page.locator(".xterm-screen:visible").first().waitFor({ state: "visible", timeout: 15_000 });
}

export async function close(session) {
  await session.app.close().catch(() => {});
}

export { cpuOver, memorySnapshot, profile, hotFunctions, rpc, chatMarkdown, streamChunks, seedChat, openCora };
