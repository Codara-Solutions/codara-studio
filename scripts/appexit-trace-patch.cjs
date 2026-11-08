// Temporary (issue 170): adds stderr quit-stage traces to out/main/index.js.
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "..", "out", "main", "index.js");
let s = fs.readFileSync(file, "utf8");
const T = (m) => `process.stderr.write("TRACE ${m} "+Date.now()+"\\n");`;
const anchors = [
  [/\.app\.on\("before-quit",(\w+)=>\{/, (m) => m + T("before-quit-handler")],
  [/finally\{clearTimeout\((\w+)\),(\w+)=!0/, (m) => m.replace("finally{", "finally{" + T("cleanup-done"))],
];
for (const [re, fn] of anchors) {
  const hits = s.match(new RegExp(re.source, "g")) ?? [];
  if (hits.length !== 1) throw new Error(`anchor ${re} matched ${hits.length}`);
  s = s.replace(re, fn);
}
s += `;(()=>{const {app}=require("electron");const t=(m)=>process.stderr.write("TRACE "+m+" "+Date.now()+"\\n");
for (const e of ["will-quit","quit","window-all-closed","browser-window-created"]) app.on(e,()=>t(e));
app.on("browser-window-created",(_e,w)=>{w.on("close",()=>t("window-close"));w.on("closed",()=>t("window-closed"));});
process.on("exit",()=>t("process-exit"));})();\n`;
fs.writeFileSync(file, s);
console.log("trace patch applied");
