"use strict";
// Self-check for deep-expr-interpreter: builds a reference interpreter, then
// runs the REAL gates from task.json against it (spawnSync, shell:true, exactly
// as the adapter does). Proves the gates are self-consistent and correctly
// escaped (esp. the ^ caret) before a long Spark run. Safe to delete.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TASK = path.join(__dirname, "tasks", "deep-expr-interpreter", "task.json");

// Reference interpreter (single index.js — gates only touch the public API).
const REF_INDEX = `
const NUM="num",IDENT="ident",OP="op",LP="lp",RP="rp",COMMA="comma",ASSIGN="assign",SEMI="semi",EOF="eof";
function tokenize(src){
  const s=String(src),toks=[]; let i=0;
  while(i<s.length){
    const c=s[i];
    if(/\\s/.test(c)){i++;continue;}
    if(/[0-9]/.test(c)||(c==="."&&/[0-9]/.test(s[i+1]||""))){let j=i+1;while(j<s.length&&/[0-9.]/.test(s[j]))j++;toks.push({type:NUM,value:parseFloat(s.slice(i,j))});i=j;continue;}
    if(/[A-Za-z_]/.test(c)){let j=i+1;while(j<s.length&&/[A-Za-z0-9_]/.test(s[j]))j++;toks.push({type:IDENT,value:s.slice(i,j)});i=j;continue;}
    if(c==="("){toks.push({type:LP});i++;continue;}
    if(c===")"){toks.push({type:RP});i++;continue;}
    if(c===","){toks.push({type:COMMA});i++;continue;}
    if(c===";"){toks.push({type:SEMI});i++;continue;}
    if(c==="="){toks.push({type:ASSIGN});i++;continue;}
    if("+-*/^".includes(c)){toks.push({type:OP,value:c});i++;continue;}
    throw new Error("syntax error: unexpected character "+c);
  }
  toks.push({type:EOF}); return toks;
}
function parse(tokens){
  let pos=0; const peek=()=>tokens[pos]; const next=()=>tokens[pos++];
  const expect=(t)=>{const tk=tokens[pos]; if(!tk||tk.type!==t)throw new Error("syntax error: expected "+t); return tokens[pos++];};
  function parseProgram(){const statements=[parseStatement()]; while(peek().type===SEMI){next(); if(peek().type===EOF)break; statements.push(parseStatement());} expect(EOF); return {type:"program",statements};}
  function parseStatement(){ if(peek().type===IDENT && tokens[pos+1] && tokens[pos+1].type===ASSIGN){const name=next().value; next(); return {type:"assign",name,expr:parseExpr()};} return parseExpr(); }
  function parseExpr(){return parseAdd();}
  function parseAdd(){let left=parseMul(); while(peek().type===OP&&(peek().value==="+"||peek().value==="-")){const op=next().value; left={type:"binary",op,left,right:parseMul()};} return left;}
  function parseMul(){let left=parseUnary(); while(peek().type===OP&&(peek().value==="*"||peek().value==="/")){const op=next().value; left={type:"binary",op,left,right:parseUnary()};} return left;}
  function parseUnary(){ if(peek().type===OP&&peek().value==="-"){next(); return {type:"unary",op:"-",expr:parseUnary()};} return parsePower(); }
  function parsePower(){let left=parsePrimary(); if(peek().type===OP&&peek().value==="^"){next(); return {type:"binary",op:"^",left,right:parseUnary()};} return left;}
  function parsePrimary(){
    const t=peek();
    if(t.type===NUM){next(); return {type:"num",value:t.value};}
    if(t.type===LP){next(); const e=parseExpr(); expect(RP); return e;}
    if(t.type===IDENT){const name=next().value; if(peek().type===LP){next(); const args=[]; if(peek().type!==RP){args.push(parseExpr()); while(peek().type===COMMA){next(); args.push(parseExpr());}} expect(RP); return {type:"call",name,args};} return {type:"var",name};}
    throw new Error("syntax error: unexpected token "+(t&&t.type));
  }
  return parseProgram();
}
const BUILTINS={sqrt:Math.sqrt,abs:Math.abs,floor:Math.floor,ceil:Math.ceil,min:Math.min,max:Math.max,pow:Math.pow};
function createEnv(){return {vars:{}};}
function evalNode(n,env){
  switch(n.type){
    case "program":{let v; for(const s of n.statements)v=evalNode(s,env); return v;}
    case "num":return n.value;
    case "var": if(!(n.name in env.vars))throw new Error("undefined variable: "+n.name); return env.vars[n.name];
    case "assign":{const v=evalNode(n.expr,env); env.vars[n.name]=v; return v;}
    case "unary":return -evalNode(n.expr,env);
    case "binary":{const l=evalNode(n.left,env),r=evalNode(n.right,env); switch(n.op){case "+":return l+r;case "-":return l-r;case "*":return l*r;case "/":if(r===0)throw new Error("division by zero");return l/r;case "^":return Math.pow(l,r);} throw new Error("syntax error: bad op");}
    case "call":{const fn=BUILTINS[n.name]; if(!fn)throw new Error("unknown function: "+n.name); return fn(...n.args.map(a=>evalNode(a,env)));}
  }
  throw new Error("syntax error: unknown node");
}
function evaluate(ast,env){return evalNode(ast,env||createEnv());}
function run(src,env){env=env||createEnv(); return evaluate(parse(tokenize(src)),env);}
module.exports={tokenize,parse,evaluate,run,createEnv};
`;

const task = JSON.parse(fs.readFileSync(TASK, "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interp-selfcheck-"));
fs.mkdirSync(path.join(dir, "src"), { recursive: true });
fs.writeFileSync(path.join(dir, "src", "index.js"), REF_INDEX.trimStart() + "\n", "utf8");

const gates = [...task.publicGates, ...task.hiddenGates];
let failed = 0;
for (const gate of gates) {
  const r = spawnSync(gate.command, { cwd: dir, shell: true, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${gate.id}${ok ? "" : "\n      " + (r.stderr || r.stdout || `exit ${r.status}`).trim().split(/\r?\n/).slice(0, 3).join("\n      ")}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${gates.length - failed}/${gates.length} gates passed against the reference interpreter.`);
process.exit(failed ? 1 : 0);
