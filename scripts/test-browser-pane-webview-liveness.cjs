#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "src/renderer/src/components/Preview/BrowserPane.tsx"),
  "utf8",
);

const guard = source.match(
  /const getLiveWebview = useCallback\(\(\): WebviewElement \| null => \{([\s\S]*?)\n  \}, \[\]\);/,
);
assert.ok(guard, "BrowserPane must define one stable live-webview resolver");
assert.match(guard[1], /domReadyRef\.current/);
assert.match(guard[1], /webview\.isConnected/);
assert.match(guard[1], /host\.contains\(webview\)/);

assert.match(
  source,
  /addEventListener\("render-process-gone", onRenderProcessGone\)/,
);
assert.match(
  source,
  /removeEventListener\("render-process-gone", onRenderProcessGone\)/,
);
assert.match(
  source,
  /const onRenderProcessGone[\s\S]*?domReadyRef\.current = false;[\s\S]*?setDomReady\(false\);/,
);

const directGuestCall =
  /webviewRef\.current(?:\?\.)?\.(?:send|capturePage|executeJavaScript|getWebContentsId|loadURL|reload|reloadIgnoringCache|goBack|goForward|getURL|getTitle|openDevTools|canGoBack|canGoForward)\b/;
assert.doesNotMatch(
  source,
  directGuestCall,
  "guest methods must resolve through getLiveWebview before Electron IPC",
);

for (const method of [
  "send",
  "capturePage",
  "executeJavaScript",
  "getWebContentsId",
  "loadURL",
  "reload",
  "goBack",
  "goForward",
  "getURL",
  "getTitle",
  "openDevTools",
]) {
  assert.match(
    source,
    new RegExp(`getLiveWebview\\(\\)[\\s\\S]{0,180}\\b${method}\\b`),
    `${method} must be reached through the liveness guard`,
  );
}

console.log(
  "PASS BrowserPane gates guest IPC on current DOM attachment and invalidates exited renderers",
);
