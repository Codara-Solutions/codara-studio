#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// Modal dialogs read over a busy terminal. Their surface is the shared read
// tier of glass (.spark-glass--strong.spark-overlay-surface): a deep tint and
// a strong frost, so the words behind turn into color. The agent's "Remove
// worktrees?" dialog wore those classes and still showed the terminal through
// sharp, because its surface sat inside the scrim: the scrim's fade-in makes
// it a backdrop root, so the frost blurred only the empty scrim. This holds:
//   - every .spark-scrim is a sibling under its dialog, never a wrapper
//   - the approval dialog's fill is at least as opaque as the shared dialog
//     surface, with the same frost, and no ancestor cuts the frost off
//   - over a terminal full of text, what leaks through the dialog is blurred
//   - nothing starts ticked, a row that cannot go has no checkbox and folds
//     into one line at the bottom, the Remove button names the count, and a
//     blocked row says why once
//   - with 17 rows that can go and 18 that cannot: Tick all ticks the 17 and
//     only those go in the answer, and the agent's line shows as text
//
//   node scripts/test-dialog-glass-surface.cjs
//   CODARA_GLASS_SHOTS=/some/dir node scripts/test-dialog-glass-surface.cjs   (also saves screenshots)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT, "src", "renderer", "src");

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

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The JSX opening tags whose className names spark-scrim and that hold children. */
function wrappingScrims(file) {
  const text = fs.readFileSync(file, "utf8");
  const found = [];
  const pattern = /className=(?:"[^"]*\bspark-scrim\b[^"]*"|\{`[^`]*\bspark-scrim\b[^`]*`\})/g;
  for (let match; (match = pattern.exec(text)); ) {
    const start = text.lastIndexOf("<", match.index);
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0 && text[index - 1] !== "=") {
        end = index;
        break;
      }
    }
    if (end > 0 && text[end - 1] !== "/") {
      found.push(`${path.relative(ROOT, file)}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  return found;
}

const BLOCKED = "In use: the agent in the Claude Code tab for “fix the build” in Widgets, which made it.";

function approvalRequest() {
  const base = (name, extra) => ({
    repoRoot: "/work/widgets",
    repoName: "widgets",
    path: `/work/trees/widgets/${name}`,
    branch: `feat/${name}`,
    workspaceName: `feat/${name}`,
    sizeBytes: 52_000_000,
    advice: "safe",
    reason: "Its pull request #12 was merged and nothing is left to save.",
    blocked: null,
    blockedGroup: null,
    missing: false,
    merged: true,
    branchDeletable: true,
    onRemote: true,
    pullRequest: { number: 12, state: "merged" },
    ignored: [],
    unmergedCommits: 0,
    remote: { offered: false, reason: "No merged pull request uses it.", name: "origin", suggested: false },
    ...extra,
  });
  return {
    id: "req-1",
    agent: { client: "claude-code", workspaceName: "Widgets" },
    reason: null,
    expiresAt: Date.now() + 5 * 60_000,
    items: [
      base("merged-docs"),
      base("abandoned", {
        advice: "review",
        reason: "Pull request #9 was closed without merging: 3 commits not merged.",
        unmergedCommits: 3,
        merged: false,
        pullRequest: { number: 9, state: "closed" },
      }),
      base("dns-cutover", { advice: "keep", reason: BLOCKED, blocked: BLOCKED, blockedGroup: IN_USE }),
      base("dns-mcp", {
        advice: "keep",
        reason: "Unsaved changes: 2 files modified.",
        blocked: "It has unsaved changes. Only you can remove it, from Clean up worktrees.",
        blockedGroup: "With unsaved changes",
      }),
    ],
  };
}

const IN_USE = "In use by an open tab or a running program";
const AGENT_REASON =
  "You approved removing every merged worktree <b>today</b>. I recommend ticking all 17; the draft and closed ones only if you are done with them.";

/** About what the owner was asked on 25 Nov: 17 rows that can go and 18 that cannot. */
function crowdedRequest() {
  const repos = ["widgets", "studio-app", "docs-site"];
  const row = (index, extra) => {
    const repo = repos[index % repos.length];
    const name = `task-${String(index).padStart(2, "0")}`;
    return {
      repoRoot: `/work/${repo}`,
      repoName: repo,
      path: `/work/trees/${repo}/${name}`,
      branch: `fix/${name}`,
      workspaceName: null,
      sizeBytes: 40_000_000 + index * 9_000_000,
      advice: "safe",
      reason: `Merged through pull request #${100 + index}, clean and idle.`,
      blocked: null,
      blockedGroup: null,
      missing: false,
      merged: true,
      branchDeletable: true,
      onRemote: true,
      pullRequest: { number: 100 + index, state: "merged" },
      ignored: [],
      unmergedCommits: 0,
      remote: { offered: false, reason: "No merged pull request uses it.", name: "origin", suggested: false },
      ...extra,
    };
  };
  const items = [];
  for (let index = 0; index < 13; index += 1) items.push(row(index));
  items.push(row(13, { advice: "keep", reason: "Pull request #213 is a draft, still open.", merged: false, unmergedCommits: 4, pullRequest: { number: 213, state: "draft" } }));
  items.push(row(14, { advice: "review", reason: "Pull request #214 was closed without merging: 2 commits not merged.", merged: false, unmergedCommits: 2, pullRequest: { number: 214, state: "closed" } }));
  items.push(row(15, { advice: "review", reason: "Merged, but it holds ignored files a fresh checkout does not bring back (.env.local).", ignored: [".env.local"] }));
  items.push(row(16, { advice: "review", reason: "2 commits not merged, no activity for 21 days, no local changes. Its branch stays after removal.", merged: false, unmergedCommits: 2, pullRequest: null, onRemote: false }));
  for (let index = 17; index < 32; index += 1) {
    const why = `In use: the Claude Code tab “task ${index}” in Widgets.`;
    items.push(row(index, { advice: "keep", reason: why, blocked: why, blockedGroup: IN_USE }));
  }
  for (let index = 32; index < 34; index += 1) {
    items.push(row(index, {
      advice: "keep",
      reason: "Unsaved changes: 3 edited files.",
      blocked: "It has unsaved changes. Only you can remove it, from Clean up worktrees.",
      blockedGroup: "With unsaved changes",
    }));
  }
  items.push(row(34, { advice: "keep", reason: "Locked with git worktree lock.", blocked: "Locked with git worktree lock.", blockedGroup: "Locked with git worktree lock" }));
  return { id: "req-crowded", agent: { client: "claude-code", workspaceName: "Widgets" }, reason: AGENT_REASON, expiresAt: Date.now() + 5 * 60_000, items };
}

function alphaOf(color) {
  const slash = /\/\s*([\d.]+%?)\s*\)\s*$/.exec(color);
  if (slash) return slash[1].endsWith("%") ? Number(slash[1].slice(0, -1)) / 100 : Number(slash[1]);
  const rgba = /^rgba\(([^)]+)\)$/.exec(color);
  if (rgba) return Number(rgba[1].split(",")[3]);
  if (color === "transparent") return 0;
  return 1;
}

const BUSY_TEXT = Array.from({ length: 140 }, (_, line) =>
  `${String(line).padStart(4, "0")} build: compiled src/module-${line}.ts -> out/module-${line}.js  OK  ${"#".repeat(line % 37)} ${"lorem ipsum dolor sit amet ".repeat(3)}`,
).join("\n");

async function main() {
  // Every scrim is a sibling under its dialog, so the dialog frosts the window
  // itself rather than the scrim's empty layer.
  const wrapping = walk(RENDERER).flatMap(wrappingScrims);
  assert.deepEqual(wrapping, [], "a .spark-scrim wraps a dialog; make it a self-closing sibling under the surface, as in SettingsDialog.tsx");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-dialog-glass-"));
  let browser;
  try {
    await esbuild.build({
      stdin: {
        contents: `import React from "react";
          import { createRoot } from "react-dom/client";
          import "./src/renderer/src/styles.css";
          import WorktreeCleanupApproval from "./src/renderer/src/components/worktree-cleanup/WorktreeCleanupApproval";
          window.answers = [];
          window.spark = {
            worktreeCleanup: { answerApproval: async (answer) => { window.answers.push(answer); return null; } },
            clipboard: { writeText: async () => undefined },
          };
          window.mountApproval = (request) => {
            const host = document.getElementById("root");
            createRoot(host).render(<WorktreeCleanupApproval request={request} onDone={() => { window.done = true; }} />);
          };`,
        resolveDir: ROOT,
        sourcefile: "dialog-glass-harness.tsx",
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
    fs.writeFileSync(path.join(directory, "busy.txt"), BUSY_TEXT);
    fs.writeFileSync(
      path.join(directory, "index.html"),
      `<!doctype html><html data-glass="on"><head><meta charset="utf-8"><link rel="stylesheet" href="view.css"><style>
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
        #terminal { position: fixed; inset: 0; margin: 0; padding: 6px 8px; background: var(--bg); color: var(--ink);
          font: 13px/1.35 var(--font-mono, monospace); white-space: pre; overflow: hidden; }
        #terminal.is-blank { color: transparent; }
        #root { position: fixed; inset: 0; background: transparent; }
      </style></head><body><pre id="terminal"></pre><div id="root"></div><script src="view.js"></script></body></html>`,
    );
    browser = await launchBrowser();
    const shots = process.env.CODARA_GLASS_SHOTS ? path.resolve(process.env.CODARA_GLASS_SHOTS) : null;
    if (shots) fs.mkdirSync(shots, { recursive: true });

    for (const theme of [
      { id: "codara-classic", mode: "dark" },
      { id: "codara-daylight", mode: "light" },
    ]) {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 720, height: 800 },
      ]) {
        const label = `${theme.mode} ${viewport.width}`;
        const page = await browser.newPage({ viewport });
        // Glass follows prefers-reduced-transparency, and a macOS runner can
        // report reduce. Pin the default so every runner judges the glass.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-transparency", value: process.env.CODARA_GLASS_TRANSPARENCY || "no-preference" }],
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("file://" + path.join(directory, "index.html"));
        assert.equal(
          await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches),
          (process.env.CODARA_GLASS_TRANSPARENCY || "no-preference") === "reduce",
          `${label}: the transparency preference was not pinned`,
        );
        await page.evaluate(
          ({ theme, text }) => {
            document.documentElement.dataset.theme = theme.id;
            document.documentElement.dataset.themeMode = theme.mode;
            document.getElementById("terminal").textContent = text;
          },
          { theme, text: BUSY_TEXT },
        );
        await page.evaluate((request) => window.mountApproval(request), approvalRequest());
        const dialog = page.getByRole("dialog", { name: "Remove worktrees?" });
        await expect(dialog).toBeVisible();
        // Let the scrim's fade-in finish: a filled animation must not hold on.
        await page.waitForTimeout(400);

        // The fill is at least as opaque as the shared dialog surface, with
        // the same frost, and nothing above it cuts that frost off.
        const look = await page.evaluate(() => {
          const surface = document.querySelector('[data-testid="worktree-cleanup-approval"]');
          const reference = document.createElement("div");
          reference.className = "spark-glass--strong spark-overlay-surface";
          reference.style.cssText = "position: fixed; left: 0; top: 0; width: 10px; height: 10px; pointer-events: none;";
          document.body.appendChild(reference);
          const own = getComputedStyle(surface);
          const shared = getComputedStyle(reference);
          const result = {
            background: own.backgroundColor,
            sharedBackground: shared.backgroundColor,
            backdrop: own.backdropFilter,
            sharedBackdrop: shared.backdropFilter,
            opacity: own.opacity,
            roots: [],
          };
          reference.remove();
          for (let element = surface.parentElement; element; element = element.parentElement) {
            const style = getComputedStyle(element);
            const why = [];
            if (Number(style.opacity) < 1) why.push(`opacity ${style.opacity}`);
            if (style.filter !== "none") why.push(`filter ${style.filter}`);
            if (style.backdropFilter !== "none") why.push(`backdrop-filter ${style.backdropFilter}`);
            if (style.mixBlendMode !== "normal") why.push(`mix-blend-mode ${style.mixBlendMode}`);
            if ((style.maskImage || style.webkitMaskImage || "none") !== "none") why.push("mask");
            if (style.clipPath !== "none") why.push(`clip-path ${style.clipPath}`);
            if (/opacity|filter/.test(style.willChange)) why.push(`will-change ${style.willChange}`);
            const animations = element.getAnimations ? element.getAnimations() : [];
            if (animations.length) why.push(`${animations.length} animation(s) still in effect`);
            if (why.length) result.roots.push(`${element.tagName.toLowerCase()}.${[...element.classList].join(".")}: ${why.join(", ")}`);
          }
          return result;
        });
        assert.deepEqual(look.roots, [], `${label}: an ancestor of the dialog is a backdrop root, so its frost sees nothing behind it`);
        assert.ok(
          alphaOf(look.background) >= alphaOf(look.sharedBackground) - 0.001,
          `${label}: the dialog fill ${look.background} is thinner than the shared dialog surface ${look.sharedBackground}`,
        );
        assert.equal(look.backdrop, look.sharedBackdrop, `${label}: the dialog frost differs from the shared dialog surface`);
        assert.match(look.backdrop, /blur\((?!0px)/, `${label}: the dialog does not frost`);
        assert.equal(look.opacity, "1", `${label}: the dialog itself is faded`);

        // What the busy terminal leaks through the dialog is blurred: compare
        // the dialog over the text with the dialog over the same blank
        // terminal, and measure the sharp edges in the difference, inside the
        // dialog and outside it under the scrim alone.
        const box = await dialog.boundingBox();
        const shoot = async () => (await page.screenshot({ type: "png" })).toString("base64");
        const busy = await shoot();
        if (shots) {
          await page.screenshot({ path: path.join(shots, `approval-${theme.mode}-${viewport.width}.png`) });
        }
        await page.evaluate(() => document.getElementById("terminal").classList.add("is-blank"));
        await page.waitForTimeout(100);
        const blank = await shoot();
        await page.evaluate(() => document.getElementById("terminal").classList.remove("is-blank"));
        const leak = await page.evaluate(
          async ({ busy, blank, box }) => {
            const decode = async (data) => {
              const image = new Image();
              image.src = `data:image/png;base64,${data}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d");
              context.drawImage(image, 0, 0);
              return context.getImageData(0, 0, image.width, image.height);
            };
            const a = await decode(busy);
            const b = await decode(blank);
            const luma = (data, x, y) => {
              const i = (y * data.width + x) * 4;
              return 0.2126 * data.data[i] + 0.7152 * data.data[i + 1] + 0.0722 * data.data[i + 2];
            };
            const diff = (x, y) => luma(a, x, y) - luma(b, x, y);
            const edges = (x0, y0, x1, y1) => {
              let total = 0;
              let count = 0;
              for (let y = Math.max(0, Math.floor(y0)); y < Math.min(a.height, Math.floor(y1)); y += 1) {
                for (let x = Math.max(0, Math.floor(x0)); x < Math.min(a.width - 1, Math.floor(x1)); x += 1) {
                  total += Math.abs(diff(x + 1, y) - diff(x, y));
                  count += 1;
                }
              }
              return count ? total / count : 0;
            };
            const inset = 6;
            return {
              inside: edges(box.x + inset, box.y + inset, box.x + box.width - inset, box.y + box.height - inset),
              outside: Math.max(edges(0, 0, box.x - 2, a.height), edges(box.x + box.width + 2, 0, a.width, a.height), edges(0, 0, a.width, box.y - 2)),
            };
          },
          { busy, blank, box },
        );
        assert.ok(leak.outside > 1, `${label}: the busy terminal is not visible around the dialog (${JSON.stringify(leak)})`);
        assert.ok(
          leak.inside < leak.outside * 0.15,
          `${label}: the terminal shows through the dialog sharp (edges inside ${leak.inside.toFixed(2)}, outside ${leak.outside.toFixed(2)})`,
        );

        // Nothing starts ticked; Remove is off until something is, then names the count.
        const boxes = dialog.locator("li[data-worktree-path] .wtc-review-head > input[type=checkbox]");
        assert.equal(await boxes.count(), 2, `${label}: only the rows that can go have a checkbox`);
        for (let index = 0; index < 2; index += 1) await expect(boxes.nth(index)).not.toBeChecked();
        await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
        const row = (name) => dialog.locator(`li[data-worktree-path="/work/trees/widgets/${name}"]`);
        // The rows that cannot go fold into one line at the bottom.
        await expect(row("dns-cutover")).toHaveCount(0);
        const fold = dialog.getByRole("button", { name: /^2 cannot be removed now/ });
        await expect(fold).toHaveAttribute("aria-expanded", "false");
        await fold.click();
        await expect(fold).toHaveAttribute("aria-expanded", "true");
        await expect(row("dns-cutover")).toBeVisible();
        assert.equal(await row("dns-cutover").getByRole("checkbox").count(), 0, `${label}: a blocked row has a checkbox`);
        assert.equal(await row("dns-mcp").getByRole("checkbox").count(), 0, `${label}: a blocked row has a checkbox`);
        // A blocked row says why once; a blocker that adds to the reason stays.
        assert.equal(await row("dns-cutover").getByText(BLOCKED, { exact: true }).count(), 1, `${label}: the blocked reason is repeated`);
        await expect(row("dns-mcp").locator(".wtc-review-blocker")).toHaveText(/unsaved changes/);
        await fold.click();
        await row("abandoned").getByRole("checkbox", { name: "Remove feat/abandoned" }).check();
        await expect(dialog.getByRole("button", { name: "Remove 1 worktree" })).toBeEnabled();
        if (shots) await page.screenshot({ path: path.join(shots, `approval-${theme.mode}-${viewport.width}-ticked.png`) });
        assert.deepEqual(errors, [], `${label}: page errors`);
        console.log(`  ok ${label}: fill ${look.background}, leak inside ${leak.inside.toFixed(2)} vs outside ${leak.outside.toFixed(2)}`);

        // The crowded case: 17 that can go, 18 that cannot, and the agent's line.
        await page.evaluate(() => {
          window.answers = [];
          document.getElementById("root").remove();
          const host = document.createElement("div");
          host.id = "root";
          host.style.cssText = "position: fixed; inset: 0;";
          document.body.appendChild(host);
        });
        const crowded = crowdedRequest();
        await page.evaluate((request) => window.mountApproval(request), crowded);
        await expect(dialog).toBeVisible();
        await page.waitForTimeout(300);
        const said = dialog.getByTestId("worktree-cleanup-agent-reason");
        await expect(said.locator("q")).toHaveText(AGENT_REASON);
        assert.equal(await said.locator("b").count(), 0, `${label}: the agent's markup rendered`);
        await expect(said).toContainText("claude-code in Widgets says");
        const crowdedBoxes = dialog.locator("li[data-worktree-path] .wtc-review-head > input[type=checkbox]");
        assert.equal(await crowdedBoxes.count(), 17);
        assert.equal(await dialog.locator("li[data-worktree-path] input:checked").count(), 0, `${label}: something starts ticked`);
        await expect(dialog.getByText("17 worktrees can be removed")).toBeVisible();
        await expect(dialog.getByRole("button", { name: /^18 cannot be removed now/ })).toHaveAttribute("aria-expanded", "false");
        assert.equal(await dialog.getByText("keep", { exact: true }).count(), 0, `${label}: a badge says keep`);
        await expect(dialog.getByText("Folder goes. The branch stays, here and on origin, with pull request #213.")).toBeVisible();
        if (shots) await page.screenshot({ path: path.join(shots, `crowded-${theme.mode}-${viewport.width}.png`) });
        await dialog.getByRole("button", { name: "Tick all 17" }).click();
        await expect(dialog.getByRole("button", { name: "Remove 17 worktrees" })).toBeEnabled();
        await dialog.getByRole("button", { name: "Untick all" }).click();
        await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
        await dialog.getByRole("button", { name: "Tick all 17" }).click();
        await dialog.getByRole("button", { name: /^18 cannot be removed now/ }).click();
        await expect(dialog.getByRole("heading", { name: `${IN_USE} · 15` })).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "With unsaved changes · 2" })).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "Locked with git worktree lock · 1" })).toBeVisible();
        assert.equal(await dialog.locator("li.is-blocked input").count(), 0, `${label}: a blocked row has a checkbox`);
        if (shots) {
          await dialog.locator(".wtc-fold").scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(shots, `crowded-${theme.mode}-${viewport.width}-ticked-open.png`) });
        }
        await dialog.getByRole("button", { name: "Remove 17 worktrees" }).click();
        const answer = await page.evaluate(() => window.answers[0]);
        assert.equal(answer.approved, true);
        const sent = new Map(answer.items.map((entry) => [entry.path, entry.remove]));
        for (const entry of crowded.items) assert.equal(sent.get(entry.path), entry.blocked === null, `${label}: ${entry.path} sent wrong`);
        assert.deepEqual(errors, [], `${label}: page errors`);
        console.log(`  ok ${label}: 17 ticked with Tick all, 18 folded and never sent`);
        await page.close();
      }
    }
    console.log("PASS dialogs frost the window behind them, and the approval dialog removes nothing by accident");
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL dialog glass surface");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
