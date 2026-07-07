// Runtime round-trip test for the macOS branch of src/main/clipboard-files.ts.
//
// esbuild-bundles the REAL TS module (same pattern as
// scripts/test-terminal-agent-notify.cjs — clipboard-files.ts has no electron
// or @shared imports, so no stubs are needed) and drives
// writeClipboardFilePaths / readClipboardFilePaths against the live system
// NSPasteboard via osascript.
//
//   node scripts/test-clipboard-files.cjs
//
// NOTE: this OVERWRITES the system clipboard while it runs (it writes file URLs,
// then a line of plain text). Exits non-zero on any failed assertion.
// On non-darwin platforms it prints a skip line and exits 0 (CI-safe).

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "clipboard-files.ts");

async function main() {
  if (process.platform !== "darwin") {
    console.log(`SKIP clipboard-files test — darwin only (platform=${process.platform})`);
    return;
  }

  const outfile = path.join(os.tmpdir(), "spark-clipboard-files-test", "clipboard-files.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const mod = require(outfile);

  let pass = 0;
  const check = (name, cond) => {
    if (!cond) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  console.log("NOTE: this test overwrites the system clipboard while it runs.\n");

  // Real, existing files under the repo — exact absolute paths must round-trip.
  const p1 = path.join(ROOT, "package.json");
  const p2 = path.join(ROOT, "tsconfig.json");
  assert.ok(fs.existsSync(p1), `fixture exists: ${p1}`);
  assert.ok(fs.existsSync(p2), `fixture exists: ${p2}`);

  // ── Round-trip: single file ──
  const wrote1 = await mod.writeClipboardFilePaths([p1]);
  check("writeClipboardFilePaths([p1]) returns true", wrote1 === true);
  const read1 = await mod.readClipboardFilePaths();
  check(
    "readClipboardFilePaths returns exactly [p1]",
    Array.isArray(read1) && read1.length === 1 && read1[0] === p1,
  );

  // ── Multi-file: both returned, order preserved ──
  const wrote2 = await mod.writeClipboardFilePaths([p1, p2]);
  check("writeClipboardFilePaths([p1, p2]) returns true", wrote2 === true);
  const read2 = await mod.readClipboardFilePaths();
  check(
    "readClipboardFilePaths returns [p1, p2] in order",
    Array.isArray(read2) && read2.length === 2 && read2[0] === p1 && read2[1] === p2,
  );

  // ── Unicode normalization: macOS hands accented filenames back from the
  //    pasteboard in a DIFFERENT normalization form (NFC in → NFD out). The
  //    renderer's cut-detection (isSameFileSet) depends on the two spellings
  //    being NFC-equal. Guard both the platform behavior and that invariant —
  //    an ASCII round-trip structurally cannot catch this. ──
  const accentDir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cbf-nfc-"));
  const accentPath = path.join(accentDir, "café.txt"); // é = U+00E9, NFC-composed
  fs.writeFileSync(accentPath, "x");
  try {
    const wroteA = await mod.writeClipboardFilePaths([accentPath]);
    check("writeClipboardFilePaths([accented]) returns true", wroteA === true);
    const readA = await mod.readClipboardFilePaths();
    check("accented readback is a single path", Array.isArray(readA) && readA.length === 1);
    // (a) The OS really changed the normalization form. If this ever stops
    //     holding, the premise behind the renderer fix moved — fail loudly.
    check("accented readback differs raw from input (NFC→NFD)", readA[0] !== accentPath);
    // (b) The invariant the cut-detection fix relies on.
    check(
      "accented readback is NFC-equal to the input path",
      readA[0].normalize("NFC") === accentPath.normalize("NFC"),
    );
  } finally {
    fs.rmSync(accentDir, { recursive: true, force: true });
  }

  // ── Text-clipboard isolation: plain text (incl. a path-looking line) must
  //    NOT be read as file URLs. Proves FileURLsOnly is in effect. ──
  execFileSync("pbcopy", [], { input: `plain text, not files\n${p1}` });
  const read3 = await mod.readClipboardFilePaths();
  check("readClipboardFilePaths returns null for a plain-text clipboard", read3 === null);

  // ── Empty guard: never touches the clipboard, returns false ──
  const wrote3 = await mod.writeClipboardFilePaths([]);
  check("writeClipboardFilePaths([]) returns false", wrote3 === false);

  console.log(`\nAll ${pass} clipboard-files checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
