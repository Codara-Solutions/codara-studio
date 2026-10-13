// The blocked-sites editor. The service worker owns the list and detaches
// any tab that a saved change blocks.

import { DEFAULT_BLOCKED_SITES } from "./lib/policy.js";

const sites = document.getElementById("sites");
const saved = document.getElementById("saved");

async function send(type, extra = {}) {
  const answer = await chrome.runtime.sendMessage({ type, ...extra });
  if (answer?.error) throw new Error(answer.error);
  return answer;
}

async function save(text) {
  await send("setBlockedSites", { text });
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 1500);
}

document.getElementById("save").addEventListener("click", () => void save(sites.value));
document.getElementById("reset").addEventListener("click", () => {
  sites.value = DEFAULT_BLOCKED_SITES;
  void save(sites.value);
});

void send("state").then((state) => {
  sites.value = state.blockedSites;
});
