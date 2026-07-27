// Real-Electron regression test for the privileged-IPC sender gate
// (src/main/ipc.ts requireTrustedSender + registerTrustedMainWindow).
//
//   node scripts/test-trusted-sender.cjs
//
// This boots a headless Electron app twice against a real attacker file://
// document that forges its URL with history.pushState, and proves:
//
//   MODE=prefix (the PRE-FIX gate that read event.senderFrame.url through the
//     allowlist): the forgery SUCCEEDS. pushState rewrites the frame URL to the
//     renderer entry path with no navigation, so the URL read is fooled and the
//     privileged channel executes. This is the captured proof-of-failure: the
//     old code was exploitable.
//
//   MODE=fixed (the current gate: frame identity against the live main frame +
//     a trust flag maintained only from COMMITTED navigations): the forgery is
//     DENIED. pushState fires no did-navigate, so the trust flag stays false and
//     the sender is the untrusted document.
//
// The `fixed` mode reimplements the exact mechanism from src/main/ipc.ts here in
// the harness (the way the reviewer's probe copied the function), because the
// real gate is wired deep into the app boot. The source-level companion test
// scripts/test-ipc-gate-default.cjs guards against the real registration drifting
// away from being gated at all.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const NAV_ENTRY = path.join(ROOT, "src", "main", "navigation-allowlist.ts");

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-trusted-sender-"));

  // Real navigation-allowlist predicate, bundled to CJS.
  esbuild.buildSync({
    entryPoints: [NAV_ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(dir, "nav.cjs"),
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });

  const rendererDir = path.join(dir, "renderer");
  fs.mkdirSync(rendererDir, { recursive: true });
  const rendererEntry = path.join(rendererDir, "index.html");
  fs.writeFileSync(rendererEntry, "<!doctype html><title>codara</title><body>renderer</body>");

  const attackerDir = path.join(dir, "attacker");
  fs.mkdirSync(attackerDir, { recursive: true });
  fs.writeFileSync(
    path.join(attackerDir, "evil.html"),
    `<!doctype html><title>EVIL</title><body>evil<script>
      window.__forge = async (entryPath) => {
        // Rewrite this file: document's URL to the real renderer entry with NO
        // navigation. Fires no will-navigate / did-navigate, only history state.
        history.pushState({}, "", entryPath);
        const after = location.href;
        const result = await window.probe.invoke("privileged:test");
        return { after, result };
      };
    </script></body>`,
  );

  fs.writeFileSync(
    path.join(dir, "preload.js"),
    `const { contextBridge, ipcRenderer } = require("electron");
     contextBridge.exposeInMainWorld("probe", {
       invoke: (ch) => ipcRenderer.invoke(ch).then((v) => "OK:" + v).catch((e) => "DENIED:" + e.message),
     });`,
  );

  fs.writeFileSync(path.join(dir, "main.js"), MAIN_JS);
  return { dir, rendererEntry };
}

// The Electron main process for the probe. MODE selects which gate to install.
const MAIN_JS = `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const nav = require(path.join(__dirname, "nav.cjs"));

const RENDERER_ENTRY = process.env.PROBE_RENDERER_ENTRY;
const MODE = process.env.PROBE_MODE;
const cfg = { devServerUrl: null, rendererEntryPath: RENDERER_ENTRY };

let win = null;

// --- PRE-FIX gate: trusts a live event.senderFrame.url read (the defect). ----
function requireTrustedSenderPrefix(event, channel) {
  const deny = (r) => { throw new Error("Blocked: " + channel + " (" + r + ")"); };
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) deny("not-a-window");
  const frame = event.senderFrame;
  if (!frame) deny("no-frame");
  if (frame.parent !== null) deny("subframe");
  if (!nav.isAllowedMainWindowUrl(frame.url, cfg)) deny("url-not-allowlisted");
}

// --- FIXED gate: mirrors src/main/ipc.ts requireTrustedSender exactly. --------
let trustedDocumentCommitted = false;
function registerTrust(w) {
  trustedDocumentCommitted = false;
  const evaluate = (url, isMainFrame) => {
    if (!isMainFrame) return;
    trustedDocumentCommitted = nav.isAllowedMainWindowUrl(url, cfg);
  };
  w.webContents.on("did-navigate", (_e, url) => evaluate(url, true));
  w.webContents.on("did-frame-navigate", (_e, url, _c, _t, isMainFrame) => evaluate(url, isMainFrame));
  // Deliberately NOT did-navigate-in-page.
}
function requireTrustedSenderFixed(event, channel) {
  const deny = (r) => { throw new Error("Blocked: " + channel + " (" + r + ")"); };
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) deny("no-window");
  const mainFrame = win.webContents.mainFrame;
  const frame = event.senderFrame;
  if (!frame || frame !== mainFrame) deny("not-main-frame");
  if (!trustedDocumentCommitted) deny("untrusted-document");
}

const gate = MODE === "fixed" ? requireTrustedSenderFixed : requireTrustedSenderPrefix;

ipcMain.handle("privileged:test", (event) => {
  gate(event, "privileged:test");
  return "PRIVILEGED-ACTION-RAN";
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  if (MODE === "fixed") registerTrust(win);
  const wc = win.webContents;
  const out = [];

  // 1) Legit renderer entry: gated channel must succeed.
  await win.loadFile(RENDERER_ENTRY);
  out.push("legit=" + await wc.executeJavaScript("window.probe.invoke('privileged:test')"));

  // 2) Attacker file:// document, no forgery: must be denied.
  await win.loadFile(path.join(__dirname, "attacker", "evil.html"));
  out.push("attacker=" + await wc.executeJavaScript("window.probe.invoke('privileged:test')"));

  // 3) pushState forgery to the renderer entry path, then invoke.
  const forged = await wc.executeJavaScript("window.__forge(" + JSON.stringify(RENDERER_ENTRY) + ")");
  out.push("forgedUrlMatches=" + (forged.after.endsWith("renderer/index.html")));
  out.push("forged=" + forged.result);

  console.log("PROBE_RESULT " + JSON.stringify(out));
  app.exit(0);
});
`;

function runMode(dir, rendererEntry, mode) {
  const res = spawnSync(electron, [path.join(dir, "main.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROBE_MODE: mode,
      PROBE_RENDERER_ENTRY: rendererEntry,
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  const line = (res.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  if (!line) {
    console.error(`[${mode}] no PROBE_RESULT. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    return null;
  }
  const arr = JSON.parse(line.slice("PROBE_RESULT ".length));
  const map = {};
  for (const kv of arr) {
    const i = kv.indexOf("=");
    map[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return map;
}

function main() {
  const { dir, rendererEntry } = build();
  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  console.log("── MODE=prefix (pre-fix gate, PROOF the old code was exploitable) ──");
  const prefix = runMode(dir, rendererEntry, "prefix");
  if (!prefix) {
    failures += 1;
  } else {
    console.log("  captured:", JSON.stringify(prefix));
    check("[prefix] legit renderer invoke succeeds", prefix.legit === "OK:PRIVILEGED-ACTION-RAN");
    check("[prefix] attacker (no forgery) is denied", (prefix.attacker || "").startsWith("DENIED:"));
    check("[prefix] pushState rewrote the frame url to the renderer entry", prefix.forgedUrlMatches === "true");
    // The whole point: the pre-fix URL check ALLOWS the forged call. If this
    // asserts DENIED, the pre-fix gate was not actually vulnerable and the
    // regression test proves nothing, so we assert the vulnerability here.
    check("[prefix] FORGERY SUCCEEDS against the pre-fix gate (proof-of-failure)", prefix.forged === "OK:PRIVILEGED-ACTION-RAN");
  }

  console.log("\n── MODE=fixed (current gate) ──");
  const fixed = runMode(dir, rendererEntry, "fixed");
  if (!fixed) {
    failures += 1;
  } else {
    console.log("  captured:", JSON.stringify(fixed));
    check("[fixed] legit renderer invoke still succeeds", fixed.legit === "OK:PRIVILEGED-ACTION-RAN");
    check("[fixed] attacker (no forgery) is denied", (fixed.attacker || "").startsWith("DENIED:"));
    check("[fixed] pushState still rewrote the frame url", fixed.forgedUrlMatches === "true");
    check("[fixed] FORGERY IS DENIED (untrusted-document)", (fixed.forged || "").startsWith("DENIED:"));
    check("[fixed] denial reason is untrusted-document, not a crash", (fixed.forged || "").includes("untrusted-document"));
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
