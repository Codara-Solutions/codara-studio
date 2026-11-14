// How often and how much the terminal scrollback store writes to disk
// (src/main/terminal-scrollback-store.ts), in virtual time.
//
// Guards:
// - a pane is saved 10 s after it goes quiet, and at most 60 s after its
//   first unsaved byte while it never goes quiet;
// - a save is forced when the pane leaves the screen (flush(paneId), from
//   TerminalPane through terminalScrollback:flush), when its process exits,
//   and at quit (flush() from before-quit and flushAllStores);
// - a save appends only what was printed since the last one, and the file
//   then restores exactly what a whole rewrite would;
// - a pane printing for 2 minutes is saved twice (the byte count against the
//   store before this change: measure-terminal-scrollback-writes.cjs).
//
//   node scripts/test-terminal-scrollback-writes.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`PASS ${name}`);
}

async function bundle(entry, name, dir) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    // An older store checked out to a temp folder resolves packages here too.
    nodePaths: [path.join(ROOT, "node_modules")],
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

// Bytes the store hands the file system under `dir`: whole writes, and
// appends (writes through a handle opened "r+").
function countWrites(dir) {
  const fsp = fs.promises;
  const writeFile = fsp.writeFile;
  const open = fsp.open;
  const counter = { bytes: 0, writes: 0, appends: 0 };
  fsp.writeFile = function (file, data, options) {
    if (String(file).startsWith(dir)) {
      counter.bytes += data.length;
      counter.writes += 1;
    }
    return writeFile.call(this, file, data, options);
  };
  fsp.open = async function (file, flags, mode) {
    const handle = await open.call(this, file, flags, mode);
    if (String(file).startsWith(dir) && flags === "r+") {
      const write = handle.write;
      handle.write = function (data, ...rest) {
        counter.bytes += data.length;
        counter.appends += 1;
        return write.call(this, data, ...rest);
      };
    }
    return handle;
  };
  counter.restore = () => {
    fsp.writeFile = writeFile;
    fsp.open = open;
  };
  return counter;
}

const ERASE_FRAME = "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G";
// A line printed above the footer, which the next frame then redraws below.
const aboveFooter = (text) => `${ERASE_FRAME}${text}\r\n\r\n\r\n`;
const inkFrame = (n) =>
  ERASE_FRAME +
  `\x1b[38;2;215;119;87m${"✻✶✳✢·"[n % 5]} Working… (${Math.floor(n / 10)}s · esc to interrupt)\x1b[39m\r\n` +
  `╭${"─".repeat(60)}╮\r\n│ > ${" ".repeat(57)}│`;

// A store over `dir`, its save timers on a virtual clock. The timers go to
// the store as a dependency, and to globalThis.__scrollbackSaveTimers for a
// copy of an older store patched to read them there
// (measure-terminal-scrollback-writes.cjs).
async function makeHarness(storeMod, dir, limits = {}) {
  let now = 1_700_000_000_000;
  const timers = new Set();
  const taps = new Map();
  const exits = new Map();
  const sessions = new Set();
  const h = { dims: { cols: 100, rows: 30 } };
  const virtualTimers = {
    setTimeout(fn, ms) {
      const timer = { at: now + Math.max(0, ms), fn };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
  };
  globalThis.__scrollbackSaveTimers = virtualTimers;
  const store = new storeMod.TerminalScrollbackStore({
    dir,
    tap: (id, handler) => {
      taps.set(id, handler);
      return () => taps.delete(id);
    },
    onExit: (id, handler) => {
      exits.set(id, handler);
      return () => exits.get(id) === handler && exits.delete(id);
    },
    hasSession: (id) => sessions.has(id),
    dimensions: () => h.dims,
    readTail: () => null,
    enabled: () => true,
    limits,
    now: () => now,
    timers: virtualTimers,
  });
  await store.init();
  const file = (paneId) => path.join(dir, storeMod.scrollbackFileName(paneId));
  return Object.assign(h, {
    dir,
    store,
    sessions,
    file,
    exists: (paneId) => fs.existsSync(file(paneId)),
    feed(paneId, text) {
      taps.get(paneId)(Buffer.from(text, "utf8"));
    },
    exit(paneId) {
      const handler = exits.get(paneId);
      exits.delete(paneId);
      handler?.();
    },
    hasExitWatch: (paneId) => exits.has(paneId),
    now: () => now,
    // pty-manager drops the handlers without calling them on a duplicate exit.
    dropExitWatch: (paneId) => exits.delete(paneId),
    // Moves the clock, firing every save timer due on the way.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        timers.delete(due);
        due.fn();
        await store.idle();
      }
      now = end;
      await store.idle();
    },
  });
}

// Two minutes of a pane that already holds a session's output: bytes written
// meanwhile. The workloads never stay quiet for 10 s.
async function twoMinutes(storeMod, dir, limits, workload) {
  const h = await makeHarness(storeMod, dir, limits);
  h.store.track(["agent"]);
  for (let i = 0; i < 400; i += 1) h.feed("agent", `● Read src/file-${i}.ts (${i * 7} lines)\r\n  ⎿  done\r\n`);
  await h.store.flush();
  const counter = countWrites(h.dir);
  await workload(h);
  counter.restore();
  h.store.dispose();
  return counter;
}

const WORKLOADS = {
  // A spinner repaint every 100 ms and a tool call line every 3 s.
  "an agent working": async (h) => {
    for (let t = 0, n = 0; t < 120_000; t += 100, n += 1) {
      if (t % 3_000 === 0) h.feed("agent", aboveFooter(`● Bash(npm test -- step ${t / 1000})\r\n  ⎿  ok`));
      h.feed("agent", inkFrame(n));
      await h.advance(100);
    }
  },
  // Thirty log lines at a time, 2.5 to 9 s apart.
  "a build printing in bursts": async (h) => {
    for (let t = 0, i = 0; t < 120_000; i += 1) {
      for (let line = 0; line < 30; line += 1) h.feed("agent", `[build] step ${i}.${line} ${"·".repeat(50)}\r\n`);
      const gap = 2_500 + ((i * 2_300) % 6_500);
      await h.advance(gap);
      t += gap;
    }
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-scrollback-writes-"));
  const storeMod = await bundle(path.join(ROOT, "src", "main", "terminal-scrollback-store.ts"), "store", tmp);
  const defaults = storeMod.DEFAULT_TERMINAL_SCROLLBACK_LIMITS;
  check("saves wait 10 s of quiet, 60 s at most", defaults.saveDebounceMs === 10_000 && defaults.saveMaxWaitMs === 60_000);

  let run = 0;
  const harness = (limits = {}) => {
    run += 1;
    return makeHarness(storeMod, path.join(tmp, `run-${run}`, "terminal-scrollback"), limits);
  };

  // ── debounce ──────────────────────────────────────────────────────────
  {
    const h = await harness();
    h.store.track(["quiet"]);
    h.feed("quiet", "$ ls\r\na b c\r\n$ ");
    await h.advance(9_900);
    check("nothing is written before 10 s of quiet", !h.exists("quiet"));
    await h.advance(200);
    check("the pane is saved once quiet for 10 s", h.exists("quiet"));
    h.feed("quiet", "more\r\n");
    await h.advance(5_000);
    h.feed("quiet", "and more\r\n");
    await h.advance(9_000);
    const before = (await h.store.read("quiet")).raw.toString("utf8");
    check("output 5 s apart restarts the wait", !before.includes("more"));
    await h.advance(1_100);
    const after = (await h.store.read("quiet")).raw.toString("utf8");
    check("and is saved 10 s after the last of it", after.includes("more\r\nand more"));
    h.store.dispose();
  }

  // ── max wait ──────────────────────────────────────────────────────────
  {
    const h = await harness();
    h.store.track(["busy"]);
    const fsp = fs.promises;
    const writeFile = fsp.writeFile;
    let firstSaveAt = -1;
    const start = h.now();
    fsp.writeFile = function (file, data, options) {
      if (firstSaveAt < 0 && String(file).startsWith(h.dir)) firstSaveAt = h.now() - start;
      return writeFile.call(this, file, data, options);
    };
    let n = 0;
    for (let t = 0; t < 70_000; t += 100) {
      h.feed("busy", inkFrame(n++));
      await h.advance(100);
    }
    fsp.writeFile = writeFile;
    check(
      "a pane that never goes quiet is saved exactly 60 s after its first unsaved byte",
      firstSaveAt === 60_000,
      String(firstSaveAt),
    );
    h.store.dispose();
  }

  // ── each forced save ──────────────────────────────────────────────────
  {
    const h = await harness();
    h.store.track(["shown", "hidden"]);
    h.feed("shown", "visible output\r\n");
    h.feed("hidden", "output of a pane that left the screen\r\n");
    await h.store.flush("hidden");
    check("a pane leaving the screen is saved at once", h.exists("hidden"));
    check("and only that pane", !h.exists("shown"));

    h.sessions.add("shown");
    h.feed("shown", "last words\r\n");
    h.exit("shown");
    await h.store.idle();
    check("a pane whose process exits is saved at once", h.exists("shown"));
    check(
      "with everything it printed",
      (await h.store.read("shown")).raw.toString("utf8").includes("visible output\r\nlast words"),
    );
    check("the next process in that pane is watched too", h.hasExitWatch("shown"));
    h.feed("shown", "second shell\r\n");
    h.exit("shown");
    await h.store.idle();
    check(
      "and saved when it exits",
      (await h.store.read("shown")).raw.toString("utf8").includes("second shell"),
    );

    h.feed("hidden", "printed just before quit\r\n");
    h.feed("shown", "also just before quit\r\n");
    await h.store.flush();
    check(
      "quit saves every pane with unsaved output",
      (await h.store.read("hidden")).raw.toString("utf8").includes("printed just before quit") &&
        (await h.store.read("shown")).raw.toString("utf8").includes("also just before quit"),
    );
    h.dropExitWatch("shown");
    h.store.track(["shown", "hidden"]);
    check("a dropped exit handler is registered again at the next layout sync", h.hasExitWatch("shown"));
    await h.store.forget("shown");
    check("a closed pane stops being watched", !h.hasExitWatch("shown"));
    h.store.dispose();
  }

  // The real app reaches those saves: the renderer asks when a pane hides,
  // main wires the exit, the window hide and the quit paths.
  {
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
    const pane = read("src/renderer/src/components/Terminal/TerminalPane.tsx");
    const wrapper = read("src/main/terminal-scrollback.ts");
    const preload = read("src/preload/areas/terminal-scrollback.ts");
    const index = read("src/main/index.ts");
    check("TerminalPane flushes its pane when it leaves the screen", /terminalScrollback\?\.flush\?\.\(sessionId\)/.test(pane));
    check("the flush channel exists on both sides", wrapper.includes('"terminalScrollback:flush"') && preload.includes('"terminalScrollback:flush"'));
    check("main hands the store each pane's exit", /onExit: \(paneId, handler\) => pty\.onExit\(/.test(wrapper));
    const quit = index.slice(index.indexOf('app.on("before-quit"'));
    const flushAll = index.slice(index.indexOf("async function flushAllStores"), index.indexOf("async function flushAllStores") + 1200);
    check("before-quit saves every pane", quit.includes("flushTerminalScrollback()"));
    check("flushAllStores waits for those saves", flushAll.includes("flushTerminalScrollback()"));
    check(
      "hiding or minimizing the window saves every pane",
      /on\("minimize", \(\) => \{[^}]*flushTerminalScrollback\(\)/.test(index) &&
        /on\("hide", \(\) => \{[^}]*flushTerminalScrollback\(\)/.test(index),
    );
  }

  // ── appends restore what a whole rewrite would ────────────────────────
  {
    const small = { rawCompactBytes: 8 * 1024, rawHardCapBytes: 32 * 1024 };
    const appended = await harness(small);
    const whole = await harness(small);
    const counter = countWrites(appended.dir);
    for (const h of [appended, whole]) h.store.track(["p"]);
    let n = 0;
    for (let round = 0; round < 12; round += 1) {
      for (let i = 0; i < 20; i += 1) {
        const text = i % 5 === 0 ? aboveFooter(`● step ${round}.${i}: ${"x".repeat(40)}`) : inkFrame(n++);
        appended.feed("p", text);
        whole.feed("p", text);
      }
      await appended.advance(61_000);
    }
    await appended.store.flush();
    await whole.store.flush();
    counter.restore();
    check("saves after the first append to the file", counter.appends > 0 && counter.writes >= 1, JSON.stringify(counter));
    check(
      "the file stays bounded",
      fs.statSync(appended.file("p")).size < 32 * 1024 + 256 * 1024 + 4096,
      JSON.stringify(counter),
    );
    const a = await appended.store.read("p");
    const w = await whole.store.read("p");
    const render = await bundle(path.join(ROOT, "src", "main", "terminal-scrollback-render.ts"), "render", tmp);
    const show = (r) => render.renderScrollbackForDisplay([r.history, r.raw], r.cols, r.rows, { maxLines: 3000, maxChars: 1024 * 1024 });
    const shownA = await show(a);
    const shownW = await show(w);
    check("the appended file restores the same text as a whole rewrite", shownA === shownW && shownA.includes("step 11.15"), `${shownA.length} vs ${shownW.length}`);
    check("a read gives the time of the last append, not of the header", Date.parse(a.savedAt) >= fs.statSync(appended.file("p")).mtimeMs - 1);

    // A resize or a failed write starts over with a whole file.
    appended.store.track(["q"]);
    appended.feed("q", "before\r\n");
    await appended.store.flush("q");
    appended.dims = { cols: 90, rows: 30 };
    let after = countWrites(appended.dir);
    appended.feed("q", "narrower\r\n");
    await appended.store.flush("q");
    after.restore();
    check("a resized pane's file is rewritten whole", after.writes === 1 && after.appends === 0, JSON.stringify(after));
    const fsp = fs.promises;
    const realOpen = fsp.open;
    fsp.open = async (file, flags, mode) => {
      if (flags === "r+") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return realOpen.call(fsp, file, flags, mode);
    };
    appended.feed("q", "lost append\r\n");
    await appended.store.flush("q");
    fsp.open = realOpen;
    after = countWrites(appended.dir);
    appended.feed("q", "next\r\n");
    await appended.store.flush("q");
    after.restore();
    const text = (await appended.store.read("q")).raw.toString("utf8");
    check(
      "after a failed append the next save rewrites the file with what it missed",
      after.writes === 1 && text.includes("before") && text.includes("lost append\r\nnext"),
      JSON.stringify({ after, text }),
    );

    // Log lines (cheaper to append than to rewrite) until the raw part would
    // pass the cap: that save rewrites the file whole, folded.
    appended.store.track(["log"]);
    appended.feed("log", "start\r\n");
    await appended.store.flush("log");
    let crossed = null;
    for (let i = 0, raw = 0; raw < 40 * 1024; i += 1) {
      const counter = countWrites(appended.dir);
      const chunk = Array.from({ length: 20 }, (_, j) => `log ${i}.${j} ${"=".repeat(60)}\r\n`).join("");
      raw += chunk.length;
      appended.feed("log", chunk);
      await appended.store.flush("log");
      counter.restore();
      if (crossed === null && counter.writes === 1) crossed = { at: raw, counter };
      else if (crossed === null && counter.appends !== 1) crossed = { at: raw, counter, wrong: true };
    }
    check(
      "log output is appended until the raw part would pass the cap, then rewritten whole",
      crossed && !crossed.wrong && crossed.at > 24 * 1024 && crossed.at <= 34 * 1024,
      JSON.stringify(crossed),
    );

    // The disk takes only part of an append (filling up): the rest is still
    // written, or, when it takes nothing, the pane stays unsaved and the
    // next save rewrites the file whole.
    const withHandleWrite = async (paneId, fakeWrite, run) => {
      const realOpen = fsp.open;
      fsp.open = async (file, flags, mode) => {
        const handle = await realOpen.call(fsp, file, flags, mode);
        if (flags === "r+" && String(file).endsWith(storeMod.scrollbackFileName(paneId))) {
          const write = handle.write.bind(handle);
          handle.write = (data, offset, length, position) => fakeWrite(write, data, offset, length, position);
        }
        return handle;
      };
      try {
        await run();
      } finally {
        fsp.open = realOpen;
      }
    };
    appended.store.track(["short"]);
    appended.feed("short", "head\r\n");
    await appended.store.flush("short");
    let calls = 0;
    await withHandleWrite(
      "short",
      (write, data, offset, length, position) => {
        calls += 1;
        return write(data, offset, Math.min(3, length), position);
      },
      async () => {
        appended.feed("short", "abcdefghij\r\n");
        await appended.store.flush("short");
      },
    );
    check(
      "an append the disk takes 3 bytes at a time is written whole",
      calls > 1 && (await appended.store.read("short")).raw.toString("utf8") === "head\r\nabcdefghij\r\n",
    );
    await withHandleWrite(
      "short",
      async () => ({ bytesWritten: 0 }),
      async () => {
        appended.feed("short", "klmnop\r\n");
        await appended.store.flush("short");
      },
    );
    const stalled = countWrites(appended.dir);
    await appended.store.flush("short");
    stalled.restore();
    check(
      "an append that writes nothing leaves the pane unsaved, and the next save rewrites it",
      stalled.writes === 1 && (await appended.store.read("short")).raw.toString("utf8") === "head\r\nabcdefghij\r\nklmnop\r\n",
      JSON.stringify(stalled),
    );

    // The total budget evicts a file while its append is on the way: the
    // append fails instead of leaving a tail with no header, and the next
    // save writes the file whole.
    appended.store.track(["evicted"]);
    appended.feed("evicted", "kept line\r\n");
    await appended.store.flush("evicted");
    const openFor = fsp.open;
    fsp.open = async (file, flags, mode) => {
      if (flags === "r+" && String(file).endsWith(storeMod.scrollbackFileName("evicted"))) {
        await appended.store.removeFile(storeMod.scrollbackFileName("evicted"));
      }
      return openFor.call(fsp, file, flags, mode);
    };
    appended.feed("evicted", "printed during the eviction\r\n");
    await appended.store.flush("evicted");
    fsp.open = openFor;
    check("an append never recreates an evicted file without its header", !appended.exists("evicted"));
    appended.feed("evicted", "after\r\n");
    await appended.store.flush("evicted");
    const back = (await appended.store.read("evicted"))?.raw.toString("utf8") ?? "";
    check(
      "the next save writes it whole again",
      back.includes("kept line\r\nprinted during the eviction\r\nafter"),
      JSON.stringify(back),
    );
    appended.store.dispose();
    whole.store.dispose();
  }

  // ── a restored pane: rewritten with the marker, then appended ─────────
  {
    run += 1;
    const dir = path.join(tmp, `run-${run}`, "terminal-scrollback");
    const first = await makeHarness(storeMod, dir);
    first.store.track(["r"]);
    first.feed("r", "$ echo before restart\r\nbefore restart\r\n$ ");
    await first.store.flush();
    first.store.dispose();
    const second = await makeHarness(storeMod, dir);
    const replay = await second.store.restoreReplay("r");
    check("the earlier output is replayed", !!replay && replay.text.includes("before restart"));
    second.store.track(["r"]);
    second.sessions.add("r");
    const counter = countWrites(dir);
    second.feed("r", "$ echo one\r\none\r\n");
    await second.store.flush();
    second.feed("r", "$ echo two\r\ntwo\r\n");
    await second.store.flush();
    counter.restore();
    check("the first save after a restore is whole, the next one appended", counter.writes === 1 && counter.appends === 1, JSON.stringify(counter));
    second.store.dispose();
    const third = await makeHarness(storeMod, dir);
    const text = (await third.store.restoreReplay("r"))?.text ?? "";
    const order = ["before restart", "Restored from before", "one\r\n", "two\r\n"].map((part) => text.indexOf(part));
    check(
      "the next restart shows both sessions around the marker, in order",
      order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
      JSON.stringify(order),
    );
    third.store.dispose();
  }

  // ── 2 minutes of output ───────────────────────────────────────────────
  // measure-terminal-scrollback-writes.cjs runs the same against the store
  // before this change; here the new one alone must stay within two saves.
  for (const [name, workload] of Object.entries(WORKLOADS)) {
    run += 1;
    const counter = await twoMinutes(storeMod, path.join(tmp, `run-${run}`, "terminal-scrollback"), {}, workload);
    check(
      `${name} for 2 minutes is saved twice (${counter.writes} whole, ${counter.appends} appended, ${counter.bytes} bytes)`,
      counter.writes + counter.appends === 2,
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} checks passed`);
}

module.exports = { ROOT, bundle, makeHarness, twoMinutes, WORKLOADS };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
