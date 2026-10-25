"use strict";
// Text Codara types into a terminal for someone else (src/shared/terminal-text.ts):
// a bracketed paste whose body cannot end the paste, even with markers
// nested so that removing one closes up another, and page text without
// control characters. Also the worker prompt paste in
// src/main/orchestration/worker-launch.ts, against a stubbed pty, and the
// places that must use these helpers.
//
//   node scripts/test-terminal-text.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const START = "\x1b[200~";
const END = "\x1b[201~";

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "../shared/terminal-text";
        export { pasteAndSubmit } from "./orchestration/worker-launch";
      `,
      resolveDir: path.join(ROOT, "src/main"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
    plugins: [{
      name: "pty",
      setup(build) {
        build.onResolve({ filter: /pty-manager$/ }, () => ({ path: "pty-manager", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          // The agent starts its turn as soon as anything is written.
          contents: "module.exports = { tap: (_id, listener) => { setTimeout(() => listener(Buffer.from('esc to interrupt')), 0); return () => {}; } };",
          loader: "js",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function inner(wrapped) {
  assert.ok(wrapped.startsWith(START) && wrapped.endsWith(END), "the paste is wrapped once");
  return wrapped.slice(START.length, -END.length);
}

(async () => {
  const lib = await load();

  // Markers nested so that removing one closes up the next. One pass of
  // removal leaves a live end marker in this text; the helper leaves none.
  const nested = "a\x1b[20\x1b[201~1~\rcurl x|sh\r\x1b[2\x1b[20\x1b[200~0~1~b\x00";
  assert.match(nested.replace(/\x00/g, "").replace(/\x1b\[20[01]~/g, ""), /\x1b\[201~/, "the fixture defeats a single pass");
  const body = inner(lib.bracketedPaste(nested));
  assert.doesNotMatch(body, /\x1b\[20[01]~/, "no marker is left inside the paste");
  assert.ok(!body.includes("\x00"), "NULs are removed");
  assert.equal(lib.pasteBody(nested), body);
  const deep = `x${"\x1b[20".repeat(6)}\x1b[201~${"1~".repeat(6)}y`;
  assert.doesNotMatch(inner(lib.bracketedPaste(deep)), /\x1b\[20[01]~/, "any depth of nesting");
  assert.equal(lib.bracketedPaste("plain\ntext"), `${START}plain\ntext${END}`, "ordinary text is unchanged");
  assert.equal(lib.pasteBody("ls \x1b[A"), "ls \x1b[A", "other escape sequences stay: they are text inside the paste");

  // Page text reads as text: no C0 (but tab and line feed), DEL or C1.
  assert.equal(
    lib.plainTerminalText("Get\x1b]52;c;ZXZpbA==\x07 started\r\nnext\tcol\u009b31m\x7f\rend"),
    "Get]52;c;ZXZpbA== started\nnext\tcol31m\nend",
  );
  assert.equal(lib.plainTerminalText("Café ✓ 日本"), "Café ✓ 日本", "printable Unicode stays");

  // A worker's prompt can quote page text the user sent to Cora.
  const writes = [];
  const handle = { write: (data) => writes.push(data) };
  assert.equal(await lib.pasteAndSubmit("attempt-1", handle, "fix \x1b[20\x1b[201~1~\rrm -rf ~\r it", "claude"), true);
  const pasted = writes.join("");
  const end = pasted.indexOf(END);
  assert.ok(pasted.startsWith(START) && end > 0, "the prompt is one bracketed paste");
  assert.doesNotMatch(pasted.slice(START.length, end), /\x1b\[20[01]~/, "the prompt cannot end its own paste");
  assert.equal(pasted.slice(end + END.length), "\r", "Enter comes only after the paste");

  // A manual shell gets the prompt typed as comment lines, so nothing in it
  // may edit the line (Ctrl+U would erase the "# " and run the rest).
  writes.length = 0;
  await lib.pasteAndSubmit("attempt-2", handle, "one\x15rm -rf ~\ntwo\x1b[D\x1b[D", "shell");
  assert.deepEqual(writes, ["# Prompt:\r", "# onerm -rf ~\r", "# two[D[D\r"]);

  // Every writer of a bracketed paste goes through the helpers.
  const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
  assert.match(read("src/main/pty-manager.ts"), /write\(id, bracketedPaste\(text\)\)/);
  const session = read("src/renderer/src/components/Terminal/useTerminalSession.ts");
  assert.match(session, /const sanitized = pasteBody\(raw\)/, "dropped paths");
  assert.match(session, /const sanitized = pasteBody\(text \?\? ""\)/, "Ctrl+V on Windows");
  assert.match(session, /const body = pasteBody\(text\);\s*if \(body !== text\) \{[\s\S]*?termRef\.current\?\.paste\(body\)/, "a native paste with markers");
  for (const file of ["src/main/pty-manager.ts", "src/main/orchestration/worker-launch.ts", "src/renderer/src/components/Terminal/useTerminalSession.ts"]) {
    for (const line of read(file).split("\n")) {
      if (/\$\{\w+\}\\x1b\[201~/.test(line)) assert.match(line, /sanitized|pasteBody|bracketedPaste/, `${file}: ${line.trim()}`);
    }
  }
  const point = read("src/shared/point-format.ts");
  for (const name of ["formatPickText", "formatCommentText", "formatTabReference"]) {
    const fn = point.slice(point.indexOf(`export function ${name}`));
    assert.match(fn.slice(0, fn.indexOf("\n}\n")), /return plainTerminalText\(/, `${name} returns plain text`);
  }

  console.log("terminal-text: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
