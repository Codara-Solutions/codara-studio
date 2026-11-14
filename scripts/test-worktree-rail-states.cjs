#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// useWorktreeRailStates (src/renderer/src/git/useWorktreeRailStates.ts)
// says when its first read finished, failed reads included, so the rail can
// tell "not known yet" from "never known". Also checks that the window
// capture Escape handlers behind a modal leave its keys to it.
//
//   node scripts/test-worktree-rail-states.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    const cache = path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
    const candidates = [];
    for (const directory of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
      for (const binary of ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
        const candidate = path.join(cache, directory, binary);
        if (fs.existsSync(candidate)) candidates.push(candidate);
      }
    }
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates.sort().pop() });
  }
}

async function main() {
  // The three window capture handlers that claim Escape leave it to a modal.
  for (const file of ["board/BoardView.tsx", "automations/WorkersView.tsx", "automations/LiveBoard.tsx"]) {
    const source = fs.readFileSync(path.join(ROOT, "src", "renderer", "src", "components", file), "utf8");
    assert.match(source, /keyInsideModal\(/, `${file} leaves a modal's keys to it`);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-states-"));
  let browser;
  try {
    await esbuild.build({
      stdin: {
        contents: `import React from "react";
          import { createRoot } from "react-dom/client";
          import { useWorktreeRailStates } from "./src/renderer/src/git/useWorktreeRailStates";
          const workspaces = [{ id: "wt", name: "wt", cwd: "/wt", color: "#000", workers: [], copyBranch: { repoCwd: "/repo", branch: "b", city: "x", mode: "fork", createdAt: "2026-10-25T10:00:00Z" } }];
          function Harness() {
            const { loaded } = useWorktreeRailStates(workspaces, () => {});
            return <span id="loaded">{String(loaded)}</span>;
          }
          createRoot(document.getElementById("root")).render(<Harness />);`,
        resolveDir: ROOT,
        sourcefile: "rail-states-harness.tsx",
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: path.join(directory, "view.js"),
      jsx: "automatic",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    fs.writeFileSync(path.join(directory, "index.html"), '<!doctype html><html><body><div id="root"></div><script src="view.js"></script></body></html>');
    browser = await launchBrowser();
    for (const [name, script, expected] of [
      ["a read still pending is not loaded", () => { window.spark = { worktreeCleanup: { railStates: () => new Promise(() => {}) } }; }, "false"],
      ["a failed read counts as loaded", () => { window.spark = { worktreeCleanup: { railStates: () => Promise.reject(new Error("main is busy")) } }; }, "true"],
      ["a read that lists nothing counts as loaded", () => { window.spark = { worktreeCleanup: { railStates: async () => ({ states: [], external: [] }) } }; }, "true"],
    ]) {
      const page = await browser.newPage();
      await page.addInitScript(script);
      await page.goto("file://" + path.join(directory, "index.html"));
      await page.waitForTimeout(150);
      await expect(page.locator("#loaded"), name).toHaveText(expected);
      await page.close();
    }
    console.log("PASS the rail's worktree states say when they are known");

    // The rail and the git clock: a change seen while a read runs is read
    // when it ends, and a change between the first read and the clock's
    // first comparison is not lost as a first sighting.
    await esbuild.build({
      stdin: {
        contents: `import React from "react";
          import { createRoot } from "react-dom/client";
          import { useWorktreeRailStates } from "./src/renderer/src/git/useWorktreeRailStates";
          const workspaces = [{ id: "wt", name: "wt", cwd: "/wt", color: "#000", workers: [], copyBranch: { repoCwd: "/repo", branch: "b", city: "x", mode: "fork", createdAt: "2026-10-25T10:00:00Z" } }];
          function Harness() {
            useWorktreeRailStates(workspaces, () => {}, () => false);
            return <span id="mounted">yes</span>;
          }
          createRoot(document.getElementById("root")).render(<Harness />);`,
        resolveDir: ROOT,
        sourcefile: "rail-clock-harness.tsx",
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: path.join(directory, "clock.js"),
      jsx: "automatic",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    fs.writeFileSync(path.join(directory, "clock.html"), '<!doctype html><html><body><div id="root"></div><script src="clock.js"></script></body></html>');
    // The rail is off screen: the clock compares it every HIDDEN_EVERY ticks
    // of TICK_MS (gitRefreshClock.ts), on the page's own fake timers.
    const hiddenTick = async (page) => {
      await page.clock.runFor(30_000);
      await page.waitForTimeout(150);
    };
    const railWithClock = async (holdFirstRead) => {
      const page = await browser.newPage();
      await page.addInitScript((hold) => {
        window.__sig = { "/wt": "s0" };
        window.__calls = [];
        window.__release = [];
        window.spark = {
          app: { e2eBackground: true },
          git: { signatures: async (cwds) => Object.fromEntries(cwds.map((cwd) => [cwd, window.__sig[cwd] ?? null])) },
          worktreeCleanup: {
            railStates: (projects) => {
              window.__calls.push(projects ?? null);
              const answer = { states: [], external: [] };
              if (hold === "fail" && window.__calls.length === 1) return Promise.reject(new Error("main is busy"));
              if (hold === true && window.__calls.length === 1) return new Promise((resolve) => window.__release.push(() => resolve(answer)));
              return Promise.resolve(answer);
            },
            railCleanUp: async () => null,
          },
        };
      }, holdFirstRead);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, "clock.html"));
      await page.waitForFunction(() => window.__calls.length === 1);
      return page;
    };
    {
      const page = await railWithClock(true);
      // A merge lands while the full read runs; the rail's next tick looks.
      await page.evaluate(() => { window.__sig["/wt"] = "s1"; });
      await hiddenTick(page);
      await page.evaluate(() => window.__release.forEach((release) => release()));
      await page.waitForTimeout(150);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/repo"], ["/repo"]], "a change seen mid-read is read after it");
      await page.close();
      console.log("PASS a git change seen while a rail read runs is read when it ends");
    }
    {
      const page = await railWithClock(false);
      await page.waitForTimeout(100);
      // A commit after the first read, before the clock's first comparison.
      await page.evaluate(() => { window.__sig["/wt"] = "s1"; });
      await hiddenTick(page);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/repo"], ["/repo"]], "the move after the first read is read");
      await hiddenTick(page);
      assert.equal(await page.evaluate(() => window.__calls.length), 2, "nothing moved since: no read");
      await page.close();
      console.log("PASS a change between the rail's first read and the first comparison is not lost");
    }
    {
      // The first full read fails after its baseline: the next comparison
      // (every HIDDEN_EVERY ticks) asks again instead of waiting for the
      // 30-minute full read.
      const page = await railWithClock("fail");
      await hiddenTick(page);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/repo"], ["/repo"]], "a failed read is retried on the next comparison");
      await hiddenTick(page);
      assert.equal(await page.evaluate(() => window.__calls.length), 2, "and once it succeeds, not again");
      await page.close();
      console.log("PASS a failed rail read is retried on the next comparison");
    }
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL the rail's worktree states say when they are known");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
