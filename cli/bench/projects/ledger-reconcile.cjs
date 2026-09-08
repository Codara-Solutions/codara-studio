"use strict";

const contract = `# Revision ledger reconciliation

Implement csv.js, ledger.js, and cli.js using Node.js built-ins only. Do not
change README.md or test.js. Every rule below is graded.

## CSV interface

csv.js exports parseCsv(text), returning arrays of string fields. The input is
a string. Strip a single leading UTF-8 BOM. Support comma separators, LF and
CRLF record endings, quoted fields with embedded commas and newlines, and
escaped double quotes represented by two double quotes inside a quoted field.
Preserve field text exactly, including whitespace and embedded line endings.
A quote may open only at the start of a field. After its closing quote only a
comma, record ending, or EOF is allowed. Bare quotes in unquoted fields,
unclosed quotes, and lone CR outside quotes throw SyntaxError.
Empty input returns []. A final record ending does not add an extra empty row;
an actual blank record still returns [""]. Empty final fields are preserved.

## Reconciliation interface

ledger.js exports LedgerError (an Error subclass) and reconcile(csvText).
The exact header, in order, is id,revision,account,currency,amount,status,note.
Parse the entire CSV before validating its header and data rows. Every data row
has seven fields. Validate ALL rows, including superseded ones:
- id and account must contain at least one non-whitespace character. Preserve
  their spelling, including whitespace. note is any string.
- revision is canonical decimal text from 1 through 2147483647, no leading zero.
- currency is exactly three uppercase ASCII letters.
- amount is an optional minus, a canonical integer part (0 or a nonzero digit
  followed by digits), a decimal point, and exactly two decimal digits. No
  exponent, plus, whitespace, or leading zeros. There is no magnitude limit.
- status is exactly posted or void. Voided rows still require valid amounts.

Each (id, revision) identifies a version. Fully identical duplicate records
are ignored for selection and increment counts.duplicates, including obsolete
versions. Two different records with the same id and revision are a CONFLICT,
even if a newer revision exists. Validate and detect conflicts in input order:
the first invalid or conflicting row is the error. For each id, select its
highest revision, independent of input order. A winning void record suppresses
that id and increments counts.voided. Older posted rows must not resurrect it.

Return exactly {entries, balances, counts}. entries contains winning posted
records as {id, revision, account, currency, cents, note}, sorted by id using
JavaScript code-unit string order. revision is a number; cents is an exact
signed base-10 INTEGER STRING with no leading zeros (negative zero becomes 0).
balances sums cents by the exact (account,currency) pair, includes zero totals,
and returns {account,currency,cents} sorted by account then currency using the
same string ordering. counts is {rows,duplicates,voided}; rows counts all data
records before deduplication. Use arbitrary-precision integer arithmetic.
Repeated calls are independent. Do not write files from reconcile.

Malformed CSV throws LedgerError with code CSV and row null. An incorrect or
missing header throws code HEADER and row 1. Invalid data throws code ROW;
conflicting versions throw code CONFLICT. For ROW/CONFLICT, row is the logical
CSV record number (header is 1), not the physical line number. LedgerError must
have those public code and row properties; its message text is unconstrained.

## CLI interface

node cli.js FILE reads one UTF-8 file and writes exactly one compact JSON result
and a newline to stdout, exit 0. It must not modify the input or create files.
On failure stdout is empty, exit 2, and stderr is exactly one compact JSON line
{error:{code,row}}. Forward LedgerError fields. A read failure uses READ/null;
anything other than exactly one file argument uses USAGE/null.
Importing cli.js must not execute the CLI. No packages, network, or subprocesses
from the implementation are needed. Run node test.js to check the visible case.
`;

const visible = String.raw`"use strict";
const assert = require("node:assert/strict");
const { parseCsv } = require("./csv.js");
const { reconcile } = require("./ledger.js");
assert.deepEqual(parseCsv('a,"b,c"\n1,"two"\n'), [["a", "b,c"], ["1", "two"]]);
const header = "id,revision,account,currency,amount,status,note\n";
assert.deepEqual(reconcile(header + "b,1,cash,USD,1.25,posted,old\na,1,cash,USD,2.00,posted,ok\nb,2,cash,USD,1.50,posted,new\n"), {
  entries: [
    { id: "a", revision: 1, account: "cash", currency: "USD", cents: "200", note: "ok" },
    { id: "b", revision: 2, account: "cash", currency: "USD", cents: "150", note: "new" },
  ],
  balances: [{ account: "cash", currency: "USD", cents: "350" }],
  counts: { rows: 3, duplicates: 0, voided: 0 },
});
console.log("ok");
`;

const reference = {
  "csv.js": String.raw`"use strict";
function parseCsv(text) {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (!text.length) return [];
  const rows = [];
  let row = [], field = "", state = "start", recordEnded = false;
  const flushField = () => { row.push(field); field = ""; state = "start"; };
  const flushRow = () => { flushField(); rows.push(row); row = []; recordEnded = true; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    recordEnded = false;
    if (state === "quoted") {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else state = "closed";
      continue;
    }
    if (ch === ",") { flushField(); continue; }
    if (ch === "\n") { flushRow(); continue; }
    if (ch === "\r") {
      if (text[i + 1] !== "\n") throw new SyntaxError("bare CR");
      i++; flushRow(); continue;
    }
    if (state === "closed") throw new SyntaxError("text after quote");
    if (ch === '"') {
      if (state !== "start") throw new SyntaxError("bare quote");
      state = "quoted";
    } else { field += ch; state = "plain"; }
  }
  if (state === "quoted") throw new SyntaxError("unclosed quote");
  if (!recordEnded) flushRow();
  return rows;
}
module.exports = { parseCsv };
`,
  "ledger.js": String.raw`"use strict";
const { parseCsv } = require("./csv.js");
class LedgerError extends Error {
  constructor(code, row) { super(code); this.code = code; this.row = row; }
}
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function reconcile(text) {
  let rows;
  try { rows = parseCsv(text); } catch { throw new LedgerError("CSV", null); }
  const header = ["id", "revision", "account", "currency", "amount", "status", "note"];
  if (!rows.length || rows[0].length !== header.length || header.some((name, i) => name !== rows[0][i])) throw new LedgerError("HEADER", 1);
  const versions = new Map(), latest = new Map();
  let duplicates = 0, voided = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const [id, rev, account, currency, amount, status, note] = row;
    if (row.length !== 7 || !id.trim() || !account.trim() || !/^[1-9]\d*$/.test(rev) || BigInt(rev) > 2147483647n || !/^[A-Z]{3}$/.test(currency) || !/^-?(0|[1-9]\d*)\.\d{2}$/.test(amount) || !["posted", "void"].includes(status)) throw new LedgerError("ROW", i + 1);
    let seen = versions.get(id);
    if (!seen) versions.set(id, seen = new Map());
    if (seen.has(rev)) {
      if (JSON.stringify(seen.get(rev)) !== JSON.stringify(row)) throw new LedgerError("CONFLICT", i + 1);
      duplicates++;
      continue;
    }
    seen.set(rev, row);
    const entry = { id, revision: Number(rev), account, currency, cents: BigInt(amount.replace(".", "")).toString(), note, status };
    if (!latest.has(id) || latest.get(id).revision < entry.revision) latest.set(id, entry);
  }
  const entries = [], totals = new Map();
  for (const row of latest.values()) {
    if (row.status === "void") { voided++; continue; }
    const { status, ...entry } = row;
    entries.push(entry);
    let account = totals.get(entry.account);
    if (!account) totals.set(entry.account, account = new Map());
    account.set(entry.currency, (account.get(entry.currency) ?? 0n) + BigInt(entry.cents));
  }
  entries.sort((a, b) => cmp(a.id, b.id));
  const balances = [];
  for (const [account, currencies] of totals) for (const [currency, cents] of currencies) balances.push({ account, currency, cents: cents.toString() });
  balances.sort((a, b) => cmp(a.account, b.account) || cmp(a.currency, b.currency));
  return { entries, balances, counts: { rows: rows.length - 1, duplicates, voided } };
}
module.exports = { LedgerError, reconcile };
`,
  "cli.js": String.raw`"use strict";
const fs = require("node:fs");
const { LedgerError, reconcile } = require("./ledger.js");
function main(args) {
  try {
    if (args.length !== 1) throw new LedgerError("USAGE", null);
    let text;
    try { text = fs.readFileSync(args[0], "utf8"); } catch { throw new LedgerError("READ", null); }
    process.stdout.write(JSON.stringify(reconcile(text)) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: error.code, row: error.row } }) + "\n");
    process.exitCode = 2;
  }
}
if (require.main === module) main(process.argv.slice(2));
`
};

const setup = String.raw`const assert = require("node:assert/strict");
const { reconcile, LedgerError } = require("./ledger.js");
const H = "id,revision,account,currency,amount,status,note\n";
const checkError = (text, code, row) => assert.throws(() => reconcile(text), (e) => e instanceof LedgerError && e.code === code && e.row === row);
`;

module.exports = {
  name: "ledger-reconcile",
  brief: "multi-file CSV reconciliation with revision conflicts, exact money, and a CLI",
  tier: "project",
  split: "holdout",
  par: { wallS: 480, tokensK: 160 },
  protectedFiles: ["README.md", "test.js"],
  files: {
    "README.md": contract,
    "test.js": visible,
    "csv.js": '"use strict";\nfunction parseCsv() { throw new Error("TODO"); }\nmodule.exports = { parseCsv };\n',
    "ledger.js": '"use strict";\nclass LedgerError extends Error { constructor(code, row) { super(code); this.code = code; this.row = row; } }\nfunction reconcile() { throw new Error("TODO"); }\nmodule.exports = { LedgerError, reconcile };\n',
    "cli.js": '"use strict";\nif (require.main === module) { console.error("TODO"); process.exitCode = 1; }\n',
  },
  prompt: "Implement the revision-ledger project described in README.md across csv.js, ledger.js, and cli.js. Run node test.js. Every documented CSV, reconciliation, error, precision, and CLI rule is graded. Do not change README.md or test.js, add dependencies, or access other workspaces or previous solutions.",
  hidden: [
    {
      name: "CSV quoting, record boundaries, and malformed input",
      weight: 3,
      source: String.raw`const assert = require("node:assert/strict");
const { parseCsv } = require("./csv.js");
assert.deepEqual(parseCsv('\uFEFFa,"b\r\nc","say ""hi""",\r\n\r\n'), [["a", "b\r\nc", 'say "hi"', ""], [""]]);
assert.deepEqual(parseCsv('"",x,'), [["", "x", ""]]);
assert.deepEqual(parseCsv(''), []);
assert.deepEqual(parseCsv('\n'), [[""]]);
assert.deepEqual(parseCsv('a\n\n'), [["a"], [""]]);
assert.deepEqual(parseCsv(' a , b '), [[" a ", " b "]]);
for (const bad of ['a"b', '"a"x', '"a" ', '"a', 'a\rb', 'a\r']) assert.throws(() => parseCsv(bad), SyntaxError, bad);
console.log("ok");`,
    },
    {
      name: "latest revision, obsolete duplicates, and void tombstones",
      weight: 3,
      source: setup + String.raw`
const rows = ["x,3,old,USD,8.00,void,gone", "x,1,old,USD,2.00,posted,old", "y,2,new,EUR,-0.00,posted,live", "y,1,new,USD,3.00,posted,old", "x,1,old,USD,2.00,posted,old", "z,1,new,EUR,0.00,posted,zero"];
assert.deepEqual(reconcile(H + rows.join("\n")), {
 entries: [{id:"y",revision:2,account:"new",currency:"EUR",cents:"0",note:"live"},{id:"z",revision:1,account:"new",currency:"EUR",cents:"0",note:"zero"}],
 balances: [{account:"new",currency:"EUR",cents:"0"}], counts:{rows:6,duplicates:1,voided:1}
});
assert.deepEqual(reconcile(H), {entries:[],balances:[],counts:{rows:0,duplicates:0,voided:0}});
assert.deepEqual(reconcile(H + [...rows].reverse().join("\n")), reconcile(H + rows.join("\n")));
console.log("ok");`,
    },
    {
      name: "arbitrary precision, pair identity, and code-unit ordering",
      weight: 3,
      source: setup + String.raw`
const result = reconcile(H + '__proto__,1,__proto__,USD,900719925474099312345.67,posted,"one,\ntwo"\na,1,__proto__,USD,0.33,posted,\nz,1,a,EUR,-1.00,posted,\nZ,1,a,USD,1.00,posted,\n');
assert.deepEqual(result.entries.map(x => x.id), ["Z","__proto__","a","z"]);
assert.equal(result.entries[1].note, "one,\ntwo");
assert.deepEqual(result.balances, [{account:"__proto__",currency:"USD",cents:"90071992547409931234600"},{account:"a",currency:"EUR",cents:"-100"},{account:"a",currency:"USD",cents:"100"}]);
const spaced = reconcile(H + 'i,1, a ,USD,0.10,posted,\nj,1,a,USD,0.20,posted,');
assert.deepEqual(spaced.balances.map(x=>x.account), [" a ","a"]);
console.log("ok");`,
    },
    {
      name: "all rows validated and obsolete conflicts remain errors",
      weight: 3,
      source: setup + String.raw`
checkError('', "HEADER", 1);
checkError('revision,id,account,currency,amount,status,note\n', "HEADER", 1);
checkError(H + '"unterminated', "CSV", null);
for (const field of ["0", "01", "2147483648", "1e2", "-1"]) checkError(H + 'a,'+field+',x,USD,1.00,posted,', "ROW", 2);
for (const field of ["1", "1.0", "01.00", "+1.00", "1e2", " 1.00", "1.000", "-01.00"]) checkError(H + 'a,1,x,USD,'+field+',void,', "ROW", 2);
for (const row of [' ,1,x,USD,1.00,posted,','a,1, ,USD,1.00,posted,','a,1,x,usd,1.00,posted,','a,1,x,USD,1.00,pending,','a,1,x,USD,1.00,posted']) checkError(H + row, "ROW", 2);
checkError(H + 'a,9,x,USD,1.00,posted,new\na,1,x,USD,1.00,posted,old\na,1,x,USD,1.01,posted,old', "CONFLICT", 4);
checkError(H + 'a,9,x,USD,1.00,posted,new\na,1,x,USD,broken,void,old', "ROW", 3);
checkError(H + 'a,1,x,USD,1.00,posted,"two\nlines"\na,1,x,USD,1.00,posted,different', "CONFLICT", 3);
console.log("ok");`,
    },
    {
      name: "CLI success, errors, import safety, and input preservation",
      weight: 3,
      source: setup + String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const cli = path.resolve("cli.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cli-grade-"));
const input = path.join(dir, "input.csv");
const call = args => spawnSync(process.execPath, [cli, ...args], {cwd:dir,encoding:"utf8",timeout:3000});
try {
 const text = H + 'a,1,x,USD,0.10,posted,"a,b"\n'; fs.writeFileSync(input, text);
 const ok = call([input]); assert.equal(ok.status,0); assert.equal(ok.stderr,""); assert.equal(ok.stdout,JSON.stringify(reconcile(text))+"\n");
 assert.equal(fs.readFileSync(input,"utf8"),text); assert.deepEqual(fs.readdirSync(dir),["input.csv"]);
 const error = (args,code,row) => {const r=call(args);assert.equal(r.status,2);assert.equal(r.stdout,"");assert.equal(r.stderr,JSON.stringify({error:{code,row}})+"\n");};
 error([],"USAGE",null); error([input,input],"USAGE",null); error([path.join(dir,"missing")],"READ",null);
 fs.writeFileSync(input,H+'a,0,x,USD,1.00,posted,'); error([input],"ROW",2);
 fs.writeFileSync(input,'bad\n'); error([input],"HEADER",1);
 const imported=spawnSync(process.execPath,["-e","require("+JSON.stringify(cli)+")"],{cwd:dir,encoding:"utf8",timeout:3000});
 assert.equal(imported.status,0);assert.equal(imported.stdout,"");assert.equal(imported.stderr,"");
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log("ok");`,
    },
  ],
  reference,
};
