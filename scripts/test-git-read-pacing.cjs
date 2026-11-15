#!/usr/bin/env node
// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// When the window's git reads run (gitRefreshClock.ts and its watchers), in
// a browser with the real hooks:
//   - at start the rail reads the visible workspace's project first, and its
//     rows have their state within 5 s; the other projects follow one at a
//     time, and the rail says it is loaded once all were read;
//   - the visible project is read on its own: at once when a project still
//     waiting in the round is selected, and at once on refocus when its git
//     state moved while the window was away;
//   - the round keeps its place when workspaces come and go, reads news
//     every other turn so no project starves, wakes when focus has settled
//     however focus comes and goes, and reads nothing while unfocused;
//   - reads due only by time wait until the window has been focused for a
//     whole off-screen round after it comes back;
//   - on focus, Source Control's lanes re-read the user's own lane and the lanes whose
//     git state moved, not every lane of the project;
//   - the rail re-reads at once only the projects with a row waiting on time
//     or tabs (merged, missing, about to be removed), even one waiting in
//     the round; a project whose git state moved off screen waits for its
//     next off-screen comparison.
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
        const [visible, setVisible] = React.useState("q1");
        window.__setWorkspaces = setList;
        window.__setVisible = setVisible;
        const { states, loaded, refresh } = useWorktreeRailStates(list, () => {}, () => true, visible);
        window.__refresh = refresh;
        if (states.q1 && window.__badgeAt === undefined) window.__badgeAt = performance.now();
        return <span id="rows">{Object.keys(states).sort().join(",") + (loaded ? " loaded" : "")}</span>;
      }
      createRoot(document.getElementById("root")).render(<Harness />);`,
    );
    browser = await launchBrowser();
    const railSpark = () => {
      window.__calls = [];
      window.__sig = {};
      window.__merged = [];
      // Milliseconds a read of a project takes ("*": every project).
      window.__slow = {};
      window.spark = {
        app: { e2eBackground: true },
        git: { signatures: async (cwds) => Object.fromEntries(cwds.map((cwd) => [cwd, window.__sig[cwd] ?? "s0"])) },
        worktreeCleanup: {
          railStates: async (projects) => {
            window.__calls.push(projects ? [...projects].sort() : null);
            const slow = Math.max(0, ...(projects ?? []).map((project) => window.__slow[project] ?? window.__slow["*"] ?? 0));
            if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
            const rows = { "/p": ["w1", "w2"], "/q": ["q1"], "/c": ["c"] };
            const ids = (projects ?? ["/p", "/q"]).flatMap((project) => rows[project] ?? []);
            return {
              states: ids.map((id) => ({
                workspaceId: id,
                missing: false,
                branch: id,
                branchGone: false,
                merge: window.__merged.includes(id) ? "merged" : "ahead",
                autoCandidate: false,
              })),
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
      // Leaving and coming back inside a pace does not read a project at the
      // refocus either: a project needs a whole pace of focused window.
      const page = await browser.newPage();
      await page.addInitScript(railSpark);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, "start.html"));
      await page.waitForFunction(() => window.__calls.length === 1);
      await page.clock.runFor(5_000);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.clock.runFor(24_000);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.__calls.length), 1, "no read around the refocus");
      await page.clock.runFor(60_000);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.__calls), [["/q"], ["/p"]], "then it carries on");
      await page.close();
      console.log("PASS leaving and coming back inside a pace reads nothing at the refocus");
    }
    const startPage = async () => {
      const page = await browser.newPage();
      await page.addInitScript(railSpark);
      await page.clock.install();
      await page.goto("file://" + path.join(directory, "start.html"));
      await page.waitForFunction(() => window.__calls.length === 1);
      return page;
    };
    const run = async (page, ms) => {
      await page.clock.runFor(ms);
      await page.waitForTimeout(100);
    };
    const calls = (page) => page.evaluate(() => window.__calls);
    const fire = (page, name) => page.evaluate((event) => window.dispatchEvent(new Event(event)), name);
    {
      // A change of workspaces keeps the round's place and pace. New projects
      // are news: in a round they take every other turn, so the others move.
      const page = await startPage();
      await run(page, 31_000);
      assert.deepEqual(await calls(page), [["/q"], ["/p"]]);
      await page.evaluate((more) => window.__setWorkspaces((list) => [...list, ...more]), [
        { id: "r", name: "r", cwd: "/r", color: "#000", workers: [] },
        { id: "s", name: "s", cwd: "/s", color: "#000", workers: [] },
      ]);
      await page.waitForTimeout(100);
      await page.evaluate(() => window.__refresh());
      await page.waitForTimeout(100);
      await run(page, 95_000);
      // The start's last turn went to news (/p, never compared before), so
      // this round starts with the oldest.
      assert.deepEqual((await calls(page)).slice(2), [["/q"], ["/r"], ["/p"]], "the oldest, news, the oldest");
      assert.equal(await page.locator("#rows").textContent(), "q1,w1,w2 loaded");
      await page.close();
      console.log("PASS a change of workspaces keeps the round's place; news takes every other turn");
    }
    {
      // A workspace added every 20 s neither resets the pace nor starves the
      // project that was waiting first.
      const page = await startPage();
      for (let index = 0; index < 8; index++) {
        await page.evaluate(
          (id) => window.__setWorkspaces((list) => [...list, { id, name: id, cwd: `/${id}`, color: "#000", workers: [] }]),
          `n${index}`,
        );
        await page.waitForTimeout(50);
        await run(page, 20_000);
      }
      const seen = await calls(page);
      assert.ok(seen.some((call) => call[0] === "/p"), `the first project waiting is read (${JSON.stringify(seen)})`);
      assert.ok(seen.length - 1 >= 5, `one project every 30 s goes on (${seen.length - 1} in 160 s)`);
      await page.close();
      console.log("PASS workspaces added every 20 s starve no project");
    }
    {
      // Focus that comes and goes out of step with the 30 s pace: the round
      // wakes when focus has settled, not on the next 30 s poll.
      const page = await startPage();
      await fire(page, "blur");
      await run(page, 31_000);
      await fire(page, "focus");
      await run(page, 29_000);
      assert.equal((await calls(page)).length, 1, "not before focus has settled");
      await run(page, 2_000);
      assert.deepEqual(await calls(page), [["/q"], ["/p"]], "30 s after focus returned");
      await page.close();
      console.log("PASS the round wakes when focus has settled, however focus comes and goes");
    }
    {
      // Selecting a project still waiting in the round reads it at once.
      const page = await startPage();
      await page.evaluate(() => window.__setVisible("w1"));
      await page.waitForTimeout(150);
      assert.deepEqual(await calls(page), [["/q"], ["/p"]], "the selected project at once");
      // Selecting a project read and with nothing waiting reads nothing; its
      // checkouts are then compared every tick.
      await page.evaluate(() => window.__setVisible("q1"));
      await page.waitForTimeout(150);
      assert.equal((await calls(page)).length, 2, "nothing waits on /q: no read");
      await page.evaluate(() => {
        window.__sig["/q1"] = "s1";
      });
      await run(page, 3_100);
      assert.deepEqual((await calls(page)).slice(2), [["/q"]], "a move on screen within one tick");
      await page.close();
      console.log("PASS the selected project is read at once when it waits, and watched every tick");
    }
    {
      // A slow background read (25 s) of one project does not hold up the
      // project the user selects: its row has a state within 5 s.
      const page = await startPage();
      await page.evaluate(() => {
        window.__slow["/p"] = 25_000;
        window.__setWorkspaces((list) => [...list, { id: "c", name: "c", cwd: "/c", color: "#000", workers: [] }]);
      });
      await page.waitForTimeout(100);
      await run(page, 31_000);
      assert.deepEqual((await calls(page)).at(-1), ["/p"], "the round is reading /p, slowly");
      await page.evaluate(() => window.__setVisible("c"));
      await page.waitForTimeout(100);
      await run(page, 5_000);
      assert.match(await page.locator("#rows").textContent(), /^c,q1/, "the selected project's row within 5 s");
      await run(page, 25_000);
      assert.match(await page.locator("#rows").textContent(), /^c,q1,w1,w2 loaded/, "and /p's when its read ends");
      await page.close();
      console.log("PASS a slow background read does not hold up the selected project");
    }
    {
      // Reads that take 25 s while a workspace is added every 20 s: no read
      // is thrown away, every project is read and the rail is loaded.
      const page = await startPage();
      await page.evaluate(() => {
        window.__slow["*"] = 25_000;
      });
      for (let index = 0; index < 8; index++) {
        await page.evaluate(
          (id) => window.__setWorkspaces((list) => [...list, { id, name: id, cwd: `/${id}`, color: "#000", workers: [] }]),
          `m${index}`,
        );
        await page.waitForTimeout(50);
        await run(page, 20_000);
      }
      assert.ok((await calls(page)).some((call) => call[0] === "/p"), "the project waiting first is read");
      for (let step = 0; step < 12; step++) await run(page, 30_000);
      const read = new Set((await calls(page)).map((call) => call[0]));
      for (const project of ["/p", "/q", ...Array.from({ length: 8 }, (_, index) => `/m${index}`)]) {
        assert.ok(read.has(project), `${project} is read`);
      }
      assert.match(await page.locator("#rows").textContent(), / loaded$/, "and the rail is loaded");
      await page.close();
      console.log("PASS slow reads and steady workspace changes: every project is read, the rail is loaded");
    }
    {
      // Sol's schedule: reads that take 25 s while a worktree of the visible
      // project is added every 20 s. Nothing in flight is thrown away for the
      // other projects, the round goes on, and once the additions stop every
      // project is read and the rail is loaded.
      const page = await startPage();
      await page.evaluate(() => {
        window.__slow["*"] = 25_000;
      });
      for (let index = 2; index < 10; index++) {
        await page.evaluate(
          (worktree) => window.__setWorkspaces((list) => [...list, worktree]),
          { id: `q${index}`, name: `q${index}`, cwd: `/q${index}`, color: "#000", workers: [], copyBranch: { repoCwd: "/q", branch: `q${index}`, city: "x", mode: "fork", createdAt: "2026-10-25T10:00:00Z" } },
        );
        await page.waitForTimeout(50);
        await run(page, 20_000);
      }
      assert.equal(
        (await calls(page)).filter((call) => call[0] === "/p").length,
        1,
        "the other project is read once during the additions, its answer kept",
      );
      for (let step = 0; step < 4; step++) await run(page, 30_000);
      const read = new Set((await calls(page)).map((call) => call[0]));
      assert.ok(read.has("/p") && read.has("/q"), "every project is read");
      assert.match(await page.locator("#rows").textContent(), / loaded$/, "and the rail is loaded");
      await page.close();
      console.log("PASS slow reads while the visible project keeps growing: the rest is read, the rail is loaded");
    }
    {
      // refresh() while a read runs: that read may predate what the refresh
      // is for, so the project is read again after it.
      const page = await startPage();
      await page.evaluate(() => {
        window.__slow["/p"] = 25_000;
      });
      await run(page, 31_000);
      assert.deepEqual((await calls(page)).at(-1), ["/p"], "/p is being read");
      await page.evaluate(() => window.__refresh());
      await page.waitForTimeout(100);
      await run(page, 30_000);
      assert.equal((await calls(page)).filter((call) => call[0] === "/p").length, 2, "read again after the refresh");
      await page.close();
      console.log("PASS refresh() during a read reads that project again");
    }
    {
      // A merge lands in the visible project while the window is away: the
      // refocus reads it at once. Nothing moved: nothing is read.
      const page = await startPage();
      await run(page, 31_000);
      assert.equal((await calls(page)).length, 2);
      await fire(page, "blur");
      await run(page, 60_000);
      await fire(page, "focus");
      await run(page, 100);
      assert.equal((await calls(page)).length, 2, "a refocus with nothing moved reads nothing");
      await fire(page, "blur");
      await page.evaluate(() => {
        window.__sig["/q"] = "s1";
        window.__sig["/q1"] = "s1";
      });
      await run(page, 60_000);
      await fire(page, "focus");
      await run(page, 100);
      assert.deepEqual((await calls(page)).slice(2), [["/q"]], "the visible project at once on refocus");
      await page.close();
      console.log("PASS a refocus reads the visible project at once when it moved");
    }
    {
      // A row waiting on removal is read on focus even while its project
      // waits in a round.
      const page = await startPage();
      await page.evaluate(() => {
        window.__merged = ["w1"];
      });
      await run(page, 31_000);
      assert.deepEqual(await calls(page), [["/q"], ["/p"]]);
      await page.evaluate(() => window.__refresh());
      await page.waitForTimeout(100);
      await fire(page, "blur");
      await run(page, 25_000);
      await fire(page, "focus");
      await run(page, 100);
      assert.deepEqual((await calls(page)).slice(2), [["/p"]], "the project waiting on removal at once, round or not");
      await page.close();
      console.log("PASS a row waiting on removal is read on focus even while its project waits in the round");
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
      // Away longer than the safety re-read: it waits until the window has
      // been focused for a whole off-screen round, not the first tick.
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.clock.runFor(6 * 60_000);
      await page.evaluate(() => {
        window.__reads = [];
        window.dispatchEvent(new Event("focus"));
      });
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.__reads), [["/p"]], "the 10 s after a long absence read the own lane only");
      await page.clock.runFor(25_000);
      await page.waitForTimeout(100);
      assert.deepEqual((await page.evaluate(() => window.__reads)).at(-1), ["/p", "/w1", "/w2"], "the overdue safety read comes later");
      await page.close();
      console.log("PASS on focus the lanes re-read the user's own lane and the lanes that moved, and overdue reads wait");
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
