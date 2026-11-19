"use strict";
// Input where the browser gives no trusted input (Firefox's extension has no
// debugger): the trusted-input tools (mouse, hover, scroll, drag, key,
// press_key, upload) play the same events as a script in the page and say
// so. In a real Chromium page, through a session that refuses the Input
// commands as the Firefox link does, each tool gets the outcome the trusted
// path gets (a click counted, text typed, a form sent, a box scrolled, a
// drop, files on the input), with events the page sees as untrusted, and
// no Input command is ever sent. Through a session that takes them,
// nothing changes for Chrome.
//
//   node scripts/test-scripted-input.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer } = require("./fixtures/browser-page-target.cjs");

const PAGE = `<!doctype html><title>Input</title>
  <button id="b">Press</button> <span id="ctx">Menu here</span> <span id="hover">Hover me</span>
  <form id="f"><input id="t"> <button>Go</button></form> <textarea id="ta"></textarea>
  <div id="scroller" style="height: 100px; overflow: auto"><div style="height: 1000px">Long</div></div>
  <div id="src" draggable="true" style="width: 80px">Drag me</div> <div id="dst" style="width: 120px; height: 40px">Drop here</div>
  <input id="file" type="file" multiple> <input id="one" type="file">
  <form id="g"><input id="g1"> <input id="g2"></form> <form id="h"><input id="h1"></form>
  <div id="rb" role="button" tabindex="0">Custom</div> <input id="m" maxlength="2"> <input id="e">
  <iframe id="fr" srcdoc="<input id='inner'>" style="height: 40px"></iframe>
  <form id="k"><input id="k1"> <input type="image" id="kimg" alt="Go"> <button id="kb">B</button></form>
  <form id="q"><input id="q1"> <input id="q2"> <button type="bogus" id="qb">Q</button></form>
  <button id="dis" disabled>Off</button>
  <script>window.seen = []; window.state = { clicks: 0, submitted: 0, dropped: null, files: null, hovered: false, left: false, keyCodes: [], gSent: 0, hSent: 0, custom: 0 };
    document.querySelector("#g").addEventListener("submit", (event) => { event.preventDefault(); window.state.gSent++; });
    document.querySelector("#h").addEventListener("submit", (event) => { event.preventDefault(); window.state.hSent++; });
    document.querySelector("#rb").addEventListener("click", () => window.state.custom++);
    window.state.submitters = [];
    for (const id of ["k", "q"]) document.querySelector("#" + id).addEventListener("submit", (event) => { event.preventDefault(); window.state.submitters.push(event.submitter && event.submitter.id); });
    window.state.disClicks = 0;
    document.querySelector("#dis").addEventListener("click", () => window.state.disClicks++);
    document.querySelector("#hover").addEventListener("mouseleave", () => (window.state.left = true));
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "auxclick", "keydown", "keyup", "wheel"]) {
      document.addEventListener(type, (event) => window.seen.push(type + (event.isTrusted ? "!" : "") + ":" + (event.target.id || event.target.tagName)), true);
    }
    document.addEventListener("keydown", (event) => window.state.keyCodes.push(event.keyCode));
    document.querySelector("#b").addEventListener("click", () => window.state.clicks++);
    document.querySelector("#hover").addEventListener("mouseenter", () => (window.state.hovered = true));
    document.querySelector("#f").addEventListener("submit", (event) => { event.preventDefault(); window.state.submitted++; });
    document.querySelector("#src").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "from src"));
    document.querySelector("#dst").addEventListener("dragover", (event) => event.preventDefault());
    document.querySelector("#dst").addEventListener("drop", (event) => { event.preventDefault(); window.state.dropped = event.dataTransfer.getData("text/plain"); });
    document.querySelector("#file").addEventListener("change", async (event) => {
      window.state.files = await Promise.all([...event.target.files].map(async (file) => file.name + " " + file.type + " " + (await file.text())));
    });</script>`;

const REFUSED = /^(Input\.|DOM\.setFileInputFiles$)/;

async function openTarget(chromium, lib, url, { refuse }) {
  const { targetId } = await chromium.newPage("about:blank");
  const inner = chromium.transportFor(targetId);
  const sent = [];
  // As the Firefox extension does, every evaluate's answer names its page
  // (here Chromium's own context id for the top frame), and an evaluate that
  // asks for one runs only there; a test can act after an answer (afterAnswer).
  let page = null;
  inner.onEvent((method, params) => {
    if (method === "Runtime.executionContextCreated" && params.context.auxData?.isDefault && params.context.auxData.frameId === targetId) page = params.context.uniqueId;
    if (method === "Runtime.executionContextsCleared") page = null;
  });
  const hooks = { afterAnswer: null };
  const transport = {
    ...inner,
    attach: () => inner.attach(),
    isAttached: () => inner.isAttached(),
    detach: () => inner.detach(),
    onEvent: (listener) => inner.onEvent(listener),
    onDetach: (listener) => inner.onDetach(listener),
    send: async (method, params) => {
      sent.push(method);
      const answer = await inner.send(method, params);
      if (method !== "Runtime.evaluate") return answer;
      const named = refuse && page ? { ...answer, uniqueContextId: page } : answer;
      const after = hooks.afterAnswer;
      if (after) await after(params, named);
      return named;
    },
    refuses: (method) => (refuse && REFUSED.test(method) ? `${method} is not available in Firefox: Firefox gives extensions no debugger.` : null),
  };
  const session = new lib.CdpSession(`test:${targetId}`, transport);
  await session.send("Runtime.enable");
  const target = {
    kind: "preview",
    ref: "tab-1",
    session,
    workspaceId: null,
    async info() {
      return { ref: "tab-1", kind: "preview", url: "", title: "", viewport: null, devicePixelRatio: 1 };
    },
    async evaluate(expression, options = {}) {
      const result = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: options.awaitPromise !== false });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
      return result.result.value;
    },
    async captureViewport() {
      throw new Error("not used");
    },
    async showActivity() {},
  };
  await session.send("Page.enable");
  await session.send("Page.navigate", { url });
  for (let i = 0; i < 100 && (await target.evaluate("document.readyState").catch(() => "")) !== "complete"; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    target,
    sent,
    hooks,
    close() {
      session.dispose({ detach: true });
      void chromium.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

/** Every tool once, as an agent would call it; what the page saw after each. */
async function drive(ops, target, uploads) {
  const state = () => target.evaluate("({ ...window.state, keyCodes: window.state.keyCodes.splice(0), seen: window.seen.splice(0) })");
  const out = {};
  out.click = await ops.mouse(target, { selector: "#b" });
  out.afterClick = await state();
  await ops.mouse(target, { selector: "#b", action: "dblclick" });
  out.afterDbl = await state();
  await ops.mouse(target, { selector: "#ctx", action: "rightclick" });
  out.afterContext = await state();
  out.hover = await ops.hover(target, { selector: "#hover" });
  out.afterHover = await state();
  await ops.mouse(target, { selector: "#t" });
  for (const key of ["a", "b", "Backspace", "c"]) out.key = await ops.key(target, { key });
  out.typed = await target.evaluate("document.querySelector('#t').value");
  out.afterKeys = await state();
  out.enter = await ops.pressKey(target, { key: "Enter", selector: "#t" });
  out.afterEnter = await state();
  await ops.pressKey(target, { key: " ", selector: "#b" });
  out.afterSpace = await state();
  await ops.mouse(target, { selector: "#ta" });
  await ops.key(target, { key: "x" });
  await ops.pressKey(target, { key: "Enter" });
  await ops.key(target, { key: "y" });
  out.textarea = await target.evaluate("document.querySelector('#ta').value");
  // Enter: a form with two fields and no button is not sent, one with a single field is; a custom button is not pressed.
  await ops.pressKey(target, { key: "Enter", selector: "#g1" });
  await ops.pressKey(target, { key: "Enter", selector: "#h1" });
  await ops.pressKey(target, { key: "Enter", selector: "#rb" });
  // The default button is the form's first submit button in tree order, image inputs and unknown types included.
  await ops.pressKey(target, { key: "Enter", selector: "#k1" });
  await ops.pressKey(target, { key: "Enter", selector: "#q1" });
  // A disabled button takes no click.
  await ops.mouse(target, await target.evaluate("(() => { const el = document.querySelector('#dis'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"));
  // A press and a release in two calls click; leaving an element tells it.
  await ops.mouse(target, { selector: "#b", action: "down" });
  await ops.mouse(target, { selector: "#b", action: "up" });
  await ops.hover(target, { selector: "#hover" });
  await ops.hover(target, { selector: "#b" });
  out.afterSplit = await state();
  // A field's maxlength holds; Backspace takes a whole emoji.
  await ops.mouse(target, { selector: "#m" });
  for (const key of ["a", "b", "c"]) await ops.key(target, { key });
  await ops.mouse(target, { selector: "#e" });
  for (const key of ["a", "😀", "Backspace"]) await ops.key(target, { key });
  out.fields = await target.evaluate("[document.querySelector('#m').value, document.querySelector('#e').value]");
  // A field in a frame of the same site.
  await ops.mouse(target, { selector: "#fr" });
  await ops.key(target, { key: "z" });
  out.inFrame = await target.evaluate("document.querySelector('#fr').contentDocument.querySelector('#inner').value");
  out.scroll = await ops.scroll(target, { selector: "#scroller", deltaY: 200 });
  out.scrollTop = await target.evaluate("document.querySelector('#scroller').scrollTop");
  out.drag = await ops.drag(target, { from: { selector: "#src" }, to: { selector: "#dst" } });
  out.afterDrag = await state();
  out.upload = await ops.upload(target, { selector: "#file", paths: [path.join(uploads, "notes.txt"), path.join(uploads, "data.json")] });
  for (let i = 0; i < 40 && !(await target.evaluate("window.state.files")); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  out.files = await target.evaluate("window.state.files");
  return out;
}

(async () => {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP scripted input: no Chromium (npx playwright install chromium)");
    return;
  }
  const lib = bundleBrowser(`
    export * as ops from "./chrome/tab-ops";
    export { uploadMimeType, SCRIPTED_UPLOAD_MAX_BYTES, scriptedUploadPinProbe, scriptedUploadProbe } from "./scripted-input";
    export { createPreviewDOM } from "../../shared/preview-dom";
  `);
  const { ops } = lib;
  const server = await startPageServer({
    "/input": PAGE,
    // A page that sets a trap where the upload keeps its pins.
    "/trap": `<!doctype html><input id="file" type="file" multiple><script>
      window.caught = [];
      const trap = { get: () => document.querySelector("#file"), delete: () => true, set: () => trap };
      Object.defineProperty(window, Symbol.for("codara.uploadPins"), { get: () => { window.caught.push("looked"); return trap; } });
      for (const name of ["atob", "DataTransfer", "File"]) { const real = window[name]; window[name] = function (...args) { window.caught.push(name); return new.target ? new real(...args) : real(...args); }; }
    </script>`,
  });
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "codara-scripted-input-"));
  fs.writeFileSync(path.join(uploads, "notes.txt"), "hello from a file");
  fs.writeFileSync(path.join(uploads, "data.json"), '{"a":1}');
  const pages = [];
  try {
    // The type a picked file gets, from its name, as browsers give it.
    assert.equal(lib.uploadMimeType("/x/Report.PDF"), "application/pdf");
    assert.equal(lib.uploadMimeType("/x/photo.jpeg"), "image/jpeg");
    assert.equal(lib.uploadMimeType("/x/unknown.bin"), "");
    assert.equal(lib.uploadMimeType("/x/no-extension"), "");

    // Chrome: trusted input through the protocol, as before.
    const chrome = await openTarget(chromium, lib, server.url("/input"), { refuse: false });
    pages.push(chrome);
    const trusted = await drive(ops, chrome.target, uploads);
    assert.ok(chrome.sent.includes("Input.dispatchMouseEvent") && chrome.sent.includes("Input.dispatchKeyEvent") && chrome.sent.includes("DOM.setFileInputFiles"));
    assert.equal(trusted.click.trusted, undefined, "a trusted answer is as it was");
    assert.deepEqual(trusted.afterClick.seen, ["pointerdown!:b", "mousedown!:b", "mouseup!:b", "click!:b"]);

    // Firefox: the same calls, played in the page.
    const firefox = await openTarget(chromium, lib, server.url("/input"), { refuse: true });
    pages.push(firefox);
    const played = await drive(ops, firefox.target, uploads);
    assert.deepEqual(firefox.sent.filter((method) => REFUSED.test(method)), [], "no Input command reaches a browser that refuses them");
    for (const answer of [played.click, played.hover, played.key, played.enter, played.scroll, played.drag, played.upload]) {
      assert.equal(answer.trusted, false, JSON.stringify(answer));
      assert.match(answer.note, /isTrusted false/);
    }
    assert.equal(played.click.target, "button#b");
    assert.equal(played.click.ok, true);

    // What the page saw: the same events in the same order, untrusted.
    const untrusted = (seen) => seen.map((entry) => entry.replace("!", ""));
    assert.deepEqual(played.afterClick.seen, untrusted(trusted.afterClick.seen));
    assert.deepEqual(played.afterContext.seen, untrusted(trusted.afterContext.seen));
    // And the same outcome for every tool.
    // (Not the drag: the protocol's mouse alone starts no drag and drop in headless Chromium.)
    for (const key of ["afterClick", "afterDbl", "afterContext", "afterHover", "afterEnter", "afterSpace", "afterSplit"]) {
      const { seen: _a, keyCodes: _b, ...outcome } = played[key];
      const { seen: _c, keyCodes: _d, ...expected } = trusted[key];
      assert.deepEqual(outcome, { ...expected, files: null }, key);
    }
    assert.equal(played.afterClick.clicks, 1);
    assert.equal(played.afterDbl.clicks, 3);
    assert.ok(played.afterDbl.seen.includes("dblclick:b"));
    assert.ok(played.afterContext.seen.includes("contextmenu:ctx"));
    assert.equal(played.afterHover.hovered, true);
    assert.equal(played.typed, trusted.typed);
    assert.equal(played.typed, "ac");
    assert.deepEqual(played.afterKeys.keyCodes, trusted.afterKeys.keyCodes, "pages reading keyCode see the same codes");
    assert.equal(played.afterEnter.submitted, 1, "Enter in a field sends its form");
    assert.equal(played.afterSpace.clicks, 4, "Space on a button presses it");
    assert.equal(played.textarea, trusted.textarea);
    assert.equal(played.textarea, "x\ny");
    assert.equal(played.scroll.scrolled, "div#scroller");
    // (The trusted wheel scrolls smoothly, after the call returns: only the scripted one is read at once.)
    assert.equal(played.scrollTop, 200);
    assert.equal(played.afterDrag.dropped, "from src");
    assert.equal(played.drag.dragged, "div#src");
    assert.equal(played.drag.dropped, "div#dst");
    assert.deepEqual(played.files, trusted.files);
    assert.deepEqual(played.files, ["notes.txt text/plain hello from a file", 'data.json application/json {"a":1}']);
    assert.equal(played.upload.count, 2);
    assert.deepEqual(played.afterSplit.submitters, ["kimg", "qb"]);
    assert.equal(played.afterSplit.disClicks, 0);
    assert.deepEqual(played.afterSplit.seen.filter((entry) => entry.startsWith("click")), untrusted(trusted.afterSplit.seen).filter((entry) => entry.startsWith("click")));
    assert.equal(played.afterSplit.clicks, 5, "a press and a release in two calls click");
    assert.equal(played.afterSplit.left, true, "the element the pointer left hears it");
    assert.deepEqual([played.afterSplit.gSent, played.afterSplit.hSent, played.afterSplit.custom], [0, 1, 0], "HTML's implicit submission, and no press of a custom button");
    assert.deepEqual(played.fields, trusted.fields);
    assert.deepEqual(played.fields, ["ab", "a"]);
    assert.equal(played.inFrame, trusted.inFrame);
    assert.equal(played.inFrame, "z");

    // An upload this path cannot do says why.
    const target = firefox.target;
    await assert.rejects(ops.upload(target, { selector: "#file", paths: [uploads] }), /is not a file/);
    await assert.rejects(ops.upload(target, { selector: "#one", paths: [path.join(uploads, "notes.txt"), path.join(uploads, "data.json")] }), /takes one file/);
    await assert.rejects(ops.upload(target, { selector: "#missing", paths: [path.join(uploads, "notes.txt")] }), /file input not found/);
    const big = path.join(uploads, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, lib.SCRIPTED_UPLOAD_MAX_BYTES + 1);
    await assert.rejects(ops.upload(target, { selector: "#file", paths: [big] }), /at most 10 MB/);
    // The upload's bytes go only to the page whose input was pinned: a page
    // that replaced it while the files were read gets nothing, even one that
    // sets a trap where the pins are kept.
    const notes = path.join(uploads, "notes.txt");
    firefox.hooks.afterAnswer = async (params) => {
      if (!String(params.expression).includes("codara.uploadPins") || params.uniqueContextId) return;
      firefox.hooks.afterAnswer = null;
      await target.session.send("Page.navigate", { url: server.url("/trap") });
      for (let i = 0; i < 100 && (await target.evaluate("document.readyState + location.pathname").catch(() => "")) !== "complete/trap"; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await assert.rejects(ops.upload(target, { selector: "#file", paths: [notes] }), /page changed while the files were read; nothing was uploaded/);
    assert.deepEqual(await target.evaluate("[location.pathname, window.caught.length, document.querySelector('#file').files.length]"), ["/trap", 0, 0], "the trap page got nothing");
    // An input that stops taking files meanwhile gets none.
    await target.session.send("Page.navigate", { url: server.url("/input") });
    for (let i = 0; i < 100 && (await target.evaluate("document.readyState + location.pathname").catch(() => "")) !== "complete/input"; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    firefox.hooks.afterAnswer = async (params) => {
      if (!String(params.expression).includes("codara.uploadPins") || params.uniqueContextId) return;
      firefox.hooks.afterAnswer = null;
      await target.evaluate("document.querySelector('#one').type = 'text'");
    };
    await assert.rejects(ops.upload(target, { selector: "#one", paths: [notes] }), /file input changed while the files were read/);
    await target.evaluate("document.querySelector('#one').type = 'file'");
    // A named pipe is not waited on.
    if (process.platform !== "win32") {
      const pipe = path.join(uploads, "pipe");
      require("node:child_process").execFileSync("mkfifo", [pipe]);
      await assert.rejects(ops.upload(target, { selector: "#file", paths: [pipe] }), /is not a file/);
    }
    // Text edits keep whole characters: no half emoji at maxlength, none left by a delete inside one.
    await target.evaluate("const m = document.querySelector('#m'); m.maxLength = 3; m.value = 'ab'; m.focus(); m.setSelectionRange(2, 2)");
    await ops.key(target, { key: "😀" });
    assert.equal(await target.evaluate("document.querySelector('#m').value"), "ab");
    await target.evaluate("const e = document.querySelector('#e'); e.value = 'a😀b'; e.focus(); e.setSelectionRange(2, 2)");
    await ops.key(target, { key: "Backspace" });
    assert.equal(await target.evaluate("document.querySelector('#e').value"), "ab");
    // A diagonal wheel: the vertical box holds its axis, the horizontal part goes on to the box around it.
    await target.evaluate(`document.body.insertAdjacentHTML("beforeend", '<div id="wide" style="width: 300px; overflow: auto"><div style="width: 2000px"><div id="tall" style="width: 200px; height: 80px; overflow: auto; overscroll-behavior-y: contain"><div style="height: 400px">t</div></div></div></div>'); document.querySelector("#tall").scrollTop = 1000`);
    const diagonal = await ops.scroll(target, { selector: "#tall", deltaX: 100, deltaY: 100 });
    assert.equal(diagonal.scrolled, "div#wide");
    assert.deepEqual(await target.evaluate("[document.querySelector('#wide').scrollLeft, document.querySelector('#tall').scrollTop, scrollY]"), [100, 320, 0]);
    // The file's own time and type.
    const dated = path.join(uploads, "photo.avif");
    fs.writeFileSync(dated, "img");
    fs.utimesSync(dated, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await ops.upload(target, { selector: "#one", paths: [dated] });
    assert.deepEqual(await target.evaluate("[...document.querySelector('#one').files].map((f) => [f.name, f.type, f.lastModified])"), [["photo.avif", "image/avif", 1_700_000_000_000]]);
    // A drag in one step still drops.
    await ops.drag(target, { from: { selector: "#src" }, to: { selector: "#dst" }, steps: 1 });
    assert.equal(await target.evaluate("window.state.dropped"), "from src");
    // A box that keeps its overscroll keeps the wheel at its end.
    await target.evaluate("const box = document.querySelector('#scroller'); box.style.overscrollBehavior = 'contain'; box.scrollTop = box.scrollHeight; document.body.style.height = '5000px'; scrollTo(0, 0)");
    assert.equal((await ops.scroll(target, { selector: "#scroller", deltaY: 300 })).scrolled, null);
    assert.equal(await target.evaluate("scrollY"), 0, "the page behind does not move");
    // A point outside the page.
    await assert.rejects(ops.mouse(target, { x: -50, y: -50 }), /outside the page/);
    // A page that cancels the wheel keeps its scroll.
    await target.evaluate("document.querySelector('#scroller').addEventListener('wheel', (event) => event.preventDefault(), { passive: false }); document.querySelector('#scroller').scrollTop = 0");
    const kept = await ops.scroll(target, { selector: "#scroller", deltaY: 200 });
    assert.equal(kept.scrolled, null);
    assert.equal(await target.evaluate("document.querySelector('#scroller').scrollTop"), 0);
  } finally {
    for (const page of pages) page.close();
    server.close();
    fs.rmSync(uploads, { recursive: true, force: true });
    await chromium.close();
  }
  console.log("scripted input: a browser without trusted input gets every input tool played in the page with the trusted path's outcome, untrusted and said so; Chrome keeps the protocol");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
