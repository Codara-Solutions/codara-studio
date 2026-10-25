#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// The merged fold's Clean up confirm (rail/WorkspaceChildren.tsx): it asks
// only for more than one worktree, never comes back by itself after the
// worktrees went elsewhere, starts on Cancel, and keeps Escape to itself.
//
//   node scripts/test-rail-clean-up-confirm.cjs

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-rail-confirm-"));
  let browser;
  try {
    await esbuild.build({
      stdin: {
        contents: `import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { WorkspaceChildren } from "./src/renderer/src/components/rail/WorkspaceChildren";
          import { keyInsideModal } from "./src/renderer/src/shortcuts/modal-keys";
          window.keyInsideModal = keyInsideModal;
          function Harness() {
            const [names, setNames] = useState(["widgets · feat/old", "widgets · feat/older"]);
            window.setMergedNames = setNames;
            window.cleaned = window.cleaned || [];
            return (
              <WorkspaceChildren
                parentId="ws-app"
                ownAgents={[]}
                active={[]}
                merged={{
                  count: names.length,
                  open: false,
                  onToggle: () => {},
                  cleanUps: names.map((name) => ({
                    id: name,
                    name,
                    cleanUp: async () => {
                      window.cleaned.push(name);
                      return { status: "removed", branchDeleted: true };
                    },
                  })),
                  rows: [],
                }}
              />
            );
          }
          window.outerEscapes = 0;
          window.addEventListener("keydown", (event) => { if (event.key === "Escape") window.outerEscapes += 1; });
          // The board's and the workers view's own Escape: window, capture
          // phase, stopPropagation, registered before the confirm opens.
          window.boardEscapes = 0;
          window.boardOpen = false;
          window.addEventListener("keydown", (event) => {
            if (!window.boardOpen || event.key !== "Escape" || keyInsideModal(event)) return;
            event.preventDefault();
            event.stopPropagation();
            window.boardEscapes += 1;
          }, true);
          createRoot(document.getElementById("root")).render(<Harness />);`,
        resolveDir: ROOT,
        sourcefile: "rail-confirm-harness.tsx",
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
    fs.writeFileSync(
      path.join(directory, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="view.css"></head><body><div id="root"></div><script src="view.js"></script></body></html>',
    );
    browser = await launchBrowser();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("file://" + path.join(directory, "index.html"));
    const cleanUp = page.getByTestId("workspace-merged-clean-up");
    const confirm = page.getByTestId("workspace-merged-clean-up-confirm");

    // Two to remove: it asks, and starts on Cancel.
    await cleanUp.click();
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();

    // Escape closes it and goes no further.
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.outerEscapes), 0, "Escape reached the rest of the app");

    // The worktrees go elsewhere while it is open; a later merge does not bring it back.
    await cleanUp.click();
    await expect(confirm).toBeVisible();
    await page.evaluate(() => window.setMergedNames([]));
    await expect(confirm).toHaveCount(0);
    await page.evaluate(() => window.setMergedNames(["widgets · feat/new"]));
    await expect(cleanUp).toBeVisible();
    await page.waitForTimeout(100);
    await expect(confirm).toHaveCount(0);
    await page.evaluate(() => window.setMergedNames(["widgets · feat/new", "widgets · feat/newer"]));
    await page.waitForTimeout(100);
    await expect(confirm).toHaveCount(0);

    // One to remove: no question.
    await page.evaluate(() => window.setMergedNames(["widgets · feat/new"]));
    await cleanUp.click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.cleaned)).toEqual(["widgets · feat/new"]);

    // Down to one while open: it closes rather than ask about one.
    await page.evaluate(() => window.setMergedNames(["a", "b"]));
    await cleanUp.click();
    await expect(confirm).toBeVisible();
    await page.evaluate(() => window.setMergedNames(["a"]));
    await expect(confirm).toHaveCount(0);
    await page.evaluate(() => window.setMergedNames(["a", "c"]));
    await page.waitForTimeout(100);
    await expect(confirm).toHaveCount(0);

    // With the board open behind it, Escape still belongs to the confirm.
    await page.evaluate(() => {
      window.boardOpen = true;
    });
    await cleanUp.click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.boardEscapes), 0, "the board took the confirm's Escape");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => window.boardEscapes), 1, "the board keeps its own Escape");
    // A click on the confirm's text keeps focus in it, and with focus on
    // nothing at all the open confirm still owns Escape.
    await cleanUp.click();
    await confirm.locator(".rail-confirm-text").click();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await cleanUp.click();
    await expect(confirm).toBeVisible();
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.boardEscapes), 1, "the board took an Escape meant for the confirm");
    await page.evaluate(() => {
      window.boardOpen = false;
    });

    // A modal that is itself position: fixed (offsetParent is null for it)
    // still owns a key with focus on nothing; a hidden one does not.
    const ownsBodyEscape = (style) =>
      page.evaluate((css) => {
        const modal = document.createElement("div");
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.style.cssText = css;
        modal.textContent = "fixed dialog";
        document.body.appendChild(modal);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        let owned = null;
        const probe = (event) => {
          owned = window.keyInsideModal(event);
        };
        window.addEventListener("keydown", probe, true);
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        window.removeEventListener("keydown", probe, true);
        modal.remove();
        return owned;
      }, style);
    assert.equal(await ownsBodyEscape("position: fixed; inset: 20px; z-index: 5"), true, "a fixed modal owns the key");
    assert.equal(await ownsBodyEscape("position: fixed; inset: 20px; display: none"), false, "a hidden modal does not");

    // Confirming runs it.
    await cleanUp.click();
    await confirm.getByRole("button", { name: "Clean up" }).click();
    await expect(confirm).toHaveCount(0);
    // Each worktree the confirm named runs once, in order.
    await expect.poll(() => page.evaluate(() => window.cleaned.slice(1))).toEqual(["a", "c"]);
    assert.deepEqual(errors, []);
    console.log("PASS the merged fold's Clean up confirm");
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL the merged fold's Clean up confirm");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
