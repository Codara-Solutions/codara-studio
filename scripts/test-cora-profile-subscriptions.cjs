const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

async function main() {
  for (const relative of ["components/chat/ChatComposer.tsx", "components/AgentCapabilitiesDialog.tsx"]) {
    const filename = path.join(__dirname, "..", "src/renderer/src", relative);
    const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect" &&
          node.arguments[0]?.getText(parsed).includes("coraProfiles.onChanged")) effect = node.arguments[0];
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(effect, `${relative}: profile subscription effect exists`);
    const code = ts.transpileModule(`module.exports = ${effect.getText(parsed)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    for (const hasSubscription of [false, true]) {
      let refreshed = 0;
      let unsubscribed = 0;
      let ipcListener;
      const windowListeners = new Set();
      const profiles = {
        list: async () => { refreshed++; return []; },
        ...(hasSubscription ? { onChanged: (listener) => { ipcListener = listener; return () => { unsubscribed++; }; } } : {}),
      };
      const sandbox = {
        module: { exports: {} },
        window: {
          spark: { coraProfiles: profiles, memory: { get: async () => ({}) } },
          addEventListener: (_type, listener) => windowListeners.add(listener),
          removeEventListener: (_type, listener) => windowListeners.delete(listener),
        },
        refreshProfiles: async () => { refreshed++; },
        workspaceId: "new-workspace", setMemory: () => {}, setProfiles: () => {},
        setStatus: (message) => { throw new Error(message); },
      };
      vm.runInNewContext(code, sandbox, { filename });
      const mount = sandbox.module.exports;
      // React StrictMode mounts, cleans up, then mounts the same effect again.
      const firstCleanup = mount();
      firstCleanup();
      const cleanup = mount();
      assert.ok(refreshed >= 2, `${relative}: profiles still load without the new API`);
      if (ipcListener) {
        const before = refreshed;
        ipcListener();
        assert.ok(refreshed > before, `${relative}: current preload still refreshes live`);
      }
      for (const listener of windowListeners) listener();
      cleanup();
      assert.equal(windowListeners.size, 0);
      assert.equal(unsubscribed, hasSubscription ? 2 : 0);
      await new Promise((resolve) => setImmediate(resolve));
    }
    console.log(`PASS ${relative}: old and current preload, refresh, StrictMode cleanup`);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
