// Contracts for the per-chunk byte searches in
// src/renderer/src/components/Terminal/terminalByteScan.ts.
//
//   node scripts/test-terminal-byte-scan.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ENTRY = path.resolve(__dirname, "../src/renderer/src/components/Terminal/terminalByteScan.ts");

function naiveIndexOf(haystack, needle) {
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-byte-scan-"));
  try {
    const outfile = path.join(dir, "scan.cjs");
    await esbuild.build({ entryPoints: [ENTRY], outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
    const { asciiBytes, indexOfBytes } = require(outfile);
    const bytes = (text) => new Uint8Array(Buffer.from(text, "utf8"));
    const reset = asciiBytes("\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l");

    assert.deepEqual([...asciiBytes("\x1b[?")], [0x1b, 0x5b, 0x3f]);
    assert.equal(indexOfBytes(bytes("plain output"), reset), -1);
    assert.equal(indexOfBytes(bytes("\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l"), reset), 0, "at the start");
    assert.equal(indexOfBytes(bytes("ab\x1b[0m\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049lzz"), reset), 6, "after other escapes");
    assert.equal(indexOfBytes(bytes("\x1b[0m\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049"), reset), -1, "truncated at the end");
    assert.equal(indexOfBytes(bytes("xx\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l"), reset), 2, "at the very end");
    assert.equal(indexOfBytes(bytes("see https://localhost:5173/"), asciiBytes("://")), 9);
    assert.equal(indexOfBytes(bytes("12:30:45 ::/ :/"), asciiBytes("://")), -1, "colons without the separator");
    assert.equal(indexOfBytes(bytes("aaab"), asciiBytes("aab")), 1, "a repeated first byte restarts the match");
    assert.equal(indexOfBytes(bytes("ab"), asciiBytes("abc")), -1, "needle longer than haystack");
    assert.equal(indexOfBytes(bytes("ab"), new Uint8Array(0)), 0);
    const jump = reset.indexOf(0x4a);
    assert.equal(indexOfBytes(bytes("J\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l"), reset, jump), 1, "an anchor byte before the match is skipped");
    assert.equal(indexOfBytes(bytes("\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049"), reset, jump), -1, "an anchor too close to the end cannot match");
    assert.equal(indexOfBytes(bytes("x://y"), asciiBytes("://"), 1), 1);

    // Randomized agreement with a naive scan over an escape-heavy alphabet.
    const alphabet = [0x1b, 0x5b, 0x63, 0x48, 0x32, 0x4a, 0x33, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c, 0x3a, 0x2f];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 2000; round += 1) {
      const haystack = new Uint8Array(random() % 64);
      for (let i = 0; i < haystack.length; i += 1) haystack[i] = alphabet[random() % alphabet.length];
      if (round % 5 === 0 && haystack.length >= reset.length) {
        haystack.set(reset, random() % (haystack.length - reset.length + 1));
      }
      for (const needle of [reset, asciiBytes("://"), asciiBytes("\x1b[")]) {
        for (let anchor = 0; anchor < needle.length; anchor += 1) {
          assert.equal(indexOfBytes(haystack, needle, anchor), naiveIndexOf(haystack, needle), `round ${round} anchor ${anchor}`);
        }
      }
    }
    console.log("terminal byte scan checks passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
