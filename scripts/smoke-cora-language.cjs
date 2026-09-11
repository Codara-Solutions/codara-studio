"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { rpcRaw } = require("../cli/lib/rpc.cjs");
const { findRun } = require("../cli/lib/store.cjs");
const { driveToCompletion } = require("../cli/commands/bench.cjs");

async function main() {
  const workspaceRun = process.env.CODARA_BROWSER_SMOKE_RUN;
  const output = process.env.CODARA_LANGUAGE_SMOKE_OUTPUT;
  if (!workspaceRun || !output) throw new Error("Set CODARA_BROWSER_SMOKE_RUN and a new CODARA_LANGUAGE_SMOKE_OUTPUT path");
  if (fs.existsSync(output)) throw new Error("Output artifact already exists");
  const cwd = findRun({}, workspaceRun).settingsSnapshot.workspaceCwd;
  assert.match(cwd, /cora-browser-ticket-/);
  const samples = [
    { execution: "managed", language: "English", prompt: 'what is wrong with this app:\nmira lo que pasa: el modelo pide search_web("DiDi Mexico Uber Cabify Beat precios tarifas comparación 2025" · year)\n12:33:08\naviso\n*búsqueda rechazada por presupuesto (brave): límite de 2 búsquedas para este tema*\n12:33:09\n\ndo not change anything find the issue...\nExplain only what this log establishes in two sentences. Use no tools, workers, or repository access.' },
    { execution: "direct", language: "Spanish", prompt: '¿Qué significa este error? Ejemplo: "Search rejected: the limit of 2 searches for this topic has been reached." Explica solo lo que demuestra el mensaje en dos frases, sin herramientas ni cambios.' },
    { execution: "direct", language: "English", prompt: '¿Qué significa este error? "búsqueda rechazada por presupuesto: límite de 2 búsquedas para este tema". Please answer in English in two sentences, using only this log and no tools or file changes.' },
  ];
  const results = [];
  const request = async (method, params) => {
    const response = await rpcRaw({}, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  for (const sample of samples) {
    const created = await request("chat.create", { cwd, prompt: sample.prompt, model: "gpt-5.6-sol", effort: "low", execution: sample.execution, title: `language regression: ${sample.language}` });
    const runId = created.run.id;
    try {
      const outcome = await driveToCompletion({}, runId, Date.now() + 120_000, "gpt-5.6-sol");
      const run = findRun({}, runId);
      const reply = run.humanMessages.filter(message => message.author !== 'user').at(-1)?.message || run.resultManifest?.summary || '';
      results.push({ ...sample, runId, status: outcome.status, reply });
      assert.equal(outcome.status, 'complete');
      assert.ok(reply, 'a real reply was recorded');
    } finally {
      await request("chat.cancel", { runId, reason: "Language smoke completed" }).catch(() => {});
    }
  }
  fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(results, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
