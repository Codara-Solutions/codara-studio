// Word wrap in the file editor: which files wrap by default, how the saved
// choice overrides that, and that Alt+Z is registered without a clash.
//
//   node scripts/test-editor-word-wrap.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/renderer/src/components/editor-cm/wordWrap";',
        'export { COMMANDS } from "./src/renderer/src/shortcuts/commands";',
        'export { commandHint, terminalKeepsChord, buildBindingTable } from "./src/renderer/src/shortcuts/bindings";',
        'export { chordEquals } from "./src/renderer/src/shortcuts/chord";',
        'export { DEFAULT_PREFERENCES, EDITOR_WORD_WRAP_VALUES } from "./src/shared/types";',
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
  const w = await load();

  check("prose, README-style names and rotated logs wrap by default", () => {
    for (const p of ["/a/notes.txt", "/a/README.md", "/a/x.markdown", "/a/server.LOG", "/a/server.log.1", "/a/LICENSE", "/a/CHANGELOG", "C:\\a\\b\\notes.txt", "/a/notes."]) {
      assert.equal(w.wrapsByDefault(p), true, p);
    }
  });

  check("code, build files and dotfiles do not wrap by default", () => {
    for (const p of ["/a/index.ts", "/a/x.py", "/a/data.json", "/a/style.css", "/a/run.sh", "/a/Dockerfile", "/a/Makefile", "/a/Gemfile", "/a/CMakeLists.txt", "/a/.bashrc", "/a/.env", "/a/.env.local", "/a/.gitignore", "/a/Dockerfile.dev", "/a/data.csv"]) {
      assert.equal(w.wrapsByDefault(p), false, p);
    }
  });

  check("a dot in a folder name is not an extension", () => {
    assert.equal(w.wrapsByDefault("/home/me/my.project/LICENSE"), true);
    assert.equal(w.wrapsByDefault("/home/me/my.project/main.rs"), false);
  });

  check("the saved choice beats the file type", () => {
    assert.equal(w.resolveWordWrap("on", "/a/index.ts"), true);
    assert.equal(w.resolveWordWrap("off", "/a/notes.txt"), false);
    assert.equal(w.resolveWordWrap("auto", "/a/notes.txt"), true);
    assert.equal(w.resolveWordWrap("auto", "/a/index.ts"), false);
  });

  check("the preference defaults to auto and has three values", () => {
    assert.equal(w.DEFAULT_PREFERENCES.editorWordWrap, "auto");
    assert.deepEqual([...w.EDITOR_WORD_WRAP_VALUES], ["auto", "on", "off"]);
  });

  check("Alt+Z is registered once and no other command shares its chord", () => {
    const cmd = w.COMMANDS.find((c) => c.id === "editor.toggleWordWrap");
    assert.ok(cmd, "registered");
    assert.deepEqual(cmd.defaultChords[0], { ctrl: false, meta: false, alt: true, shift: false, key: "z" });
    for (const other of w.COMMANDS) {
      if (other.id === cmd.id) continue;
      for (const c of other.defaultChords) assert.equal(w.chordEquals(c, cmd.defaultChords[0]), false, other.id);
    }
  });

  check("the hint follows the binding in force, including a rebind", () => {
    const def = w.commandHint({}, "editor.toggleWordWrap");
    assert.equal(def, "Alt+Z");
    const rebound = w.commandHint({ "editor.toggleWordWrap": "ctrl+alt+w" }, "editor.toggleWordWrap");
    assert.notEqual(rebound, def);
    assert.match(rebound, /W/i);
    assert.equal(w.commandHint({ "editor.toggleWordWrap": null }, "editor.toggleWordWrap"), "");
  });

  check("a terminal keeps Alt+Z, an editor does not, and other chords are never held back", () => {
    const inTerminal = { closest: (sel) => (sel === ".codara-terminal-session" ? {} : null) };
    const inEditor = { closest: () => null };
    assert.equal(w.terminalKeepsChord("editor.toggleWordWrap", inTerminal), true);
    assert.equal(w.terminalKeepsChord("editor.toggleWordWrap", inEditor), false);
    assert.equal(w.terminalKeepsChord("editor.toggleWordWrap", null), false);
    assert.equal(w.terminalKeepsChord("sidebar.toggleLeft", inTerminal), false);
  });

  console.log(`${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
