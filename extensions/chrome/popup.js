// The toolbar popup: connect to Codara, one switch for this tab, how far
// sharing reaches (tabs picked one by one, this window, every tab), the
// shared tabs with their Stop, and which agent used this tab last. All state
// lives in the service worker; this page only asks it and redraws.

import { REACH_TEXT, REACHES, agentColorVar, otherWindowsText, parseBlockedSites, toolVerb } from "./lib/policy.js";

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  idle: "Not connected",
  searching: "Looking for Codara",
  pairing: "Waiting for Codara",
  connected: "Connected",
  offline: "Codara not found",
  denied: "Declined",
  unpaired: "Not connected",
  error: "Error",
};

const RESTRICTED_TEXT =
  "Chrome does not let extensions work on this page (Chrome Web Store and browser pages). Agents can use any normal website tab.";
const FILE_TEXT =
  'Chrome keeps extensions off local files until you turn on "Allow access to file URLs" for Codara (chrome://extensions, Details). Agents can use any normal website tab.';

let current = null;
let view = null;
let sharedKey = "";

async function call(type, extra = {}) {
  const answer = await chrome.runtime.sendMessage({ type, tabId: current?.id, windowId: current?.windowId, ...extra });
  if (answer?.error) throw new Error(answer.error);
  return answer;
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Two letters standing in for the site's icon, so the popup loads nothing from the page. */
function initials(tab) {
  const host = hostOf(tab.url);
  if (host && !/^[\d.:[\]]+$/.test(host) && host !== "localhost") {
    const parts = host.split(".").filter(Boolean);
    return (parts.length > 1 ? parts[parts.length - 2] : parts[0]).slice(0, 2).toUpperCase();
  }
  const words = String(tab.title ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
}

async function copy(text, button) {
  await navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

// window.confirm() in a toolbar popup opens a native dialog wider than the
// popup, which clips its buttons, so questions are asked inside the page.
let pendingAnswer = null;

function ask(text, yesLabel) {
  pendingAnswer?.(false);
  $("ask-text").textContent = text;
  $("ask-yes").textContent = yesLabel;
  $("ask").hidden = false;
  $("ask").scrollIntoView({ block: "nearest" });
  $("ask-yes").focus();
  return new Promise((resolve) => {
    pendingAnswer = (answer) => {
      pendingAnswer = null;
      $("ask").hidden = true;
      resolve(answer);
    };
  });
}

function renderShared(list) {
  // The list redraws only when it changed, so a focused Stop keeps its focus
  // across the 1 s refresh.
  const key = JSON.stringify(list.map((tab) => [tab.tabId, tab.title, tab.url, tab.blocked, tab.usage?.runtime ?? null, Boolean(tab.usage)]));
  if (key === sharedKey) return;
  sharedKey = key;
  const holder = $("shared-list");
  holder.replaceChildren();
  for (const tab of list) {
    const item = document.createElement("li");
    item.className = "row";
    item.dataset.tabId = String(tab.tabId);
    const fav = document.createElement("span");
    fav.className = "fav";
    fav.setAttribute("aria-hidden", "true");
    fav.textContent = initials(tab);
    const title = document.createElement("span");
    title.className = "grow ttl";
    title.textContent = tab.blocked ? "Blocked site" : tab.title || tab.url;
    item.append(fav, title);
    if (tab.usage) {
      const chip = document.createElement("span");
      chip.className = "agentchip";
      chip.title = tab.usage.name ?? tab.usage.agent;
      const dot = document.createElement("i");
      dot.style.setProperty("--c", agentColorVar(tab.usage.runtime));
      chip.append(dot);
      item.append(chip);
    }
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn ghost";
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", `Stop sharing ${title.textContent}`);
    stop.addEventListener("click", () => void act("stopTab", { tabId: tab.tabId }));
    item.append(stop);
    holder.append(item);
  }
}

function renderReach(reach, others = {}) {
  for (const button of $("reach-choice").querySelectorAll("[data-reach]")) {
    const on = button.dataset.reach === reach;
    button.setAttribute("aria-checked", String(on));
    // One tab stop for the group; the arrow keys move inside it.
    button.tabIndex = on ? 0 : -1;
  }
  // Windows and tabs shared elsewhere keep their choice; say so, or the line
  // would promise less access than there is.
  const elsewhere = reach === "all" ? "" : ` ${otherWindowsText(others)}`;
  $("reach-note").textContent = `${REACH_TEXT[reach].includes}${elsewhere} Blocked sites and browser pages stay off.`;
}

function renderTab(tab, connected) {
  $("this-tab").hidden = !tab;
  if (!tab) return;
  // Chrome keeps extensions off its own pages and the Web Store, and a
  // blocked site stays off whatever is shared, so neither offers a switch.
  const usable = !tab.restricted && !tab.blocked;
  $("tab-title").textContent = tab.title || tab.url;
  $("tab-host").textContent = hostOf(tab.url);
  $("tab-host").hidden = !usable;
  $("tab-fav").textContent = initials(tab);
  const note = tab.restricted === "file"
    ? FILE_TEXT
    : tab.restricted
    ? RESTRICTED_TEXT
    : tab.blocked
      ? `This site is on your blocked list (${tab.blocked}), so agents cannot use it. Change the list under Blocked sites.`
      : "";
  $("tab-note").hidden = !note;
  $("tab-note").textContent = note;
  $("tab-note").className = note ? "note why" : "note";
  $("share-tab").hidden = !usable;
  $("share-tab").checked = tab.shared;
  const usage = usable ? tab.usage : null;
  $("tab-agent").hidden = !usage;
  if (usage) {
    $("tab-agent-dot").style.setProperty("--c", agentColorVar(usage.runtime));
    $("tab-agent-name").textContent = usage.name ?? usage.agent;
    $("tab-usage").textContent = `${toolVerb(usage.tool)}, ${ago(usage.at)}`;
    $("tab-usage").title = usage.tool;
  }
  // Agents the user stopped from the page: the only place to give the tab back, besides Codara's Settings.
  $("tab-paused").hidden = !(usable && tab.shared && tab.paused);
  const stopped = usable && Array.isArray(tab.stoppedAgents) ? tab.stoppedAgents : [];
  $("tab-stopped").hidden = stopped.length === 0;
  $("tab-stopped").replaceChildren(
    ...stopped.map((agent) => {
      const item = document.createElement("li");
      item.className = "row";
      const text = document.createElement("span");
      text.className = "grow";
      text.textContent = `You stopped ${agent.name} on this tab.`;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn";
      // Codara owns the list: until it answers, the agent stays stopped.
      back.textContent = agent.waiting ? "Waiting for Codara" : "Give back";
      back.disabled = agent.waiting === true;
      back.setAttribute("aria-label", agent.waiting ? `Waiting for Codara about ${agent.name}` : `Give this tab back to ${agent.name}`);
      back.addEventListener("click", () => void act("giveBack", { tabId: tab.tabId, key: agent.key }));
      item.append(text, back);
      return item;
    }),
  );
  $("tab-details").hidden = !usable || !connected;
  $("copy-id").textContent = tab.shared ? "Copy tab id" : "Share and copy id";
  $("tab-id").textContent = tab.agentId;
  $("storage-row").hidden = !usable || !tab.shared;
  $("storage-note").hidden = $("storage-row").hidden;
  $("share-storage").checked = tab.storage;
}

function render() {
  if (!view) return;
  const { status } = view;
  const connected = status.state === "connected";
  $("status").dataset.state = status.state;
  $("status-text").textContent = connected && status.app?.version ? `Studio ${status.app.version}` : STATUS_TEXT[status.state] ?? status.state;
  $("status").title = connected ? `Connected to Codara${status.app?.version ? ` ${status.app.version}` : ""}` : "";

  $("connect").hidden = connected;
  $("pairing").hidden = status.state !== "pairing";
  $("pairing-code").textContent = status.code ?? "";
  $("connect-error").hidden = !status.error || connected;
  $("connect-error").textContent = status.error ?? "";
  $("connect-button").hidden = status.state === "pairing" || status.state === "searching";
  $("connect-button").textContent = view.paired ? "Reconnect" : "Connect to Codara";
  $("connect-text").textContent = view.paired
    ? "This browser is paired with Codara. Open Codara to reconnect."
    : "Connect this browser to Codara so agents can use the tabs you share. Codara shows a code to allow.";
  $("unpair").hidden = !view.paired;

  renderTab(view.current, connected);

  $("reach").hidden = false;
  if (!pendingAnswer) renderReach(view.reach, view);
  $("allow-open").checked = view.allowOpen;
  $("on-page").hidden = false;
  $("presence-overlay").checked = view.presence.overlay;
  $("presence-glow").checked = view.presence.overlay && view.presence.glow;
  $("presence-glow").disabled = !view.presence.overlay;

  $("shared").hidden = view.shared.length === 0;
  $("shared-label").textContent = `Shared, ${view.shared.length} tab${view.shared.length === 1 ? "" : "s"}`;
  renderShared(view.shared);

  $("open-options").textContent = `Blocked sites (${parseBlockedSites(view.blockedSites).length})`;
}

async function refresh(extra = {}) {
  view = await call("state", extra);
  render();
}

async function act(type, extra = {}) {
  try {
    view = await call(type, extra);
    render();
  } catch (error) {
    $("connect-error").hidden = false;
    $("connect-error").textContent = error.message;
  }
}

async function pickReach(reach) {
  // While "Everything" asks, the other segments wait for the answer.
  if (!view || reach === view.reach || pendingAnswer) return;
  if (reach === "all") {
    // The segment shows the choice while the question is open.
    renderReach("all");
    const yes = await ask("Let agents use every tab in this browser, including ones you open later? Sites on your blocked list stay off.", "Share every tab");
    if (!yes) {
      renderReach(view.reach, view);
      return;
    }
  }
  await act("setReach", { reach });
  $("reach-choice").querySelector(`[data-reach="${reach}"]`)?.focus();
}

async function start() {
  // ?tab=<id> shows another tab (the options page and the tests open the popup as a page).
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) current = await chrome.tabs.get(forced).catch(() => null);
  if (!current) [current] = await chrome.tabs.query({ active: true, currentWindow: true });

  $("connect-button").addEventListener("click", () => void act("connect"));
  $("share-tab").addEventListener("change", (event) => void act("shareTab", { on: event.target.checked }));
  $("share-storage").addEventListener("change", (event) => void act("setStorage", { on: event.target.checked }));
  const choice = $("reach-choice");
  choice.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reach]");
    if (button) void pickReach(button.dataset.reach);
  });
  choice.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step || !view) return;
    event.preventDefault();
    const at = REACHES.indexOf(event.target.dataset?.reach ?? view.reach);
    void pickReach(REACHES[(at + step + REACHES.length) % REACHES.length]);
  });
  $("ask-yes").addEventListener("click", () => pendingAnswer?.(true));
  $("ask-no").addEventListener("click", () => pendingAnswer?.(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pendingAnswer) {
      event.preventDefault();
      pendingAnswer(false);
    }
  });
  $("allow-open").addEventListener("change", (event) => void act("setAllowOpen", { on: event.target.checked }));
  $("presence-overlay").addEventListener("change", (event) => void act("setPresence", { overlay: event.target.checked }));
  $("presence-glow").addEventListener("change", (event) => void act("setPresence", { glow: event.target.checked }));
  $("stop-all").addEventListener("click", () => void act("stopAll"));
  $("copy-id").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    // An id is only useful to an agent once the tab is shared.
    if (!view?.current?.shared) await act("shareTab", { on: true });
    if (view?.current?.shared) await copy(view.current.agentId, button);
  });
  $("open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  $("unpair").addEventListener("click", async () => {
    if (await ask("Disconnect this browser from Codara? Agents lose access to every tab until you connect again.", "Disconnect")) void act("unpair");
  });

  // Opening the popup looks for Codara now; the 1 s refresh only reads.
  await refresh({ opened: true });
  setInterval(() => void refresh(), 1000);
}

void start();
