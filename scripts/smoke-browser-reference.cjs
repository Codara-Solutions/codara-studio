"use strict";

const fs = require("node:fs");
const { rpcRaw, homeDir } = require("../cli/lib/rpc.cjs");
const { startTicketFixture, TARGET_ID, EXPECTED_NOTE } = require("../cli/bench/browser/ticket-fixture.cjs");

(async () => {
  const flags = { home: process.env.CODARA_BROWSER_SMOKE_HOME ?? homeDir() };
  const fixture = await startTicketFixture();
  const observations = [];
  const request = async (method, params = {}) => {
    const response = await rpcRaw(flags, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
  const waitFor = async (text) => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const snapshot = await request("preview.snapshot");
      if (JSON.stringify(snapshot).includes(text)) { observations.push(snapshot); return; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Snapshot never showed: ${text}`);
  };
  try {
    observations.push(await request("preview.navigate", { url: fixture.url }));
    await waitFor("Next page");
    await request("preview.click", { selector: "#next" });
    await waitFor(`Edit ${TARGET_ID}`);
    await request("preview.click", { selector: `[data-ticket="${TARGET_ID}"]` });
    await waitFor("Owner: Avery");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request("preview.type", { selector: "#priority", text: "High" });
      await request("preview.type", { selector: "#note", text: EXPECTED_NOTE, clearFirst: true });
      await request("preview.click", { selector: "#save" });
      await waitFor("Confirm ticket change");
      await request("preview.click", { selector: "#confirm" });
      if (attempt === 0) {
        await waitFor("This ticket changed");
        await request("preview.click", { selector: "#reload" });
        await waitFor("Owner: Morgan");
      }
    }
    await waitFor(`Saved ${TARGET_ID}`);
    await request("preview.click", { selector: `[data-ticket="${TARGET_ID}"]` });
    await waitFor("Owner: Morgan");
    const checks = fixture.grade();
    if (process.env.CODARA_BROWSER_REFERENCE_OUTPUT) fs.writeFileSync(process.env.CODARA_BROWSER_REFERENCE_OUTPUT, JSON.stringify({ checks, state: fixture.snapshot(), observations }, null, 2) + "\n");
    console.log(JSON.stringify(checks, null, 2));
    if (checks.some((check) => !check.pass)) process.exitCode = 1;
  } finally {
    await fixture.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
