// Unit tests for the notification transports (src/main/notify/deliver.ts):
// which channels fire for an alert, the chime burst filter, and the native
// notification: shown and held for real, built but never shown under e2e, and
// a click that reveals the window and routes its target with its center row.
// Also the reveal itself (revealWindow in src/main/e2e-background.ts).
// Electron, the e2e flag and the file log are stubbed; sent IPC messages are
// recorded.
//
//   node scripts/test-notify-deliver.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const OUT_DIR = path.join(os.tmpdir(), "spark-notify-deliver-test");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ELECTRON_STUB =
  "export class Notification {\n" +
  "  static isSupported() { return true; }\n" +
  "  constructor(options) {\n" +
  "    this.title = options.title; this.body = options.body; this.listeners = {}; this.shown = 0;\n" +
  "    globalThis.__createdNotifications.push(this);\n" +
  "  }\n" +
  "  on(event, listener) { (this.listeners[event] ??= []).push(listener); return this; }\n" +
  "  emit(event, ...args) { for (const l of this.listeners[event] ?? []) l(...args); }\n" +
  "  show() { this.shown += 1; }\n" +
  "  close() {}\n" +
  "}\n" +
  "export const BrowserWindow = { getAllWindows: () => [globalThis.__deliverWin] };\n" +
  "export const app = { commandLine: { appendSwitch() {} } };\n";

function harness(e2e) {
  const stubs = {
    electron: ELECTRON_STUB,
    "../e2e-background":
      `export const E2E_BACKGROUND = ${e2e};\n` +
      "export function revealWindow(win) { globalThis.__reveals.push(win); }\n",
    "../file-log": "export function logMain() {}\n",
  };
  return {
    name: "notify-deliver-harness",
    setup(build) {
      build.onResolve({ filter: /^@shared\// }, (args) => ({
        path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
      }));
      build.onResolve({ filter: /^(electron|\.\.\/e2e-background|\.\.\/file-log)$/ }, (args) => ({
        path: args.path,
        namespace: "stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    },
  };
}

async function buildDeliver(e2e) {
  const outfile = path.join(OUT_DIR, `deliver-${e2e ? "e2e" : "real"}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "notify", "deliver.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [harness(e2e)],
  });
  return require(outfile);
}

async function buildReveal() {
  const outfile = path.join(OUT_DIR, "e2e-background.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "e2e-background.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "reveal-harness",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "export const app = { commandLine: { appendSwitch() {} } };\n",
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(outfile);
}

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

function fakeWindow({ focused = true, minimized = false, visible = true } = {}) {
  const calls = [];
  const state = { minimized, visible };
  return {
    calls,
    sent: [],
    isDestroyed: () => false,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isFocused: () => focused,
    restore() {
      calls.push("restore");
      state.minimized = false;
    },
    show() {
      calls.push("show");
      state.visible = true;
    },
    focus() {
      calls.push("focus");
    },
    setSkipTaskbar(skip) {
      calls.push(`skipTaskbar:${skip}`);
    },
    on() {},
    get webContents() {
      const sent = this.sent;
      return { send: (channel, ...payload) => sent.push({ channel, payload }) };
    },
  };
}

async function main() {
  globalThis.__createdNotifications = [];
  globalThis.__reveals = [];

  const real = await buildDeliver(false);
  const e2e = await buildDeliver(true);

  // ── Channels and the chime burst filter (focused window) ───────────────
  const focusedWin = fakeWindow({ focused: true });
  globalThis.__deliverWin = focusedWin;
  const channels = { inApp: true, native: true, sound: true, osCues: false };
  let id = 0;
  const event = (soundKind, target) => {
    id += 1;
    return {
      id: `e${id}`,
      kind: soundKind === "done" ? "terminal.agent.done" : "terminal.agent.needs-input",
      title: "Claude Code finished",
      body: "Done.",
      soundKind,
      target: target ?? { type: "terminal", workspaceId: "w", tabId: "t", paneId: `p${id}` },
    };
  };
  const chimes = () => focusedWin.sent.filter((m) => m.channel === "notification:sound").map((m) => m.payload[0].kind);
  const toasts = () => focusedWin.sent.filter((m) => m.channel === "notification:in-app").length;

  e2e.deliver(event("done"), channels);
  e2e.deliver(event("done"), channels);
  check("two finishes in the same second chime once", chimes().join(",") === "done");
  check("each finish still gets its toast", toasts() === 2);
  e2e.deliver(event("needs-you"), channels);
  check("a prompt right after a finish still sounds its own chime", chimes().join(",") === "done,needs-you");
  e2e.deliver(event("needs-you"), channels);
  check("a second prompt in the burst is quiet", chimes().join(",") === "done,needs-you");
  await sleep(1_600);
  e2e.deliver(event("done"), channels);
  check("after the burst window a finish chimes again", chimes().join(",") === "done,needs-you,done");
  e2e.deliver({ ...event("needs-you"), silent: true }, channels);
  check("a silent alert never chimes", chimes().length === 3 && toasts() === 6);
  check("a focused window gets the toast and no native notification", globalThis.__createdNotifications.length === 0);

  // ── Native notification, real app (window in the background) ──────────
  const awayWin = fakeWindow({ focused: false });
  globalThis.__deliverWin = awayWin;
  const runTarget = { type: "run", runId: "r1", workspaceId: "w2" };
  const away = { ...event("needs-you", runTarget), workspaceName: "api-server" };
  real.deliver(away, channels);
  const shown = globalThis.__createdNotifications.at(-1);
  check("an unfocused window gets a native notification", globalThis.__createdNotifications.length === 1);
  check("the real app shows it", shown?.shown === 1);
  check("the title carries the workspace", shown?.title === "Claude Code finished · api-server");
  check("no toast while away", awayWin.sent.every((m) => m.channel !== "notification:in-app"));
  shown.emit("click");
  const focus = awayWin.sent.filter((m) => m.channel === "notify:focus");
  check("a click reveals the window", globalThis.__reveals.at(-1) === awayWin);
  check(
    "a click routes the target with its center row",
    focus.length === 1 && focus[0].payload[0] === runTarget && focus[0].payload[1] === away.id,
  );

  // ── Native notification under e2e: built, held, never shown ───────────
  const before = globalThis.__createdNotifications.length;
  const terminalTarget = { type: "terminal", workspaceId: "w3", tabId: "t3", paneId: "p3" };
  const seamEvent = event("done", terminalTarget);
  e2e.deliver(seamEvent, channels);
  const built = globalThis.__createdNotifications[before];
  check("an e2e app builds the notification", globalThis.__createdNotifications.length === before + 1);
  check("an e2e app never shows it", built?.shown === 0);
  const recorded = globalThis.__codaraNativeNotifications ?? [];
  check(
    "the e2e seam lists it with its target",
    recorded.length === 1 && recorded[0].id === seamEvent.id && recorded[0].target === terminalTarget,
  );
  check("the seam holds it only weakly", recorded[0]?.notification.deref() === built);
  recorded[0].notification.deref().emit("click");
  const seamFocus = awayWin.sent.filter((m) => m.channel === "notify:focus").at(-1);
  check(
    "a click fired from the seam routes like a real one",
    seamFocus?.payload[0] === terminalTarget && seamFocus?.payload[1] === seamEvent.id,
  );

  // ── Native channel off, or in-app off while focused ────────────────────
  const count = globalThis.__createdNotifications.length;
  real.deliver(event("done"), { ...channels, native: false });
  check("native off raises nothing", globalThis.__createdNotifications.length === count);
  globalThis.__deliverWin = focusedWin;
  real.deliver(event("done"), { ...channels, inApp: false });
  check("in-app off falls back to native even when focused", globalThis.__createdNotifications.length === count + 1);

  // ── revealWindow ────────────────────────────────────────────────────────
  delete process.env.SPARK_E2E_BACKGROUND;
  const { revealWindow } = await buildReveal();
  const minimized = fakeWindow({ minimized: true });
  revealWindow(minimized);
  check("a minimized window is restored and focused", minimized.calls.join(",") === "restore,focus");
  const behind = fakeWindow({ focused: false });
  revealWindow(behind);
  check("a window behind others is focused", behind.calls.join(",") === "focus");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const tray = fakeWindow({ visible: false });
    revealWindow(tray);
    check(
      "a window hidden to the tray on Windows gets its taskbar button back",
      tray.calls.join(",") === "skipTaskbar:false,show,focus",
    );
    Object.defineProperty(process, "platform", { value: "linux" });
    const hidden = fakeWindow({ visible: false });
    revealWindow(hidden);
    check("a hidden window is shown and focused", hidden.calls.join(",") === "show,focus");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  if (failures > 0) {
    console.error(`\n${failures} notify-deliver check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll notify-deliver checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
