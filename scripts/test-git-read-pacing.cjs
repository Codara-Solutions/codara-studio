#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// When the window's git reads run (gitRefreshClock.ts and its watchers), in
// a browser with the real hooks:
//   - at start the rail reads the visible workspace's project first, and its
//     rows have their state within 5 s; the other projects follow one at a
//     time, and the rail says it is loaded once all were read;
//   - on focus, Source Control's lanes re-read the user's own lane and the lanes whose
//     git state moved, not every lane of the project;
//   - the rail re-reads at once only the projects with a row waiting on time
//     or tabs (merged, missing, about to be removed); a project whose git
//     state moved off screen waits for its next off-screen comparison.
//
//   node scripts/test-git-read-pacing.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium } = require("@playwright/test");

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

async function bundle(directory, name, contents) {
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: `${name}.tsx`, loader: "tsx" },
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: path.join(directory, `${name}.js`),
    jsx: "automatic",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  fs.writeFileSync(path.join(directory, `${name}.html`), `<!doctype html><html><body><div id="root"></div><script src="${name}.js"></script></body></html>`);
}

const copy = (id, cwd, repoCwd) => ({
  id,
  name: id,
  cwd,
  color: "#000",
  workers: [],
  copyBranch: { repoCwd, branch: id, city: id, mode: "fork", createdAt: "2026-10-25T10:00:00Z" },
});

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-read-pacing-"));
  let browser;
  try {
    const workspaces = [
      { id: "p", name: "p", cwd: "/p", color: "#000", workers: [] },
      copy("w1", "/w1", "/p"),
      copy("w2", "/w2", "/p"),
      { id: "q", name: "q", cwd: "/q", color: "#000", workers: [] },
      copy("q1", "/q1", "/q"),
    ];
    await bundle(
      directory,
      "lanes",
      `import React from "react";
      import { createRoot } from "react-dom/client";
      import { useSourceLanes } from "./src/renderer/src/components/git/lanes/useSourceLanes";
      const workspaces = ${JSON.stringify(workspaces)};
      function Harness() {
        useSourceLanes({ workspaces }, workspaces[0], { branch: "main", visible: true, version: 0 });
        return <span id="mounted">yes</span>;
      }
      createRoot(document.getElementById("root")).render(<Harness />);`,
    );
    await bundle(
      directory,
      "rail",
      `import React from "react";
      import { createRoot } from "react-dom/client";
      import { useWorktreeRailStates } from "./src/renderer/src/git/useWorktreeRailStates";
      const workspaces = ${JSON.stringify(workspaces)};
      function Harness() {
        useWorktreeRailStates(workspaces, () => {}, () => true);
        return <span id="mounted">yes</span>;
      }
      createRoot(document.getElementById("root")).render(<Harness />);`,
    );
    await bundle(
      directory,
      "start",
      `import React from "react";
      import { createRoot } from "react-dom/client";
      import { useWorktreeRailStates } from "./src/renderer/src/git/useWorktreeRailStates";
      const workspaces = ${JSON.stringify(workspaces)};
      function Harness() {
        const [list, setList] = React.useState(workspaces);
        window.__setWorkspaces = setList;
        const { states, loaded } = useWorktreeRailStates(list, () => {}, () => true, "q1");
        if (states.q1 && window.__badgeAt === undefined) window.__badgeAt = performance.now();
        return <span id="rows">{Object.keys(states).sort().join(",") + (loaded ? " loaded" : "")}</span>;
      }
      createRoot(document.getElementById("root")).render(<Harness />);`,
    );
    browser = await launchBrowser();
    const railSpark = () => {
      window.__calls = [];
      window.spark = {
        app: { e2eBackground: true },
        git: { signatures: async (cwds) => Object.fromEntries(cwds.map((cwd) => [cwd, "s0"])) },
        worktreeCleanup: {
          railStates: async (projects) => {
            window.__calls.push(projects ? [...projects].sort() : null);
            const rows = { "/p": ["w1", "w2"], "/q": ["q1"] };
            const ids = (projects ?? ["/p", "/q"]).flatMap((project) => rows[project] ?? []);
            return {
              states: ids.map((id) => ({ workspaceId: id, missing: false, branch: id, branchGone: false, merge: "ahead", autoCandidate: false })),
              external: [],
            };
          },
          railCleanUp: async () => null,
        },
      };
    };

    {
      // Real timers: the visible workspace's row has its state within 5 s.
      const page = await browser.newPage();
      await page.addInitScript(railSpark);
      await page.goto("file://" + path.join(directory, "start.html"));
      await page.waitForFunction(() => window.__badgeAt !== undefined, null, { timeout: 5_000 });
      assert.ok((await page.evaluate(() => window.__badgeAt)) < 5_000, "within 5 s of the page loading");
      await page.waitForTimeout(500);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/q"]], "the visible project first, the others not yet");
      assert.equal(await page.locator("#rows").textContent(), "q1", "not loaded while projects wait their turn");
      await page.close();
      console.log("PASS at start the visible workspace's rail state comes first, within 5 s");
    }
    {
      const page = await browser.newPage();
      await page.addInitScript(railSpark);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, "start.html"));
      await page.waitForFunction(() => window.__calls.length === 1);
      await page.clock.runFor(31_000);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/q"], ["/p"]], "then one project at a time");
      assert.equal(await page.locator("#rows").textContent(), "q1,w1,w2 loaded");
      await page.close();
      console.log("PASS the other projects follow one at a time, and the rail is loaded once all were read");
    }
    {
      // The round waits while the window is unfocused, and a refocus does
      // not read the next project at once.
      const page = await browser.newPage();
      await page.addInitScript(railSpark);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, "start.html"));
      await page.waitForFunction(() => window.__calls.length === 1);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.clock.runFor(91_000);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.__calls.length), 1, "nothing read while unfocused");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.__calls.length), 1, "nor in the 10 s after focus returns");
      await page.clock.runFor(60_000);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/q"], ["/p"]], "then it carries on");
      await page.close();
      console.log("PASS the round waits while the window is unfocused, and not for a refocus");
    }
    {
      // A change of workspaces restarts the round: it carries on with the
      // projects read least recently, so none is starved by restarts.
      const page = await browser.newPage();
      await page.addInitScript(railSpark);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, "start.html"));
      await page.waitForFunction(() => window.__calls.length === 1);
      await page.evaluate((more) => window.__setWorkspaces((list) => [...list, ...more]), [
        { id: "r", name: "r", cwd: "/r", color: "#000", workers: [] },
        { id: "s", name: "s", cwd: "/s", color: "#000", workers: [] },
      ]);
      await page.waitForTimeout(100);
      await page.clock.runFor(31_000);
      await page.waitForTimeout(100);
      // The first round's /q, the restart's /q (visible first), then /p.
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/q"], ["/q"], ["/p"]]);
      await page.evaluate((more) => window.__setWorkspaces((list) => [...list, ...more]), [
        { id: "t", name: "t", cwd: "/t", color: "#000", workers: [] },
      ]);
      await page.waitForTimeout(100);
      await page.clock.runFor(31_000);
      await page.waitForTimeout(100);
      assert.deepEqual(
        (await page.evaluate(() => window.__calls)).slice(3),
        [["/q"], ["/r"]],
        "after another restart the projects never read come before /p, read a moment ago",
      );
      assert.ok(!(await page.locator("#rows").textContent()).includes("loaded"), "not loaded while /s and /t wait");
      await page.close();
      console.log("PASS a restarted round carries on with the projects read least recently");
    }

    const open = async (name, init) => {
      const page = await browser.newPage();
      await page.addInitScript(init);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, `${name}.html`));
      return page;
    };
    const spark = () => {
      window.__sig = {};
      window.__reads = [];
      window.spark = {
        app: { e2eBackground: true },
        fs: { onChanged: () => () => {} },
        git: {
          signatures: async (cwds) => Object.fromEntries(cwds.map((cwd) => [cwd, window.__sig[cwd] ?? "s0"])),
          laneChanges: async (cwds) => {
            window.__reads.push([...cwds].sort());
            return {};
          },
        },
      };
    };
    const refocus = async (page) => {
      await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
      });
      await page.clock.runFor(10);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.clock.runFor(10);
      await page.waitForTimeout(100);
    };

    {
      const page = await open("lanes", spark);
      await page.waitForFunction(() => window.__reads.length >= 1);
      await page.waitForTimeout(100);
      // The first comparison (a first sighting is a change) settles.
      await page.clock.runFor(3_100);
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.__reads = [];
      });
      await refocus(page);
      assert.deepEqual(await page.evaluate(() => window.__reads), [["/p"]], "focus with nothing moved reads only the user's own lane");
      await page.evaluate(() => {
        window.__reads = [];
        window.__sig["/w2"] = "s1";
      });
      await refocus(page);
      assert.deepEqual(await page.evaluate(() => window.__reads), [["/p", "/w2"]], "and a lane that moved");
      await page.close();
      console.log("PASS on focus the lanes re-read the user's own lane and the lanes that moved");
    }

    {
      const page = await open("rail", () => {
        window.__sig = {};
        window.__calls = [];
        window.spark = {
          app: { e2eBackground: true },
          git: { signatures: async (cwds) => Object.fromEntries(cwds.map((cwd) => [cwd, window.__sig[cwd] ?? "s0"])) },
          worktreeCleanup: {
            railStates: async (projects) => {
              window.__calls.push(projects ? [...projects].sort() : null);
              // w1 is merged: a row waiting on time and tabs.
              const all = [
                { workspaceId: "w1", missing: false, branch: "w1", branchGone: false, merge: "merged", autoCandidate: false },
                { workspaceId: "q1", missing: false, branch: "q1", branchGone: false, merge: "ahead", autoCandidate: false },
              ];
              return { states: all, external: [] };
            },
            railCleanUp: async () => null,
          },
        };
      });
      await page.waitForFunction(() => window.__calls.length === 1);
      await page.waitForTimeout(100);
      // Past the focus gap, with q's git state moved while the window was away.
      // The start round reads /p, then /q 30 s later; then past the focus gap.
      await page.clock.runFor(52_000);
      await page.evaluate(() => {
        window.__calls = [];
        window.__sig["/q1"] = "s1";
      });
      await refocus(page);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/p"]], "focus reads the project waiting on removal, not the one that moved");
      await page.clock.runFor(30_000);
      await page.waitForTimeout(150);
      assert.ok(
        (await page.evaluate(() => window.__calls)).some((call) => call && call.includes("/q")),
        "the moved project is read on its next off-screen comparison",
      );
      await page.close();
      console.log("PASS on focus the rail re-reads only the projects waiting on removal at once");
    }
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("FAIL what the window reads when it regains focus");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
