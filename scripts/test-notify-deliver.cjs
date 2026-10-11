// Unit tests for the notification transports (src/main/notify/deliver.ts):
// which channels fire for an alert, and the chime burst filter. Electron, the
// e2e flag and the file log are stubbed; sent IPC messages are recorded.
//
//   node scripts/test-notify-deliver.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STUBS = {
  electron:
    "export const Notification = { isSupported: () => false };\n" +
    "export const BrowserWindow = { getAllWindows: () => [globalThis.__deliverWin] };\n",
  "../e2e-background": "export const E2E_BACKGROUND = true;\nexport function revealWindow() {}\n",
  "../file-log": "export function logMain() {}\n",
};

const harness = {
  name: "notify-deliver-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^(electron|\.\.\/e2e-background|\.\.\/file-log)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-notify-deliver-test", "deliver.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "notify", "deliver.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [harness],
  });
  const sent = [];
  globalThis.__deliverWin = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isFocused: () => true,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const { deliver } = require(outfile);
  const channels = { inApp: true, native: true, sound: true, osCues: false };
  let id = 0;
  const event = (soundKind) => {
    id += 1;
    return {
      id: `e${id}`,
      kind: soundKind === "done" ? "terminal.agent.done" : "terminal.agent.needs-input",
      title: "Claude Code finished",
      body: "Done.",
      soundKind,
      target: { type: "terminal", workspaceId: "w", tabId: "t", paneId: `p${id}` },
    };
  };
  const chimes = () => sent.filter((m) => m.channel === "notification:sound").map((m) => m.payload.kind);
  const toasts = () => sent.filter((m) => m.channel === "notification:in-app").length;

  deliver(event("done"), channels);
  deliver(event("done"), channels);
  check("two finishes in the same second chime once", chimes().join(",") === "done");
  check("each finish still gets its toast", toasts() === 2);
  deliver(event("needs-you"), channels);
  check("a prompt right after a finish still sounds its own chime", chimes().join(",") === "done,needs-you");
  deliver(event("needs-you"), channels);
  check("a second prompt in the burst is quiet", chimes().join(",") === "done,needs-you");
  await sleep(1_600);
  deliver(event("done"), channels);
  check("after the burst window a finish chimes again", chimes().join(",") === "done,needs-you,done");
  deliver({ ...event("needs-you"), silent: true }, channels);
  check("a silent alert never chimes", chimes().length === 3 && toasts() === 6);

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
