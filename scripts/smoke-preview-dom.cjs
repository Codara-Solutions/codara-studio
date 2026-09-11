"use strict";

// Uses a running development Studio and an existing disposable benchmark run.
// No provider calls, simulator, or additional browser process.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { rpcRaw } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");

async function main() {
  const runId = process.env.CODARA_BROWSER_SMOKE_RUN;
  if (!runId) throw new Error("Set CODARA_BROWSER_SMOKE_RUN to a disposable browser benchmark run");
  const run = findRun({}, runId);
  assert.match(run.settingsSnapshot.workspaceCwd, /cora-browser-ticket-/, "only operate a disposable benchmark workspace");
  const html = `<!doctype html><title>Browser control regression</title>
  <style>body{font:16px sans-serif}button,input,textarea{margin:8px}#cover{position:fixed;inset:0;z-index:100;background:white}</style>
  <div><div><h1>Control regression</h1><div><div id="react"></div></div></div></div>
  <button onclick="this.textContent='first changed'">Duplicate</button><button onclick="this.textContent='second changed'">Duplicate</button>
  <button id="disabled" disabled>Disabled</button><input id="readonly" readonly value="preserve">
  <input id="password" type="password" value="private-fixture-value">
  <div id="editable" contenteditable="true">before</div>
  <button id="replace" onclick="this.outerHTML='<button id=replace>Replacement</button>'">Replace node</button>
  <button id="covered">Covered</button><div id="cover" hidden>Overlay</div>
  <button id="open" onclick="document.querySelector('#modal').showModal()">Open dialog</button>
  <dialog id="modal" tabindex="-1"><h2>Confirm</h2><button id="close" onclick="this.closest('dialog').close()">Close dialog</button></dialog>
  <button id="delayed" onclick="addLate()">Add delayed control</button>
  <div id="hidden" hidden>Hidden secret</div>
  <script src="/react.js"></script><script src="/react-dom.js"></script>
  <script>function addLate(){setTimeout(()=>{const button=document.createElement('button');button.id='late';button.textContent='Late control';button.onclick=e=>button.textContent=String(e.isTrusted);document.body.append(button)},150)};ReactDOM.createRoot(document.querySelector('#react')).render(React.createElement(function Form(){
    const [value,setValue]=React.useState('');return React.createElement('label',null,
      React.createElement('span',null,'Nested label'),React.createElement('input',{value,onChange:e=>setValue(e.target.value)}),
      React.createElement('output',{id:'mirror'},value));
  }));</script>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/react.js' || req.url === '/react-dom.js') {
      const pkg = req.url === '/react.js' ? 'react' : 'react-dom';
      res.setHeader('content-type', 'text/javascript');
      res.end(fs.readFileSync(path.join(__dirname, `../node_modules/${pkg}/umd/${pkg}.production.min.js`)));
    } else { res.setHeader('content-type', 'text/html'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const request = async (op, params = {}) => {
    let response;
    try {
      response = await rpcRaw({}, `preview.${op}`, { runId, ...params }, { timeoutMs: 15_000 });
    } catch (error) {
      throw new Error(`${op} ${params.selector ?? ''}: ${error.message}`);
    }
    if (response.error) throw new Error(response.error.message);
    if (response.result?.ok === false) throw new Error(response.result.error);
    return response.result;
  };
  try {
    await request('navigate', { url });
    await request('wait_for', { selector: '#react input' });
    await request('evaluate', { code: "Object.defineProperty(crypto, 'randomUUID', { value: undefined })" });
    const first = await request('snapshot');
    assert.match(first.snapshot, /textbox @\S+ "Nested label"/);
    assert.doesNotMatch(first.snapshot, /<div|private-fixture-value|Hidden secret/);
    const reference = line => line.match(/@[^\s]+/)[0];
    const inputRef = reference(first.snapshot.split('\n').find(line => line.includes('Nested label') && line.includes('textbox')));
    await request('type', { selector: inputRef, text: 'React sees this', clearFirst: true });
    let snapshot = await request('snapshot', { selector: '#mirror' });
    assert.match(snapshot.snapshot, /React sees this/, 'React received the new controlled value');
    const same = await request('snapshot', { selector: '#mirror', since: snapshot.snapshotId });
    assert.equal(same.diff, true);
    assert.equal(same.snapshot, '(unchanged)');
    await assert.rejects(request('click', { selector: 'button' }), /Ambiguous/);
    await assert.rejects(request('click', { selector: '#disabled' }), /disabled/);
    await assert.rejects(request('type', { selector: '#readonly', text: 'bad', clearFirst: true }), /readonly/);
    const typedSecret = await request('type', { selector: '#password', text: 'secret' });
    assert.doesNotMatch(JSON.stringify(typedSecret), /secret|private-fixture-value/);
    await request('type', { selector: '#editable', text: 'after', clearFirst: true });
    assert.match((await request('snapshot', { selector: '#editable' })).snapshot, /"after"/);
    const oldRef = reference(first.snapshot.split('\n').find(line => line.includes('#replace')));
    await request('click', { selector: oldRef });
    await assert.rejects(request('click', { selector: oldRef }), /Stale element reference/);
    await request('wait_for', { selector: oldRef, state: 'hidden' });
    const replacement = await request('snapshot', { selector: '#replace' });
    assert.notEqual(reference(replacement.snapshot), oldRef);
    await request('evaluate', { code: "document.querySelector('#cover').hidden=false" });
    await assert.rejects(request('click', { selector: '#covered' }), /covered/);
    await request('evaluate', { code: "document.querySelector('#cover').hidden=true" });
    await request('click', { selector: '#open' });
    snapshot = await request('snapshot');
    assert.match(snapshot.snapshot, /Close dialog/);
    assert.doesNotMatch(snapshot.snapshot, /Duplicate|Nested label|Covered/);
    await request('click', { selector: reference(snapshot.snapshot.split('\n').find(line => line.includes('#close'))) });
    await request('click', { selector: '#delayed' });
    await request('click', { selector: '#late' });
    assert.match((await request('snapshot', { selector: '#late' })).snapshot, /"false"/);
    // A navigation must not recycle references even if its DOM is identical.
    await request('navigate', { url });
    await request('wait_for', { selector: '#react input' });
    await assert.rejects(request('type', { selector: inputRef, text: 'wrong document' }), /Stale element reference/);
    snapshot = await request('snapshot', { maxBytes: 180 });
    assert.equal(snapshot.truncated, true);
    assert.ok(Buffer.byteLength(snapshot.snapshot) <= 180);
    console.log('PASS real browser: references, stale navigation, ambiguity, delayed actions, overlays, modal scope, React typing, readonly, password redaction, contentEditable, snapshot diffs and byte limits');
  } finally {
    await request('navigate', { url: 'about:blank' }).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
