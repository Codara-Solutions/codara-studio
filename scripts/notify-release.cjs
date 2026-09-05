"use strict";

const ENDPOINT = "https://studio.codarasolutions.com/hooks/releases";

async function notifyRelease(env = process.env, fetcher = fetch) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return false;
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", ENDPOINT);
  const identity = await fetcher(url, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!identity.ok) throw new Error(`release identity HTTP ${identity.status}`);
  const { value } = await identity.json();
  if (typeof value !== "string") throw new Error("release identity missing");
  const response = await fetcher(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${value}` },
    signal: AbortSignal.timeout(15_000), redirect: "error" });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`release notification HTTP ${response.status}`);
  return true;
}

module.exports = { notifyRelease };
