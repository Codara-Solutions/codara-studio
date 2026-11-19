import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIREFOX_DIR, assembledEntries, payloadDigest, recordVersion, recordedVersions } from "../build/assemble.mjs";

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
  // Only "tabs" has a line in Firefox's install question: the others have none (measured on 160; the e2e checks it).
  // The body filter must be granted at install: granted later, it did not start (measured).
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "cookies", "scripting", "storage", "tabs", "webRequest", "webRequestBlocking", "webRequestFilterResponse"]);
  // userScripts can only be optional, and is asked alone (Firefox refuses it with another permission).
  assert.deepEqual(manifest.optional_permissions, ["userScripts"]);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], "one site at a time, or all sites, asked from the popup");
  // Codara hands each version out once, in a folder it never rewrites: other files need another version.
  const recorded = recordedVersions();
  assert.equal(
    recorded[manifest.version],
    payloadDigest(assembledEntries()),
    `the add-on's files changed but its version ${manifest.version} did not (or was not recorded): raise "version" in manifest.json and run node extensions/firefox/build/assemble.mjs --record-version`,
  );
  const copy = mkdtempSync(join(tmpdir(), "codara-firefox-versions-"));
  try {
    cpSync(FIREFOX_DIR, copy, { recursive: true, filter: (from) => !from.includes(`${FIREFOX_DIR}/dist`) });
    writeFileSync(join(copy, "background.js"), `${readFileSync(join(copy, "background.js"), "utf8")}\n// changed\n`);
    assert.throws(() => recordVersion(copy), /Version .* was recorded with other files: raise "version"/);
    writeFileSync(join(copy, "manifest.json"), JSON.stringify({ ...manifest, version: "99.0.0" }));
    assert.equal(recordVersion(copy).version, "99.0.0");
    assert.deepEqual(Object.keys(recordedVersions(copy)), [...Object.keys(recorded), "99.0.0"]);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  return "manifest: MV3 event page, Firefox 153, loopback WebSocket allowed, no site access at install, one recorded set of files per version";
}
