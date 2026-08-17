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
