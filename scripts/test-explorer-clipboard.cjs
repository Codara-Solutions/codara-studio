// Unit test for the explorer clipboard's pure cut-detection helper,
// isSameFileSet (src/renderer/src/lib/explorerClipboard.ts).
//
// esbuild-bundles the REAL TS module (it has no imports, so no stubs) and
// exercises the logic directly -- no React, no OS clipboard, so it runs on
// every platform. This is the regression guard for the macOS NFC->NFD bug: a
// filename that survives the OS pasteboard round-trip in a different unicode
// normalization form must still be recognized as our own cut set.
//
//   node scripts/test-explorer-clipboard.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "lib", "explorerClipboard.ts");

// "cafe.txt" with an accented e, in the two normalization forms the pasteboard
// round-trip flips between: composed U+00E9 (NFC) vs "e" + U+0301 combining
// acute (NFD). Built from \u escapes (plain ASCII in this source) so the
// fixtures are guaranteed byte-distinct however this file is itself normalized.
const NFC = "/ws/dir/café.txt";
const NFD = "/ws/dir/café.txt";

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-explorer-clipboard-test", "explorerClipboard.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { isSameFileSet } = require(outfile);

  let pass = 0;
  const check = (name, cond) => {
    if (!cond) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  // Sanity: the two spellings really are byte-distinct but NFC-equal -- the
  // exact situation the pasteboard creates.
  check("NFC and NFD fixtures are byte-distinct", NFC !== NFD);
  check("NFC and NFD fixtures are NFC-equal", NFC.normalize("NFC") === NFD.normalize("NFC"));

  // The regression: our cut set read back in the other normalization form is
  // still recognized as the same set (raw === would have said false -> copy).
  check("NFC set vs same names in NFD -> true", isSameFileSet([NFC], [NFD]) === true);
  check(
    "multi-file mixed-form set -> true",
    isSameFileSet([NFC, "/ws/a.txt"], [NFD, "/ws/a.txt"]) === true,
  );
  check("identical set -> true", isSameFileSet([NFC, "/ws/a.txt"], [NFC, "/ws/a.txt"]) === true);
  check("empty vs empty -> true", isSameFileSet([], []) === true);

  // Genuinely different clipboards must NOT be treated as our cut set.
  check("different names -> false", isSameFileSet(["/ws/x.txt"], ["/ws/y.txt"]) === false);
  check("different length -> false", isSameFileSet([NFC], [NFC, "/ws/a.txt"]) === false);
  check(
    "same names, different order -> false",
    isSameFileSet(["/ws/a", "/ws/b"], ["/ws/b", "/ws/a"]) === false,
  );

  console.log(`\nAll ${pass} explorer-clipboard checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
