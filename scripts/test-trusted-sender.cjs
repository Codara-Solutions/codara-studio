// Real-Electron regression test for the privileged-IPC sender gate
// (src/main/main-window-trust.ts requireTrustedSender + registerTrustedMainWindow).
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
//   MODE=errorpage (a fail-OPEN regression for the SAME real gate): load the
//     allowlisted renderer entry (trust flag true), then navigate the main frame
//     to a non-existent file. Chromium commits its error page and fires
//     did-fail-load(isMainFrame) but NO did-navigate, so a gate that only clears
//     trust on committed navigations would keep the stale TRUE and stay OPEN. The
//     gate also clears on main-frame did-fail-load, so a privileged invoke from
//     the error document is DENIED. Removing that clear makes this mode fail.
//
// UNLIKE the prefix mode (which reproduces the OLD gate by hand for the
// proof-of-failure), the fixed and errorpage modes import the REAL shipped gate:
// this bundles src/main/main-window-trust.ts and calls its actual
// registerTrustedMainWindow / requireTrustedSender. Reintroducing the pre-fix
// defect (or removing the did-fail-load clear) into that module makes THIS test
// fail, so the proof-of-fix is wired to the code that ships, not a copy. The
// source-level companion scripts/test-ipc-gate-default.cjs guards against a new
// registration landing ungated.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const NAV_ENTRY = path.join(ROOT, "src", "main", "navigation-allowlist.ts");
const GATE_ENTRY = path.join(ROOT, "src", "main", "main-window-trust.ts");

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-trusted-sender-"));

  // Real navigation-allowlist predicate, bundled to CJS (used by the pre-fix
  // gate reproduction).
  esbuild.buildSync({
    entryPoints: [NAV_ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(dir, "nav.cjs"),
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });

  // The REAL shipped sender gate, bundled to CJS. electron is provided by the
  // runtime, so it stays external; navigation-allowlist and file-log come along
  // in the bundle. The fixed mode below drives this exact module.
  esbuild.buildSync({
    entryPoints: [GATE_ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(dir, "gate.cjs"),
    external: ["electron"],
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
const gate = require(path.join(__dirname, "gate.cjs"));

const RENDERER_ENTRY = process.env.PROBE_RENDERER_ENTRY;
const MODE = process.env.PROBE_MODE;
const cfg = { devServerUrl: null, rendererEntryPath: RENDERER_ENTRY };

let win = null;

// --- PRE-FIX gate: trusts a live event.senderFrame.url read (the defect). ----
// Reproduced by hand here purely to capture the proof-of-failure; the fixed
// mode uses the real gate module instead of any copy.
function requireTrustedSenderPrefix(event, channel) {
  const deny = (r) => { throw new Error("Blocked: " + channel + " (" + r + ")"); };
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed()) deny("not-a-window");
  const frame = event.senderFrame;
  if (!frame) deny("no-frame");
  if (frame.parent !== null) deny("subframe");
  if (!nav.isAllowedMainWindowUrl(frame.url, cfg)) deny("url-not-allowlisted");
}

const useRealGate = MODE === "fixed" || MODE === "errorpage";

ipcMain.handle("privileged:test", (event) => {
  if (useRealGate) {
    // The REAL shipped gate from src/main/main-window-trust.ts.
    gate.requireTrustedSender(event, "privileged:test");
  } else {
    requireTrustedSenderPrefix(event, "privileged:test");
  }
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
  // Wire the REAL trust tracker to this window BEFORE the first load, exactly as
  // index.ts does, injecting the synthetic renderer-entry allowlist.
  if (useRealGate) gate.registerTrustedMainWindow(win, () => cfg);
  const wc = win.webContents;
  const out = [];

  if (MODE === "errorpage") {
    // Fail-OPEN regression: trust must not survive an error-page commit.
    // 1) Legit renderer entry: committed=true, gated invoke succeeds (baseline).
    await win.loadFile(RENDERER_ENTRY);
    out.push("baseline=" + await wc.executeJavaScript("window.probe.invoke('privileged:test')"));
    // 2) Navigate the main frame to a non-existent file. Chromium commits its
    //    error page and fires did-fail-load(isMainFrame) but NO did-navigate, so
    //    without the did-fail-load clear the trust flag would keep step 1's TRUE.
    const badPath = path.join(__dirname, "does-not-exist", "nope.html");
    let loadFailed = false;
    try {
      await win.loadFile(badPath);
    } catch (_e) {
      loadFailed = true;
    }
    out.push("loadFailed=" + loadFailed);
    out.push("errorUrlIsAttackerChosen=" + wc.getURL().includes("does-not-exist"));
    // 3) The preload is still live in the error document; a privileged invoke
    //    must now be DENIED because the committed document is not allowlisted.
    out.push(
      "afterError=" +
        (await wc
          .executeJavaScript("window.probe.invoke('privileged:test')")
          .catch((e) => "EXEC-ERR:" + e.message)),
    );
    console.log("PROBE_RESULT " + JSON.stringify(out));
    app.exit(0);
    return;
  }

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
      // Keep the real gate's security log out of the user's ~/.Codara/logs.
      CODARA_HOME_DIR: dir,
    },
  });
  const stdout = res.stdout || "";
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  if (!line) {
    console.error(`[${mode}] no PROBE_RESULT. stdout:\n${stdout}\nstderr:\n${res.stderr}`);
    return null;
  }
  const arr = JSON.parse(line.slice("PROBE_RESULT ".length));
  const map = {};
  for (const kv of arr) {
    const i = kv.indexOf("=");
    map[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { map, stdout };
}

function main() {
  const { dir, rendererEntry } = build();
  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  console.log("── MODE=prefix (pre-fix gate, PROOF the old code was exploitable) ──");
  const prefixRun = runMode(dir, rendererEntry, "prefix");
  if (!prefixRun) {
    failures += 1;
  } else {
    const prefix = prefixRun.map;
    console.log("  captured:", JSON.stringify(prefix));
    check("[prefix] legit renderer invoke succeeds", prefix.legit === "OK:PRIVILEGED-ACTION-RAN");
    check("[prefix] attacker (no forgery) is denied", (prefix.attacker || "").startsWith("DENIED:"));
    check("[prefix] pushState rewrote the frame url to the renderer entry", prefix.forgedUrlMatches === "true");
    // The whole point: the pre-fix URL check ALLOWS the forged call. If this
    // asserts DENIED, the pre-fix gate was not actually vulnerable and the
    // regression test proves nothing, so we assert the vulnerability here.
    check("[prefix] FORGERY SUCCEEDS against the pre-fix gate (proof-of-failure)", prefix.forged === "OK:PRIVILEGED-ACTION-RAN");
  }

  console.log("\n── MODE=fixed (the REAL src/main/main-window-trust.ts gate) ──");
  const fixedRun = runMode(dir, rendererEntry, "fixed");
  if (!fixedRun) {
    failures += 1;
  } else {
    const fixed = fixedRun.map;
    console.log("  captured:", JSON.stringify(fixed));
    check("[fixed] legit renderer invoke still succeeds", fixed.legit === "OK:PRIVILEGED-ACTION-RAN");
    check("[fixed] attacker (no forgery) is denied", (fixed.attacker || "").startsWith("DENIED:"));
    check("[fixed] pushState still rewrote the frame url", fixed.forgedUrlMatches === "true");
    check("[fixed] FORGERY IS DENIED", (fixed.forged || "").startsWith("DENIED:"));
    // The real gate never leaks the reason to the renderer (the thrown message
    // is generic); it logs it. Assert the gate denied specifically because the
    // committed document was untrusted (the pushState-proof mechanism), not for
    // some incidental reason, by checking its security log line.
    check(
      "[fixed] denial is the untrusted-document path (committed-flag mechanism)",
      /blocked privileged channel privileged:test from untrusted sender \(untrusted-document\)/.test(
        fixedRun.stdout,
      ),
    );
  }

  console.log("\n── MODE=errorpage (fail-OPEN regression: trust must not survive an error commit) ──");
  const errorRun = runMode(dir, rendererEntry, "errorpage");
  if (!errorRun) {
    failures += 1;
  } else {
    const err = errorRun.map;
    console.log("  captured:", JSON.stringify(err));
    check("[errorpage] baseline renderer invoke succeeds", err.baseline === "OK:PRIVILEGED-ACTION-RAN");
    check("[errorpage] the bad navigation actually failed to load", err.loadFailed === "true");
    check("[errorpage] the committed url is the attacker-chosen path", err.errorUrlIsAttackerChosen === "true");
    // The load-bearing assertion: after the error-page commit the gated channel
    // must be DENIED. Without the did-fail-load clear the flag stays TRUE and
    // this returns OK:PRIVILEGED-ACTION-RAN.
    check("[errorpage] privileged invoke is DENIED after the error commit", (err.afterError || "").startsWith("DENIED:"));
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
