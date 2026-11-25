#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// The merged fold's Clean up confirm (rail/WorkspaceChildren.tsx): it asks
// only for more than one worktree, in one dialog that names what each would
// stop or delete, never comes back by itself after the worktrees went
// elsewhere, starts on Cancel, keeps Escape to itself, and shows its
// progress before the first removal is done.
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
        contents: `import React, { useContext, useState } from "react";
          import { createRoot } from "react-dom/client";
          import { WorkspaceChildren } from "./src/renderer/src/components/rail/WorkspaceChildren";
          import { RailRemovingContext } from "./src/renderer/src/components/rail/RailCleanUp";
          // Stands for a merged row: it reads whether its removal is under way.
          function Row({ name }) {
            const removing = useContext(RailRemovingContext).has(name);
            return <div data-testid="harness-row" data-name={name}>{removing ? name + ": Removing…" : name}</div>;
          }
          import { keyInsideModal } from "./src/renderer/src/shortcuts/modal-keys";
          window.keyInsideModal = keyInsideModal;
          function Harness() {
            const [names, setNames] = useState(["widgets · feat/old", "widgets · feat/older"]);
            const [open, setOpen] = useState(false);
            window.setMergedNames = setNames;
            window.setFoldOpen = setOpen;
            window.cleaned = window.cleaned || [];
            return (
              <WorkspaceChildren
                parentId="ws-app"
                ownAgents={[]}
                active={[]}
                merged={{
                  count: names.length,
                  open,
                  onToggle: () => {},
                  cleanUps: names.map((name) => ({
                    id: name,
                    name,
                    cleanUp: async (answer = {}) => {
                      window.answers = window.answers || [];
                      window.answers.push([name, answer]);
                      // Checks that wait together until the test lets them answer.
                      if (answer.preview && window.holdPreviews) {
                        window.previewStarted.push(name);
                        await (window.previewGate ||= new Promise((done) => (window.releasePreviews = done)));
                      }
                      // "held" stays with a reason; "secret" asks about its
                      // .env and "server" about its leftover until the
                      // question's fingerprint comes back.
                      if (name === "held") return { status: "refused", message: "Close the tab first.", branchDeleted: false };
                      if (name === "secret" && answer.confirmIgnored !== "fp-1") {
                        return { status: "confirm", holds: [".env"], fingerprint: "fp-1", branchDeleted: false };
                      }
                      if (name === "server" && answer.confirmStop !== "sp-1") {
                        const processes = [{ pid: 4242, program: "node server.js", runningMs: 3 * 3600000, startedBy: "started by an agent that is still open: the tab “dev”" }];
                        return { status: "confirm", processes, stopFingerprint: "sp-1", branchDeleted: false };
                      }
                      // "late" reads READY at the check, then gains a program
                      // before the click: main asks about it (no fingerprint came back).
                      if (name === "late" && !answer.preview && window.lateGained && answer.confirmStop !== "sp-late") {
                        const processes = [{ pid: 5151, program: "vite", runningMs: 1000 }];
                        return { status: "confirm", code: "CONFIRM_STOP", processes, stopFingerprint: "sp-late", branchDeleted: false };
                      }
                      if (answer.preview) return { status: "confirm", code: "READY", branchDeleted: false };
                      window.cleaned.push(name);
                      // A removal that waits for the test to let it finish.
                      if (window.hold) await new Promise((done) => (window.releases[name] = done));
                      return { status: "removed", branchDeleted: true };
                    },
                  })),
                  rows: names.map((name) => <Row key={name} name={name} />),
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

    // Confirming one worktree's .env leaves the other's reason in place.
    await page.evaluate(() => window.setMergedNames(["held", "secret"]));
    const notice = page.getByTestId("workspace-merged-notice");
    await cleanUp.click();
    // One dialog: what was refused is a line by the button, not a question.
    await expect(confirm).toContainText("secret holds .env");
    await expect(notice).toContainText("held: Close the tab first.");
    await confirm.getByRole("button", { name: "Remove anyway" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.cleaned.slice(-1))).toEqual(["secret"]);
    await expect(notice).toContainText("held: Close the tab first.");
    await notice.getByRole("button", { name: /^Dismiss/ }).click();
    await expect(notice).toHaveCount(0);

    // A leftover program and an ignored file, asked about together, one
    // line per worktree; the yes carries both fingerprints back.
    await page.evaluate(() => window.setMergedNames(["server", "secret", "plain"]));
    await cleanUp.click();
    await expect(confirm).toContainText("Clean up 3 merged worktrees?");
    await expect(confirm.locator("li")).toHaveText([
      "server: stops node server.js (pid 4242), running 3 h, started by an agent that is still open: the tab “dev”",
      "secret: deletes .env",
      "plain",
    ]);
    await page.evaluate(() => (window.answers = []));
    await confirm.getByRole("button", { name: "Stop and clean up" }).click();
    await expect(confirm).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.answers))
      .toEqual([
        ["server", { confirmStop: "sp-1" }],
        ["secret", { confirmIgnored: "fp-1" }],
        ["plain", {}],
      ]);

    // Several rows are checked all at once: every check is asked before
    // any has answered, and the button says so from the click.
    await page.evaluate(() => {
      window.setMergedNames(["a", "b", "c", "d"]);
      window.previewStarted = [];
      window.previewGate = null;
      window.holdPreviews = true;
    });
    await cleanUp.click();
    await expect(cleanUp).toHaveText("Checking…");
    await expect.poll(() => page.evaluate(() => window.previewStarted.slice().sort())).toEqual(["a", "b", "c", "d"]);
    await page.evaluate(() => {
      window.holdPreviews = false;
      window.releasePreviews();
    });
    await expect(confirm).toContainText("Clean up 4 merged worktrees?");

    // On yes, before the first removal has finished, the button counts and
    // the row being removed says so; each row leaves as soon as its own
    // removal is done, and the next one says so in turn.
    await page.evaluate(() => {
      window.hold = true;
      window.releases = {};
      window.cleaned = [];
      window.setFoldOpen(true);
    });
    const rows = page.getByTestId("harness-row");
    await confirm.getByRole("button", { name: "Clean up" }).click();
    await expect(cleanUp).toHaveText("Cleaning 1 of 4…");
    await expect(cleanUp).toBeDisabled();
    await expect(rows).toHaveText(["a: Removing…", "b", "c", "d"]);
    assert.deepEqual(await page.evaluate(() => Object.keys(window.releases)), ["a"], "the first removal is still running");
    await page.evaluate(() => {
      window.releases.a();
      window.setMergedNames((names) => names.filter((name) => name !== "a"));
    });
    await expect(cleanUp).toHaveText("Cleaning 2 of 4…");
    await expect(rows).toHaveText(["b: Removing…", "c", "d"]);
    await page.evaluate(() => {
      window.hold = false;
      window.releases.b();
    });
    await expect(cleanUp).toHaveText("Clean up");
    await expect(rows).toHaveText(["b", "c", "d"]);

    // A row READY at the check that gained a program before the click is
    // asked about again, named as changed, and is not removed meanwhile.
    await page.evaluate(() => {
      window.setMergedNames(["late", "plain"]);
      window.cleaned = [];
      window.answers = [];
      window.lateGained = false;
    });
    await cleanUp.click();
    await expect(confirm).toContainText("Clean up 2 merged worktrees?");
    await expect(confirm.locator("li")).toHaveText(["late", "plain"]);
    await page.evaluate(() => (window.lateGained = true));
    await confirm.getByRole("button", { name: "Clean up" }).click();
    await expect(confirm).toContainText("late still runs vite");
    await expect(confirm).toContainText("It changed since you were asked. Check the list again.");
    assert.deepEqual(await page.evaluate(() => window.cleaned), ["plain"], "late was not removed on the first yes");
    await confirm.getByRole("button", { name: "Stop and clean up" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.cleaned)).toEqual(["plain", "late"]);
    assert.deepEqual(
      await page.evaluate(() => window.answers.filter(([name]) => name === "late").map(([, answer]) => answer)),
      [{ preview: true }, {}, { confirmStop: "sp-late" }],
    );
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
