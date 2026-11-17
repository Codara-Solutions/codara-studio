// Browser tabs on screen at once that show one site share one zoom: when one
// applies its level, the others take it at once. Fake panes at stale levels
// must settle in one pass, not hand each other old levels in a loop.
//
//   node scripts/test-page-zoom-peers.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "renderer", "src", "components", "Preview", "page-zoom-peers.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

/**
 * A pane as BrowserPageZoom runs it: adopt takes the level at once, and a
 * changed level makes the pane apply it again, which shares it.
 */
function pane(peers, site, level, log) {
  const self = {
    level,
    shown: true,
    site: () => (self.shown ? site : null),
    adopt(next) {
      log.push(next);
      if (log.length > 50) throw new Error("the panes keep handing levels back and forth");
      if (self.level === next) return;
      self.level = next;
      self.apply();
    },
    apply() {
      peers.share(self, self.site(), self.level);
    },
  };
  self.remove = peers.add(self);
  return self;
}

async function main() {
  const { createPageZoomPeers } = await load();

  // Three panes on one site at stale levels: the one applying wins, in one pass.
  {
    const peers = createPageZoomPeers();
    const log = [];
    const a = pane(peers, "s example.com", 1.1, log);
    const b = pane(peers, "s example.com", 1, log);
    const c = pane(peers, "s example.com", 1.25, log);
    a.apply();
    assert.deepEqual([a.level, b.level, c.level], [1.1, 1.1, 1.1]);
    // Each pane changes once; the calls that change nothing end there.
    assert.ok(log.length <= 9, `settled in ${log.length} adopts`);
    // Then the others applying again change nothing.
    b.apply();
    c.apply();
    assert.deepEqual([a.level, b.level, c.level], [1.1, 1.1, 1.1]);
  }

  // Another site, another session, or a hidden pane keeps its own level.
  {
    const peers = createPageZoomPeers();
    const log = [];
    const a = pane(peers, "s example.com", 1.5, log);
    const other = pane(peers, "s other.org", 1, log);
    const session = pane(peers, "logged-out example.com", 1, log);
    const hidden = pane(peers, "s example.com", 0.9, log);
    hidden.shown = false;
    a.apply();
    assert.deepEqual([other.level, session.level, hidden.level], [1, 1, 0.9]);
    // A removed pane is no longer reached.
    const gone = pane(peers, "s example.com", 2, log);
    gone.remove();
    a.apply();
    assert.equal(gone.level, 2);
  }

  console.log("page zoom peers: one pass, same site and session only, hidden and removed panes left alone");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
