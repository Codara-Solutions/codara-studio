const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

const sourcePath = path.join(__dirname, "..", "src", "shared", "types.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const mod = { exports: {} };
const sandbox = {
  exports: mod.exports,
  module: mod,
  require,
  console,
};
vm.runInNewContext(outputText, sandbox, { filename: sourcePath });

const {
  TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MIN,
  TERMINAL_SCROLLBACK_LINE_LIMIT_MAX,
  normalizeTerminalScrollbackLineLimit,
  trimTerminalScrollbackLines,
} = mod.exports;

assert.equal(TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT, 10_000);
assert.equal(normalizeTerminalScrollbackLineLimit(undefined), TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT);
assert.equal(normalizeTerminalScrollbackLineLimit("not-a-number"), TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT);
assert.equal(normalizeTerminalScrollbackLineLimit(TERMINAL_SCROLLBACK_LINE_LIMIT_MIN - 1), TERMINAL_SCROLLBACK_LINE_LIMIT_MIN);
assert.equal(normalizeTerminalScrollbackLineLimit(String(TERMINAL_SCROLLBACK_LINE_LIMIT_MAX + 1)), TERMINAL_SCROLLBACK_LINE_LIMIT_MAX);
assert.equal(normalizeTerminalScrollbackLineLimit(1234.9), 1234);

assert.equal(trimTerminalScrollbackLines("one\ntwo\nthree\nfour", 2), "three\nfour");
assert.equal(trimTerminalScrollbackLines("one\r\ntwo\r\nthree", 2), "two\nthree");
assert.equal(trimTerminalScrollbackLines("one\ntwo", 10), "one\ntwo");
assert.equal(trimTerminalScrollbackLines("one\ntwo", 0), "");

console.log("terminal scrollback helpers OK");
