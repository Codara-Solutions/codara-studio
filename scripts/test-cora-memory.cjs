// Focused coverage for Cora memory v2 (src/main/orchestration/cora-memory.ts):
// the two markdown tiers, the provenance tag grammar, TTL + dedup + byte-cap
// curation, the codara_remember add/replace guardrails, the lessons.json
// migration, the enable/disable toggles, and the per-run hash gating that
// keeps injection to one copy per run.
//
//   node scripts/test-cora-memory.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cora-memory-"));
const MEMORY_DIR = path.join(TMP_HOME, "memory");
const GLOBAL_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const WORKSPACES_DIR = path.join(MEMORY_DIR, "workspaces");
const LESSONS_FILE = path.join(TMP_HOME, "lessons.json");

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgoStamp(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}
function daysAgoIso(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

async function expectThrow(name, fn, match) {
  try {
    await fn();
    check(name, false, "expected a rejection, got success");
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(name, match.test(message), message);
    return message;
  }
}

const harness = {
  name: "cora-memory-harness",
  setup(build) {
    build.onResolve({ filter: /\/spark-home$/ }, () => ({
      path: "spark-home-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const sparkHome = () => ${JSON.stringify(TMP_HOME)};`,
      loader: "js",
    }));
  },
};

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [harness],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function workspaceFile(mem, workspaceId) {
  return mem.workspaceMemoryPath(workspaceId);
}

async function main() {
  // ── migration fixtures must exist BEFORE the module's first API call ──────
  fs.writeFileSync(
    LESSONS_FILE,
    JSON.stringify({
      version: 1,
      workspaces: {
        "ws-migrate": [
          { text: "Fresh migrated lesson about this workspace.", runId: "run-legacy-1", createdAt: daysAgoIso(5) },
          { text: "Stale lesson that must not survive.", runId: "run-legacy-2", createdAt: daysAgoIso(120) },
        ],
      },
    }),
    "utf8",
  );
  // Workspace metadata for the managed header.
  fs.writeFileSync(
    path.join(TMP_HOME, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-main", name: "Demo Workspace", cwd: "/tmp/demo", color: "#fff", workers: [] }],
    }),
    "utf8",
  );

  const mem = await load(path.join(ROOT, "src", "main", "orchestration", "cora-memory.ts"));

  // ── migration import + .bak rename ────────────────────────────────────────
  await mem.getMemoryStatus("ws-migrate"); // first API call triggers migration
  const migratedPath = workspaceFile(mem, "ws-migrate");
  const migrated = fs.existsSync(migratedPath) ? fs.readFileSync(migratedPath, "utf8") : "";
  check(
    "migration imports unexpired lessons as [auto] bullets with the original date and run id",
    migrated.includes(`- [auto ${daysAgoStamp(5)} run:run-legacy-1] Fresh migrated lesson about this workspace.`),
    migrated,
  );
  check("migration drops lessons already past the auto TTL", !migrated.includes("Stale lesson"), migrated);
  check(
    "migration renames lessons.json to lessons.json.bak",
    !fs.existsSync(LESSONS_FILE) && fs.existsSync(`${LESSONS_FILE}.bak`),
    fs.readdirSync(TMP_HOME).join(", "),
  );

  // ── parse/serialize round trip + tag grammar ──────────────────────────────
  const roundTrip = [
    "# Cora memory (workspace: Demo)",
    "<!-- cwd: /tmp/demo",
    "     Managed by Cora. Edit freely in the editor; keep it under 4 KB.",
    "     Bullets tagged [auto ...] or [cora ...] belong to Cora and may be pruned,",
    "     rewritten, or expired. Untagged lines are yours; Cora never deletes them. -->",
    "",
    "## Conventions",
    "- an untagged user bullet",
    "  * [cora 2026-07-01] an indented cora bullet",
    "- [auto 2026-07-20 run:run-9] an auto bullet with provenance",
    "- [auto 2026-07-20] an auto bullet without a run id",
    "plain prose the user wrote",
    "- [not a tag] bullet whose bracket text is not a provenance tag",
  ].join("\n");
  const parsed = mem.parseMemoryFile(roundTrip);
  check("parse/serialize round trip is byte-identical", mem.serializeMemoryFile(parsed) === roundTrip);
  check("the managed header is split off", parsed.headerLines.length === 5, JSON.stringify(parsed.headerLines));
  const kinds = parsed.lines.map((line) => line.kind);
  check(
    "tag grammar: cora/auto bullets are Cora's, everything else is the user's",
    JSON.stringify(kinds) ===
      JSON.stringify(["blank", "user", "user", "cora", "auto", "auto", "user", "user"]),
    JSON.stringify(kinds),
  );
  check(
    "tag grammar: run id is parsed off the auto tag",
    parsed.lines[4].tag.runId === "run-9" && parsed.lines[5].tag.runId === undefined,
    JSON.stringify(parsed.lines[4].tag),
  );

  // ── rememberAdd creates the file with the managed header ──────────────────
  const addResult = await mem.rememberAdd("workspace", "ws-main", ["The user prefers tabs over spaces."], "run-1");
  const mainPath = workspaceFile(mem, "ws-main");
  const created = fs.readFileSync(mainPath, "utf8");
  check(
    "rememberAdd lazily creates the file with the workspace header",
    created.startsWith("# Cora memory (workspace: Demo Workspace)") && created.includes("cwd: /tmp/demo"),
    created,
  );
  check(
    "rememberAdd stamps [cora <today>]",
    created.includes(`- [cora ${daysAgoStamp(0)}] The user prefers tabs over spaces.`),
    created,
  );
  check(
    "rememberAdd reports bytes and a message",
    addResult.bytesUsed > 0 && addResult.bytesCap === mem.MEMORY_FILE_MAX_BYTES && /added 1/.test(addResult.message),
    JSON.stringify(addResult),
  );

  // ── dedup: replace in place, newest tag wins; user duplicates are kept ────
  await mem.appendAutoMemories("ws-main", ["Runtime claude fell back to codex after a rate limit."], "run-2");
  const beforeDedup = fs.readFileSync(mainPath, "utf8");
  check("auto bullet lands with run provenance", beforeDedup.includes(`- [auto ${daysAgoStamp(0)} run:run-2]`), beforeDedup);
  await mem.rememberAdd("workspace", "ws-main", ["Runtime claude fell back to codex after a rate limit"], "run-3");
  const afterDedup = fs.readFileSync(mainPath, "utf8");
  const dedupMatches = afterDedup.match(/Runtime claude fell back to codex/g) ?? [];
  check("a duplicate replaces the old line in place (one copy)", dedupMatches.length === 1, afterDedup);
  check(
    "the newest tag wins on dedup (auto became cora)",
    afterDedup.includes(`- [cora ${daysAgoStamp(0)}] Runtime claude fell back to codex after a rate limit`) &&
      !afterDedup.includes("run:run-2"),
    afterDedup,
  );
  const linesBefore = afterDedup.split("\n");
  const tabsIndex = linesBefore.findIndex((line) => line.includes("prefers tabs"));
  const fallbackIndex = linesBefore.findIndex((line) => line.includes("fell back to codex"));
  check("replace-in-place preserves the line's position", fallbackIndex > tabsIndex, `${tabsIndex} vs ${fallbackIndex}`);

  // A duplicate of a user-authored line is dropped and reported as known.
  fs.writeFileSync(mainPath, `${afterDedup.trimEnd()}\n- the user wrote this line by hand\n`, "utf8");
  const knownResult = await mem.rememberAdd("workspace", "ws-main", ["The user wrote this line by hand."], "run-4");
  const afterKnown = fs.readFileSync(mainPath, "utf8");
  check(
    "a duplicate of a user line is dropped and reported as already known",
    /already known/.test(knownResult.message) &&
      (afterKnown.match(/wrote this line by hand/g) ?? []).length === 1 &&
      afterKnown.includes("- the user wrote this line by hand"),
    `${knownResult.message} · ${afterKnown}`,
  );

  // ── TTL: filtered on read, physically pruned on the next write ────────────
  const ttlPath = workspaceFile(mem, "ws-ttl");
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fs.writeFileSync(
    ttlPath,
    [
      "# Cora memory (workspace: ttl)",
      `- [auto ${daysAgoStamp(40)} run:run-old] expired auto line`,
      `- [auto ${daysAgoStamp(5)} run:run-new] fresh auto line`,
      `- [cora ${daysAgoStamp(100)}] expired cora line`,
      `- [cora ${daysAgoStamp(50)}] fresh cora line`,
      "- [auto 2026-99-99] unparseable date reads as fresh",
      "- a user line never expires",
    ].join("\n"),
    "utf8",
  );
  const ttlInjected = await mem.formatCoraMemoryForTurn("ws-ttl", "run-ttl-1");
  check(
    "expired auto (30d) and cora (90d) lines are filtered at injection",
    ttlInjected !== null &&
      !ttlInjected.includes("expired auto line") &&
      !ttlInjected.includes("expired cora line") &&
      ttlInjected.includes("fresh auto line") &&
      ttlInjected.includes("fresh cora line") &&
      ttlInjected.includes("unparseable date reads as fresh") &&
      ttlInjected.includes("a user line never expires"),
    String(ttlInjected),
  );
  check(
    "a pure read never rewrites the file",
    fs.readFileSync(ttlPath, "utf8").includes("expired auto line"),
    "read pruned the file",
  );
  await mem.rememberAdd("workspace", "ws-ttl", ["A new bullet to force a write."], "run-ttl-2");
  const ttlAfterWrite = fs.readFileSync(ttlPath, "utf8");
  check(
    "the next programmatic write physically prunes expired lines",
    !ttlAfterWrite.includes("expired auto line") &&
      !ttlAfterWrite.includes("expired cora line") &&
      ttlAfterWrite.includes("fresh auto line") &&
      ttlAfterWrite.includes("a user line never expires"),
    ttlAfterWrite,
  );

  // ── add-overflow rejection ────────────────────────────────────────────────
  const fullPath = workspaceFile(mem, "ws-full");
  const filler = Array.from({ length: 39 }, (_, i) => `user filler line ${i} ${"x".repeat(80)}`).join("\n");
  fs.writeFileSync(fullPath, `# Cora memory (workspace: full)\n${filler}\n`, "utf8");
  const fullMessage = await expectThrow(
    "rememberAdd rejects on overflow with the consolidate-first error",
    () => mem.rememberAdd("workspace", "ws-full", [`New bullet ${"y".repeat(200)}`], "run-full"),
    /^memory full \(\d+\/4096 bytes\): consolidate first with action "replace" \(rewrite the \[cora\]\/\[auto\] lines shorter or drop stale ones; untagged user lines must be kept\)$/,
  );
  check(
    "the overflow rejection matches the exported error builder",
    fullMessage !== null && fullMessage.startsWith("memory full (") && mem.memoryFullError(1, 2).includes("consolidate first"),
    String(fullMessage),
  );
  check(
    "a rejected add leaves the file untouched",
    !fs.readFileSync(fullPath, "utf8").includes("New bullet"),
    "rejected add still wrote",
  );

  // ── auto-eviction order: expired first (via prune), then oldest [auto] ────
  const evictPath = workspaceFile(mem, "ws-evict");
  // Sized so exactly one eviction brings the file under the cap: with the
  // regenerated 288-byte header, 28 user lines, three ~260-byte autos and the
  // ~250-byte incoming line the file is 4167 bytes; dropping the oldest auto
  // (261 bytes) lands at 3906.
  const evictFiller = Array.from({ length: 28 }, (_, i) => `user context line ${i} ${"z".repeat(80)}`).join("\n");
  fs.writeFileSync(
    evictPath,
    [
      "# Cora memory (workspace: evict)",
      evictFiller,
      `- [auto ${daysAgoStamp(20)} run:r20] oldest auto ${"a".repeat(220)}`,
      `- [auto ${daysAgoStamp(10)} run:r10] middle auto ${"b".repeat(220)}`,
      `- [auto ${daysAgoStamp(2)} run:r2] newest auto ${"c".repeat(220)}`,
    ].join("\n"),
    "utf8",
  );
  await mem.appendAutoMemories("ws-evict", [`incoming lesson ${"d".repeat(200)}`], "run-evict");
  const evicted = fs.readFileSync(evictPath, "utf8");
  check(
    "eviction removes the oldest [auto] bullet first",
    !evicted.includes("oldest auto") && evicted.includes("middle auto") && evicted.includes("newest auto"),
    evicted,
  );
  check("the incoming auto lesson landed", evicted.includes("incoming lesson"), evicted);
  check("user lines are never evicted", evicted.includes("user context line 27"), evicted);
  check(
    "the evicted file fits the cap",
    Buffer.byteLength(evicted, "utf8") <= mem.MEMORY_FILE_MAX_BYTES,
    `${Buffer.byteLength(evicted, "utf8")} bytes`,
  );

  // When nothing evictable remains, the incoming lesson is silently dropped.
  const dropPath = workspaceFile(mem, "ws-drop");
  const dropFiller = Array.from({ length: 46 }, (_, i) => `immovable user line ${i} ${"w".repeat(80)}`).join("\n");
  fs.writeFileSync(dropPath, `# Cora memory (workspace: drop)\n${dropFiller}\n`, "utf8");
  const dropBefore = fs.readFileSync(dropPath, "utf8");
  await mem.appendAutoMemories("ws-drop", ["this lesson cannot fit anywhere"], "run-drop");
  check(
    "an auto lesson that cannot fit is silently dropped and the file untouched",
    fs.readFileSync(dropPath, "utf8") === dropBefore,
    "file changed",
  );

  // ── replace: user-line preservation + confirm_drop override + stamping ────
  const replacePath = workspaceFile(mem, "ws-replace");
  fs.writeFileSync(
    replacePath,
    [
      "# Cora memory (workspace: replace)",
      "## Build",
      "- always run npm test before pushing",
      "prose note the user wrote",
      `- [cora ${daysAgoStamp(3)}] stale cora line to drop`,
    ].join("\n"),
    "utf8",
  );
  await expectThrow(
    "replace rejects a body that drops a user line, listing it",
    () =>
      mem.rememberReplace(
        "workspace",
        "ws-replace",
        "## Build\n- always run npm test before pushing\n",
        false,
        "run-r1",
      ),
    /replace would drop these user-authored lines[\s\S]*prose note the user wrote[\s\S]*confirm_drop_user_lines/,
  );
  check(
    "a rejected replace leaves the file untouched",
    fs.readFileSync(replacePath, "utf8").includes("stale cora line to drop"),
    "rejected replace still wrote",
  );
  const replaceBody = [
    "## Build",
    "- always run npm test before pushing",
    "prose note the user wrote",
    "- a brand new consolidated fact",
  ].join("\n");
  const replaced = await mem.rememberReplace("workspace", "ws-replace", replaceBody, false, "run-r2");
  const replacedFile = fs.readFileSync(replacePath, "utf8");
  check("replace succeeded once every user line is carried", replaced.bytesUsed > 0, JSON.stringify(replaced));
  check(
    "a NEW untagged bullet is auto-stamped [cora <today>] on replace",
    replacedFile.includes(`- [cora ${daysAgoStamp(0)}] a brand new consolidated fact`),
    replacedFile,
  );
  check(
    "existing user lines stay untagged through replace",
    replacedFile.includes("- always run npm test before pushing") &&
      !replacedFile.includes("cora ${daysAgoStamp(0)}] always run npm test") &&
      replacedFile.includes("prose note the user wrote"),
    replacedFile,
  );
  check("the dropped cora line is gone after replace", !replacedFile.includes("stale cora line"), replacedFile);
  check("replace regenerates the managed header", replacedFile.startsWith("# Cora memory (workspace:"), replacedFile);

  // confirm_drop_user_lines overrides the guardrail.
  const confirmed = await mem.rememberReplace("workspace", "ws-replace", "## Build\n- a brand new consolidated fact\n", true, "run-r3");
  const confirmedFile = fs.readFileSync(replacePath, "utf8");
  check(
    "confirm_drop_user_lines drops user lines and says so",
    /dropped \d+ user-authored line/.test(confirmed.message) &&
      !confirmedFile.includes("npm test") &&
      !confirmedFile.includes("prose note"),
    `${confirmed.message} · ${confirmedFile}`,
  );

  // Replace when the user's own content alone exceeds the cap.
  const hugePath = workspaceFile(mem, "ws-huge");
  const hugeUserLines = Array.from({ length: 60 }, (_, i) => `user epic line ${i} ${"u".repeat(80)}`).join("\n");
  fs.writeFileSync(hugePath, `# Cora memory (workspace: huge)\n${hugeUserLines}\n`, "utf8");
  await expectThrow(
    "replace reports when user-authored content alone exceeds the cap",
    () => mem.rememberReplace("workspace", "ws-huge", hugeUserLines, false, "run-huge"),
    /^user-authored content alone exceeds the cap; ask the user to trim /,
  );

  // ── oversize hand-edited file: truncated on inject, add refused ───────────
  const injected = await mem.formatCoraMemoryForTurn("ws-huge", "run-huge-inject");
  check(
    "an oversize hand-edited file is truncated at the cap with a visible notice",
    injected !== null && injected.includes("[memory truncated at 4 KB: ask Cora to consolidate, or trim the file]"),
    String(injected).slice(-400),
  );
  const wsSection = injected.slice(injected.indexOf("CORA MEMORY, THIS WORKSPACE"));
  const bodyOnly = wsSection
    .split("\n")
    .filter((line) => !line.startsWith("CORA MEMORY") && !line.startsWith("[END CORA MEMORY") && !line.startsWith("[memory truncated") && !line.startsWith("This memory file is"))
    .join("\n");
  check(
    "the truncated body respects the byte cap",
    Buffer.byteLength(bodyOnly, "utf8") <= mem.MEMORY_FILE_MAX_BYTES + 1,
    `${Buffer.byteLength(bodyOnly, "utf8")} bytes`,
  );
  check(
    "the soft-cap footer rides the oversize section",
    injected.includes("bytes. Consolidate it with codara_remember action \"replace\" before adding more."),
    String(injected).slice(-400),
  );
  await expectThrow(
    "rememberAdd refuses on an oversize hand-edited file",
    () => mem.rememberAdd("workspace", "ws-huge", ["one more"], "run-huge-add"),
    /^memory full \(/,
  );
  check(
    "the app never modified the oversize file",
    fs.readFileSync(hugePath, "utf8").includes("user epic line 59"),
    "oversize file was rewritten",
  );

  // ── injection layout: global first, then workspace ────────────────────────
  await mem.rememberAdd("global", "", ["The user's name is Etienne."], "run-g1");
  const layout = await mem.formatCoraMemoryForTurn("ws-main", "run-layout");
  check(
    "the global section precedes the workspace section",
    layout !== null &&
      layout.indexOf("CORA MEMORY, GLOBAL") === 0 &&
      layout.indexOf("[END CORA MEMORY GLOBAL]") < layout.indexOf("CORA MEMORY, THIS WORKSPACE") &&
      layout.trimEnd().endsWith("[END CORA MEMORY WORKSPACE]"),
    String(layout),
  );
  check(
    "section headers carry the editable file paths",
    layout.includes(`(user-editable file: ${GLOBAL_FILE};`) &&
      layout.includes(`(user-editable file: ${workspaceFile(mem, "ws-main")};`),
    String(layout),
  );
  check(
    "the global template suggests the About the user heading",
    fs.readFileSync(GLOBAL_FILE, "utf8").includes("## About the user"),
    fs.readFileSync(GLOBAL_FILE, "utf8"),
  );

  // ── hash gating: once per run, force flag, change re-injects ──────────────
  const first = await mem.formatCoraMemoryForTurn("ws-main", "run-gate");
  const second = await mem.formatCoraMemoryForTurn("ws-main", "run-gate");
  check("unchanged memory injects once per run", first !== null && second === null, `${first === null} / ${second === null}`);
  const forced = await mem.formatCoraMemoryForTurn("ws-main", "run-gate", { force: true });
  check("force re-injects unchanged memory (canonical replay)", forced !== null && forced === first, String(forced).slice(0, 80));
  const otherRun = await mem.formatCoraMemoryForTurn("ws-main", "run-gate-2");
  check("a different run gets its own first injection", otherRun !== null, "expected rendered sections");
  await mem.rememberAdd("workspace", "ws-main", ["A fact that changes the hash."], "run-gate-3");
  const afterChange = await mem.formatCoraMemoryForTurn("ws-main", "run-gate");
  check(
    "a memory write re-injects on the same run",
    afterChange !== null && afterChange.includes("A fact that changes the hash."),
    String(afterChange),
  );

  // ── toggle semantics, including disabled writes ───────────────────────────
  await mem.setMemoryEnabled("workspace", "ws-main", false);
  const wsDisabled = await mem.formatCoraMemoryForTurn("ws-main", "run-toggle-1");
  check(
    "a disabled workspace tier injects the global section only",
    wsDisabled !== null && wsDisabled.includes("CORA MEMORY, GLOBAL") && !wsDisabled.includes("CORA MEMORY, THIS WORKSPACE"),
    String(wsDisabled),
  );
  await expectThrow(
    "rememberAdd on a disabled workspace tier errors with the disabled message",
    () => mem.rememberAdd("workspace", "ws-main", ["should not land"], "run-toggle-2"),
    /^memory is disabled for this workspace; tell the user if they asked you to remember something$/,
  );
  const disabledSnapshot = fs.readFileSync(mainPath, "utf8");
  await mem.appendAutoMemories("ws-main", ["auto lesson while disabled"], "run-toggle-3");
  check(
    "appendAutoMemories writes nothing while the tier is disabled",
    fs.readFileSync(mainPath, "utf8") === disabledSnapshot,
    "disabled write landed",
  );
  const statusDisabled = await mem.getMemoryStatus("ws-main");
  check(
    "getMemoryStatus reflects the toggle",
    statusDisabled.workspace.enabled === false && statusDisabled.global.enabled === true,
    JSON.stringify(statusDisabled),
  );

  await mem.setMemoryEnabled("global", null, false);
  const allDisabled = await mem.formatCoraMemoryForTurn("ws-main", "run-toggle-4");
  check("the global toggle is the master off switch for injection", allDisabled === null, String(allDisabled));
  await expectThrow(
    "rememberAdd global errors while globally disabled",
    () => mem.rememberAdd("global", "", ["should not land"], "run-toggle-5"),
    /^memory is disabled for this global; tell the user if they asked you to remember something$/,
  );
  await mem.setMemoryEnabled("global", null, true);
  await mem.setMemoryEnabled("workspace", "ws-main", true);
  const reEnabled = await mem.formatCoraMemoryForTurn("ws-main", "run-toggle-6");
  check("re-enabling restores both sections", reEnabled !== null && reEnabled.includes("CORA MEMORY, THIS WORKSPACE"), String(reEnabled));

  // ── status counts ─────────────────────────────────────────────────────────
  const status = await mem.getMemoryStatus("ws-ttl");
  check(
    "getMemoryStatus counts line provenance per tier",
    status.workspace.counts.user >= 1 && status.workspace.counts.auto >= 1 && status.workspace.counts.cora >= 1,
    JSON.stringify(status.workspace),
  );
  check(
    "getMemoryStatus with a null workspace reports a disabled empty workspace tier",
    (await mem.getMemoryStatus(null)).workspace.enabled === false &&
      (await mem.getMemoryStatus(null)).workspace.path === "",
    JSON.stringify(await mem.getMemoryStatus(null)),
  );

  // ── clearMemory ───────────────────────────────────────────────────────────
  await mem.clearMemory("workspace", "ws-ttl", false);
  const cleared = fs.readFileSync(ttlPath, "utf8");
  const clearedTagged = cleared.split("\n").filter((line) => /^\s*[-*]\s+\[(auto|cora) /.test(line));
  check(
    "clearMemory default removes only [auto]/[cora] lines",
    clearedTagged.length === 0 && cleared.includes("a user line never expires"),
    cleared,
  );
  await mem.clearMemory("workspace", "ws-ttl", true);
  const clearedAll = fs.readFileSync(ttlPath, "utf8");
  check(
    "clearMemory includeUserLines rewrites to the fresh template",
    clearedAll.startsWith("# Cora memory (workspace:") && !clearedAll.includes("a user line never expires"),
    clearedAll,
  );

  // ── replace cannot launder a user line into a tagged (expirable) line ─────
  const launderPath = workspaceFile(mem, "ws-launder");
  fs.writeFileSync(
    launderPath,
    "# Cora memory (workspace: launder)\n- Never force-push to main\n",
    "utf8",
  );
  await expectThrow(
    "replace rejects a user line reappearing under an [auto] tag (laundering)",
    () => mem.rememberReplace("workspace", "ws-launder", "- [auto 2020-01-01] Never force-push to main\n", false, "run-l1"),
    /replace would drop these user-authored lines[\s\S]*Never force-push to main/,
  );
  await expectThrow(
    "replace rejects a user line reappearing under a [cora] tag too",
    () => mem.rememberReplace("workspace", "ws-launder", `- [cora ${daysAgoStamp(0)}] Never force-push to main\n`, false, "run-l2"),
    /replace would drop these user-authored lines/,
  );
  check(
    "the laundering attempts left the user line untagged on disk",
    fs.readFileSync(launderPath, "utf8").includes("\n- Never force-push to main"),
    fs.readFileSync(launderPath, "utf8"),
  );

  // ── replace cannot mint new non-bullet lines ──────────────────────────────
  await expectThrow(
    "replace rejects new prose/heading lines with the bullets-only error",
    () => mem.rememberReplace("workspace", "ws-launder", "## Cora's new section\n- Never force-push to main\n", false, "run-l3"),
    /^only bullet lines may be added by Cora; prose and headings belong to the user/,
  );
  await expectThrow(
    "replace rejects hiding a user line inside a new comment line",
    () => mem.rememberReplace("workspace", "ws-launder", "<!-- Never force-push to main -->\n", false, "run-l4"),
    /only bullet lines may be added by Cora|replace would drop these user-authored lines/,
  );
  const carriedReplace = await mem.rememberReplace(
    "workspace",
    "ws-launder",
    "- Never force-push to main\n- a consolidated cora fact\n",
    false,
    "run-l5",
  );
  check(
    "replace still accepts a body of carried user lines plus new bullets",
    carriedReplace.bytesUsed > 0 &&
      fs.readFileSync(launderPath, "utf8").includes("- Never force-push to main") &&
      /- \[cora \d{4}-\d{2}-\d{2}\] a consolidated cora fact/.test(fs.readFileSync(launderPath, "utf8")),
    fs.readFileSync(launderPath, "utf8"),
  );

  // ── unclosed header comment must not swallow user content ─────────────────
  const brokenHeaderPath = workspaceFile(mem, "ws-broken-header");
  fs.writeFileSync(
    brokenHeaderPath,
    [
      "# Cora memory (workspace: broken)",
      "<!-- cwd: /tmp/x",
      "     the user deleted the closing marker",
      "",
      "- my precious user note one",
      "important prose the user wrote",
      `- [cora ${daysAgoStamp(1)}] cora line to clear`,
    ].join("\n") + "\n",
    "utf8",
  );
  const brokenParsed = mem.parseMemoryFile(fs.readFileSync(brokenHeaderPath, "utf8"));
  check(
    "an unclosed header comment keeps only the title line as header",
    brokenParsed.headerLines.length === 1,
    JSON.stringify(brokenParsed.headerLines),
  );
  await mem.clearMemory("workspace", "ws-broken-header", false);
  const brokenAfterClear = fs.readFileSync(brokenHeaderPath, "utf8");
  check(
    "default clear survives an unclosed header comment (user lines kept)",
    brokenAfterClear.includes("my precious user note one") &&
      brokenAfterClear.includes("important prose the user wrote") &&
      !brokenAfterClear.includes("cora line to clear"),
    brokenAfterClear,
  );
  await mem.rememberAdd("workspace", "ws-broken-header", ["a new cora fact"], "run-bh1");
  const brokenAfterAdd = fs.readFileSync(brokenHeaderPath, "utf8");
  check(
    "rememberAdd survives an unclosed header comment (user lines kept)",
    brokenAfterAdd.includes("my precious user note one") &&
      brokenAfterAdd.includes("the user deleted the closing marker") &&
      brokenAfterAdd.includes("a new cora fact"),
    brokenAfterAdd,
  );

  // ── code fences: lines inside a fence are the user's, never pruned ────────
  const fencePath = workspaceFile(mem, "ws-fence");
  fs.writeFileSync(
    fencePath,
    [
      "# Cora memory (workspace: fence)",
      "Example of the tag format:",
      "```",
      "- [auto 2020-01-01] example inside the user's code fence",
      "```",
    ].join("\n") + "\n",
    "utf8",
  );
  const fenceParsed = mem.parseMemoryFile(fs.readFileSync(fencePath, "utf8"));
  check(
    "fence content parses as user lines, not tagged bullets",
    fenceParsed.lines.every((line) => line.kind !== "auto" && line.kind !== "cora"),
    JSON.stringify(fenceParsed.lines.map((line) => line.kind)),
  );
  await mem.rememberAdd("workspace", "ws-fence", ["trigger a write"], "run-f1");
  check(
    "a write never prunes an expired-looking line inside a fence",
    fs.readFileSync(fencePath, "utf8").includes("example inside the user's code fence"),
    fs.readFileSync(fencePath, "utf8"),
  );
  const fenceInjected = await mem.formatCoraMemoryForTurn("ws-fence", "run-f2");
  check(
    "injection carries fence content despite its expired-looking tag",
    fenceInjected !== null && fenceInjected.includes("example inside the user's code fence"),
    String(fenceInjected),
  );
  await mem.clearMemory("workspace", "ws-fence", false);
  check(
    "default clear keeps fence content",
    fs.readFileSync(fencePath, "utf8").includes("example inside the user's code fence"),
    fs.readFileSync(fencePath, "utf8"),
  );

  // ── concurrent writers on one file are serialized ─────────────────────────
  await Promise.all([
    mem.rememberAdd("workspace", "ws-race", ["cora fact from the remember tool"], "run-race-1"),
    mem.appendAutoMemories("ws-race", ["auto lesson from run completion"], "run-race-2"),
    mem.rememberAdd("workspace", "ws-race", ["second cora fact in flight"], "run-race-3"),
  ]);
  const raceFile = fs.readFileSync(workspaceFile(mem, "ws-race"), "utf8");
  check(
    "concurrent add + auto-append + add all land (per-path write queue)",
    raceFile.includes("cora fact from the remember tool") &&
      raceFile.includes("auto lesson from run completion") &&
      raceFile.includes("second cora fact in flight"),
    raceFile,
  );
  check(
    "the raced file has exactly one header",
    (raceFile.match(/# Cora memory/g) ?? []).length === 1,
    raceFile,
  );

  // ── release: a failed pre-submission turn does not consume the injection ──
  const gatePath = workspaceFile(mem, "ws-release");
  fs.writeFileSync(gatePath, "# Cora memory (workspace: release)\n- a fact to inject\n", "utf8");
  const firstInject = await mem.formatCoraMemoryForTurn("ws-release", "run-release");
  check("release test: first turn injects", firstInject !== null, String(firstInject));
  mem.releaseCoraMemoryInjection("run-release");
  const retryInject = await mem.formatCoraMemoryForTurn("ws-release", "run-release");
  check(
    "after release, the retry injects again instead of null",
    retryInject !== null && retryInject === firstInject,
    String(retryInject),
  );
  const settled = await mem.formatCoraMemoryForTurn("ws-release", "run-release");
  check("once a turn stands, the next unchanged turn is gated again", settled === null, String(settled));
  // A null (already-carried) turn that fails must not roll back the earlier
  // successful injection into a duplicate-free state change; releasing after
  // it re-injects at worst (harmless), never skips.
  mem.releaseCoraMemoryInjection("run-release");
  const afterNullRelease = await mem.formatCoraMemoryForTurn("ws-release", "run-release");
  check(
    "release after an already-carried turn re-injects rather than skips",
    afterNullRelease !== null,
    String(afterNullRelease),
  );

  // ── sanitize path safety with a hostile workspaceId ───────────────────────
  const hostile = "../../../evil/../__proto__";
  const hostilePath = workspaceFile(mem, hostile);
  check(
    "a hostile workspaceId cannot escape the workspaces dir",
    path.dirname(path.resolve(hostilePath)) === path.resolve(WORKSPACES_DIR),
    hostilePath,
  );
  await mem.rememberAdd("workspace", hostile, ["hostile id write lands safely"], "run-hostile");
  check("the hostile write landed inside the workspaces dir", fs.existsSync(hostilePath), hostilePath);
  check(
    "no file escaped the memory root",
    !fs.existsSync(path.join(TMP_HOME, "..", "evil")) && !fs.existsSync(path.join(TMP_HOME, "evil")),
    "hostile path escaped",
  );

  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll cora-memory checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
