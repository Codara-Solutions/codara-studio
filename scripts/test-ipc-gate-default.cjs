// Gate-by-default property test for the whole main-process IPC surface.
//
//   node scripts/test-ipc-gate-default.cjs
//
// The privileged-IPC surface is gated by DEFAULT: every ipcMain.handle in
// registerIpc is registered through the local `handle()` wrapper (src/main/
// ipc.ts), which runs requireTrustedSender before the listener, and every
// ipcMain.on registration in the main process consults the sender gate
// (isTrustedOnSender / requireTrustedSender) in its body. This test fails the
// build if:
//
//   * a raw `ipcMain.handle(...)` / `ipcMain.handleOnce(...)` registration
//     appears anywhere other than the two gated wrapper internals in ipc.ts
//     (i.e. a privileged invoke channel that bypassed the gate), OR
//   * an `ipcMain.on(...)` / `.once` / `.addListener` registration in ANY
//     main-process file neither consults the sender gate in its body nor is
//     listed in ON_OPT_OUT.
//
// It is a source/registration-level check (not runtime). It is deliberately
// QUOTE-AGNOSTIC and CHANNEL-EXPRESSION-AGNOSTIC: it keys off the registration
// CALL, never the channel argument, so `ipcMain.handle('x',…)`,
// `ipcMain.handle(\`x\`,…)`, and `ipcMain.handle(CONST,…)` are all caught the
// same way, and it scans EVERY file under src/main (not just ipc.ts). A tiny
// string/comment-aware scanner finds the real call sites so a channel name that
// merely appears inside a comment or string is not mistaken for a registration.
// The runtime forgery regression lives in scripts/test-trusted-sender.cjs.

const fs = require("node:fs");
const path = require("node:path");

const MAIN_DIR = path.resolve(__dirname, "..", "src", "main");
const IPC = path.join(MAIN_DIR, "ipc.ts");
const GATE = path.join(MAIN_DIR, "main-window-trust.ts");

// Event-style ipcMain.on registrations that are intentionally ungated. Each
// entry is keyed "<basename>:<channelLiteralOrSnippet>" and must be justified
// at its call site. Empty today: every ipcMain.on in the main process gates its
// sender.
const ON_OPT_OUT = new Set([]);

// Invoke channels registered through the explicit ungated opt-out wrapper
// handleOpen(...) in ipc.ts. Each must be justified at its call site. Empty
// today: no channel legitimately accepts a non-main-window sender.
const OPT_OUT = new Set([]);

// The tokens that count as consulting the sender gate inside an ipcMain.on body.
const GATE_TOKENS = ["isTrustedOnSender(", "requireTrustedSender(", "untrustedSenderReason("];

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.log("FAIL " + msg);
  } else {
    console.log("PASS " + msg);
  }
};

// ── A minimal string/comment-aware scanner ────────────────────────────────────
function isIdentChar(c) {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

// src[i] is an opening quote (" ' or `); return the index just past the close.
// Handles escapes and, for template literals, nested ${ ... } expressions
// (which can themselves contain strings and parens).
function skipString(src, i) {
  const quote = src[i];
  const n = src.length;
  i += 1;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      i = skipBraces(src, i + 1);
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return n;
}

// src[i] is "{"; return the index just past the matching "}", skipping strings
// and comments so braces inside them do not affect the depth.
function skipBraces(src, i) {
  const n = src.length;
  let depth = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n;
}

// src[i] is "("; return the index of the matching ")", skipping strings and
// comments. -1 if unbalanced.
function matchingParen(src, i) {
  const n = src.length;
  let depth = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// All ipcMain.<method>( registrations in `src`, ignoring occurrences inside
// strings and comments. Returns { method, parenIdx } for each real call site.
const REGISTER_METHODS = /^(handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\s*\(/;
function findRegistrations(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (
      c === "i" &&
      src.startsWith("ipcMain.", i) &&
      !isIdentChar(src[i - 1])
    ) {
      const m = REGISTER_METHODS.exec(src.slice(i + "ipcMain.".length));
      if (m) {
        const parenIdx = i + "ipcMain.".length + m[0].length - 1;
        out.push({ method: m[1], parenIdx });
        i = parenIdx + 1;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

// Call sites of a plain local function `name(` (string/comment-aware), skipping
// its `function name(` definition and any non-call mention. Returns the index of
// each call's opening paren.
function findPlainCalls(src, name) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (
      src.startsWith(name, i) &&
      !isIdentChar(src[i - 1]) &&
      !isIdentChar(src[i + name.length])
    ) {
      let j = i + name.length;
      while (j < n && /\s/.test(src[j])) j += 1;
      if (src[j] === "(") {
        // Exclude the `function name(` definition.
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k -= 1;
        const before = src.slice(Math.max(0, k - 8), k + 1);
        if (!/\bfunction$/.test(before)) out.push(j);
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

// Best-effort channel label for messages: a leading string literal argument if
// present, else the first ~48 chars of the call.
function channelLabel(src, parenIdx) {
  const body = src.slice(parenIdx + 1);
  const lit = /^\s*(["'`])([^"'`]*)\1/.exec(body);
  if (lit) return lit[2];
  return body.slice(0, 48).replace(/\s+/g, " ").trim() + "…";
}

function listMainFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMainFiles(full));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

// ── The gate wrappers must still exist and be gated ──────────────────────────
const ipcSrc = fs.readFileSync(IPC, "utf8");
check(
  /function handle\(channel: string, listener: InvokeListener\): void/.test(ipcSrc),
  "the gate-by-default handle() wrapper is defined in ipc.ts",
);
check(
  /requireTrustedSender\(event, channel\);/.test(ipcSrc),
  "handle() calls requireTrustedSender before the listener",
);

check(fs.existsSync(GATE), "the shared sender-gate module (main-window-trust.ts) exists");
if (fs.existsSync(GATE)) {
  const gateSrc = fs.readFileSync(GATE, "utf8");
  check(
    /export function requireTrustedSender\(/.test(gateSrc),
    "main-window-trust exports requireTrustedSender (the invoke gate)",
  );
  check(
    /export function isTrustedOnSender\(/.test(gateSrc),
    "main-window-trust exports isTrustedOnSender (the ipcMain.on gate)",
  );
}

// ── Scan every main-process file ─────────────────────────────────────────────
const files = listMainFiles(MAIN_DIR);
check(files.length > 5, `scanning the whole main tree (${files.length} files)`);

let invokeRegistrations = 0; // ipcMain.handle / handleOnce across ALL files
let gatedWrapperCalls = 0; // handle("…") wrapper uses in ipc.ts (sanity)

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const base = path.basename(file);
  const regs = findRegistrations(src);

  for (const reg of regs) {
    const isInvoke = reg.method === "handle" || reg.method === "handleOnce";
    if (isInvoke) {
      invokeRegistrations += 1;
      // A raw invoke registration is only ever legitimate as one of the two
      // wrapper internals in ipc.ts; anywhere else it bypassed the gate.
      check(
        base === "ipc.ts",
        `raw ipcMain.${reg.method}( at ${base} must be a gate wrapper in ipc.ts (channel: ${channelLabel(src, reg.parenIdx)})`,
      );
      continue;
    }
    // Event registration: its body must consult the sender gate.
    const end = matchingParen(src, reg.parenIdx);
    const call = end === -1 ? src.slice(reg.parenIdx) : src.slice(reg.parenIdx, end + 1);
    const gated = GATE_TOKENS.some((t) => call.includes(t));
    const label = channelLabel(src, reg.parenIdx);
    const key = `${base}:${label}`;
    if (ON_OPT_OUT.has(key)) {
      check(true, `ipcMain.${reg.method} "${label}" (${base}) is in ON_OPT_OUT`);
      continue;
    }
    check(gated, `ipcMain.${reg.method} "${label}" (${base}) gates its sender in its body`);
  }
}

// Exactly the two gated wrapper internals may be raw ipcMain.handle calls, and
// both live in ipc.ts. Any evasion (a third raw handle in any quote/channel
// form, or a handle in another file) pushes this above 2.
check(
  invokeRegistrations === 2,
  `exactly 2 raw ipcMain.handle registrations exist (the gated wrappers); found ${invokeRegistrations}`,
);

// handleOpen(...) is the explicit UNGATED opt-out wrapper in ipc.ts. Every call
// site must be justified in OPT_OUT (the wrapper definition and `void handleOpen`
// are not calls). Any new opt-out that is not allowlisted fails the build.
const openCalls = findPlainCalls(ipcSrc, "handleOpen");
for (const parenIdx of openCalls) {
  const label = channelLabel(ipcSrc, parenIdx);
  check(OPT_OUT.has(label), `handleOpen opt-out "${label}" is in the documented OPT_OUT allowlist`);
}
check(
  openCalls.length === OPT_OUT.size,
  `every OPT_OUT entry is actually used (handleOpen calls=${openCalls.length}, allowlist=${OPT_OUT.size})`,
);

// Sanity: the gated wrapper is in heavy use (the privileged surface is large).
const wrapperUseMatches = ipcSrc.match(/\bhandle\(\s*["'`]/g) || [];
gatedWrapperCalls = wrapperUseMatches.length;
console.log(`  info: ${gatedWrapperCalls} channels registered via the gated handle() wrapper`);
check(gatedWrapperCalls > 100, `the gated set is non-trivial (${gatedWrapperCalls} channels)`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
