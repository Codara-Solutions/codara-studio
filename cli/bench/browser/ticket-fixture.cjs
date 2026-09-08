"use strict";

const http = require("node:http");

const TARGET_ID = "OPS-184";
const EXPECTED_NOTE = "Validated against staging build 42.";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northstar support desk</title>
<style>
body{font:16px system-ui;margin:40px auto;max-width:900px;color:#172336;background:#f7f9fc}
button,input,select,textarea{font:inherit;padding:9px;margin:5px}button{cursor:pointer}
table{width:100%;border-collapse:collapse;background:white}td,th{padding:12px;text-align:left;border-bottom:1px solid #dce2eb}
label{display:block;margin:12px 0}dialog{border:1px solid #9ba9bc;border-radius:12px;padding:24px;min-width:400px}
#status{min-height:28px;color:#425678}#error{color:#9c241c}textarea{display:block;width:90%}
</style></head><body><h1>Northstar support desk</h1>
<p>Review tickets, preserve current ownership, and confirm changes before saving.</p>
<label>Search tickets <input id="search" type="search" placeholder="ID or title"></label>
<button id="refresh">Search</button><p id="status" role="status">Loading tickets...</p>
<table><thead><tr><th>Ticket</th><th>Title</th><th>Team</th><th>Priority</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table>
<button id="previous" disabled>Previous page</button><span id="page"></span><button id="next">Next page</button>
<dialog id="editor" aria-labelledby="editor-title"><h2 id="editor-title">Edit ticket</h2>
<p id="owner"></p><p id="error" role="alert"></p>
<label>Priority <select id="priority"><option>Low</option><option>Normal</option><option>High</option></select></label>
<label>Note <textarea id="note"></textarea></label>
<button id="reload" hidden>Reload latest ticket</button><button id="save">Review change</button><button id="cancel">Cancel</button>
</dialog>
<dialog id="confirmation" aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm ticket change</h2><p id="summary"></p>
<button id="confirm">Confirm save</button><button id="back">Back to edit</button></dialog>
<script>
const $ = id => document.getElementById(id);
let page=0, ticket=null, query='', generation=0;
async function load(){
 const current=++generation; $('status').textContent='Loading tickets...';
 const response=await fetch('/api/tickets?q='+encodeURIComponent(query)+'&page='+page);
 const result=await response.json(); if(current!==generation)return;
 $('rows').replaceChildren();
 for(const row of result.rows){
  const tr=document.createElement('tr');
  for(const value of [row.id,row.title,row.team,row.priority]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
  const td=document.createElement('td'),button=document.createElement('button');button.textContent='Edit '+row.id;button.dataset.ticket=row.id;
  button.onclick=()=>openTicket(row.id);td.append(button);tr.append(td);$('rows').append(tr);
 }
 $('page').textContent='Page '+(page+1)+' of '+result.pages;
 $('previous').disabled=page===0;$('next').disabled=page+1>=result.pages;
 $('status').textContent=result.total+' matching tickets';
}
async function openTicket(id){
 ticket=await (await fetch('/api/tickets/'+encodeURIComponent(id))).json();
 $('editor-title').textContent='Edit '+ticket.id;$('owner').textContent='Owner: '+ticket.owner;
 $('priority').value=ticket.priority;$('note').value=ticket.note;$('error').textContent='';$('reload').hidden=true;$('save').disabled=false;
 if(!$('editor').open)$('editor').showModal();
}
$('refresh').onclick=()=>{query=$('search').value;page=0;load();};
$('search').onkeydown=e=>{if(e.key==='Enter')$('refresh').click();};
$('next').onclick=()=>{page++;load();};$('previous').onclick=()=>{page--;load();};
$('reload').onclick=()=>openTicket(ticket.id);
$('save').onclick=()=>{
 if(!$('note').value.trim()){$('error').textContent='A note is required.';return;}
 $('summary').textContent=ticket.id+' / '+$('priority').value+' / '+$('note').value+' / Owner: '+ticket.owner;
 $('confirmation').showModal();
};
$('back').onclick=()=>$('confirmation').close();$('cancel').onclick=()=>$('editor').close();
$('confirm').onclick=async()=>{
 $('confirm').disabled=true;
 try{
  const response=await fetch('/api/tickets/'+ticket.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:ticket.revision,priority:$('priority').value,note:$('note').value})});
  const result=await response.json();$('confirmation').close();
  if(!response.ok){$('error').textContent=result.error;$('reload').hidden=false;$('save').disabled=true;return;}
  $('editor').close();await load();$('status').textContent='Saved '+result.id+' at revision '+result.revision+'.';
 }finally{$('confirm').disabled=false;}
};
load();
</script></body></html>`;

async function startTicketFixture({ delayMs = 180 } = {}) {
  const tickets = Array.from({ length: 14 }, (_, index) => ({
    id: `OPS-${180 + index}`,
    title: index === 4 ? "Release checklist" : `Release checklist follow-up ${index + 1}`,
    team: index % 2 ? "Client" : "Platform",
    owner: "Avery",
    priority: "Normal",
    note: "",
    revision: 1,
  }));
  const initial = structuredClone(tickets);
  const journal = [];
  let conflictInjected = false;
  const send = (res, status, value, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/tickets") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
        const matches = tickets.filter((ticket) => (ticket.id + " " + ticket.title).toLowerCase().includes(q));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return send(res, 200, { rows: matches.slice(page * 4, page * 4 + 4), total: matches.length, pages: Math.max(1, Math.ceil(matches.length / 4)) });
      }
      const id = /^\/api\/tickets\/(OPS-\d+)$/.exec(url.pathname)?.[1];
      const ticket = tickets.find((entry) => entry.id === id);
      if (!ticket) return send(res, 404, { error: "Ticket not found" });
      if (req.method === "GET") return send(res, 200, ticket);
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) return send(res, 413, { error: "Request too large" });
      }
      let update;
      try { update = JSON.parse(body); } catch { return send(res, 400, { error: "Invalid JSON" }); }
      if (!update || !["Low", "Normal", "High"].includes(update.priority) || typeof update.note !== "string" || !update.note.trim()) {
        return send(res, 400, { error: "Priority and note are required" });
      }
      if (ticket.id === TARGET_ID && !conflictInjected) {
        conflictInjected = true;
        ticket.owner = "Morgan";
        ticket.revision += 1;
      }
      if (ticket.revision !== update.revision) {
        journal.push({ kind: "conflict", id, revision: ticket.revision });
        return send(res, 409, { error: "This ticket changed while you were editing. Reload the latest ticket, preserve its owner, and reapply your change." });
      }
      ticket.priority = update.priority;
      ticket.note = update.note;
      ticket.revision += 1;
      journal.push({ kind: "saved", id, priority: ticket.priority, note: ticket.note, owner: ticket.owner, revision: ticket.revision });
      return send(res, 200, ticket);
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    snapshot: () => structuredClone({ tickets, journal }),
    grade() {
      const target = tickets.find((ticket) => ticket.id === TARGET_ID);
      return [
        { name: "target priority and note saved", pass: target.priority === "High" && target.note === EXPECTED_NOTE },
        { name: "concurrent owner preserved", pass: target.owner === "Morgan" && target.revision === 3 },
        { name: "conflict recovered with one successful write", pass: journal.filter((entry) => entry.kind === "conflict").length >= 1 && journal.filter((entry) => entry.kind === "saved").length === 1 },
        { name: "other tickets unchanged", pass: tickets.every((ticket, index) => ticket.id === TARGET_ID || JSON.stringify(ticket) === JSON.stringify(initial[index])) },
      ];
    },
    close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

module.exports = { startTicketFixture, TARGET_ID, EXPECTED_NOTE };
