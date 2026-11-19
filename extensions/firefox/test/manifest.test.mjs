import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIREFOX_DIR } from "../build/assemble.mjs";

export function run() {
  const manifest = JSON.parse(readFileSync(join(FIREFOX_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, "userScripts.execute exists only in Manifest V3");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "153.0", "userScripts.execute arrived in Firefox 153");
  assert.match(manifest.browser_specific_settings.gecko.id, /^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/, "AMO needs an id for MV3");
  assert.ok(manifest.browser_specific_settings.gecko.data_collection_permissions.required.length > 0, "AMO asks new add-ons to declare data collection");
  // Firefox's default MV3 policy adds upgrade-insecure-requests, which turns
  // ws://127.0.0.1 into wss:// and the link fails (measured, close code 1015).
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'");
  assert.deepEqual(manifest.background.scripts, ["background.js"], "an event page: Firefox has no extension service workers");
  // Nothing beyond what the link needs at install; sites are asked for when shared.
  assert.equal(manifest.host_permissions, undefined, "no site access at install");
  // scripting shows no line in Firefox's install prompt (it does nothing without site access).
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "scripting", "storage", "tabs"]);
  // userScripts can only be optional, and is asked alone (Firefox refuses it with another permission).
  assert.deepEqual(manifest.optional_permissions, ["userScripts"]);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], "one site at a time, or all sites, asked from the popup");
  return "manifest: MV3 event page, Firefox 153, loopback WebSocket allowed, no site access at install";
}
