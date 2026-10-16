// A shortcut the user bound beats a default another command ships with
// (findBinding), so a new default can end up hidden. Keybindings shows a note
// on that command; hiddenDefaults (src/renderer/src/shortcuts/bindings.ts) is
// where it is worked out.
//
//   node scripts/test-keybinding-hidden-defaults.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/renderer/src/shortcuts/bindings";',
        'export * from "./src/renderer/src/shortcuts/chord";',
        'export { COMMANDS } from "./src/renderer/src/shortcuts/commands";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    tsconfig: path.join(ROOT, "tsconfig.web.json"),
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    banner: { js: 'var navigator = { platform: "Linux x86_64" };' },
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function main() {
  const kb = await load();
  const rebindable = kb.COMMANDS.filter((c) => !c.fixed && !c.digitRange && !c.customMatch && c.defaultChords.length === 1);
  const [a, b] = rebindable;

  check("with no overrides nothing is hidden", () => {
    const table = kb.buildBindingTable({});
    for (const command of kb.COMMANDS) assert.deepEqual(kb.hiddenDefaults(table, command.id), [], command.id);
  });

  check("a user binding on another command's default chord hides it", () => {
    const table = kb.buildBindingTable({ [b.id]: kb.chordToStorage(a.defaultChords[0]) });
    const hidden = kb.hiddenDefaults(table, a.id);
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].by.command.id, b.id);
    assert.ok(kb.chordEquals(hidden[0].chord, a.defaultChords[0]));
    assert.deepEqual(kb.hiddenDefaults(table, b.id), [], "the command that holds the chord has nothing hidden");
  });

  check("the note goes away once the command has a shortcut of its own, or the binding is reset", () => {
    const taken = kb.chordToStorage(a.defaultChords[0]);
    const rebound = kb.buildBindingTable({ [b.id]: taken, [a.id]: kb.chordToStorage({ ...a.defaultChords[0], key: "F9" }) });
    assert.deepEqual(kb.hiddenDefaults(rebound, a.id), [], "rebound");
    const unbound = kb.buildBindingTable({ [b.id]: taken, [a.id]: null });
    assert.deepEqual(kb.hiddenDefaults(unbound, a.id), [], "unbound");
    assert.deepEqual(kb.hiddenDefaults(kb.buildBindingTable({}), a.id), [], "reset");
  });

  check("a binding that only matches by chord, not by a different chord, hides nothing", () => {
    const table = kb.buildBindingTable({ [b.id]: kb.chordToStorage({ ...a.defaultChords[0], key: "F9" }) });
    assert.deepEqual(kb.hiddenDefaults(table, a.id), []);
  });

  check("fixed and unknown commands report nothing", () => {
    const table = kb.buildBindingTable({ [b.id]: kb.chordToStorage(a.defaultChords[0]) });
    const fixed = kb.COMMANDS.find((c) => c.fixed);
    if (fixed) assert.deepEqual(kb.hiddenDefaults(table, fixed.id), []);
    assert.deepEqual(kb.hiddenDefaults(table, "no.such.command"), []);
  });

  check("a chord bound over a digit-range command's default hides that range", () => {
    const range = kb.COMMANDS.find((c) => c.digitRange && !c.fixed);
    if (!range) return;
    const chord = range.defaultChords[0];
    const other = rebindable.find((c) => c.id !== range.id);
    const table = kb.buildBindingTable({ [other.id]: kb.chordToStorage({ ...chord, key: "1" }) });
    const hidden = kb.hiddenDefaults(table, range.id);
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].by.command.id, other.id);
  });

  console.log(`\n${passed} keybinding hidden-default checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
