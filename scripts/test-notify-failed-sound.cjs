#!/usr/bin/env node
"use strict";

// The "failed" chime and the Sound setting, end to end:
//   - every failure kind plays "failed", whatever its producer passed, and
//     every producer that publishes a failure says "failed" itself (a table
//     over the emitters in src/main, so a new one cannot slip in);
//   - a failed run never plays "done";
//   - native OS notifications are always silent, so Studio's chime is the
//     only sound and the Sound toggle off means no sound for any kind;
//   - the three chimes are distinct, short, unclipped and equally loud.
// Electron, the event log, preferences and the center store are stubbed.
//
//   node scripts/test-notify-failed-sound.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED = path.join(ROOT, "src", "shared");
const SOUND_KINDS = ["needs-you", "done", "failed"];

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function stubPlugin(stubs) {
  return {
    name: "failed-sound-stubs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) =>
        args.path in stubs ? { path: args.path, namespace: "failed-sound-stubs" } : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "failed-sound-stubs" }, (args) => ({
        contents: stubs[args.path],
        loader: "js",
      }));
    },
  };
}

async function bundle(dir, name, entry, stubs = {}) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: { "@shared": SHARED },
    plugins: [stubPlugin(stubs)],
  });
  return require(outfile);
}

// Every member of the NotifyKind union, read from the source so a new kind is
// covered without touching this file.
function notifyKinds() {
  const source = fs.readFileSync(path.join(SHARED, "types.ts"), "utf8");
  const union = source.match(/export type NotifyKind =([\s\S]*?);/);
  assert.ok(union, "NotifyKind union found");
  return [...union[1].matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1]);
}

// The publish({ ... }) object literals in a file, by balanced braces.
function publishCalls(source) {
  const calls = [];
  const re = /\bpublish\(\{/g;
  let m;
  while ((m = re.exec(source))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && --depth === 0) break;
    }
    calls.push(source.slice(m.index, i + 1));
  }
  return calls;
}

function mainSources(dir = path.join(ROOT, "src", "main"), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) mainSources(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Every producer of a failure alert, with where its behaviour is exercised.
// The source scan below fails when this table and the code disagree.
const FAILURE_EMITTERS = [
  { file: "src/main/notify/index.ts", kind: "run.failed", what: "a Cora run failed", suite: "this suite" },
  { file: "src/main/terminal-agent-notify.ts", kind: "terminal.agent.failed", what: "a terminal agent stopped with an error", suite: "test-terminal-agent-notify" },
  { file: "src/main/orchestration/automation-loop.ts", kind: "automation.failed", what: "an automation hit its monthly cap", suite: "test-automation-catchup" },
  { file: "src/main/orchestration/automation-loop.ts", kind: "automation.failed", what: "an automation paused after repeated failures", suite: "test-automation-catchup" },
  { file: "src/main/orchestration/automation-loop.ts", kind: "automation.failed", what: "an automation failed", suite: "test-automation-loop" },
  { file: "src/main/github-ci-watch.ts", kind: "git.ci-failed", what: "CI failed on a pull request", suite: "test-github-ci-watch" },
  { file: "src/main/agent-socket.ts", kind: "(any, from app.notify)", what: "a test notification with tone danger", suite: "source check below" },
];

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-failed-sound-"));
  try {
    const center = await bundle(dir, "center", 'export * from "./src/shared/notify-center";');
    const kinds = notifyKinds();
    const failureKinds = kinds.filter((kind) => center.notifyState(kind) === "failed");

    await test("every kind named as a failure is classified as one", () => {
      const named = kinds.filter((kind) => /[.-]failed$/.test(kind));
      assert.deepEqual(failureKinds.sort(), named.sort());
      assert.ok(failureKinds.length >= 4);
    });

    await test("a failure kind always plays failed; other kinds keep the producer's choice", () => {
      for (const kind of kinds) {
        for (const requested of SOUND_KINDS) {
          const expected = failureKinds.includes(kind) ? "failed" : requested;
          assert.equal(center.notifySoundKind(kind, requested), expected, `${kind} asked ${requested}`);
        }
      }
    });

    await test("every failure emitter in src/main asks for the failed chime itself", () => {
      const found = [];
      for (const file of mainSources()) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        for (const call of publishCalls(fs.readFileSync(file, "utf8"))) {
          const kind = failureKinds.find((k) => call.includes(`"${k}"`));
          if (!kind) continue;
          const sound = call.match(/soundKind:\s*([^\n]+?),?\n/);
          assert.ok(sound, `${rel}: a ${kind} publish names its soundKind`);
          assert.match(sound[1], /"failed"/, `${rel}: ${kind} publish plays ${sound[1]}`);
          assert.doesNotMatch(sound[1], /^"(needs-you|done)"$/, `${rel}: ${kind} publish plays ${sound[1]}`);
          found.push({ file: rel, kind });
        }
      }
      const table = FAILURE_EMITTERS.filter((row) => !row.kind.startsWith("("));
      assert.deepEqual(
        found.map((row) => `${row.file} ${row.kind}`).sort(),
        table.map((row) => `${row.file} ${row.kind}`).sort(),
        "FAILURE_EMITTERS lists every failure publish in src/main",
      );
    });

    await test("app.notify accepts failed and defaults a danger tone to it", () => {
      const source = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
      const allowed = source.match(/const NOTIFY_SOUNDS[^\n]*\[([^\]]*)\]/);
      assert.ok(allowed);
      assert.deepEqual(allowed[1].split(",").map((s) => s.trim().replace(/"/g, "")).sort(), [...SOUND_KINDS].sort());
      assert.match(source, /tone === "danger" \? "failed"/);
    });

    // ── publish() and the run adapter ──────────────────────────────────────
    globalThis.__failedSound = { handlers: [], delivered: [] };
    const centerNames = [
      "centerSummary", "clearCenter", "flushNotificationCenter", "listCenterEntries", "loadNotificationCenter",
      "markCenterAllRead", "markCenterRead", "markCenterViewed", "muteCenterSource", "noteCenterWorkspaces",
      "removeCenterEntries", "removeCenterEntry", "restoreCenterEntries", "setCenterRead", "unmuteCenterSource",
      "settleCenterSource", "settleCenterJob", "recordToCenter",
    ];
    const notify = await bundle(
      dir,
      "notify",
      'export { publish, startNotifications } from "./src/main/notify";',
      {
        "../file-log": "export const logMain = () => {};",
        "../orchestration/event-log":
          "export const subscribeToEvents = (h) => { globalThis.__failedSound.handlers.push(h); return () => {}; };",
        "../preferences-store":
          "export const getPreferenceCached = () => false;\n" +
          "export const loadPreferences = async () => ({ notificationChannels: { inApp: true, native: true, sound: true, osCues: false } });",
        "../storage": "export const cachedState = () => ({ workspaces: [] });",
        "./attention":
          "export const isWatchingPane = () => false; export const isPaneVisible = () => false; export const isWatchingRun = () => false; export const setAttention = () => {};",
        "./deliver":
          "export const deliver = (event) => { globalThis.__failedSound.delivered.push(event); };\n" +
          "export const activeWindow = () => null; export const registerDeliveryWindow = () => {}; export const signalTerminalAttention = () => {};",
        "./center-store":
          centerNames.map((name) => `export const ${name} = async () => {};`).join("\n") +
          "\nexport const isEventMuted = () => false;",
      },
    );
    const T = globalThis.__failedSound;
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    await test("publish() turns any sound on a failure kind into failed", async () => {
      let n = 0;
      for (const kind of failureKinds) {
        for (const requested of SOUND_KINDS) {
          n += 1;
          T.delivered.length = 0;
          notify.publish({
            kind,
            sourceKey: `test:${n}`,
            title: "t",
            body: "b",
            tone: "danger",
            soundKind: requested,
            target: { type: "run", runId: `r${n}` },
          });
          await flush();
          assert.equal(T.delivered.length, 1, `${kind} delivered`);
          assert.equal(T.delivered[0].soundKind, "failed", `${kind} asked ${requested}`);
        }
      }
    });

    await test("a run that failed plays failed, never done; a finished run plays done", async () => {
      notify.startNotifications();
      assert.equal(T.handlers.length, 1);
      let seq = 0;
      const emit = (runId, status, previousStatus) =>
        T.handlers[0]({
          id: `e${(seq += 1)}`,
          type: "run.status_updated",
          runId,
          workspaceId: "w1",
          timestamp: new Date().toISOString(),
          payload: { status, previousStatus },
        });
      T.delivered.length = 0;
      emit("run-bad", "running", "planning");
      emit("run-bad", "failed", "running");
      await flush();
      const failed = T.delivered.filter((e) => e.kind === "run.failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].soundKind, "failed");
      emit("run-good", "running", "planning");
      emit("run-good", "complete", "running");
      await flush();
      const done = T.delivered.filter((e) => e.kind === "run.complete");
      assert.equal(done.length, 1);
      assert.equal(done[0].soundKind, "done");
      assert.ok(T.delivered.every((e) => e.kind !== "run.failed" || e.soundKind !== "done"));
    });

    // ── deliver(): native notifications and the Sound toggle ───────────────
    globalThis.__nativeOptions = [];
    const deliver = await bundle(dir, "deliver", 'export { deliver } from "./src/main/notify/deliver";', {
      electron:
        "export class Notification {\n" +
        "  static isSupported() { return true; }\n" +
        "  static handleActivation() {}\n" +
        "  constructor(options) { this.options = options; this.title = options.title; this.body = options.body; globalThis.__nativeOptions.push(options); }\n" +
        "  on() { return this; }\n" +
        "  show() {}\n" +
        "  close() {}\n" +
        "}\n" +
        "export const BrowserWindow = { getAllWindows: () => [globalThis.__soundWin] };\n",
      "../e2e-background": "export const E2E_BACKGROUND = true;\nexport function revealWindow() {}\n",
      "../file-log": "export function logMain() {}\n",
      "./compositor-raise": "export function raiseIfStillBehind() {}\n",
    });
    const fakeWindow = (focused) => {
      const sent = [];
      return {
        sent,
        isDestroyed: () => false,
        isMinimized: () => false,
        isFocused: () => focused,
        on() {},
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      };
    };
    let eventSeq = 0;
    const event = (soundKind) => {
      eventSeq += 1;
      return {
        id: `n${eventSeq}`,
        kind: soundKind === "failed" ? "run.failed" : soundKind === "done" ? "run.complete" : "run.blocked",
        sourceKey: `s${eventSeq}`,
        title: "Title",
        body: "Body",
        tone: "danger",
        soundKind,
        target: { type: "run", runId: `r${eventSeq}` },
        createdAt: new Date().toISOString(),
      };
    };
    const chimes = (win) => win.sent.filter((m) => m.channel === "notification:sound").map((m) => m.payload.kind);

    // First: the burst filter is module state, and the checks below chime too.
    await test("Sound on: each kind plays its own chime, a failure right after a finish included", () => {
      const win = fakeWindow(true);
      globalThis.__soundWin = win;
      for (const kind of ["done", "failed", "needs-you", "failed"]) {
        deliver.deliver(event(kind), { inApp: true, native: true, sound: true, osCues: false });
      }
      assert.deepEqual(chimes(win), ["done", "failed", "needs-you"], "the second failure in the burst is dropped");
    });

    await test("a native notification is always silent, on every platform and kind", () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      try {
        for (const value of ["darwin", "linux", "win32"]) {
          Object.defineProperty(process, "platform", { value });
          for (const sound of [true, false]) {
            for (const kind of SOUND_KINDS) {
              globalThis.__soundWin = fakeWindow(false);
              const before = globalThis.__nativeOptions.length;
              deliver.deliver({ ...event(kind), workspaceName: "ws" }, { inApp: true, native: true, sound, osCues: false });
              assert.equal(globalThis.__nativeOptions.length, before + 1, `${value} ${kind} shown`);
              assert.equal(globalThis.__nativeOptions.at(-1).silent, true, `${value} ${kind} sound=${sound}`);
            }
          }
        }
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    });

    await test("Sound off: no chime for any of the three kinds, focused or away", () => {
      for (const focused of [true, false]) {
        const win = fakeWindow(focused);
        globalThis.__soundWin = win;
        for (const kind of SOUND_KINDS) {
          deliver.deliver(event(kind), { inApp: true, native: true, sound: false, osCues: false });
        }
        assert.deepEqual(chimes(win), [], `focused=${focused}`);
      }
      assert.ok(globalThis.__nativeOptions.every((options) => options.silent === true));
    });

    // ── The chimes themselves ──────────────────────────────────────────────
    const sounds = await bundle(dir, "sounds", 'export * from "./src/renderer/src/components/notification-sounds";');

    await test("the player has a chime for every kind and plays failed's notes", () => {
      const started = [];
      class FakeParam {
        setValueAtTime() {}
        linearRampToValueAtTime() {}
        exponentialRampToValueAtTime() {}
      }
      globalThis.AudioContext = class {
        constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
        resume() { return Promise.resolve(); }
        createOscillator() {
          const osc = { type: "", frequency: { value: 0 }, connect: (node) => node, start: () => started.push(osc.frequency.value), stop() {} };
          return osc;
        }
        createGain() { return { gain: new FakeParam(), connect: (node) => node }; }
      };
      assert.deepEqual(Object.keys(sounds.CHIMES).sort(), [...SOUND_KINDS].sort());
      sounds.playNotificationSound("failed");
      const fundamentals = sounds.CHIMES.failed.notes.map((n) => n.freq);
      assert.deepEqual(started.filter((_, i) => i % 2 === 0), fundamentals);
      delete globalThis.AudioContext;
    });

    await test("failed is lower than needs-you, short, unclipped and as loud as done", () => {
      const { CHIMES, FAILED_OPTIONS } = sounds;
      const top = (chime) => Math.max(...chime.notes.map((n) => n.freq));
      assert.ok(top(CHIMES.failed) < Math.min(...CHIMES["needs-you"].notes.map((n) => n.freq)), "failed sits below needs-you");
      const done = measure(CHIMES.done);
      const rows = [["done", CHIMES.done], ["needs-you", CHIMES["needs-you"]], ...Object.entries(FAILED_OPTIONS).map(([k, c]) => [`failed:${k}`, c])];
      for (const [name, chime] of rows) {
        const m = measure(chime);
        console.log(`  ${name.padEnd(14)} ${m.lengthSec.toFixed(2)} s  peak ${m.peakDb.toFixed(1)} dBFS  ${m.lufs.toFixed(1)} LUFS`);
        assert.ok(m.tailSec <= 0.5, `${name} ends within half a second (${m.tailSec})`);
        assert.ok(m.peakDb < -6, `${name} peaks below -6 dBFS (${m.peakDb})`);
        assert.ok(Math.abs(m.lufs - done.lufs) <= 1, `${name} within 1 dB of done (${m.lufs} vs ${done.lufs})`);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} notify-failed-sound checks passed.`);
}

// An offline render of a chime that follows the Web Audio automation rules the
// player uses (linear attack, exponential decay to 0.001, stop 20 ms later),
// then the listening page's measures: peak, tail below -60 dBFS, and the
// loudest 400 ms window through the K-weighting filters (EBU momentary).
function measure(chime, sr = 48000) {
  const length = Math.round(sr * 1.2);
  const out = new Float64Array(length);
  for (const note of chime.notes) {
    for (const [harmonic, level] of [[1, 1], [2, 0.25]]) {
      const peak = chime.gain * level;
      const start = note.startSec;
      const attackEnd = start + chime.attackSec;
      const end = start + note.durSec;
      const w = 2 * Math.PI * note.freq * harmonic;
      for (let i = Math.floor(start * sr); i < Math.min(length, Math.ceil((end + 0.02) * sr)); i += 1) {
        const t = i / sr;
        if (t < start) continue;
        let g;
        if (t <= attackEnd) g = (peak * (t - start)) / chime.attackSec;
        else if (t <= end) g = peak * Math.pow(0.001 / peak, (t - attackEnd) / (end - attackEnd));
        else g = 0.001;
        out[i] += g * Math.sin(w * (t - start));
      }
    }
  }
  let peak = 0;
  let tail = 0;
  for (let i = 0; i < length; i += 1) {
    const v = Math.abs(out[i]);
    peak = Math.max(peak, v);
    if (v > 0.001) tail = i;
  }
  const k = biquad(biquad(out, highShelf(1681, 4, sr)), highPass(38, 0.5, sr));
  const win = Math.round(sr * 0.4);
  const hop = Math.round(sr * 0.01);
  const sq = new Float64Array(length + 1);
  for (let i = 0; i < length; i += 1) sq[i + 1] = sq[i] + k[i] * k[i];
  let best = 0;
  for (let s = 0; s + win <= length; s += hop) best = Math.max(best, (sq[s + win] - sq[s]) / win);
  let lastRel = 0;
  for (let i = length - 1; i >= 0; i -= 1) {
    if (Math.abs(out[i]) > peak * 0.01) {
      lastRel = i;
      break;
    }
  }
  return { lengthSec: lastRel / sr, tailSec: tail / sr, peakDb: 20 * Math.log10(peak), lufs: -0.691 + 10 * Math.log10(best) };
}

// Web Audio BiquadFilterNode coefficients (the spec's formulas).
function highShelf(f0, gainDb, sr) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = (Math.sin(w0) / 2) * Math.sqrt(2);
  const c = Math.cos(w0);
  const s = 2 * Math.sqrt(A) * alpha;
  return {
    b0: A * (A + 1 + (A - 1) * c + s),
    b1: -2 * A * (A - 1 + (A + 1) * c),
    b2: A * (A + 1 + (A - 1) * c - s),
    a0: A + 1 - (A - 1) * c + s,
    a1: 2 * (A - 1 - (A + 1) * c),
    a2: A + 1 - (A - 1) * c - s,
  };
}

function highPass(f0, qDb, sr) {
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const c = Math.cos(w0);
  return { b0: (1 + c) / 2, b1: -(1 + c), b2: (1 + c) / 2, a0: 1 + alpha, a1: -2 * c, a2: 1 - alpha };
}

function biquad(x, { b0, b1, b2, a0, a1, a2 }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
