"use strict";
// Self-check for the longrun-ledger-library eval: builds a reference
// implementation, then runs the REAL gates from task.json against it (exactly
// how the adapter runs them — spawnSync, shell:true, cwd=repo). Proves the
// gates are self-consistent and correctly escaped before we spend a long Spark
// run on them. Not part of the task (lives outside tasks/), safe to delete.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TASK = path.join(__dirname, "tasks", "longrun-ledger-library", "task.json");

const REF = {
  "money.js": `
function formatMoney(cents){const sign=cents<0?"-":"";const abs=Math.abs(Math.trunc(cents));return sign+"$"+Math.floor(abs/100)+"."+String(abs%100).padStart(2,"0");}
function parseMoney(str){const s=String(str).replace(/[$,\\s]/g,"");const neg=s.startsWith("-");const num=parseFloat(s.replace(/^-/,""))||0;const cents=Math.round(num*100);return neg?-cents:cents;}
function sumCents(list){return (list||[]).reduce((a,b)=>a+b,0);}
module.exports={formatMoney,parseMoney,sumCents};`,
  "dates.js": `
function isValidDate(str){if(typeof str!=="string")return false;const m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(str);if(!m)return false;const dt=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return dt.getUTCFullYear()===+m[1]&&dt.getUTCMonth()===+m[2]-1&&dt.getUTCDate()===+m[3];}
function monthKey(isoDate){return String(isoDate).slice(0,7);}
function compareDate(a,b){const sa=String(a),sb=String(b);return sa<sb?-1:sa>sb?1:0;}
module.exports={isValidDate,monthKey,compareDate};`,
  "categories.js": `
function normalizeCategory(raw){if(raw===null||raw===undefined)return "uncategorized";let s=String(raw).toLowerCase().trim();s=s.replace(/\\s+/g,"-").replace(/[^a-z0-9-]/g,"").replace(/-+/g,"-").replace(/^-+|-+$/g,"");return s.length?s:"uncategorized";}
module.exports={normalizeCategory};`,
  "validate.js": `
function isValidDateStr(str){if(typeof str!=="string")return false;const m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(str);if(!m)return false;const dt=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return dt.getUTCFullYear()===+m[1]&&dt.getUTCMonth()===+m[2]-1&&dt.getUTCDate()===+m[3];}
function isValidAmount(a){if(typeof a==="number")return Number.isFinite(a);if(typeof a==="string")return /^-?\\$?[\\d,]+(\\.\\d+)?$/.test(a.trim());return false;}
function validateTransaction(tx){tx=tx||{};const errors=[];if(!isValidDateStr(tx.date))errors.push("invalid date");if(!isValidAmount(tx.amount))errors.push("invalid amount");if(typeof tx.category!=="string"||tx.category.trim().length===0)errors.push("missing category");return {ok:errors.length===0,errors};}
module.exports={validateTransaction};`,
  "csv.js": `
function parseCsv(text){const lines=String(text).split(/\\r?\\n/).filter((l)=>l.trim().length>0);if(!lines.length)return [];const header=lines[0].split(",").map((h)=>h.trim());return lines.slice(1).map((line)=>{const cells=line.split(",").map((c)=>c.trim());const o={};header.forEach((h,i)=>{o[h]=cells[i]!==undefined?cells[i]:"";});return o;});}
function toCsv(rows,columns){const head=columns.join(",");const body=(rows||[]).map((row)=>columns.map((c)=>row[c]!==undefined&&row[c]!==null?String(row[c]):"").join(","));return [head,...body].join("\\n");}
module.exports={parseCsv,toCsv};`,
  "transactions.js": `
const {parseMoney}=require("./money");const {monthKey,compareDate}=require("./dates");const {normalizeCategory}=require("./categories");const {validateTransaction}=require("./validate");
function createTransaction(raw){const {ok,errors}=validateTransaction(raw);if(!ok)throw new Error("invalid transaction: "+errors.join(", "));const amountCents=typeof raw.amount==="number"?Math.round(raw.amount*100):parseMoney(raw.amount);return {date:raw.date,amountCents,category:normalizeCategory(raw.category),description:raw.description||""};}
function filterByMonth(txs,month){return (txs||[]).filter((t)=>monthKey(t.date)===month);}
function filterByCategory(txs,cat){const c=normalizeCategory(cat);return (txs||[]).filter((t)=>t.category===c);}
function sortByDate(txs){return [...(txs||[])].sort((a,b)=>compareDate(a.date,b.date));}
module.exports={createTransaction,filterByMonth,filterByCategory,sortByDate};`,
  "budget.js": `
const {normalizeCategory}=require("./categories");
function summarizeByCategory(txs){const map=new Map();for(const t of txs||[]){const cur=map.get(t.category)||{category:t.category,totalCents:0,count:0};cur.totalCents+=t.amountCents;cur.count+=1;map.set(t.category,cur);}return [...map.values()].sort((a,b)=>b.totalCents-a.totalCents||(a.category<b.category?-1:a.category>b.category?1:0));}
function applyBudget(txs,limits){limits=limits||{};const spent=new Map();for(const t of txs||[])spent.set(t.category,(spent.get(t.category)||0)+t.amountCents);const lim=new Map();for(const k of Object.keys(limits))lim.set(normalizeCategory(k),Math.round(limits[k]*100));const cats=new Set([...spent.keys(),...lim.keys()]);return [...cats].sort((a,b)=>a<b?-1:a>b?1:0).map((category)=>{const spentCents=spent.get(category)||0;const limitCents=lim.get(category)||0;return {category,spentCents,limitCents,remainingCents:limitCents-spentCents,overBudget:spentCents>limitCents};});}
module.exports={summarizeByCategory,applyBudget};`,
  "report.js": `
const {applyBudget}=require("./budget");const {sortByDate}=require("./transactions");const {formatMoney,sumCents}=require("./money");
function renderLedger(txs){return sortByDate(txs).map((t)=>t.date+" "+t.category+" "+formatMoney(t.amountCents)).join("\\n");}
function renderBudgetReport(txs,limits){const rows=applyBudget(txs,limits);const lines=rows.map((r)=>r.category+": spent "+formatMoney(r.spentCents)+" / "+formatMoney(r.limitCents)+" ("+(r.overBudget?"OVER":"ok")+")");lines.push("TOTAL spent "+formatMoney(sumCents((txs||[]).map((t)=>t.amountCents))));return lines.join("\\n");}
module.exports={renderLedger,renderBudgetReport};`,
  "index.js": `
module.exports={...require("./money"),...require("./dates"),...require("./categories"),...require("./validate"),...require("./csv"),...require("./transactions"),...require("./budget"),...require("./report")};`,
};

const task = JSON.parse(fs.readFileSync(TASK, "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-selfcheck-"));
const src = path.join(dir, "src");
fs.mkdirSync(src, { recursive: true });
for (const [name, body] of Object.entries(REF)) fs.writeFileSync(path.join(src, name), body.trimStart() + "\n", "utf8");

const gates = [...task.publicGates, ...task.hiddenGates];
let failed = 0;
for (const gate of gates) {
  const r = spawnSync(gate.command, { cwd: dir, shell: true, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${gate.id}${ok ? "" : "\n      " + (r.stderr || r.stdout || `exit ${r.status}`).trim().split(/\r?\n/).slice(0, 3).join("\n      ")}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${gates.length - failed}/${gates.length} gates passed against the reference implementation.`);
process.exit(failed ? 1 : 0);
