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
      ["a read that lists nothing counts as loaded", () => { window.spark = { worktreeCleanup: { railStates: async () => [] } }; }, "true"],
    ]) {
      const page = await browser.newPage();
      await page.addInitScript(script);
      await page.goto("file://" + path.join(directory, "index.html"));
      await page.waitForTimeout(150);
      await expect(page.locator("#loaded"), name).toHaveText(expected);
      await page.close();
    }
    console.log("PASS the rail's worktree states say when they are known");
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
