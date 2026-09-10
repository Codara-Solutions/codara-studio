#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");
const result = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../src/renderer/src/components/file-preview/csv.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const shim = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(shim, shim.exports);
const { parseCsv, replaceCsvCell, resolveCsv, compareCsvCells, csvColumnLabel, isCsvPath, CSV_ROW_LIMIT } = shim.exports;

for (const name of ["file.csv", "file.CSV", "file.tsv", "file.psv", "ssh://host/path/data.csv"]) assert.ok(isCsvPath(name));
for (const name of ["file.csv.txt", "file.xlsx", "filecsv"]) assert.ok(!isCsvPath(name));
assert.deepEqual(parseCsv('\uFEFFname,notes,id\r\nAda,"hello, world",00123\r\nBen,"line 1\nline 2; with ""quotes""",9007199254740993\r\n', ",").rows, [
  ["name", "notes", "id"], ["Ada", "hello, world", "00123"],
  ["Ben", 'line 1\nline 2; with "quotes"', "9007199254740993"],
]);
assert.deepEqual(parseCsv('a,b\r1,2\r\r3,4', ",").rows, [["a", "b"], ["1", "2"], ["3", "4"]]);
assert.deepEqual(parseCsv('a,b,\n,,\n"",,""\n\n', ",").rows, [["a", "b", ""], ["", "", ""], ["", "", ""]]);
assert.deepEqual(parseCsv('""\n \n', ",").rows, [[""], [" "]]);
assert.deepEqual(parseCsv('', ",").rows, []);
assert.deepEqual(parseCsv('\uFEFF', ",").rows, []);
assert.deepEqual(parseCsv(' 001 ,=SUM(A1:A2),<script>alert(1)</script>,2026-09-11', ",").rows[0], [" 001 ", "=SUM(A1:A2)", "<script>alert(1)</script>", "2026-09-11"]);
assert.ok(parseCsv('name,note\na,"unclosed', ",").malformed);
assert.ok(parseCsv('a,"b"oops', ",").malformed);
assert.ok(parseCsv('ab"cd,e', ",").malformed);
assert.ok(!parseCsv('a,"b"', ",").malformed);
for (const delimiter of [",", ";", "\t", "|"]) {
  const text = `name${delimiter}value\nAda${delimiter}10\nBen${delimiter}20`;
  assert.equal(resolveCsv(text, "file.csv", "auto").delimiter, delimiter);
  assert.equal(resolveCsv(text, "file.csv", delimiter).rows[1][1], "10");
}
assert.equal(resolveCsv('name;revenue;cost\nA;1,20;0,60\nB;2,30;1,40', "file.csv", "auto").delimiter, ";");
assert.equal(resolveCsv('name;notes\nA;"one,two,three,four"\nB;"five,six,seven,eight"', "file.csv", "auto").delimiter, ";");
assert.equal(resolveCsv('only one column', "file.tsv", "auto").delimiter, "\t");
assert.deepEqual(resolveCsv('\uFEFFsep=;\r\na;b\r\n1;2', "file.csv", "auto").rows, [["a", "b"], ["1", "2"]]);
assert.equal(resolveCsv('a;b\n1;2', "file.csv", ",").sourceColumns, 1);
const limited = parseCsv('a,b,c\n1,2,3\n4,"5\n6",7\n8,9,10', ",", 2, 2);
assert.deepEqual(limited.rows, [["a", "b"], ["1", "2"]]);
assert.equal(limited.sourceRows, 4);
assert.equal(limited.sourceColumns, 3);
assert.ok(limited.truncated);
assert.equal(parseCsv(Array.from({ length: 100 }, () => 'a,b').join('\n'), ",", 32, 200, true).rows.length, 32);
const large = resolveCsv('id,note\n' + Array.from({ length: CSV_ROW_LIMIT + 20 }, (_, i) => `${i},"a,b"`).join('\n'), 'large.csv', 'auto');
assert.equal(large.sourceRows, CSV_ROW_LIMIT + 21);
assert.equal(large.rows.length, CSV_ROW_LIMIT + 1);
assert.ok(large.truncated);
assert.deepEqual(['10', '2', '-1.5', '0.2', '1e2'].sort(compareCsvCells), ['-1.5', '0.2', '2', '10', '1e2']);
assert.ok(compareCsvCells('9007199254740992', '9007199254740993') < 0);
assert.ok(compareCsvCells('', 'a') > 0);
assert.equal(csvColumnLabel(0), 'A');
assert.equal(csvColumnLabel(25), 'Z');
assert.equal(csvColumnLabel(26), 'AA');
assert.equal(csvColumnLabel(199), 'GR');
console.log('PASS CSV parsing, separator detection, value preservation, preview limits, and numeric sorting');

const original = '\uFEFFsep=;\r\nname;notes;id\r\n\r\n"Ada";"old; note";00123\r\nBen;plain;9007199254740993\r\n';
const parsedOriginal = resolveCsv(original, 'file.csv', 'auto');
const edited = replaceCsvCell(original, parsedOriginal, 1, 1, 'new; note\nwith "quotes"');
assert.equal(edited, original.replace('"old; note"', '"new; note\nwith ""quotes"""'));
assert.equal(replaceCsvCell(original, parsedOriginal, 1, 0, 'Ada'), original);
assert.equal(replaceCsvCell(original, parsedOriginal, 2, 0, ''), original.replace('Ben;plain', '"";plain'));
const ragged = 'a,b,c\n1\n2,3,4';
assert.equal(replaceCsvCell(ragged, resolveCsv(ragged, 'file.csv', ','), 1, 2, 'last'), 'a,b,c\n1,,last\n2,3,4');
const single = 'header\nvalue';
assert.equal(replaceCsvCell(single, resolveCsv(single, 'file.csv', ','), 1, 0, ''), 'header\n""');
for (const separator of [',', ';', '\t', '|']) {
  const initial = 'a' + separator + 'b\n1' + separator + '2';
  const next = replaceCsvCell(initial, resolveCsv(initial, 'file.csv', separator), 1, 1, ' =hello\n"world" ');
  assert.equal(resolveCsv(next, 'file.csv', separator).rows[1][1], ' =hello\n"world" ');
}
assert.throws(() => replaceCsvCell('a,"broken', resolveCsv('a,"broken', 'file.csv', ','), 0, 0, 'x'));
console.log('PASS cell edits preserve all untouched source bytes, encode special values, extend ragged rows, and reject malformed CSV');

const singleWithSeparator = replaceCsvCell(single, resolveCsv(single, 'file.csv', 'auto'), 1, 0, 'still;one|cell');
assert.deepEqual(resolveCsv(singleWithSeparator, 'file.csv', 'auto').rows, [['header'], ['still;one|cell']]);
