"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const esbuild = require("esbuild");

async function main() {
  const requests = [], events = [], commands = [];
  const document = { activeElement: null };
  const target = {
    isConnected: true,
    closest: () => null,
    matches: () => false,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: -100, right: 300, top: 10, bottom: 50 }),
    scrollIntoView() {},
    contains: node => node === target,
    focus: () => { document.activeElement = target; },
  };
  document.querySelectorAll = selector => selector === 'dialog:modal' ? [] : selector === '.duplicate' ? [target, target] : [target];
  document.elementFromPoint = () => target;
  const context = vm.createContext({ window: {}, document, crypto: webcrypto, Uint32Array, innerWidth: 100, innerHeight: 100,
    getComputedStyle: () => ({ visibility: 'visible' }), setTimeout, clearTimeout });
  const domBundle = await esbuild.build({ entryPoints: [path.join(__dirname, '../src/shared/preview-dom.ts')], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'contract' });
  vm.runInContext(domBundle.outputFiles[0].text, context);
  context.target = target;
  const ref = vm.runInContext('contract.createPreviewDOM().ref(target)', context);
  const wc = { id: 7, isDestroyed: () => false, on() {}, once() {},
    executeJavaScript: async code => vm.runInContext(code, context),
    sendInputEvent: event => events.push(event),
    debugger: { on() {}, isAttached: () => true, sendCommand: async (...args) => commands.push(args) },
  };
  const out = await esbuild.build({ entryPoints: [path.join(__dirname, '../src/main/preview-input.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron', './preview-bridge', './main-window-trust'] });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, name => {
    if (name === 'electron') return { ipcMain: { on() {} }, webContents: { fromId: () => wc } };
    if (name === './main-window-trust') return { isTrustedPreviewGuest: () => true, isTrustedOnSender: () => true };
    if (name === './preview-bridge') return { requestPreviewOp: async (op, params) => {
      requests.push({ op, params }); return { webContentsId: 7, tabId: 'tab-a', viewport: { width: 100, height: 100 }, devicePixelRatio: 1 };
    } };
    throw new Error(`unexpected dependency ${name}`);
  });
  const call = mod.exports.handlePreviewInputOp;
  await call('mouse', { selector: ref, runId: 'run-a', workspaceId: 'workspace-a' });
  assert.equal(events.length, 3);
  assert.equal(events[0].x, 50, 'trusted input uses the visible clipped center');
  assert.equal(events[0].y, 30);
  assert.equal(requests[0].params.workspaceId, 'workspace-a');
  assert.equal(requests[0].params.runId, 'run-a');
  await call('press_key', { selector: ref, key: 'Enter', runId: 'run-a', workspaceId: 'workspace-a' });
  assert.equal(document.activeElement, target);
  assert.ok(commands.some(([name]) => name === 'Input.dispatchKeyEvent'));
  await assert.rejects(call('mouse', { selector: '.duplicate' }), /Ambiguous selector/);
  target.isConnected = false;
  await assert.rejects(call('mouse', { selector: ref }), /Stale element reference/);
  assert.equal(events.length, 3, 'rejected targets receive no input');
  console.log('preview references survive serialization into trusted mouse and keyboard probes');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
