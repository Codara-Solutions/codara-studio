// The toolbar popup: connect to Codara, share this tab (or this window, or
// every tab), see each shared tab's id and which agent used it last, allow
// cookie and storage access per tab, and stop. All state lives in the
// service worker; this page only asks it and redraws.

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

let current = null;
let view = null;

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

function usageText(tab) {
  if (!tab.usage) return tab.attached ? "An agent is attached." : "No agent has used it yet.";
  return `${tab.usage.agent}${tab.usage.tool ? ` (${tab.usage.tool})` : ""}, ${ago(tab.usage.at)}`;
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
  const holder = $("shared-list");
  holder.replaceChildren();
  for (const tab of list) {
    const item = document.createElement("li");
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.blocked ? "Blocked site" : tab.title || tab.url;
    const ids = document.createElement("div");
    ids.className = "row";
    const id = document.createElement("code");
    id.textContent = tab.agentId;
    const actions = document.createElement("span");
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", () => void copy(tab.agentId, copyButton));
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "danger";
    stop.textContent = "Stop";
    stop.addEventListener("click", () => void act("stopTab", { tabId: tab.tabId }));
    actions.append(copyButton, " ", stop);
    ids.append(id, actions);
    const usage = document.createElement("div");
    usage.className = "note";
    usage.textContent = tab.blocked ? `On your blocked list (${tab.blocked}).` : usageText(tab);
    item.append(title, ids, usage);
    holder.append(item);
  }
}

function render() {
  if (!view) return;
  const { status } = view;
  const pill = $("status");
  pill.dataset.state = status.state;
  pill.textContent = status.state === "connected" && status.app?.version ? `Connected to Codara ${status.app.version}` : STATUS_TEXT[status.state] ?? status.state;

  const connected = status.state === "connected";
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

  const tab = view.current;
  $("this-tab").hidden = !tab;
  if (tab) {
    $("tab-title").textContent = tab.title || tab.url;
    const note = tab.restricted
      ? "Agents cannot use browser pages like this one."
      : tab.blocked
        ? `This site is on your blocked list (${tab.blocked}), so agents cannot use it.`
        : "";
    $("tab-note").hidden = !note;
    $("tab-note").textContent = note;
    $("share-tab").checked = tab.shared;
    $("share-tab").disabled = tab.restricted;
    $("tab-shared").hidden = !tab.shared || Boolean(tab.blocked);
    $("tab-copy").hidden = tab.restricted || Boolean(tab.blocked) || !connected;
    $("copy-id").textContent = tab.shared ? "Copy tab id" : "Share and copy id";
    $("tab-id").textContent = tab.agentId;
    $("tab-usage").textContent = usageText(tab);
    $("share-storage").checked = tab.storage;
  }

  $("more").hidden = false;
  $("share-window").checked = view.windowShared;
  $("share-all").checked = view.shareAll;
  $("allow-open").checked = view.allowOpen;

  $("shared").hidden = view.shared.length === 0;
  renderShared(view.shared);
}

async function refresh() {
  view = await call("state");
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

async function start() {
  // ?tab=<id> shows another tab (the options page and the tests open the popup as a page).
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) current = await chrome.tabs.get(forced).catch(() => null);
  if (!current) [current] = await chrome.tabs.query({ active: true, currentWindow: true });

  $("connect-button").addEventListener("click", () => void act("connect"));
  $("share-tab").addEventListener("change", (event) => void act("shareTab", { on: event.target.checked }));
  $("share-storage").addEventListener("change", (event) => void act("setStorage", { on: event.target.checked }));
  $("share-window").addEventListener("change", (event) => void act("shareWindow", { on: event.target.checked }));
  $("share-all").addEventListener("change", async (event) => {
    const box = event.target;
    if (box.checked && !(await ask("Let agents use every tab in this browser, including ones you open later? Sites on your blocked list stay off.", "Share every tab"))) {
      box.checked = false;
      return;
    }
    void act("shareAll", { on: box.checked });
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

  await refresh();
  setInterval(() => void refresh(), 1000);
}

void start();
