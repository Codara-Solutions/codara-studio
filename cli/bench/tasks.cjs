"use strict";

// The Cora harness benchmark: small, deterministic coding tasks that grade the
// HARNESS, not just the answer. Every task carries:
//
//   tier      trivial | standard | hard — what effort SHOULD look like. The
//             scorer rewards being cheap on trivial work and patient on hard
//             work (see score.cjs).
//   split     train | holdout — iterate prompts against train, confirm on
//             holdout so we don't overfit Cora to specific tasks.
//   par       aspirational wall-seconds and manager-tokens ("golf par").
//             Frozen constants: never recalibrate them, or scores stop being
//             comparable across Cora versions.
//   files     seeded into a throwaway git workspace before the run.
//   stages    optional checkpoints: after the run settles, each stage's files
//             overwrite the workspace (an evolved test.js) and its prompt is
//             sent as a follow-up into the SAME conversation. This measures
//             whether quality survives iterating on your own code — the
//             regime where single long contexts degrade (SlopCodeBench).
//   prompt    what the user asks Cora. Prompts SAY that the full documented
//             contract is graded, so thoroughness is rewarded fairly.
//   hidden    extra test groups run only at grading time. They test STATED
//             requirements the visible test.js does not exercise — the gap
//             between "made the test pass" and "honored the contract" is
//             exactly the headroom that keeps 100/100 out of reach.
//   extraChecks(dir, metrics)  optional task-specific graded checks
//             (untouched test files, stale names, model routing).
//   reference patch that solves the task — used ONLY by the offline
//             self-test to prove every check (hidden ones included) is
//             satisfiable. The benchmark must never be unwinnable.

const TIER_CAP_MS = { trivial: 5 * 60_000, standard: 10 * 60_000, hard: 15 * 60_000, project: 30 * 60_000 };

const TASKS = [
  // ── train · trivial ────────────────────────────────────────────────────────
  {
    name: "typo-fix",
    brief: "one-character bug; measures whether small work stays small",
    tier: "trivial",
    split: "train",
    par: { wallS: 60, tokensK: 15 },
    files: {
      "range.js": `"use strict";
// inRange(value, min, max) -> true when min <= value <= max (INCLUSIVE both ends).
function inRange(value, min, max) {
  return value >= min && value < max;
}
module.exports = { inRange };
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { inRange } = require("./range.js");
assert.equal(inRange(5, 0, 5), true);
assert.equal(inRange(0, 0, 5), true);
assert.equal(inRange(6, 0, 5), false);
console.log("ok");
`,
    },
    prompt:
      "The test in test.js fails. Fix range.js so it matches its documented contract and `node test.js` passes. " +
      "Do not change test.js. The full documented contract is graded, not just test.js.",
    hidden: [
      {
        name: "inclusive bounds hold everywhere",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { inRange } = require("./range.js");
assert.equal(inRange(-3, -3, -1), true);
assert.equal(inRange(-1, -3, -1), true);
assert.equal(inRange(2.5, 0, 2.5), true);
assert.equal(inRange(-1, -3, -2), false);
console.log("ok");`,
      },
    ],
    extraChecks(dir) {
      const untouched = (readFile(dir, "test.js") ?? "").includes("inRange(5, 0, 5)");
      return [{ name: "test.js untouched", pass: untouched, weight: 1 }];
    },
    reference: {
      "range.js": `"use strict";
function inRange(value, min, max) {
  return value >= min && value <= max;
}
module.exports = { inRange };
`,
    },
  },

  {
    name: "tiny-feature",
    brief: "add one small documented function; measures overhead on easy adds",
    tier: "trivial",
    split: "train",
    par: { wallS: 75, tokensK: 15 },
    files: {
      "strings.js": `"use strict";
function titleCase(text) {
  return text.replace(/\\b\\w/g, (ch) => ch.toUpperCase());
}
// TODO: add initials(name) -> the UPPERCASE first letter of each
// whitespace-separated word, joined. "ada  lovelace" -> "AL". Extra
// surrounding or repeated whitespace must not matter. Export it.
module.exports = { titleCase };
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { initials } = require("./strings.js");
assert.equal(initials("Ada Lovelace"), "AL");
assert.equal(initials("grace brewster murray hopper"), "GBMH");
console.log("ok");
`,
    },
    prompt:
      "Implement the TODO in strings.js so `node test.js` passes. Do not change test.js. " +
      "The full documented contract is graded, not just test.js.",
    hidden: [
      {
        name: "whitespace edge cases",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { initials } = require("./strings.js");
assert.equal(initials("  ada   lovelace  "), "AL");
assert.equal(initials("plato"), "P");
console.log("ok");`,
      },
    ],
    reference: {
      "strings.js": `"use strict";
function titleCase(text) {
  return text.replace(/\\b\\w/g, (ch) => ch.toUpperCase());
}
function initials(name) {
  return name.trim().split(/\\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("");
}
module.exports = { titleCase, initials };
`,
    },
  },

  // ── train · standard ───────────────────────────────────────────────────────
  {
    name: "parallel-slices",
    brief: "four independent modules; measures fan-out and spec-reading",
    tier: "standard",
    split: "train",
    parallel: true,
    expectedParallel: 4,
    par: { wallS: 150, tokensK: 35 },
    files: {
      "lib/slug.js": `"use strict";
// TODO: implement slugify(text): lowercase, spaces to dashes, strip anything
// that is not a-z, 0-9, or dash, COLLAPSE runs of dashes to one, and TRIM
// leading/trailing dashes. Export it.
module.exports = {};
`,
      "lib/clamp.js": `"use strict";
// TODO: implement clamp(value, min, max). Values exactly at a bound return
// that bound. Export it.
module.exports = {};
`,
      "lib/chunk.js": `"use strict";
// TODO: implement chunk(array, size) -> array of arrays. A size larger than
// the array yields one chunk; an empty array yields []. Export it.
module.exports = {};
`,
      "lib/dedupe.js": `"use strict";
// TODO: implement dedupe(array) -> new array keeping only the FIRST
// occurrence of each value, order preserved. Export it.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { slugify } = require("./lib/slug.js");
const { clamp } = require("./lib/clamp.js");
const { chunk } = require("./lib/chunk.js");
const { dedupe } = require("./lib/dedupe.js");
assert.equal(slugify("Hello World!"), "hello-world");
assert.equal(clamp(5, 0, 3), 3);
assert.equal(clamp(-1, 0, 3), 0);
assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(dedupe([1, 2, 1, 3, 2]), [1, 2, 3]);
console.log("ok");
`,
    },
    prompt:
      "Implement the four TODO modules in lib/ (slug.js, clamp.js, chunk.js, dedupe.js) so `node test.js` passes. " +
      "Each module's full documented contract is graded, not just test.js.",
    hidden: [
      {
        name: "slugify collapses and trims dashes",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { slugify } = require("./lib/slug.js");
assert.equal(slugify(" --Mixed  UP  case!! "), "mixed-up-case");
assert.equal(slugify("a---b"), "a-b");
console.log("ok");`,
      },
      {
        name: "clamp and chunk boundary cases",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { clamp } = require("./lib/clamp.js");
const { chunk } = require("./lib/chunk.js");
assert.equal(clamp(3, 3, 3), 3);
assert.equal(clamp(0, 0, 5), 0);
assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
assert.deepEqual(chunk([], 3), []);
console.log("ok");`,
      },
      {
        name: "dedupe keeps first occurrence order",
        weight: 1,
        source: `const assert = require("node:assert/strict");
const { dedupe } = require("./lib/dedupe.js");
assert.deepEqual(dedupe(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
assert.deepEqual(dedupe([]), []);
console.log("ok");`,
      },
    ],
    reference: {
      "lib/slug.js": `"use strict";
function slugify(text) {
  return text.toLowerCase().replace(/\\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
module.exports = { slugify };
`,
      "lib/clamp.js": `"use strict";
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
module.exports = { clamp };
`,
      "lib/chunk.js": `"use strict";
function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
module.exports = { chunk };
`,
      "lib/dedupe.js": `"use strict";
function dedupe(array) {
  return [...new Set(array)];
}
module.exports = { dedupe };
`,
    },
  },

  {
    name: "cross-file-rename",
    brief: "rename an API across every call site without breaking anything",
    tier: "standard",
    split: "train",
    par: { wallS: 150, tokensK: 35 },
    files: {
      "db.js": `"use strict";
const rows = [];
function insertRecord(row) { rows.push(row); return rows.length; }
function allRecords() { return [...rows]; }
module.exports = { insertRecord, allRecords };
`,
      "api.js": `"use strict";
const { insertRecord, allRecords } = require("./db.js");
function addUser(name) { return insertRecord({ name }); }
function listUsers() { return allRecords(); }
module.exports = { addUser, listUsers };
`,
      "report.js": `"use strict";
const { allRecords } = require("./db.js");
function count() { return allRecords().length; }
module.exports = { count };
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { addUser, listUsers } = require("./api.js");
const { count } = require("./report.js");
addUser("ada");
addUser("lin");
assert.equal(listUsers().length, 2);
assert.equal(count(), 2);
console.log("ok");
`,
    },
    prompt:
      "Rename the db.js functions: insertRecord -> insert, allRecords -> all. Update every call site in the repo. " +
      "`node test.js` must still pass and no file may still mention the old names.",
    // The seed passes its tests untouched, so "green" additionally means the
    // rename actually happened everywhere.
    probeExtra(dir) {
      return ["db.js", "api.js", "report.js"].every(
        (file) => !/insertRecord|allRecords/.test(readFile(dir, file) ?? ""),
      );
    },
    hidden: [
      {
        name: "new names exported and functional",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const db = require("./db.js");
assert.equal(typeof db.insert, "function");
assert.equal(typeof db.all, "function");
db.insert({ name: "x" });
assert.equal(db.all().length, 1);
console.log("ok");`,
      },
    ],
    extraChecks(dir) {
      const stale = ["db.js", "api.js", "report.js"].filter((file) =>
        /insertRecord|allRecords/.test(readFile(dir, file) ?? ""),
      );
      return [{ name: "no stale names", pass: stale.length === 0, weight: 2, detail: stale.join(", ") }];
    },
    reference: {
      "db.js": `"use strict";
const rows = [];
function insert(row) { rows.push(row); return rows.length; }
function all() { return [...rows]; }
module.exports = { insert, all };
`,
      "api.js": `"use strict";
const { insert, all } = require("./db.js");
function addUser(name) { return insert({ name }); }
function listUsers() { return all(); }
module.exports = { addUser, listUsers };
`,
      "report.js": `"use strict";
const { all } = require("./db.js");
function count() { return all().length; }
module.exports = { count };
`,
    },
  },

  // ── train · hard ───────────────────────────────────────────────────────────
  {
    name: "event-log",
    brief: "two subtle bugs, one visible; measures whole-contract verification",
    tier: "hard",
    split: "train",
    par: { wallS: 240, tokensK: 50 },
    files: {
      "eventlog.js": `"use strict";
// Append-only event log with STABLE 1-based ids.
//   append(event) -> id            ids start at 1 and NEVER change
//   get(id) -> event | undefined
//   slice(fromId, count) -> up to \`count\` events starting AT id \`fromId\`
//   prune(beforeId)                drop every event with id < beforeId;
//                                  ids of the remaining events stay stable
//   size() -> retained event count
function createLog() {
  const s = { events: [], base: 1 };
  return {
    append(event) { s.events.push(event); return s.base + s.events.length - 1; },
    get(id) { return s.events[id - s.base]; },
    slice(fromId, count) {
      const start = fromId - s.base + 1;
      return s.events.slice(start, start + count);
    },
    prune(beforeId) {
      s.events.splice(0, Math.max(0, beforeId - s.base));
      s.base = beforeId + 1;
    },
    size() { return s.events.length; },
  };
}
module.exports = { createLog };
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { createLog } = require("./eventlog.js");
const log = createLog();
assert.equal(log.append("a"), 1);
assert.equal(log.append("b"), 2);
assert.equal(log.append("c"), 3);
assert.deepEqual(log.slice(1, 2), ["a", "b"]);
assert.equal(log.get(2), "b");
assert.equal(log.size(), 3);
console.log("ok");
`,
    },
    prompt:
      "The test in test.js fails. Fix eventlog.js so it matches its documented contract. Read the WHOLE contract " +
      "carefully — every documented behavior is graded, including behavior test.js does not exercise. This is subtle " +
      "correctness work; treat it with the scrutiny it deserves. Do not change test.js.",
    hidden: [
      {
        name: "ids stay stable across prune",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { createLog } = require("./eventlog.js");
const log = createLog();
["a", "b", "c", "d", "e"].forEach((e) => log.append(e));
log.prune(3);
assert.equal(log.size(), 3);
assert.equal(log.get(3), "c");
assert.deepEqual(log.slice(3, 2), ["c", "d"]);
console.log("ok");`,
      },
      {
        name: "append after prune continues the id sequence",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { createLog } = require("./eventlog.js");
const log = createLog();
["a", "b", "c", "d", "e"].forEach((e) => log.append(e));
log.prune(3);
assert.equal(log.append("f"), 6);
assert.deepEqual(log.slice(5, 5), ["e", "f"]);
assert.equal(log.get(1), undefined);
console.log("ok");`,
      },
    ],
    extraChecks(dir) {
      const untouched = (readFile(dir, "test.js") ?? "").includes('log.slice(1, 2)');
      return [{ name: "test.js untouched", pass: untouched, weight: 1 }];
    },
    reference: {
      "eventlog.js": `"use strict";
function createLog() {
  const s = { events: [], base: 1 };
  return {
    append(event) { s.events.push(event); return s.base + s.events.length - 1; },
    get(id) { return s.events[id - s.base]; },
    slice(fromId, count) {
      const start = fromId - s.base;
      return s.events.slice(start, start + count);
    },
    prune(beforeId) {
      s.events.splice(0, Math.max(0, beforeId - s.base));
      s.base = Math.max(s.base, beforeId);
    },
    size() { return s.events.length; },
  };
}
module.exports = { createLog };
`,
    },
  },

  {
    name: "interval-merge",
    brief: "priority interval flattening; genuinely hard invariants with headroom",
    tier: "hard",
    split: "train",
    par: { wallS: 300, tokensK: 60 },
    files: {
      "bookings.js": `"use strict";
// mergeBookings(bookings) -> flattened schedule.
// A booking is { start, end, priority } over the half-open range [start, end).
// Contract (all of it, exactly):
// - At any point covered by at least one booking, the winner is the booking
//   with the HIGHEST priority covering that point.
// - The result is a sorted list of disjoint { start, end, priority } segments
//   describing the winner everywhere; points covered by no booking produce
//   no segment.
// - Adjacent (touching) result segments with the SAME priority are merged.
// - Empty bookings (start >= end) are ignored entirely.
// - No empty segments in the result.
// Export mergeBookings.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { mergeBookings } = require("./bookings.js");
assert.deepEqual(mergeBookings([]), []);
assert.deepEqual(
  mergeBookings([{ start: 0, end: 10, priority: 1 }, { start: 5, end: 15, priority: 1 }]),
  [{ start: 0, end: 15, priority: 1 }],
);
assert.deepEqual(
  mergeBookings([{ start: 20, end: 30, priority: 2 }, { start: 0, end: 10, priority: 1 }]),
  [{ start: 0, end: 10, priority: 1 }, { start: 20, end: 30, priority: 2 }],
);
console.log("ok");
`,
    },
    prompt:
      "Implement bookings.js so `node test.js` passes. The full documented contract is graded, and it is stricter " +
      "than test.js: overlapping priorities carve segments out of each other, touching same-priority segments merge, " +
      "empty bookings are ignored. This is subtle correctness work where almost-right implementations pass casual " +
      "tests; treat it with the scrutiny subtle work deserves. Do not change test.js.",
    hidden: [
      {
        name: "higher priority carves a hole in lower",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { mergeBookings } = require("./bookings.js");
assert.deepEqual(
  mergeBookings([{ start: 0, end: 10, priority: 1 }, { start: 3, end: 5, priority: 2 }]),
  [{ start: 0, end: 3, priority: 1 }, { start: 3, end: 5, priority: 2 }, { start: 5, end: 10, priority: 1 }],
);
assert.deepEqual(
  mergeBookings([{ start: 0, end: 10, priority: 2 }, { start: 5, end: 15, priority: 1 }]),
  [{ start: 0, end: 10, priority: 2 }, { start: 10, end: 15, priority: 1 }],
);
console.log("ok");`,
      },
      {
        name: "touching merges, containment collapses, carve at edge",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { mergeBookings } = require("./bookings.js");
assert.deepEqual(
  mergeBookings([{ start: 0, end: 5, priority: 1 }, { start: 5, end: 10, priority: 1 }]),
  [{ start: 0, end: 10, priority: 1 }],
);
assert.deepEqual(
  mergeBookings([{ start: 0, end: 10, priority: 3 }, { start: 2, end: 4, priority: 1 }]),
  [{ start: 0, end: 10, priority: 3 }],
);
assert.deepEqual(
  mergeBookings([{ start: 0, end: 10, priority: 1 }, { start: 0, end: 4, priority: 2 }]),
  [{ start: 0, end: 4, priority: 2 }, { start: 4, end: 10, priority: 1 }],
);
console.log("ok");`,
      },
      {
        name: "empty bookings ignored",
        weight: 1,
        source: `const assert = require("node:assert/strict");
const { mergeBookings } = require("./bookings.js");
assert.deepEqual(mergeBookings([{ start: 5, end: 5, priority: 9 }]), []);
assert.deepEqual(
  mergeBookings([{ start: 7, end: 3, priority: 9 }, { start: 0, end: 2, priority: 1 }]),
  [{ start: 0, end: 2, priority: 1 }],
);
console.log("ok");`,
      },
    ],
    reference: {
      "bookings.js": `"use strict";
function mergeBookings(bookings) {
  const real = bookings.filter((b) => b.start < b.end);
  const points = [...new Set(real.flatMap((b) => [b.start, b.end]))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [s, e] = [points[i], points[i + 1]];
    let priority = null;
    for (const b of real) {
      if (b.start <= s && e <= b.end) priority = priority === null ? b.priority : Math.max(priority, b.priority);
    }
    if (priority === null) continue;
    const last = out[out.length - 1];
    if (last && last.end === s && last.priority === priority) last.end = e;
    else out.push({ start: s, end: e, priority });
  }
  return out;
}
module.exports = { mergeBookings };
`,
    },
  },

  // ── train · project ────────────────────────────────────────────────────────
  {
    name: "text-tools",
    brief: "five meaty independent modules; where orchestration should finally pay",
    tier: "project",
    split: "train",
    parallel: true,
    expectedParallel: 5,
    par: { wallS: 600, tokensK: 150 },
    files: {
      "lib/glob.js": `"use strict";
// TODO: implement globMatch(pattern, text) -> boolean.
// Contract (all of it, exactly):
// - "*" matches any run of characters (including none) EXCEPT "/".
// - "?" matches exactly one character EXCEPT "/".
// - Every other character matches itself literally; "." is a literal dot,
//   never a wildcard.
// - The whole pattern must match the whole text (no partial matches).
// Export globMatch.
module.exports = {};
`,
      "lib/lcs.js": `"use strict";
// TODO: implement lcs(a, b) -> a longest common subsequence of strings a
// and b (any one of them when several are equally long). The result must be
// a subsequence of BOTH inputs and no longer common subsequence may exist.
// lcs of anything with "" is "". Inputs up to ~1500 characters each must
// complete within a few seconds (no exponential blowup). Export lcs.
module.exports = {};
`,
      "lib/duration.js": `"use strict";
// TODO: implement parseDuration(text) -> total milliseconds, or null.
// Contract (all of it, exactly):
// - Units: d (days), h (hours), m (minutes), s (seconds), ms (milliseconds).
// - A duration is one or more <integer><unit> parts, any order, with optional
//   whitespace anywhere between characters is NOT allowed inside a number or
//   unit, but whitespace between parts is fine: "1h 30m", "2d4h", "90s".
// - "ms" must never be read as minutes followed by something: "100ms" is 100
//   milliseconds.
// - Anything else (empty text, unknown units, trailing garbage, a bare
//   number with no unit) returns null, never NaN and never a partial sum.
// Export parseDuration.
module.exports = {};
`,
      "lib/numfmt.js": `"use strict";
// TODO: implement formatThousands(n) -> the integer n as a string with ","
// every three digits: 1234567 -> "1,234,567". Negative numbers keep the
// leading "-" with no comma after it: -1234 -> "-1,234". Numbers under 1000
// are unchanged. Inputs are integers within Number.MAX_SAFE_INTEGER; larger
// magnitudes are out of scope. Export formatThousands.
module.exports = {};
`,
      "lib/mdtable.js": `"use strict";
// TODO: implement renderTable(rows) -> a GitHub markdown table string.
// Contract (all of it, exactly):
// - rows is an array of plain objects. Columns are the UNION of all keys in
//   first-seen order (scanning rows in order, keys in object order).
// - Line 1 is the header: "| a | b |" (single spaces around cells).
// - Line 2 is the separator: "| --- | --- |" (three dashes per column).
// - Then one line per row in order; a key missing from a row renders as the
//   empty string ("| x |  |" style); values are stringified.
// - "|" inside a value is escaped as "\\\\|".
// - Lines are joined with "\\n"; an empty rows array returns "".
// Export renderTable.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { globMatch } = require("./lib/glob.js");
const { lcs } = require("./lib/lcs.js");
const { parseDuration } = require("./lib/duration.js");
const { formatThousands } = require("./lib/numfmt.js");
const { renderTable } = require("./lib/mdtable.js");
assert.equal(globMatch("*.js", "app.js"), true);
assert.equal(globMatch("a?c", "abc"), true);
assert.equal(lcs("ABCBDAB", "BDCABA").length, 4);
assert.equal(parseDuration("1h 30m"), 5_400_000);
assert.equal(formatThousands(1234567), "1,234,567");
assert.equal(
  renderTable([{ a: 1, b: 2 }]),
  "| a | b |\\n| --- | --- |\\n| 1 | 2 |",
);
console.log("ok");
`,
    },
    prompt:
      "Build the five TODO modules in lib/ (glob.js, lcs.js, duration.js, numfmt.js, mdtable.js) so `node test.js` " +
      "passes. This is a substantial multi-module build; the modules do not depend on each other. Each module's FULL " +
      "documented contract is graded, and the contracts are stricter than test.js: read them carefully, the edge " +
      "cases are where almost-right implementations fail.",
    hidden: [
      {
        name: "glob: wildcards stop at slashes, dots are literal",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { globMatch } = require("./lib/glob.js");
assert.equal(globMatch("*.js", "src/app.js"), false);
assert.equal(globMatch("a?c", "a/c"), false);
assert.equal(globMatch("a.b", "axb"), false);
assert.equal(globMatch("*", ""), true);
assert.equal(globMatch("", ""), true);
assert.equal(globMatch("src/*.js", "src/app.js"), true);
console.log("ok");`,
      },
      {
        name: "lcs: valid longest subsequence on ties and edges",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { lcs } = require("./lib/lcs.js");
const isSub = (s, t) => { let i = 0; for (const ch of t) if (ch === s[i]) i += 1; return i === s.length; };
{
  const out = lcs("ABCBDAB", "BDCABA");
  assert.equal(out.length, 4);
  assert.ok(isSub(out, "ABCBDAB") && isSub(out, "BDCABA"));
}
{
  const out = lcs("XMJYAUZ", "MZJAWXU");
  assert.equal(out.length, 4);
  assert.ok(isSub(out, "XMJYAUZ") && isSub(out, "MZJAWXU"));
}
assert.equal(lcs("abc", "xyz"), "");
assert.equal(lcs("", "abc"), "");
console.log("ok");`,
      },
      {
        name: "duration: ms tokenization and strict rejection",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { parseDuration } = require("./lib/duration.js");
assert.equal(parseDuration("100ms"), 100);
assert.equal(parseDuration("2d4h"), 2 * 86_400_000 + 4 * 3_600_000);
assert.equal(parseDuration("90s"), 90_000);
assert.equal(parseDuration("1x"), null);
assert.equal(parseDuration(""), null);
assert.equal(parseDuration("5m5"), null);
assert.equal(parseDuration("12"), null);
console.log("ok");`,
      },
      {
        name: "numfmt: negatives, zero, boundaries",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { formatThousands } = require("./lib/numfmt.js");
assert.equal(formatThousands(-1234), "-1,234");
assert.equal(formatThousands(0), "0");
assert.equal(formatThousands(999), "999");
assert.equal(formatThousands(1000), "1,000");
assert.equal(formatThousands(-999), "-999");
assert.equal(formatThousands(1000000000), "1,000,000,000");
console.log("ok");`,
      },
      {
        name: "lcs: no exponential blowup on 1500-char inputs",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { lcs } = require("./lib/lcs.js");
const isSub = (s, t) => { let i = 0; for (const ch of t) if (ch === s[i]) i += 1; return i === s.length; };
const B = "abc".repeat(400);
const a = B + "x".repeat(300);
const b = "y".repeat(300) + B;
const started = Date.now();
const out = lcs(a, b);
assert.ok(Date.now() - started < 10_000, "took too long: exponential or quadratic-copy blowup");
assert.equal(out.length, 1200);
assert.ok(isSub(out, a) && isSub(out, b));
console.log("ok");`,
      },
      {
        name: "glob: regex metacharacters are literal",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { globMatch } = require("./lib/glob.js");
assert.equal(globMatch("a+b?", "a+bc"), true);
assert.equal(globMatch("(x)*", "(x)yz"), true);
assert.equal(globMatch("[a]", "[a]"), true);
assert.equal(globMatch("a+b", "aab"), false);
console.log("ok");`,
      },
      {
        name: "mdtable: key union, missing cells, escaping, empty",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { renderTable } = require("./lib/mdtable.js");
assert.equal(
  renderTable([{ a: 1 }, { b: 2, a: 3 }]),
  "| a | b |\\n| --- | --- |\\n| 1 |  |\\n| 3 | 2 |",
);
assert.equal(
  renderTable([{ x: "a|b" }]),
  "| x |\\n| --- |\\n| a\\\\|b |",
);
assert.equal(renderTable([]), "");
console.log("ok");`,
      },
    ],
    reference: {
      "lib/glob.js": `"use strict";
function globMatch(pattern, text) {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  }
  return new RegExp(re + "$").test(text);
}
module.exports = { globMatch };
`,
      "lib/lcs.js": `"use strict";
function lcs(a, b) {
  let prev = new Array(b.length + 1).fill("");
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array(b.length + 1).fill("");
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) cur[j] = prev[j - 1] + a[i - 1];
      else cur[j] = prev[j].length >= cur[j - 1].length ? prev[j] : cur[j - 1];
    }
    prev = cur;
  }
  return prev[b.length];
}
module.exports = { lcs };
`,
      "lib/duration.js": `"use strict";
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
function parseDuration(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/\\s+/g, "");
  if (s === "") return null;
  const re = /(\\d+)(ms|d|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (m.index !== consumed) return null;
    total += Number(m[1]) * UNIT_MS[m[2]];
    consumed = m.index + m[0].length;
  }
  return consumed === s.length && consumed > 0 ? total : null;
}
module.exports = { parseDuration };
`,
      "lib/numfmt.js": `"use strict";
function formatThousands(n) {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(n));
  return sign + digits.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
}
module.exports = { formatThousands };
`,
      "lib/mdtable.js": `"use strict";
function renderTable(rows) {
  if (rows.length === 0) return "";
  const cols = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!cols.includes(key)) cols.push(key);
  const esc = (value) => String(value).replace(/\\|/g, "\\\\|");
  const line = (cells) => "| " + cells.join(" | ") + " |";
  return [
    line(cols.map(esc)),
    line(cols.map(() => "---")),
    ...rows.map((row) => line(cols.map((col) => (col in row ? esc(row[col]) : "")))),
  ].join("\\n");
}
module.exports = { renderTable };
`,
    },
  },

  {
    name: "checkpoint-tracker",
    brief: "evolving spec over three checkpoints; measures whether quality survives iteration",
    tier: "project",
    split: "train",
    par: { wallS: 540, tokensK: 160 },
    files: {
      "track.js": `"use strict";
// A tiny task tracker. createTracker() returns an independent tracker:
//   add(title) -> numeric id, starting at 1 and incrementing
//   list() -> one line per item, insertion order: "id [ ] title", with
//             [x] once done. Empty tracker -> "".
//   done(id) -> true, or false when no item has that id
// TODO: implement and export createTracker.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { createTracker } = require("./track.js");
const t = createTracker();
assert.equal(t.list(), "");
assert.equal(t.add("write spec"), 1);
assert.equal(t.add("review spec"), 2);
assert.equal(t.done(1), true);
assert.equal(t.done(99), false);
assert.equal(t.list(), "1 [x] write spec\\n2 [ ] review spec");
console.log("ok");
`,
    },
    prompt:
      "track.js documents a small task tracker; implement the TODO so `node test.js` passes. Do not change " +
      "test.js. The full documented contract is graded, not just test.js. This tracker will grow over two " +
      "follow-up requests in this same conversation: code structure is graded at the end (small, factored, " +
      "no duplicated logic), so build it to be extended.",
    stages: [
      {
        prompt:
          'The tracker grows (test.js has been updated; do not change it): (1) add(title, priority) accepts ' +
          '"low"|"normal"|"high", defaults to "normal", and throws on any other value. (2) list() shows a ' +
          '" (high)" or " (low)" suffix after the title; normal items stay bare. (3) list({ status }) filters ' +
          'by "open", "done", or "all" (the default), and throws on an unknown status. (4) stats() returns ' +
          "{ open, done, byPriority: { low, normal, high } }. Everything from the first request must keep " +
          "working. The full documented contract is graded, and so is the final code structure: keep track.js " +
          "small and factored — one more request follows.",
        files: {
          "test.js": `"use strict";
const assert = require("node:assert/strict");
const { createTracker } = require("./track.js");
const t = createTracker();
assert.equal(t.add("a"), 1);
assert.equal(t.add("b", "high"), 2);
assert.equal(t.add("c", "low"), 3);
assert.equal(t.done(1), true);
assert.equal(t.list(), "1 [x] a\\n2 [ ] b (high)\\n3 [ ] c (low)");
assert.equal(t.list({ status: "open" }), "2 [ ] b (high)\\n3 [ ] c (low)");
assert.equal(t.list({ status: "done" }), "1 [x] a");
assert.deepEqual(t.stats(), { open: 2, done: 1, byPriority: { low: 1, normal: 1, high: 1 } });
console.log("ok");
`,
        },
      },
      {
        prompt:
          "Final round (test.js updated again; do not change it): (1) listData(options) mirrors list() exactly " +
          "— same items, same order, same filters — as plain data objects { id, title, done, priority }; " +
          "mutating what it returns must not affect the tracker. (2) remove(id) deletes an item, returns false " +
          "for unknown ids, and removed ids are NEVER reused by add. (3) stats() and list() must stay " +
          "consistent with listData() after any mix of add/done/remove. The whole documented contract from all " +
          "three requests is graded, plus structure: track.js under 200 lines with no duplicated logic.",
        files: {
          "test.js": `"use strict";
const assert = require("node:assert/strict");
const { createTracker } = require("./track.js");
const t = createTracker();
t.add("a");
t.add("b", "high");
t.add("c", "low");
t.done(1);
assert.deepEqual(t.listData(), [
  { id: 1, title: "a", done: true, priority: "normal" },
  { id: 2, title: "b", done: false, priority: "high" },
  { id: 3, title: "c", done: false, priority: "low" },
]);
assert.equal(t.remove(2), true);
assert.equal(t.remove(2), false);
assert.equal(t.add("d"), 4);
assert.equal(t.list(), "1 [x] a\\n3 [ ] c (low)\\n4 [ ] d");
assert.deepEqual(t.listData({ status: "open" }).map((x) => x.id), [3, 4]);
assert.deepEqual(t.stats(), { open: 2, done: 1, byPriority: { low: 1, normal: 2, high: 0 } });
console.log("ok");
`,
        },
      },
    ],
    hidden: [
      {
        name: "state stays consistent through add/done/remove churn",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { createTracker } = require("./track.js");
const t = createTracker();
for (let i = 1; i <= 6; i += 1) t.add("task " + i, i % 3 === 0 ? "high" : "normal");
t.done(2);
t.done(5);
t.remove(3);
t.remove(1);
assert.equal(t.add("late"), 7);
const data = t.listData();
assert.deepEqual(data.map((x) => x.id), [2, 4, 5, 6, 7]);
const stats = t.stats();
assert.equal(stats.open + stats.done, data.length);
assert.equal(stats.done, data.filter((x) => x.done).length);
assert.equal(stats.byPriority.low + stats.byPriority.normal + stats.byPriority.high, data.length);
const lines = t.list().split("\\n");
assert.equal(lines.length, data.length);
data.forEach((item, i) => assert.ok(lines[i].startsWith(item.id + " ")));
console.log("ok");`,
      },
      {
        name: "documented errors and defaults hold",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { createTracker } = require("./track.js");
const t = createTracker();
assert.throws(() => t.add("x", "urgent"));
t.add("x");
assert.equal(t.listData()[0].priority, "normal");
assert.throws(() => t.list({ status: "someday" }));
assert.equal(t.done(42), false);
assert.equal(t.remove(42), false);
assert.equal(t.list({ status: "all" }), "1 [ ] x");
const empty = createTracker();
assert.equal(empty.list(), "");
assert.deepEqual(empty.listData(), []);
assert.deepEqual(empty.stats(), { open: 0, done: 0, byPriority: { low: 0, normal: 0, high: 0 } });
console.log("ok");`,
      },
      {
        name: "machine output is detached and trackers are independent",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { createTracker } = require("./track.js");
const t = createTracker();
t.add("a");
t.add("b", "high");
const snapshot = t.listData();
snapshot[0].title = "hacked";
snapshot.pop();
assert.equal(t.list(), "1 [ ] a\\n2 [ ] b (high)");
assert.deepEqual(t.listData()[0], { id: 1, title: "a", done: false, priority: "normal" });
const u = createTracker();
assert.equal(u.add("first"), 1);
assert.equal(t.listData().length, 2);
console.log("ok");`,
      },
    ],
    extraChecks(dir) {
      // The slop gate (SlopCodeBench-style): iterating on your own code must
      // not erode it. Verbosity = raw growth; duplication = the dominant slop
      // signal. The reference stays under a quarter of both caps.
      const source = readFile(dir, "track.js") ?? "";
      const lines = source.split("\n");
      const counts = new Map();
      for (const raw of lines) {
        const line = raw.trim();
        if (line.length < 30) continue;
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
      const duplicated = [...counts.entries()].filter(([, n]) => n >= 4).map(([line]) => line.slice(0, 40));
      return [
        {
          name: "slop: track.js stays under 200 lines",
          pass: lines.length > 0 && lines.length <= 200,
          weight: 2,
          detail: lines.length > 200 ? `${lines.length} lines` : "",
        },
        {
          name: "slop: no line duplicated 4+ times",
          pass: duplicated.length === 0,
          weight: 2,
          detail: duplicated.join(" | "),
        },
      ];
    },
    reference: {
      "track.js": `"use strict";
const PRIORITIES = ["low", "normal", "high"];
const STATUSES = ["open", "done", "all"];

function createTracker() {
  const items = [];
  let nextId = 1;

  const byStatus = (status = "all") => {
    if (!STATUSES.includes(status)) throw new Error("unknown status: " + status);
    return items.filter((it) => status === "all" || (status === "done") === it.done);
  };
  const find = (id) => items.findIndex((it) => it.id === id);

  return {
    add(title, priority = "normal") {
      if (!PRIORITIES.includes(priority)) throw new Error("unknown priority: " + priority);
      items.push({ id: nextId, title, done: false, priority });
      return nextId++;
    },
    done(id) {
      const index = find(id);
      if (index === -1) return false;
      items[index].done = true;
      return true;
    },
    remove(id) {
      const index = find(id);
      if (index === -1) return false;
      items.splice(index, 1);
      return true;
    },
    listData(options = {}) {
      return byStatus(options.status).map((it) => ({ ...it }));
    },
    list(options = {}) {
      return byStatus(options.status)
        .map((it) => {
          const suffix = it.priority === "normal" ? "" : " (" + it.priority + ")";
          return it.id + " [" + (it.done ? "x" : " ") + "] " + it.title + suffix;
        })
        .join("\\n");
    },
    stats() {
      const byPriority = { low: 0, normal: 0, high: 0 };
      for (const it of items) byPriority[it.priority] += 1;
      return { open: byStatus("open").length, done: byStatus("done").length, byPriority };
    },
  };
}

module.exports = { createTracker };
`,
    },
  },

  {
    name: "mini-lang",
    brief: "five interlocking language modules; the wide-parallelism probe",
    tier: "project",
    split: "train",
    parallel: true,
    expectedParallel: 4,
    par: { wallS: 720, tokensK: 250 },
    files: {
      "README.md": `# mini-lang

A tiny expression language. Five modules under lib/, one shared AST.

## Language

Expressions only. Grammar (precedence low to high; binary ops left-associative):

    expr    := or
    or      := and ( "||" and )*                        (prec 1)
    and     := cmp ( "&&" cmp )*                        (prec 2)
    cmp     := add ( ("=="|"!="|"<"|"<="|">"|">=") add )*   (prec 3)
    add     := mul ( ("+"|"-") mul )*                   (prec 4)
    mul     := unary ( ("*"|"/"|"%") unary )*           (prec 5)
    unary   := ("-"|"!") unary | atom                   (prec 6)
    atom    := number | "true" | "false" | ident
             | "(" expr ")"
             | "let" ident "=" expr "in" expr

Numbers are integers or decimals (\`12\`, \`0.5\`; a dot must be followed by a
digit). Identifiers are \`[A-Za-z_][A-Za-z0-9_]*\`. \`let\`, \`in\`, \`true\`,
\`false\` are keywords. Whitespace (space, tab, CR, newline) separates tokens.

## AST (shared contract)

Every node carries \`pos: { line, col }\` — 1-based position of the token that
starts the node, except \`binary\`, whose pos is the OPERATOR token's position.

    { type: "num",    value: number,             pos }
    { type: "bool",   value: boolean,            pos }
    { type: "var",    name: string,              pos }
    { type: "unary",  op: "-"|"!", expr,         pos }
    { type: "binary", op, left, right,           pos }   // pos = operator token
    { type: "let",    name, value, body,         pos }   // pos = "let" keyword

## Errors

Every thrown error is an \`Error\` whose message ends with \` at <line>:<col>\`
and which carries numeric \`line\` and \`col\` properties.

## Modules

### lib/lexer.js — \`tokenize(src) -> token[]\`

Tokens: \`{ type, value, line, col }\` with type one of \`num\` (value: number),
\`ident\`, \`kw\` (let/in/true/false), \`op\` (+ - * / % == != < <= > >= && || ! =),
\`lparen\`, \`rparen\`, and a final \`eof\` token at the position just past the
input. Two-character operators win over one-character ones. Unknown
characters throw (\`unexpected character 'X' at l:c\`).

### lib/parser.js — \`parse(src) -> ast\`

Parses per the grammar above (uses the lexer). Trailing input after the
expression is an error. Messages: \`expected ')' at l:c\`,
\`expected identifier at l:c\`, \`expected '=' at l:c\`, \`expected 'in' at l:c\`,
\`unexpected token at l:c\`.

### lib/eval.js — \`evaluate(ast, env = {}) -> number | boolean\`

- \`env\` maps variable names to values; \`let\` binds for its body only and
  inner bindings shadow outer ones.
- Unbound variable: \`unbound variable 'x' at l:c\` (the var node's pos).
- \`&&\` and \`||\` SHORT-CIRCUIT: the right operand is not evaluated (and so
  cannot fail) when the left operand decides the result. Both operands must
  be booleans when evaluated.
- \`==\` / \`!=\` are strict equality on any values.
- Other binary ops and unary \`-\` require numbers; unary \`!\` requires a
  boolean. Type errors report the OPERATOR's pos:
  \`operands of '+' must be numbers at l:c\`,
  \`operand of '-' must be a number at l:c\`,
  \`operand of '!' must be a boolean at l:c\`.
- Division (\`/\`) by zero: \`division by zero at l:c\` (operator pos).

### lib/format.js — \`format(ast) -> string\`

Canonical form: single spaces around binary operators and let keywords
(\`let x = 1 in x + 2\`), no space after unary operators (\`-x\`, \`!(a && b)\`),
numbers via \`String(value)\`.

Parentheses are MINIMAL: only where re-parsing would otherwise change the
tree. Left-associativity means \`(1 - 2) - 3\` prints as \`1 - 2 - 3\` but
\`1 - (2 - 3)\` keeps its parentheses. A \`let\` used as an operand is
parenthesized; a \`let\` in a value/body position is not.

LAW (graded): for any valid source \`s\`,
\`stripPos(parse(format(parse(s))))\` deep-equals \`stripPos(parse(s))\`.

### lib/lint.js — \`lint(ast) -> finding[]\`

Findings \`{ code, name?, line, col }\`, sorted by line, then col, then code.

- \`unused-binding\` — a \`let\` whose variable is never read in its body
  (pos: the let node). Shadowed-then-unused still counts.
- \`shadowed-binding\` — a \`let\` whose name rebinds a name already bound by an
  enclosing let (pos: the INNER let node; also carries \`name\`).
- \`constant-expr\` — a \`binary\` node whose BOTH operands are literals
  (\`num\`/\`bool\`) (pos: the binary node). Nested case: only the innermost
  qualifying node is reported (its parent has a non-literal operand).

All findings carry \`name\` for the binding codes; \`constant-expr\` has no name.
`,
      "lib/lexer.js": `"use strict";
// TODO: implement tokenize(src) -> token[]  (see README.md: token shapes, two-char ops win, unknown chars throw with position)
module.exports = {};
`,
      "lib/parser.js": `"use strict";
// TODO: implement parse(src) -> ast  (see README.md: grammar, AST shapes, binary pos = operator token, error messages)
module.exports = {};
`,
      "lib/eval.js": `"use strict";
// TODO: implement evaluate(ast, env = {}) -> number|boolean  (see README.md: let scoping, short-circuit && ||, strict == !=, typed errors at operator pos)
module.exports = {};
`,
      "lib/format.js": `"use strict";
// TODO: implement format(ast) -> string  (see README.md: canonical spacing, MINIMAL parentheses, round-trip law)
module.exports = {};
`,
      "lib/lint.js": `"use strict";
// TODO: implement lint(ast) -> finding[]  (see README.md: unused-binding, shadowed-binding, constant-expr innermost-only, sorted line/col/code)
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { tokenize } = require("./lib/lexer.js");
const { parse } = require("./lib/parser.js");
const { evaluate } = require("./lib/eval.js");
const { format } = require("./lib/format.js");
const { lint } = require("./lib/lint.js");

// lexer
const toks = tokenize("let x = 12 in x <= 3");
assert.deepEqual(toks.map((t) => t.type), ["kw", "ident", "op", "num", "kw", "ident", "op", "num", "eof"]);
assert.deepEqual(toks[3], { type: "num", value: 12, line: 1, col: 9 });
assert.deepEqual(toks[6], { type: "op", value: "<=", line: 1, col: 17 });

// parser
const ast = parse("1 + 2 * 3");
assert.equal(ast.type, "binary");
assert.equal(ast.op, "+");
assert.equal(ast.right.op, "*");
assert.deepEqual(ast.pos, { line: 1, col: 3 });

// eval
assert.equal(evaluate(parse("let x = 2 in x * x + 1")), 5);
assert.equal(evaluate(parse("1 < 2 && !(3 == 4)")), true);
assert.equal(evaluate(parse("y + 1"), { y: 41 }), 42);

// format
assert.equal(format(parse("1+2 * 3")), "1 + 2 * 3");
assert.equal(format(parse("let x=1 in x")), "let x = 1 in x");

// lint
const findings = lint(parse("let x = 1 in 2 + 3"));
assert.deepEqual(findings.map((f) => f.code), ["unused-binding", "constant-expr"]);

console.log("ok");
`,
    },
    prompt:
      "README.md specifies a tiny expression language and the contracts for five modules (lib/lexer.js, " +
      "lib/parser.js, lib/eval.js, lib/format.js, lib/lint.js). Implement them so `node test.js` passes. " +
      "Do not change test.js or README.md. The full documented spec is graded, not just test.js: the " +
      "formatter round-trip law, exact error messages and positions, short-circuit evaluation, and the " +
      "linter rules all count.",
    hidden: [
      {
        name: "parser precedence, associativity, and error positions",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { parse } = require("./lib/parser.js");
const { evaluate } = require("./lib/eval.js");

assert.equal(evaluate(parse("1 - 2 - 3")), -4);
assert.equal(evaluate(parse("2 * 3 + 4 * 5")), 26);
assert.equal(evaluate(parse("10 % 4 % 3")), 2);
assert.equal(evaluate(parse("!(true && false) || false")), true);
assert.equal(evaluate(parse("1 + 2 < 4 == true")), true);
assert.equal(evaluate(parse("--3")), 3);
assert.equal(evaluate(parse("-3 * -4")), 12);
assert.equal(evaluate(parse("let x = let y = 2 in y + 1 in x * 2")), 6);

assert.throws(() => parse("1 +"), (err) => err.line === 1 && err.col === 4);
assert.throws(() => parse("(1 + 2"), (err) => /expected '\\)' at 1:7/.test(err.message));
assert.throws(() => parse("let 1 = 2 in 3"), (err) => /expected identifier at 1:5/.test(err.message));
assert.throws(() => parse("let x 1 in x"), (err) => /expected '=' at 1:7/.test(err.message));
assert.throws(() => parse("let x = 1 x"), (err) => /expected 'in' at 1:11/.test(err.message));
assert.throws(() => parse("1 2"), (err) => /unexpected token at 1:3/.test(err.message));
console.log("ok");`,
      },
      {
        name: "formatter minimal parens and the round-trip law",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { parse } = require("./lib/parser.js");
const { format } = require("./lib/format.js");

function stripPos(node) {
  const out = {};
  for (const key of Object.keys(node)) {
    if (key === "pos") continue;
    const value = node[key];
    out[key] = value && typeof value === "object" ? stripPos(value) : value;
  }
  return out;
}

assert.equal(format(parse("(1 - 2) - 3")), "1 - 2 - 3");
assert.equal(format(parse("1 - (2 - 3)")), "1 - (2 - 3)");
assert.equal(format(parse("(1 + 2) * 3")), "(1 + 2) * 3");
assert.equal(format(parse("1 / (2 * 3)")), "1 / (2 * 3)");
assert.equal(format(parse("-(1 + 2)")), "-(1 + 2)");
assert.equal(format(parse("-1 + 2")), "-1 + 2");
assert.equal(format(parse("!(a && b)")), "!(a && b)");
assert.equal(format(parse("(let x = 1 in x) + 2")), "(let x = 1 in x) + 2");
assert.equal(format(parse("let x = 1 in x + 2")), "let x = 1 in x + 2");
assert.equal(format(parse("((0.5)) * (x)")), "0.5 * x");

const battery = [
  "1 - 2 - 3 - 4",
  "1 - (2 - (3 - 4))",
  "2 * (3 + 4) % 5",
  "a && b || c && !d",
  "a && (b || c)",
  "-(x % 2) == 1 != true",
  "let a = 1 + 2 in let b = a * a in b - a",
  "(let x = 1 in x) * (let y = 2 in y)",
  "1 <= 2 == 3 >= 4",
  "--x - -y",
];
for (const src of battery) {
  const once = parse(src);
  const twice = parse(format(once));
  assert.deepEqual(stripPos(twice), stripPos(once), "round-trip failed for: " + src + " -> " + format(once));
}
console.log("ok");`,
      },
      {
        name: "positions thread lexer -> parser -> eval errors",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { tokenize } = require("./lib/lexer.js");
const { parse } = require("./lib/parser.js");
const { evaluate } = require("./lib/eval.js");

const toks = tokenize("let x = 1\\nin  x");
const kwIn = toks.find((t) => t.type === "kw" && t.value === "in");
assert.deepEqual({ line: kwIn.line, col: kwIn.col }, { line: 2, col: 1 });
const lastVar = toks.filter((t) => t.type === "ident").pop();
assert.deepEqual({ line: lastVar.line, col: lastVar.col }, { line: 2, col: 5 });
const eof = toks[toks.length - 1];
assert.deepEqual({ type: eof.type, line: eof.line, col: eof.col }, { type: "eof", line: 2, col: 6 });

assert.throws(() => tokenize("1 + $"), (err) => /unexpected character '\\$' at 1:5/.test(err.message) && err.col === 5);
assert.throws(() => tokenize("1."), (err) => typeof err.line === "number" && typeof err.col === "number" && / at 1:\\d+$/.test(err.message));

// multi-line: the binary node's pos is the operator token
const ast = parse("let flag = true\\nin flag + 1");
assert.deepEqual(ast.body.pos, { line: 2, col: 9 });
assert.throws(() => evaluate(ast), (err) => /operands of '\\+' must be numbers at 2:9/.test(err.message) && err.line === 2 && err.col === 9);

assert.throws(() => evaluate(parse("nope")), (err) => /unbound variable 'nope' at 1:1/.test(err.message));
assert.throws(() => evaluate(parse("1 / (2 - 2)")), (err) => /division by zero at 1:3/.test(err.message));
assert.throws(() => evaluate(parse("-true")), (err) => /operand of '-' must be a number at 1:1/.test(err.message));
console.log("ok");`,
      },
      {
        name: "eval: short-circuit, shadowing, strict equality",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { parse } = require("./lib/parser.js");
const { evaluate } = require("./lib/eval.js");

// short-circuit: the unevaluated side may contain errors
assert.equal(evaluate(parse("false && 1 / 0 > 0")), false);
assert.equal(evaluate(parse("true || nope")), true);
assert.throws(() => evaluate(parse("true && 1 / 0 > 0")), (err) => /division by zero/.test(err.message));

// shadowing and scope restoration
assert.equal(evaluate(parse("let x = 1 in let x = x + 1 in x")), 2);
assert.equal(evaluate(parse("let x = 1 in (let x = 10 in x) + x")), 11);
assert.equal(evaluate(parse("let x = 5 in let y = let x = 2 in x * x in y + x")), 9);

// strict equality across types; env values flow through
assert.equal(evaluate(parse("1 == true")), false);
assert.equal(evaluate(parse("1 != true")), true);
assert.equal(evaluate(parse("0.5 + 0.25")), 0.75);
assert.equal(evaluate(parse("a && b"), { a: true, b: false }), false);

// operand type errors on logic ops
assert.throws(() => evaluate(parse("1 && true")), (err) => /operands of '&&' must be booleans at 1:3/.test(err.message));
assert.throws(() => evaluate(parse("false || 0")), (err) => /operands of '\\|\\|' must be booleans at 1:7/.test(err.message));
console.log("ok");`,
      },
      {
        name: "linter: shadowing, unused, innermost constant, order",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { parse } = require("./lib/parser.js");
const { lint } = require("./lib/lint.js");

// shadowed AND the outer becomes unused (inner read only)
const a = lint(parse("let x = 1 in let x = 2 in x"));
assert.deepEqual(a, [
  { code: "unused-binding", name: "x", line: 1, col: 1 },
  { code: "shadowed-binding", name: "x", line: 1, col: 14 },
]);

// reading through a shadow marks only the inner binding used
const b = lint(parse("let x = 1 in x + (let x = 2 in x)"));
assert.deepEqual(b.map((f) => f.code), ["shadowed-binding"]);

// value expression is evaluated in the OUTER scope: x in the value refers to
// the outer x, so the outer binding is used
const c = lint(parse("let x = 1 in let x = x + 1 in x"));
assert.deepEqual(c.map((f) => f.code), ["shadowed-binding"]);

// innermost constant only: 2 * 3 is constant, 1 + (2 * 3) is not reported
const d = lint(parse("1 + 2 * 3"));
assert.deepEqual(d, [{ code: "constant-expr", line: 1, col: 7 }]);
const e = lint(parse("(1 + 2) * 3"));
assert.deepEqual(e, [{ code: "constant-expr", line: 1, col: 4 }]);

// booleans are literals too; unary operands are walked
const f = lint(parse("!(true && false)"));
assert.deepEqual(f, [{ code: "constant-expr", line: 1, col: 8 }]);

// ordering: line, then col
const g = lint(parse("let a = 1 in\\nlet b = 2 in 3 + 4"));
assert.deepEqual(g.map((f) => [f.code, f.line, f.col]), [
  ["unused-binding", 1, 1],
  ["unused-binding", 2, 1],
  ["constant-expr", 2, 16],
]);

// no findings on clean code
assert.deepEqual(lint(parse("let n = x in n * y")), []);
console.log("ok");`,
      },
    ],
    reference: {
      "lib/lexer.js": `"use strict";
const KEYWORDS = ["let", "in", "true", "false"];
const TWO_CHAR = ["==", "!=", "<=", ">=", "&&", "||"];
const ONE_CHAR = "+-*/%<>!=";

function tokenize(src) {
  const tokens = [];
  let line = 1;
  let col = 1;
  let i = 0;
  const fail = (msg) => {
    const err = new Error(msg + " at " + line + ":" + col);
    err.line = line;
    err.col = col;
    throw err;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\n") { i += 1; line += 1; col = 1; continue; }
    if (ch === " " || ch === "\\t" || ch === "\\r") { i += 1; col += 1; continue; }
    const startLine = line;
    const startCol = col;
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      tokens.push({ type: "op", value: two, line: startLine, col: startCol });
      i += 2; col += 2; continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: ch === "(" ? "lparen" : "rparen", value: ch, line: startLine, col: startCol });
      i += 1; col += 1; continue;
    }
    if (ONE_CHAR.includes(ch)) {
      tokens.push({ type: "op", value: ch, line: startLine, col: startCol });
      i += 1; col += 1; continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j += 1;
      if (src[j] === ".") {
        if (!(src[j + 1] >= "0" && src[j + 1] <= "9")) {
          col += j + 1 - i;
          fail("invalid number");
        }
        j += 1;
        while (j < src.length && src[j] >= "0" && src[j] <= "9") j += 1;
      }
      tokens.push({ type: "num", value: Number(src.slice(i, j)), line: startLine, col: startCol });
      col += j - i; i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      tokens.push({ type: KEYWORDS.includes(text) ? "kw" : "ident", value: text, line: startLine, col: startCol });
      col += j - i; i = j; continue;
    }
    fail("unexpected character '" + ch + "'");
  }
  tokens.push({ type: "eof", value: null, line, col });
  return tokens;
}

module.exports = { tokenize };
`,
      "lib/parser.js": `"use strict";
const { tokenize } = require("./lexer.js");

const BIN_PREC = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4, "*": 5, "/": 5, "%": 5,
};

function parse(src) {
  const tokens = tokenize(src);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const fail = (msg, tok) => {
    const err = new Error(msg + " at " + tok.line + ":" + tok.col);
    err.line = tok.line;
    err.col = tok.col;
    throw err;
  };

  function parseExpr(minPrec) {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (tok.type !== "op" || !(tok.value in BIN_PREC) || BIN_PREC[tok.value] < minPrec) break;
      next();
      const right = parseExpr(BIN_PREC[tok.value] + 1);
      left = { type: "binary", op: tok.value, left, right, pos: { line: tok.line, col: tok.col } };
    }
    return left;
  }

  function parseUnary() {
    const tok = peek();
    if (tok.type === "op" && (tok.value === "-" || tok.value === "!")) {
      next();
      const expr = parseUnary();
      return { type: "unary", op: tok.value, expr, pos: { line: tok.line, col: tok.col } };
    }
    return parseAtom();
  }

  function parseAtom() {
    const tok = next();
    if (tok.type === "num") return { type: "num", value: tok.value, pos: { line: tok.line, col: tok.col } };
    if (tok.type === "kw" && (tok.value === "true" || tok.value === "false")) {
      return { type: "bool", value: tok.value === "true", pos: { line: tok.line, col: tok.col } };
    }
    if (tok.type === "ident") return { type: "var", name: tok.value, pos: { line: tok.line, col: tok.col } };
    if (tok.type === "lparen") {
      const expr = parseExpr(1);
      const close = next();
      if (close.type !== "rparen") fail("expected ')'", close);
      return expr;
    }
    if (tok.type === "kw" && tok.value === "let") {
      const name = next();
      if (name.type !== "ident") fail("expected identifier", name);
      const eq = next();
      if (!(eq.type === "op" && eq.value === "=")) fail("expected '='", eq);
      const value = parseExpr(1);
      const kwIn = next();
      if (!(kwIn.type === "kw" && kwIn.value === "in")) fail("expected 'in'", kwIn);
      const body = parseExpr(1);
      return { type: "let", name: name.value, value, body, pos: { line: tok.line, col: tok.col } };
    }
    fail("unexpected token", tok);
  }

  const expr = parseExpr(1);
  const end = peek();
  if (end.type !== "eof") fail("unexpected token", end);
  return expr;
}

module.exports = { parse };
`,
      "lib/eval.js": `"use strict";

function evaluate(ast, env = {}) {
  const fail = (msg, node) => {
    const err = new Error(msg + " at " + node.pos.line + ":" + node.pos.col);
    err.line = node.pos.line;
    err.col = node.pos.col;
    throw err;
  };
  switch (ast.type) {
    case "num":
    case "bool":
      return ast.value;
    case "var":
      if (!(ast.name in env)) fail("unbound variable '" + ast.name + "'", ast);
      return env[ast.name];
    case "unary": {
      const value = evaluate(ast.expr, env);
      if (ast.op === "-") {
        if (typeof value !== "number") fail("operand of '-' must be a number", ast);
        return -value;
      }
      if (typeof value !== "boolean") fail("operand of '!' must be a boolean", ast);
      return !value;
    }
    case "binary": {
      const op = ast.op;
      if (op === "&&" || op === "||") {
        const left = evaluate(ast.left, env);
        if (typeof left !== "boolean") fail("operands of '" + op + "' must be booleans", ast);
        if (op === "&&" && !left) return false;
        if (op === "||" && left) return true;
        const right = evaluate(ast.right, env);
        if (typeof right !== "boolean") fail("operands of '" + op + "' must be booleans", ast);
        return right;
      }
      const left = evaluate(ast.left, env);
      const right = evaluate(ast.right, env);
      if (op === "==") return left === right;
      if (op === "!=") return left !== right;
      if (typeof left !== "number" || typeof right !== "number") {
        fail("operands of '" + op + "' must be numbers", ast);
      }
      switch (op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "%": return left % right;
        case "/":
          if (right === 0) fail("division by zero", ast);
          return left / right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
      }
      fail("unexpected token", ast);
      return undefined;
    }
    case "let": {
      const bound = evaluate(ast.value, env);
      return evaluate(ast.body, { ...env, [ast.name]: bound });
    }
    default:
      fail("unexpected token", ast);
      return undefined;
  }
}

module.exports = { evaluate };
`,
      "lib/format.js": `"use strict";

const BIN_PREC = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4, "*": 5, "/": 5, "%": 5,
};
const UNARY_PREC = 6;

// min = the lowest precedence this position can hold without parentheses.
// let has precedence 0: any operand position (min >= 1) wraps it.
function fmt(node, min) {
  switch (node.type) {
    case "num": return String(node.value);
    case "bool": return String(node.value);
    case "var": return node.name;
    case "let": {
      const text = "let " + node.name + " = " + fmt(node.value, 0) + " in " + fmt(node.body, 0);
      return min > 0 ? "(" + text + ")" : text;
    }
    case "unary": {
      const text = node.op + fmt(node.expr, UNARY_PREC);
      return min > UNARY_PREC ? "(" + text + ")" : text;
    }
    case "binary": {
      const prec = BIN_PREC[node.op];
      const text = fmt(node.left, prec) + " " + node.op + " " + fmt(node.right, prec + 1);
      return min > prec ? "(" + text + ")" : text;
    }
    default:
      throw new Error("unknown node type: " + node.type);
  }
}

function format(ast) {
  return fmt(ast, 0);
}

module.exports = { format };
`,
      "lib/lint.js": `"use strict";

function isLiteral(node) {
  return node.type === "num" || node.type === "bool";
}

function lint(ast) {
  const findings = [];
  // scope: linked frames { parent, name, used }
  function walk(node, scope) {
    switch (node.type) {
      case "var": {
        for (let frame = scope; frame; frame = frame.parent) {
          if (frame.name === node.name) { frame.used = true; break; }
        }
        return;
      }
      case "let": {
        walk(node.value, scope);
        for (let frame = scope; frame; frame = frame.parent) {
          if (frame.name === node.name) {
            findings.push({ code: "shadowed-binding", name: node.name, line: node.pos.line, col: node.pos.col });
            break;
          }
        }
        const frame = { parent: scope, name: node.name, used: false };
        walk(node.body, frame);
        if (!frame.used) {
          findings.push({ code: "unused-binding", name: node.name, line: node.pos.line, col: node.pos.col });
        }
        return;
      }
      case "binary": {
        if (isLiteral(node.left) && isLiteral(node.right)) {
          findings.push({ code: "constant-expr", line: node.pos.line, col: node.pos.col });
        }
        walk(node.left, scope);
        walk(node.right, scope);
        return;
      }
      case "unary":
        walk(node.expr, scope);
        return;
      default:
        return;
    }
  }
  walk(ast, null);
  findings.sort((a, b) => a.line - b.line || a.col - b.col || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return findings;
}

module.exports = { lint };
`,
    },
  },

  {
    name: "arc-triad",
    brief: "three original ARC-style puzzles; infer each rule, graded on held-out inputs",
    tier: "hard",
    split: "train",
    parallel: true,
    expectedParallel: 3,
    par: { wallS: 480, tokensK: 120 },
    files: {
      "README.md": `# arc-triad

Three original grid puzzles in the style of abstraction-and-reasoning
corpora. Each puzzle has its own hidden transformation rule.

Grids are arrays of rows; cells are integers 0-9; 0 is empty.

For each puzzle N in {p1, p2, p3}:

- \`puzzles/pN.json\` holds \`train\` (input/output pairs that demonstrate the
  rule) and \`test\` (inputs whose outputs are graded but not shown).
- Implement \`lib/pN.js\` exporting \`transform(grid) -> grid\`. It must not
  mutate its input.
- The rule is simple, deterministic, and total over the given inputs. It is
  the SAME rule for every pair of its puzzle. Infer it from the train pairs;
  your transform is graded on how it generalizes to the unseen test inputs,
  so hardcoding the train outputs scores zero on what matters.

This is an offline reasoning task: these puzzles were authored for this
workspace and do not exist anywhere else, and web access is not permitted.
`,
      "puzzles/p1.json": `{
 "train": [
  {
   "input": [
    [
     0,
     0,
     0,
     0,
     0,
     7
    ],
    [
     0,
     3,
     3,
     3,
     3,
     0
    ],
    [
     0,
     3,
     0,
     0,
     3,
     0
    ],
    [
     0,
     3,
     0,
     0,
     3,
     0
    ],
    [
     0,
     3,
     3,
     3,
     3,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     0,
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     3,
     3,
     3,
     3,
     0
    ],
    [
     0,
     3,
     7,
     7,
     3,
     0
    ],
    [
     0,
     3,
     7,
     7,
     3,
     0
    ],
    [
     0,
     3,
     3,
     3,
     3,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0
    ]
   ]
  },
  {
   "input": [
    [
     0,
     0,
     2,
     2,
     2,
     2,
     2
    ],
    [
     0,
     0,
     2,
     0,
     0,
     0,
     2
    ],
    [
     0,
     0,
     2,
     0,
     0,
     0,
     2
    ],
    [
     0,
     0,
     2,
     2,
     2,
     2,
     2
    ],
    [
     4,
     0,
     0,
     0,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     0,
     0,
     2,
     2,
     2,
     2,
     2
    ],
    [
     0,
     0,
     2,
     4,
     4,
     4,
     2
    ],
    [
     0,
     0,
     2,
     4,
     4,
     4,
     2
    ],
    [
     0,
     0,
     2,
     2,
     2,
     2,
     2
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0,
     0
    ]
   ]
  },
  {
   "input": [
    [
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     8,
     8,
     8,
     0
    ],
    [
     0,
     8,
     0,
     8,
     0
    ],
    [
     0,
     8,
     0,
     8,
     0
    ],
    [
     0,
     8,
     8,
     8,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0
    ],
    [
     1,
     0,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     8,
     8,
     8,
     0
    ],
    [
     0,
     8,
     1,
     8,
     0
    ],
    [
     0,
     8,
     1,
     8,
     0
    ],
    [
     0,
     8,
     8,
     8,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0
    ]
   ]
  }
 ],
 "test": [
  [
   [
    6,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    5,
    5,
    5,
    5,
    0
   ],
   [
    0,
    5,
    0,
    0,
    5,
    0
   ],
   [
    0,
    5,
    5,
    5,
    5,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  [
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    7,
    7,
    7,
    7,
    0,
    0
   ],
   [
    0,
    7,
    0,
    0,
    7,
    0,
    0
   ],
   [
    0,
    7,
    0,
    0,
    7,
    0,
    0
   ],
   [
    0,
    7,
    7,
    7,
    7,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    9
   ]
  ]
 ]
}`,
      "lib/p1.js": `"use strict";
// TODO: implement transform(grid) -> grid for puzzles/p1.json (see README.md)
module.exports = {};
`,
      "puzzles/p2.json": `{
 "train": [
  {
   "input": [
    [
     5,
     0,
     0,
     0,
     4
    ],
    [
     0,
     3,
     0,
     0,
     0
    ],
    [
     0,
     0,
     6,
     0,
     0
    ],
    [
     0,
     0,
     0,
     8,
     2
    ],
    [
     1,
     0,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     5,
     0,
     0,
     0,
     4
    ],
    [
     0,
     3,
     0,
     3,
     0
    ],
    [
     0,
     0,
     6,
     0,
     0
    ],
    [
     2,
     8,
     0,
     8,
     2
    ],
    [
     1,
     0,
     0,
     0,
     1
    ]
   ]
  },
  {
   "input": [
    [
     3,
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     7,
     0,
     0,
     0,
     2
    ],
    [
     0,
     0,
     4,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     9,
     0
    ]
   ],
   "output": [
    [
     3,
     0,
     0,
     0,
     0,
     3
    ],
    [
     2,
     7,
     0,
     0,
     7,
     2
    ],
    [
     0,
     0,
     4,
     4,
     0,
     0
    ],
    [
     0,
     9,
     0,
     0,
     9,
     0
    ]
   ]
  },
  {
   "input": [
    [
     9,
     0,
     0,
     0,
     0,
     0,
     1
    ],
    [
     0,
     5,
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     6,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     3,
     0,
     0
    ],
    [
     2,
     0,
     0,
     0,
     0,
     0,
     8
    ]
   ],
   "output": [
    [
     9,
     0,
     0,
     0,
     0,
     0,
     1
    ],
    [
     0,
     5,
     0,
     0,
     0,
     5,
     0
    ],
    [
     0,
     0,
     0,
     6,
     0,
     0,
     0
    ],
    [
     0,
     0,
     3,
     0,
     3,
     0,
     0
    ],
    [
     2,
     0,
     0,
     0,
     0,
     0,
     8
    ]
   ]
  }
 ],
 "test": [
  [
   [
    4,
    0,
    0,
    0,
    0,
    6
   ],
   [
    0,
    3,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    7,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    5
   ],
   [
    8,
    0,
    0,
    0,
    0,
    0
   ]
  ],
  [
   [
    0,
    0,
    0,
    0,
    0,
    0,
    3
   ],
   [
    0,
    2,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    4,
    5,
    0
   ],
   [
    7,
    0,
    0,
    0,
    0,
    0,
    0
   ]
  ]
 ]
}`,
      "lib/p2.js": `"use strict";
// TODO: implement transform(grid) -> grid for puzzles/p2.json (see README.md)
module.exports = {};
`,
      "puzzles/p3.json": `{
 "train": [
  {
   "input": [
    [
     4,
     4,
     0,
     0,
     0
    ],
    [
     4,
     4,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     3,
     3
    ],
    [
     5,
     0,
     0,
     0,
     0
    ],
    [
     5,
     5,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     1,
     1,
     0,
     0,
     0
    ],
    [
     1,
     1,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     2,
     2
    ],
    [
     5,
     0,
     0,
     0,
     0
    ],
    [
     5,
     5,
     0,
     0,
     0
    ]
   ]
  },
  {
   "input": [
    [
     0,
     0,
     0,
     6,
     6,
     6,
     0
    ],
    [
     0,
     0,
     0,
     6,
     6,
     6,
     0
    ],
    [
     8,
     8,
     0,
     0,
     6,
     6,
     0
    ],
    [
     8,
     8,
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     7,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     0,
     0,
     0,
     1,
     1,
     1,
     0
    ],
    [
     0,
     0,
     0,
     1,
     1,
     1,
     0
    ],
    [
     8,
     8,
     0,
     0,
     1,
     1,
     0
    ],
    [
     8,
     8,
     0,
     0,
     0,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     2,
     0,
     0
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0,
     0
    ]
   ]
  },
  {
   "input": [
    [
     3,
     3,
     0,
     0,
     0,
     0
    ],
    [
     3,
     3,
     0,
     0,
     0,
     0
    ],
    [
     3,
     3,
     0,
     0,
     9,
     9
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0
    ],
    [
     4,
     4,
     0,
     0,
     0,
     0
    ],
    [
     4,
     4,
     4,
     0,
     0,
     0
    ]
   ],
   "output": [
    [
     1,
     1,
     0,
     0,
     0,
     0
    ],
    [
     1,
     1,
     0,
     0,
     0,
     0
    ],
    [
     1,
     1,
     0,
     0,
     2,
     2
    ],
    [
     0,
     0,
     0,
     0,
     0,
     0
    ],
    [
     4,
     4,
     0,
     0,
     0,
     0
    ],
    [
     4,
     4,
     4,
     0,
     0,
     0
    ]
   ]
  }
 ],
 "test": [
  [
   [
    0,
    0,
    0,
    0,
    5,
    0,
    0
   ],
   [
    7,
    7,
    7,
    0,
    5,
    0,
    0
   ],
   [
    7,
    7,
    7,
    0,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    0,
    0,
    0,
    0
   ],
   [
    0,
    3,
    3,
    0,
    0,
    0,
    0
   ],
   [
    0,
    3,
    3,
    0,
    0,
    0,
    0
   ]
  ],
  [
   [
    6,
    6,
    0,
    0,
    0,
    0
   ],
   [
    6,
    6,
    0,
    0,
    0,
    0
   ],
   [
    0,
    6,
    6,
    0,
    0,
    0
   ],
   [
    0,
    0,
    0,
    8,
    8,
    0
   ],
   [
    9,
    0,
    0,
    0,
    0,
    0
   ],
   [
    9,
    9,
    0,
    0,
    0,
    0
   ]
  ]
 ]
}`,
      "lib/p3.js": `"use strict";
// TODO: implement transform(grid) -> grid for puzzles/p3.json (see README.md)
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
{
  const { transform } = require("./lib/p1.js");
  const { train } = require("./puzzles/p1.json");
  for (const [i, pair] of train.entries()) {
    const copy = JSON.parse(JSON.stringify(pair.input));
    assert.deepEqual(transform(pair.input), pair.output, "p1 train " + i);
    assert.deepEqual(pair.input, copy, "p1 must not mutate its input");
  }
}
{
  const { transform } = require("./lib/p2.js");
  const { train } = require("./puzzles/p2.json");
  for (const [i, pair] of train.entries()) {
    const copy = JSON.parse(JSON.stringify(pair.input));
    assert.deepEqual(transform(pair.input), pair.output, "p2 train " + i);
    assert.deepEqual(pair.input, copy, "p2 must not mutate its input");
  }
}
{
  const { transform } = require("./lib/p3.js");
  const { train } = require("./puzzles/p3.json");
  for (const [i, pair] of train.entries()) {
    const copy = JSON.parse(JSON.stringify(pair.input));
    assert.deepEqual(transform(pair.input), pair.output, "p3 train " + i);
    assert.deepEqual(pair.input, copy, "p3 must not mutate its input");
  }
}
console.log("ok");
`,
    },
    prompt:
      "Three original grid puzzles live in puzzles/ (train pairs plus unseen-graded test inputs); README.md " +
      "has the rules of the game. Infer each puzzle's transformation rule from its train pairs and implement " +
      "lib/p1.js, lib/p2.js, lib/p3.js so `node test.js` passes. Do not change test.js, README.md, or the " +
      "puzzle files. Grading runs your transforms on the held-out test inputs, so the rule itself is what " +
      "counts, not the train outputs. This is an OFFLINE reasoning task: the puzzles exist only in this " +
      "workspace, and web search or fetching is not permitted and cannot help.",
    hidden: [
      {
        name: "p1 generalizes to held-out grids",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { transform } = require("./lib/p1.js");
const { test } = require("./puzzles/p1.json");
const expected = [[[0,0,0,0,0,0],[0,5,5,5,5,0],[0,5,6,6,5,0],[0,5,5,5,5,0],[0,0,0,0,0,0],[0,0,0,0,0,0]],[[0,0,0,0,0,0,0],[0,7,7,7,7,0,0],[0,7,9,9,7,0,0],[0,7,9,9,7,0,0],[0,7,7,7,7,0,0],[0,0,0,0,0,0,0]]];
for (const [i, input] of test.entries()) {
  assert.deepEqual(transform(input), expected[i], "p1 held-out " + i);
}
console.log("ok");`,
      },
      {
        name: "p2 generalizes to held-out grids",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { transform } = require("./lib/p2.js");
const { test } = require("./puzzles/p2.json");
const expected = [[[4,0,0,0,0,6],[0,3,0,0,3,0],[0,0,7,7,0,0],[5,0,0,0,0,5],[8,0,0,0,0,8]],[[3,0,0,0,0,0,3],[0,2,0,0,0,2,0],[0,5,4,0,4,5,0],[7,0,0,0,0,0,7]]];
for (const [i, input] of test.entries()) {
  assert.deepEqual(transform(input), expected[i], "p2 held-out " + i);
}
console.log("ok");`,
      },
      {
        name: "p3 generalizes to held-out grids",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { transform } = require("./lib/p3.js");
const { test } = require("./puzzles/p3.json");
const expected = [[[0,0,0,0,2,0,0],[1,1,1,0,2,0,0],[1,1,1,0,0,0,0],[0,0,0,0,0,0,0],[0,3,3,0,0,0,0],[0,3,3,0,0,0,0]],[[1,1,0,0,0,0],[1,1,0,0,0,0],[0,1,1,0,0,0],[0,0,0,2,2,0],[9,0,0,0,0,0],[9,9,0,0,0,0]]];
for (const [i, input] of test.entries()) {
  assert.deepEqual(transform(input), expected[i], "p3 held-out " + i);
}
console.log("ok");`,
      },
    ],
    reference: {
      "lib/p1.js": `"use strict";
function transform(grid) {
  const H = grid.length, W = grid[0].length;
  const counts = new Map();
  for (const row of grid) for (const v of row) if (v !== 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  let frameColor = null, loneColor = null;
  for (const [color, n] of counts) {
    if (n === 1) loneColor = color; else frameColor = color;
  }
  let top = H, left = W, bottom = -1, right = -1;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (grid[r][c] === frameColor) {
      if (r < top) top = r;
      if (r > bottom) bottom = r;
      if (c < left) left = c;
      if (c > right) right = c;
    }
  }
  const out = grid.map((row) => row.slice());
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (out[r][c] === loneColor) out[r][c] = 0;
  for (let r = top + 1; r < bottom; r++) for (let c = left + 1; c < right; c++) out[r][c] = loneColor;
  return out;
}

// p2 mirror-fill: empty cells take the value of their left-right mirror cell;
// occupied cells keep their own value.

module.exports = { transform };
`,
      "lib/p2.js": `"use strict";
function transform(grid) {
  const W = grid[0].length;
  return grid.map((row) => row.map((v, c) => (v !== 0 ? v : row[W - 1 - c])));
}

// p3 size-rank recolor: exactly three 4-connected components of nonzero
// cells, all different sizes. Largest becomes 1, smallest becomes 2, the
// middle one keeps its color.

module.exports = { transform };
`,
      "lib/p3.js": `"use strict";
function transform(grid) {
  const H = grid.length, W = grid[0].length;
  const seen = grid.map((row) => row.map(() => false));
  const comps = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (grid[r][c] === 0 || seen[r][c]) continue;
    const cells = [];
    const stack = [[r, c]];
    seen[r][c] = true;
    while (stack.length) {
      const [cr, cc] = stack.pop();
      cells.push([cr, cc]);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        if (grid[nr][nc] === 0 || seen[nr][nc]) continue;
        seen[nr][nc] = true;
        stack.push([nr, nc]);
      }
    }
    comps.push(cells);
  }
  comps.sort((a, b) => a.length - b.length);
  const out = grid.map((row) => row.slice());
  for (const [r, c] of comps[comps.length - 1]) out[r][c] = 1;
  for (const [r, c] of comps[0]) out[r][c] = 2;
  return out;
}

module.exports = { transform };
`,
    },
  },

  // ── model-controlled micro-hard tasks ─────────────────────────────────────
  {
    name: "patch-atomic",
    brief: "small JSON-patch engine; pointer escaping, arrays, and atomic failure",
    tier: "hard",
    split: "train",
    par: { wallS: 180, tokensK: 120 },
    files: {
      "patch.js": `"use strict";

class PatchError extends Error {
  constructor(index, message) {
    super(message);
    this.name = "PatchError";
    this.index = index;
  }
}

// TODO: implement applyPatch(document, operations).
// Contract:
// - JSON-shaped inputs only. Return a deep-cloned result and never mutate the
//   input document, operation objects, or operation values.
// - Apply operations sequentially. Support add, replace, and remove.
// - Paths are RFC 6901 JSON pointers: "" names the root; segments decode ~1
//   to / and ~0 to ~. Any other ~ escape is invalid.
// - Object add may create or overwrite a key. Object replace/remove require an
//   existing own key.
// - Array paths use canonical non-negative integer indexes (no leading zero,
//   except "0"). add inserts at 0..length and also accepts "-" to append;
//   replace/remove require 0..length-1. "-" is invalid outside array add.
// - Root add/replace replaces the whole document. Root remove is invalid.
// - The first invalid operation throws PatchError with .index equal to the
//   zero-based operation index. Because the input is immutable, failure is
//   atomic from the caller's perspective.
module.exports = { PatchError };
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { applyPatch, PatchError } = require("./patch.js");

const input = { user: { name: "Ada", tags: ["math", "code"] } };
const output = applyPatch(input, [
  { op: "replace", path: "/user/name", value: "Grace" },
  { op: "add", path: "/user/tags/1", value: "navy" },
  { op: "remove", path: "/user/tags/0" },
]);
assert.deepEqual(output, { user: { name: "Grace", tags: ["navy", "code"] } });
assert.deepEqual(input, { user: { name: "Ada", tags: ["math", "code"] } });
assert.throws(
  () => applyPatch(input, [{ op: "remove", path: "/missing" }]),
  (error) => error instanceof PatchError && error.index === 0,
);
console.log("ok");
`,
    },
    prompt:
      "Implement applyPatch in patch.js so `node test.js` passes. Every bullet in the documented contract is graded, " +
      "including pointer escaping, canonical array indexes, root replacement, immutability, and failure metadata. " +
      "Do not change test.js or weaken PatchError.",
    hidden: [
      {
        name: "pointer escapes and root replacement",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { applyPatch } = require("./patch.js");
const source = { "a/b": { "m~n": 1 } };
assert.deepEqual(
  applyPatch(source, [{ op: "replace", path: "/a~1b/m~0n", value: 2 }]),
  { "a/b": { "m~n": 2 } },
);
assert.deepEqual(applyPatch(source, [{ op: "add", path: "", value: [1, 2] }]), [1, 2]);
assert.deepEqual(source, { "a/b": { "m~n": 1 } });
console.log("ok");`,
      },
      {
        name: "arrays, cloning, and indexed failures",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { applyPatch, PatchError } = require("./patch.js");
const value = { deep: [1] };
const ops = [{ op: "add", path: "/-", value }];
const result = applyPatch([], ops);
value.deep.push(2);
assert.deepEqual(result, [{ deep: [1] }]);
assert.deepEqual(ops, [{ op: "add", path: "/-", value: { deep: [1, 2] } }]);
for (const path of ["/01", "/2", "/~2bad"]) {
  assert.throws(
    () => applyPatch(["x"], [{ op: "add", path: "/-", value: "y" }, { op: "replace", path, value: "z" }]),
    (error) => error instanceof PatchError && error.index === 1,
  );
}
assert.throws(
  () => applyPatch({ a: 1 }, [{ op: "remove", path: "" }]),
  (error) => error instanceof PatchError && error.index === 0,
);
console.log("ok");`,
      },
    ],
    extraChecks(dir) {
      return [{
        name: "test.js untouched",
        pass: (readFile(dir, "test.js") ?? "").includes("error.index === 0"),
        weight: 1,
      }];
    },
    reference: {
      "patch.js": `"use strict";

class PatchError extends Error {
  constructor(index, message) {
    super(message);
    this.name = "PatchError";
    this.index = index;
  }
}

const clone = (value) => structuredClone(value);

function tokens(path) {
  if (path === "") return [];
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("invalid pointer");
  return path.slice(1).split("/").map((raw) => {
    if (/~(?![01])/u.test(raw)) throw new Error("invalid pointer escape");
    return raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
  });
}

function arrayIndex(token, length, allowEnd) {
  if (!/^(0|[1-9]\\d*)$/u.test(token)) throw new Error("invalid array index");
  const index = Number(token);
  if (index < 0 || index > length || (!allowEnd && index === length)) {
    throw new Error("array index out of bounds");
  }
  return index;
}

function applyPatch(document, operations) {
  let output = clone(document);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    try {
      if (!operation || !["add", "replace", "remove"].includes(operation.op)) {
        throw new Error("unsupported operation");
      }
      const parts = tokens(operation.path);
      if (parts.length === 0) {
        if (operation.op === "remove") throw new Error("cannot remove root");
        output = clone(operation.value);
        continue;
      }
      let parent = output;
      for (const part of parts.slice(0, -1)) {
        if (parent === null || typeof parent !== "object") throw new Error("missing parent");
        if (Array.isArray(parent)) {
          parent = parent[arrayIndex(part, parent.length, false)];
        } else {
          if (!Object.hasOwn(parent, part)) throw new Error("missing parent");
          parent = parent[part];
        }
      }
      if (parent === null || typeof parent !== "object") throw new Error("missing parent");
      const key = parts.at(-1);
      if (Array.isArray(parent)) {
        if (operation.op === "add") {
          const at = key === "-" ? parent.length : arrayIndex(key, parent.length, true);
          parent.splice(at, 0, clone(operation.value));
        } else {
          if (key === "-") throw new Error("invalid array index");
          const at = arrayIndex(key, parent.length, false);
          if (operation.op === "replace") parent[at] = clone(operation.value);
          else parent.splice(at, 1);
        }
      } else if (operation.op === "add") {
        parent[key] = clone(operation.value);
      } else {
        if (!Object.hasOwn(parent, key)) throw new Error("missing key");
        if (operation.op === "replace") parent[key] = clone(operation.value);
        else delete parent[key];
      }
    } catch (error) {
      throw new PatchError(index, error instanceof Error ? error.message : String(error));
    }
  }
  return output;
}

module.exports = { applyPatch, PatchError };
`,
    },
  },

  {
    name: "stable-dag",
    brief: "stable dependency planner with missing and cyclic work",
    tier: "hard",
    split: "train",
    par: { wallS: 150, tokensK: 90 },
    files: {
      "planner.js": `"use strict";

// TODO: implement plan(jobs) -> { order, unresolved }.
// Each job is { id: string, after?: string[] }.
// Contract:
// - Inputs are not mutated. Empty input returns two empty arrays.
// - ids must be non-empty and unique; invalid ids or duplicate ids throw.
// - A job is ready only after every listed dependency was emitted.
// - Repeated dependency names count once. A job may not depend on itself.
// - At each step emit the ready job that appeared earliest in the input. This
//   makes the topological order deterministic without alphabetic sorting.
// - Stop when no job is ready. unresolved contains every un-emitted id in
//   original input order: cycles, jobs with missing dependencies, and anything
//   transitively waiting on either condition.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { plan } = require("./planner.js");

assert.deepEqual(plan([
  { id: "ship", after: ["test", "build"] },
  { id: "lint" },
  { id: "build", after: ["lint"] },
  { id: "test", after: ["build"] },
]), { order: ["lint", "build", "test", "ship"], unresolved: [] });

assert.deepEqual(plan([
  { id: "a", after: ["b"] },
  { id: "b", after: ["a"] },
  { id: "c", after: ["missing"] },
]), { order: [], unresolved: ["a", "b", "c"] });
console.log("ok");
`,
    },
    prompt:
      "Implement plan in planner.js so `node test.js` passes. Honor every documented invariant, especially " +
      "original-order tie breaking and transitive unresolved work. Do not change test.js.",
    hidden: [
      {
        name: "stable ready-order and repeated dependencies",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { plan } = require("./planner.js");
const jobs = [
  { id: "late", after: ["root", "root"] },
  { id: "first" },
  { id: "root" },
  { id: "second" },
  { id: "tail", after: ["late"] },
];
const snapshot = structuredClone(jobs);
assert.deepEqual(plan(jobs), {
  order: ["first", "root", "late", "second", "tail"],
  unresolved: [],
});
assert.deepEqual(jobs, snapshot);
assert.deepEqual(plan([]), { order: [], unresolved: [] });
console.log("ok");`,
      },
      {
        name: "invalid ids and transitive unresolved work",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { plan } = require("./planner.js");
assert.throws(() => plan([{ id: "x" }, { id: "x" }]));
assert.throws(() => plan([{ id: "" }]));
assert.throws(() => plan([{ id: "x", after: ["x"] }]));
assert.deepEqual(plan([
  { id: "ok" },
  { id: "missing", after: ["ghost"] },
  { id: "downstream", after: ["missing"] },
  { id: "cycle-a", after: ["cycle-b"] },
  { id: "cycle-b", after: ["cycle-a"] },
  { id: "after-cycle", after: ["cycle-a"] },
]), {
  order: ["ok"],
  unresolved: ["missing", "downstream", "cycle-a", "cycle-b", "after-cycle"],
});
console.log("ok");`,
      },
    ],
    reference: {
      "planner.js": `"use strict";

function plan(jobs) {
  const ids = new Set();
  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || !job.id) throw new Error("invalid job id");
    if (ids.has(job.id)) throw new Error("duplicate job id");
    ids.add(job.id);
  }
  const normalized = jobs.map((job) => {
    const after = [...new Set(job.after ?? [])];
    if (after.includes(job.id)) throw new Error("self dependency");
    return { id: job.id, after };
  });
  const emitted = new Set();
  const order = [];
  for (;;) {
    const ready = normalized.find(
      (job) => !emitted.has(job.id) && job.after.every((dependency) => emitted.has(dependency)),
    );
    if (!ready) break;
    emitted.add(ready.id);
    order.push(ready.id);
  }
  return {
    order,
    unresolved: normalized.filter((job) => !emitted.has(job.id)).map((job) => job.id),
  };
}

module.exports = { plan };
`,
    },
  },

  {
    name: "async-pool",
    brief: "bounded async map with ordered output and fail-fast scheduling",
    tier: "hard",
    split: "train",
    par: { wallS: 180, tokensK: 100 },
    files: {
      "pool.js": `"use strict";

// TODO: implement async mapPool(values, limit, worker).
// Contract:
// - limit must be a positive integer; otherwise reject with RangeError.
// - Call worker(value, index) exactly once for each started item and run no more
//   than limit workers concurrently.
// - Resolve to results in INPUT order, regardless of completion order. Empty
//   input resolves to []. Inputs are not mutated.
// - A synchronous throw and a rejected worker promise are equivalent.
// - After the first observed failure, start no additional items. Let workers
//   already in flight settle, then reject with that exact first error object.
// - The function must not leak unhandled rejections from in-flight workers.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { mapPool } = require("./pool.js");

(async () => {
  let active = 0;
  let peak = 0;
  const result = await mapPool([30, 5, 15, 1], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index * 10;
  });
  assert.deepEqual(result, [0, 10, 20, 30]);
  assert.equal(peak, 2);
  console.log("ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
    },
    prompt:
      "Implement mapPool in pool.js so `node test.js` passes. Every concurrency and error-handling bullet in " +
      "the documented contract is graded. Do not change test.js.",
    hidden: [
      {
        name: "failure stops new starts and drains in-flight work",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { mapPool } = require("./pool.js");
(async () => {
  const boom = new Error("boom");
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = mapPool([0, 1, 2, 3], 2, async (_value, index) => {
    started.push(index);
    if (index === 0) { await gate; return "done"; }
    if (index === 1) throw boom;
    return "should not start";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  let settled = false;
  pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "must wait for the in-flight worker");
  release();
  await assert.rejects(pending, (error) => error === boom);
  assert.deepEqual(started, [0, 1]);
  console.log("ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });`,
      },
      {
        name: "empty, invalid limit, and synchronous throw",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { mapPool } = require("./pool.js");
(async () => {
  assert.deepEqual(await mapPool([], 3, () => 1), []);
  for (const limit of [0, -1, 1.5, NaN]) {
    await assert.rejects(mapPool([1], limit, () => 1), RangeError);
  }
  const exact = new Error("sync");
  const values = [1, 2, 3];
  await assert.rejects(
    mapPool(values, 1, () => { throw exact; }),
    (error) => error === exact,
  );
  assert.deepEqual(values, [1, 2, 3]);
  console.log("ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });`,
      },
    ],
    reference: {
      "pool.js": `"use strict";

async function mapPool(values, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const input = [...values];
  if (input.length === 0) return [];
  return new Promise((resolve, reject) => {
    const results = new Array(input.length);
    let next = 0;
    let active = 0;
    let stopped = false;
    let firstError;

    const launch = () => {
      while (!stopped && active < limit && next < input.length) {
        const index = next++;
        active += 1;
        Promise.resolve()
          .then(() => worker(input[index], index))
          .then(
            (value) => { results[index] = value; },
            (error) => {
              if (!stopped) {
                stopped = true;
                firstError = error;
              }
            },
          )
          .finally(() => {
            active -= 1;
            if (stopped) {
              if (active === 0) reject(firstError);
              return;
            }
            if (next === input.length && active === 0) resolve(results);
            else launch();
          });
      }
    };
    launch();
  });
}

module.exports = { mapPool };
`,
    },
  },

  // ── holdout ────────────────────────────────────────────────────────────────
  {
    name: "holdout-sort-bug",
    brief: "holdout: classic default-sort bug; one-line fix",
    tier: "trivial",
    split: "holdout",
    par: { wallS: 60, tokensK: 15 },
    files: {
      "median.js": `"use strict";
// median(values) -> the middle value of the sorted numbers (mean of the two
// middles for even counts). Must not mutate the input.
function median(values) {
  const sorted = [...values].sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
module.exports = { median };
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { median } = require("./median.js");
assert.equal(median([10, 2, 33]), 10);
assert.equal(median([1, 2, 3, 4]), 2.5);
console.log("ok");
`,
    },
    prompt:
      "The test in test.js fails. Fix median.js so it matches its documented contract and `node test.js` passes. " +
      "Do not change test.js. The full documented contract is graded.",
    hidden: [
      {
        name: "numeric sort and no mutation",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { median } = require("./median.js");
assert.equal(median([9, 80, 7]), 9);
assert.equal(median([-5, 10, 0, 3]), 1.5);
const input = [3, 1, 2];
median(input);
assert.deepEqual(input, [3, 1, 2]);
console.log("ok");`,
      },
    ],
    reference: {
      "median.js": `"use strict";
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
module.exports = { median };
`,
    },
  },

  {
    name: "holdout-parallel",
    brief: "holdout: three independent modules; measures fan-out",
    tier: "standard",
    split: "holdout",
    parallel: true,
    expectedParallel: 3,
    par: { wallS: 150, tokensK: 35 },
    files: {
      "lib/pad.js": `"use strict";
// TODO: implement padLeft(text, length, fill) -> text left-padded with the
// single-character \`fill\` to \`length\`. Text already >= length is returned
// unchanged. Export it.
module.exports = {};
`,
      "lib/range.js": `"use strict";
// TODO: implement range(start, end, step = 1) -> array of numbers from start
// (inclusive) to end (EXCLUSIVE) advancing by step. start >= end yields [].
// Export it.
module.exports = {};
`,
      "lib/unique-sorted.js": `"use strict";
// TODO: implement uniqueSorted(numbers) -> new array, duplicates removed,
// ascending NUMERIC order. Export it.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { padLeft } = require("./lib/pad.js");
const { range } = require("./lib/range.js");
const { uniqueSorted } = require("./lib/unique-sorted.js");
assert.equal(padLeft("7", 3, "0"), "007");
assert.deepEqual(range(0, 4), [0, 1, 2, 3]);
assert.deepEqual(uniqueSorted([3, 1, 3, 2]), [1, 2, 3]);
console.log("ok");
`,
    },
    prompt:
      "Implement the three TODO modules in lib/ (pad.js, range.js, unique-sorted.js) so `node test.js` passes. " +
      "Each module's full documented contract is graded, not just test.js.",
    hidden: [
      {
        name: "pad and range boundary cases",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { padLeft } = require("./lib/pad.js");
const { range } = require("./lib/range.js");
assert.equal(padLeft("hello", 3, "x"), "hello");
assert.deepEqual(range(1, 8, 3), [1, 4, 7]);
assert.deepEqual(range(5, 5), []);
assert.deepEqual(range(6, 2), []);
console.log("ok");`,
      },
      {
        name: "uniqueSorted numeric order",
        weight: 2,
        source: `const assert = require("node:assert/strict");
const { uniqueSorted } = require("./lib/unique-sorted.js");
assert.deepEqual(uniqueSorted([100, 20, 3, 20]), [3, 20, 100]);
assert.deepEqual(uniqueSorted([]), []);
console.log("ok");`,
      },
    ],
    reference: {
      "lib/pad.js": `"use strict";
function padLeft(text, length, fill) {
  return text.length >= length ? text : fill.repeat(length - text.length) + text;
}
module.exports = { padLeft };
`,
      "lib/range.js": `"use strict";
function range(start, end, step = 1) {
  const out = [];
  for (let v = start; v < end; v += step) out.push(v);
  return out;
}
module.exports = { range };
`,
      "lib/unique-sorted.js": `"use strict";
function uniqueSorted(numbers) {
  return [...new Set(numbers)].sort((a, b) => a - b);
}
module.exports = { uniqueSorted };
`,
    },
  },

  {
    name: "holdout-lru",
    brief: "holdout: subtle LRU+TTL invariants; should route to claude-fable-5",
    tier: "hard",
    split: "holdout",
    par: { wallS: 300, tokensK: 60 },
    files: {
      "lru.js": `"use strict";
// TODO: implement createCache(capacity, ttlMs, now) -> { get, set, size }.
// Invariants (all of them, exactly):
// - capacity is at least 1, and now() is stable within a single call; inputs
//   outside that envelope are out of scope.
// - get(key) returns the value and makes key the MOST recently used.
// - set(key, value) inserts or updates; updating also refreshes recency AND ttl.
// - When size would exceed capacity, evict the LEAST recently USED entry
//   (usage = get or set, never insertion order alone).
// - An entry older than ttlMs (by the injected now() clock) is expired: get
//   returns undefined, the entry no longer counts toward size, and an expired
//   entry must NOT be the one "evicted" when capacity is hit (it is already
//   gone; the real LRU survivor set decides).
// - size() never counts expired entries.
module.exports = {};
`,
      "test.js": `"use strict";
const assert = require("node:assert/strict");
const { createCache } = require("./lru.js");
let t = 0;
const now = () => t;
{
  const c = createCache(2, 100, now);
  c.set("a", 1); c.set("b", 2);
  assert.equal(c.get("a"), 1);
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
}
console.log("ok");
`,
    },
    prompt:
      "Implement lru.js so `node test.js` passes. Read the invariants carefully: this is subtle correctness work " +
      "where almost-right implementations (insertion-order eviction, eager expiry sweeps, stale-entry eviction) " +
      "pass casual tests but violate the stated invariants. EVERY stated invariant is graded, including behavior " +
      "test.js does not exercise. Treat it with the scrutiny subtle work deserves.",
    hidden: [
      {
        name: "expired entries vanish from size and eviction",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { createCache } = require("./lru.js");
let t = 0;
const now = () => t;
const c = createCache(2, 100, now);
c.set("a", 1);
t = 50; c.set("b", 2);
t = 120;
assert.equal(c.get("a"), undefined);
assert.equal(c.size(), 1);
c.set("d", 4);
assert.equal(c.get("b"), 2);
assert.equal(c.get("d"), 4);
console.log("ok");`,
      },
      {
        name: "set refreshes ttl, get does not",
        weight: 3,
        source: `const assert = require("node:assert/strict");
const { createCache } = require("./lru.js");
let t = 0;
const now = () => t;
const c = createCache(2, 100, now);
c.set("a", 1);
t = 90; c.set("a", 9);
t = 150;
assert.equal(c.get("a"), 9);
t = 200;
assert.equal(c.get("a"), undefined);
console.log("ok");`,
      },
    ],
    extraChecks(dir, metrics) {
      const models = metrics?.models ?? [];
      return [
        {
          name: "routed to claude-fable-5 (premium tier for subtle invariants)",
          pass: models.includes("claude-fable-5"),
          weight: 2,
          detail: models.join(", ") || "no models recorded",
        },
      ];
    },
    reference: {
      "lru.js": `"use strict";
function createCache(capacity, ttlMs, now) {
  const entries = new Map();
  const sweep = () => {
    for (const [key, entry] of entries) if (now() - entry.at > ttlMs) entries.delete(key);
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) { entries.delete(key); return undefined; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      sweep();
      entries.delete(key);
      entries.set(key, { value, at: now() });
      if (entries.size > capacity) entries.delete(entries.keys().next().value);
    },
    size() { sweep(); return entries.size; },
  };
}
module.exports = { createCache };
`,
    },
  },
];

function readFile(dir, file) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    return fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    return null;
  }
}

module.exports = { TASKS, TIER_CAP_MS, readFile };
