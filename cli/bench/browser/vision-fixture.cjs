"use strict";

const http = require("node:http");
const { randomInt } = require("node:crypto");

async function startVisionFixture() {
  const names = ["Raven", "Maple", "Atlas", "Moss", "Cedar", "River"];
  for (let i = names.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [names[i], names[j]] = [names[j], names[i]];
  }
  const values = new Set();
  while (values.size < names.length) values.add(randomInt(8, 96));
  const streams = names.map((name, id) => ({ id, name, value: [...values][id] }));
  const expected = streams.reduce((a, b) => a.value < b.value ? a : b);
  let confirmed = null, commits = 0, loadsAfterCommit = 0, confirmedAt = null;
  const page = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>Stream latency console</title>
<style>body{font:17px system-ui;margin:32px;color:#182536;background:#f7f9fc}main{max-width:760px}h1{font-size:28px}canvas{display:block;width:680px;max-width:100%;height:auto;background:white;border:1px solid #acb9ca;border-radius:8px}button{padding:12px 18px;font:inherit;margin-top:18px}#status{min-height:28px}</style></head>
<body><main><h1>Stream latency console</h1><p>p95 latency in milliseconds. Select a stream in the chart, then confirm.</p>
<canvas width="680" height="380" aria-label="Stream latency chart"></canvas>
<button id="confirm" disabled>Confirm selection</button><p id="status" role="status"></p></main>
<script>
const streams=${JSON.stringify(streams)};
let selected=${JSON.stringify(confirmed)}, confirmed=${JSON.stringify(confirmed)};
const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d'), button=document.querySelector('button'), status=document.getElementById('status');
function draw(){
 ctx.clearRect(0,0,680,380);ctx.font='16px system-ui';ctx.fillStyle='#526176';ctx.fillText('Stream',24,30);ctx.fillText('p95 (ms)',552,30);
 for(const [i,s] of streams.entries()){
  const y=48+i*52;
  if(selected===s.id){ctx.fillStyle='#e0eefe';ctx.fillRect(12,y-4,656,46);ctx.strokeStyle='#1765bd';ctx.lineWidth=2;ctx.strokeRect(12,y-4,656,46);}
  ctx.fillStyle='#182536';ctx.font='18px system-ui';ctx.fillText(s.name,24,y+24);
  ctx.fillStyle='#327bb8';ctx.fillRect(145,y+3,s.value*3.8,30);
  ctx.fillStyle='#182536';ctx.fillText(String(s.value),576,y+24);
 }
 button.disabled=selected===null||confirmed!==null;
 status.textContent=confirmed!==null?'Confirmed: '+streams.find(s=>s.id===confirmed).name:selected!==null?'Selected: '+streams.find(s=>s.id===selected).name:'No stream selected';
}
canvas.addEventListener('click',e=>{
 if(confirmed!==null)return;
 const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)*680/r.width,y=(e.clientY-r.top)*380/r.height;
 const i=Math.floor((y-44)/52);
 if(x>=12&&x<=668&&i>=0&&i<streams.length&&y<44+i*52+46){selected=streams[i].id;draw();}
});
button.addEventListener('click',async()=>{
 button.disabled=true;
 const response=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({choice:selected})});
 if(!response.ok){status.textContent='Save failed';button.disabled=false;return;}
 confirmed=(await response.json()).choice;draw();
});
draw();
</script></body></html>`;
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.url === "/") {
      if (confirmed !== null) loadsAfterCommit++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page());
      return;
    }
    if (req.method === "POST" && req.url === "/confirm") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { res.writeHead(413); res.end(); return; }
      }
      let choice;
      try { choice = JSON.parse(body).choice; } catch { res.writeHead(400); res.end(); return; }
      if (!Number.isInteger(choice) || !streams.some((stream) => stream.id === choice)) { res.writeHead(400); res.end(); return; }
      commits++;
      confirmedAt = Date.now();
      confirmed = choice;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choice }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    snapshot: () => ({ streams, expected, confirmed, commits, loadsAfterCommit, confirmedAt }),
    grade: () => [
      { name: "lowest displayed latency selected", pass: confirmed === expected.id },
      { name: "exactly one confirmation saved", pass: commits === 1 },
      { name: "saved selection reloaded", pass: loadsAfterCommit > 0 },
    ],
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
module.exports = { startVisionFixture };
