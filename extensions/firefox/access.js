// Firefox only, beside the shared popup: what Firefox has not allowed yet
// for the tab this popup is about (its site, scripts in pages, all sites for
// screenshots), each with one sentence and a button. Firefox asks the user
// only from a click, and only when permissions.request is called before
// anything is awaited. Turning on "share this tab" also asks for its site,
// unless the user already said no to that site: then only the button asks.
// Nothing is asked at install.
//
// The questions come from the background every second, so a click checks
// them against the tab's address as Firefox last reported it (tabs.onUpdated,
// read at once): a question for a site the tab has left is never asked.

import { currentQuestion } from "./lib/page-tools.js";

const $ = (id) => document.getElementById(id);

let tab = null;
let liveUrl = "";
let view = { shared: false, rows: [] };
let shown = "";
// Asked from this popup, before the background has it on record.
const askedHere = new Set();

async function load() {
  try {
    const answer = await chrome.runtime.sendMessage({ type: "access", tabId: tab?.id, windowId: tab?.windowId });
    view = { shared: answer?.shared === true, rows: Array.isArray(answer?.rows) ? answer.rows : [] };
  } catch {
    view = { shared: false, rows: [] };
  }
  render();
}

function ask(row) {
  askedHere.add(row.key);
  // The background remembers the question, so a no is not asked again by itself.
  void chrome.runtime.sendMessage({ type: "accessAsked", key: row.key }).catch(() => {});
  return chrome.permissions
    .request(row.request)
    .catch(() => false)
    .finally(() => void load());
}

function render() {
  const rows = view.shared ? view.rows : [];
  $("access").hidden = rows.length === 0;
  const key = JSON.stringify(rows);
  if (key === shown) return;
  shown = key;
  $("access-rows").replaceChildren(
    ...rows.map((row, at) => {
      const item = document.createElement("div");
      item.dataset.need = row.need;
      item.style.cssText = "display: grid; gap: 4px";
      const text = document.createElement("p");
      text.className = "note";
      text.textContent = row.text;
      const line = document.createElement("div");
      line.className = "row end";
      const button = document.createElement("button");
      button.type = "button";
      button.className = at === 0 ? "btn pri" : "btn";
      button.textContent = row.button;
      button.addEventListener("click", () => {
        const now = currentQuestion(view.rows, row.need, { tabId: tab?.id, url: liveUrl });
        if (now) void ask(now);
        else void load();
      });
      line.append(button);
      item.append(text, line);
      return item;
    }),
  );
}

async function start() {
  if (!globalThis.chrome?.permissions || !$("access")) return;
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) tab = await chrome.tabs.get(forced).catch(() => null);
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  liveUrl = tab?.url ?? "";
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId !== tab?.id || change.url === undefined) return;
    // Another page: the questions shown may be for another site until reloaded.
    liveUrl = change.url;
    void load();
  });
  $("share-tab")?.addEventListener("change", (event) => {
    if (!event.target.checked) return;
    const site = currentQuestion(view.rows, "site", { tabId: tab?.id, url: liveUrl });
    if (!site) void load();
    else if (!site.asked && !askedHere.has(site.key)) void ask(site);
  });
  await load();
  setInterval(() => void load(), 1000);
}

void start();
