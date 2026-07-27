// Gate-by-default property test for src/main/ipc.ts.
//
//   node scripts/test-ipc-gate-default.cjs
//
// The privileged-IPC surface is gated by DEFAULT: every ipcMain.handle in
// registerIpc is registered through the local `handle()` wrapper, which runs
// requireTrustedSender before the listener. The rare channel that must accept
// other senders uses `handleOpen()` and must appear in the OPT_OUT allowlist
// below. This test fails the build if:
//
//   * any raw `ipcMain.handle("...")` registration appears (a channel that
//     bypassed the wrapper and is therefore ungated),
//   * any `handleOpen("...")` channel is not in OPT_OUT,
//   * any `ipcMain.on("...")` channel is neither gated (its body calls
//     isTrustedOnSender) nor listed in ON_OPT_OUT.
//
// It is a source/registration-level check (not runtime), and it keys off the
// registration call shape, so reformatting an individual handler does not break
// it. The runtime forgery regression lives in scripts/test-trusted-sender.cjs.

const fs = require("node:fs");
const path = require("node:path");

const IPC = path.resolve(__dirname, "..", "src", "main", "ipc.ts");

// Channels intentionally registered WITHOUT the sender gate. Each entry must be
// justified in a comment at its call site. Empty today: no channel legitimately
// has a non-main-window sender (only one BrowserWindow exists and the webview
// inspector preload exposes no ipcRenderer.invoke).
const OPT_OUT = new Set([]);
// ipcMain.on channels that are intentionally ungated (fire-and-forget, safe for
// any sender). Empty today.
const ON_OPT_OUT = new Set([]);

const src = fs.readFileSync(IPC, "utf8");

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.log("FAIL " + msg);
  } else {
    console.log("PASS " + msg);
  }
};
const collect = (re) => {
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
};

// The wrapper must still exist. If it is renamed/removed, gating vanishes
// silently, so assert its presence explicitly.
check(/function handle\(channel: string, listener: InvokeListener\): void/.test(src), "the gate-by-default handle() wrapper is defined");
check(/requireTrustedSender\(event, channel\);/.test(src), "handle() calls requireTrustedSender before the listener");

// 1) No raw ipcMain.handle("...") registration. The only legitimate
//    ipcMain.handle( calls are the two wrapper internals, which use the
//    variable `channel`, never a string literal. A string-literal raw
//    registration is a channel that bypassed the gate.
const rawHandleLiterals = collect(/ipcMain\.handle\(\s*"([^"]+)"/g);
check(
  rawHandleLiterals.length === 0,
  `no raw ipcMain.handle("...") registrations (found ${rawHandleLiterals.length}: ${rawHandleLiterals.join(", ") || "none"})`,
);

// 2) Gated registrations via handle("..."). Report the count for visibility.
const gated = collect(/(?:^|[^a-zA-Z0-9_])handle\(\s*"([^"]+)"/g);
console.log(`  info: ${gated.length} channels registered via the gated handle() wrapper`);
check(gated.length > 100, `the gated set is non-trivial (${gated.length} channels)`);

// 3) Opt-outs via handleOpen("...") must all be allowlisted.
const optOuts = collect(/handleOpen\(\s*"([^"]+)"/g);
for (const ch of optOuts) {
  check(OPT_OUT.has(ch), `handleOpen opt-out "${ch}" is in the documented OPT_OUT allowlist`);
}
check(optOuts.length === OPT_OUT.size, `every OPT_OUT entry is actually used (opt-outs=${optOuts.length}, allowlist=${OPT_OUT.size})`);

// 4) Every ipcMain.on("...") channel is gated (body calls isTrustedOnSender
//    with the same channel) or explicitly opted out.
const onChannels = collect(/ipcMain\.on\(\s*"([^"]+)"/g);
console.log(`  info: ipcMain.on channels: ${onChannels.join(", ") || "none"}`);
for (const ch of onChannels) {
  if (ON_OPT_OUT.has(ch)) {
    check(true, `ipcMain.on "${ch}" is in ON_OPT_OUT`);
    continue;
  }
  const gatedOn = src.includes(`isTrustedOnSender(e, "${ch}")`) || src.includes(`isTrustedOnSender(_e, "${ch}")`);
  check(gatedOn, `ipcMain.on "${ch}" gates its sender via isTrustedOnSender`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
