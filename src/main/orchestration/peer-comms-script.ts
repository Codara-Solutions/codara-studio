// Peer-comms helper script template.
//
// Embedded Node CLI written verbatim into each run's peer-comms directory
// (spark-peer-comms.cjs) so workers can list peers, read their inbox, and
// send/reply/await messages. Extracted from run-store.ts (move-only).

export const PEER_COMMS_HELPER_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function parseArgs(tokens) {
  const out = { _: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function usage() {
  return [
    "Cora peer comms",
    "",
    "Commands:",
    "  list  --dir <peer-comms-dir> [--self <workerTaskId>]",
    "  inbox --dir <peer-comms-dir> --self <workerTaskId> [--limit 20] [--unread] [--mark-read]",
    "  send  --dir <peer-comms-dir> --from <workerTaskId> --to <workerTaskId|all> --subject <text> --body <text>",
    "  send  --dir <peer-comms-dir> --from <workerTaskId> --to <workerTaskId|all> --subject <text> --stdin",
    "  reply --dir <peer-comms-dir> --from <workerTaskId> --to <workerTaskId> --reply-to <msgId> --subject <text> --stdin",
    "  await --dir <peer-comms-dir> --self <workerTaskId> [--from <workerTaskId>] [--reply-to <msgId>] [--timeout 120]",
  ].join("\n");
}

function required(args, name) {
  const value = args[name] || process.env["SPARK_" + name.toUpperCase().replace(/-/g, "_")];
  if (!value || value === true) {
    throw new Error("missing --" + name);
  }
  return String(value);
}

function resolveDir(args) {
  const dir = args.dir || process.env.SPARK_PEER_COMMS_DIR || path.dirname(__filename);
  return path.resolve(String(dir));
}

function ensureDir(dir) {
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now() + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body.trim()));
    if (process.stdin.isTTY) resolve("");
  });
}

function messageId() {
  return "msg-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

function readMessages(dir) {
  const messagesDir = path.join(dir, "messages");
  let names = [];
  try {
    names = fs.readdirSync(messagesDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson(path.join(messagesDir, name), null))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function targetMatches(message, self) {
  const to = message.to;
  if (to === "all" || to === self) return true;
  return Array.isArray(to) && to.includes(self);
}

// Out of the step's group chat: deliberately independent, or simply never
// flagged for it. Both keep the manager channel and lose peer traffic in both
// directions. An absent card means the roster moved on to another step, never
// "not a member" — the run-level registry is rewritten per attempt — so
// absence must stay permissive.
function outOfPeerGroup(card) {
  if (!card) return false;
  return card.isolated === true || card.peers === false;
}

function readAgents(dir) {
  const registry = readJson(path.join(dir, "agents.json"), { agents: [] });
  return Array.isArray(registry.agents) ? registry.agents.filter(Boolean) : [];
}

// A worker outside the chat does not receive peer BROADCASTS: an "all" from a
// peer is peer traffic, and delivering it would hand back through the inbox
// exactly what send refuses. An "all" from the manager always lands.
function deliverable(message, self, excluded) {
  if (!targetMatches(message, self)) return false;
  if (!excluded) return true;
  return message.to !== "all" || message.from === "manager";
}

function renderMessage(message) {
  const head = [
    "[" + message.id + "]",
    String(message.createdAt || ""),
    String(message.from || "?") + " -> " + String(message.to || "?"),
    message.replyTo ? "replyTo=" + message.replyTo : "",
  ].filter(Boolean).join(" ");
  const subject = message.subject ? "Subject: " + message.subject + "\n" : "";
  return head + "\n" + subject + String(message.body || "").trim();
}

async function bodyFromArgs(args) {
  if (args.stdin) return await readStdin();
  if (args.body && args.body !== true) return String(args.body);
  if (args._ && args._.length > 0) return args._.join(" ");
  return "";
}

function commandList(dir, args) {
  const registry = readJson(path.join(dir, "agents.json"), { agents: [] });
  const all = Array.isArray(registry.agents) ? registry.agents.filter(Boolean) : [];
  // Show only who this worker may actually address: the group chat plus the
  // manager. A worker outside the chat sees the manager alone — listing peers
  // it may not message would only invite refused sends.
  const self = args.self && args.self !== true ? String(args.self) : null;
  const selfCard = self ? all.find((agent) => agent.workerTaskId === self) : null;
  const agents = outOfPeerGroup(selfCard)
    ? all.filter((agent) => agent.workerTaskId === "manager")
    : all.filter((agent) => agent.workerTaskId === "manager" || !outOfPeerGroup(agent));
  if (args.json) {
    console.log(JSON.stringify({ ...registry, agents }, null, 2));
    return;
  }
  if (agents.length === 0) {
    console.log("No peer agents registered.");
    return;
  }
  for (const agent of agents) {
    const paths = Array.isArray(agent.allowedPaths) && agent.allowedPaths.length
      ? " paths=" + agent.allowedPaths.join(",")
      : "";
    console.log(
      agent.workerTaskId + " | " +
      (agent.runtime || "?") + " | " +
      (agent.status || "?") + " | " +
      (agent.title || agent.label || "untitled") +
      paths
    );
  }
}

function commandInbox(dir, args) {
  const self = required(args, "self");
  const limit = Math.max(1, Number(args.limit || 20));
  const excluded = outOfPeerGroup(readAgents(dir).find((agent) => agent.workerTaskId === self));
  const messages = readMessages(dir).filter((message) => deliverable(message, self, excluded));
  const filtered = args.unread
    ? messages.filter((message) => !Array.isArray(message.readBy) || !message.readBy.includes(self))
    : messages;
  const selected = filtered.slice(-limit);
  if (args.json) {
    console.log(JSON.stringify(selected, null, 2));
  } else if (selected.length === 0) {
    console.log("No messages for " + self + ".");
  } else {
    console.log(selected.map(renderMessage).join("\n\n---\n\n"));
  }
  if (args["mark-read"]) {
    for (const message of selected) markRead(dir, message, self);
  }
}

function markRead(dir, message, self) {
  const readBy = Array.isArray(message.readBy) ? message.readBy : [];
  if (readBy.includes(self)) return;
  message.readBy = [...readBy, self];
  writeJsonAtomic(path.join(dir, "messages", message.id + ".json"), message);
}

async function commandSend(dir, args, replyTo) {
  const from = required(args, "from");
  const to = required(args, "to");
  const subject = args.subject && args.subject !== true ? String(args.subject) : "";
  const body = await bodyFromArgs(args);
  if (!body.trim()) throw new Error("message body is empty; pass --body or --stdin");
  // Group-chat membership is enforced here as well as in the Pi peer_send tool,
  // because a mixed batch can have one worker on each transport and a rule that
  // only one of them obeys is not a rule. Registry is the single source of
  // truth for both who is independent and who was flagged into the chat.
  const cards = readAgents(dir);
  const selfCard = cards.find((agent) => agent.workerTaskId === from);
  if (outOfPeerGroup(selfCard) && to !== "manager") {
    throw new Error(
      selfCard.isolated
        ? "this task is running independently on purpose: send may only address the manager"
        : "this task is not in the step's worker group chat: send may only address the manager",
    );
  }
  const targetCard = cards.find((agent) => agent.workerTaskId === to);
  if (outOfPeerGroup(targetCard)) {
    throw new Error(
      targetCard.isolated
        ? '"' + to + '" is running independently on purpose and cannot receive peer messages'
        : '"' + to + '" is not in the step\'s worker group chat and cannot receive peer messages',
    );
  }
  const message = {
    id: messageId(),
    createdAt: new Date().toISOString(),
    from,
    to,
    subject,
    body,
    replyTo: replyTo || null,
    // Seed with the sender so a worker's own "all" broadcast never shows up
    // unread in its own inbox/await loop.
    readBy: [from],
  };
  writeJsonAtomic(path.join(dir, "messages", message.id + ".json"), message);
  console.log(message.id);
}

async function commandAwait(dir, args) {
  const self = required(args, "self");
  const from = args.from && args.from !== true ? String(args.from) : null;
  const replyTo = args["reply-to"] && args["reply-to"] !== true ? String(args["reply-to"]) : null;
  const timeoutSeconds = Math.max(1, Number(args.timeout || 120));
  const deadline = Date.now() + timeoutSeconds * 1000;
  const excluded = outOfPeerGroup(readAgents(dir).find((agent) => agent.workerTaskId === self));
  while (Date.now() <= deadline) {
    const messages = readMessages(dir).filter((message) => deliverable(message, self, excluded));
    const match = messages.find((message) => {
      if (from && message.from !== from) return false;
      if (replyTo && message.replyTo !== replyTo) return false;
      if (Array.isArray(message.readBy) && message.readBy.includes(self)) return false;
      return true;
    });
    if (match) {
      console.log(args.json ? JSON.stringify(match, null, 2) : renderMessage(match));
      markRead(dir, match, self);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error("Timed out waiting for peer message.");
  process.exitCode = 2;
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  const dir = resolveDir(args);
  ensureDir(dir);
  if (command === "list") return commandList(dir, args);
  if (command === "inbox") return commandInbox(dir, args);
  if (command === "send") return await commandSend(dir, args, null);
  if (command === "reply") return await commandSend(dir, args, required(args, "reply-to"));
  if (command === "await") return await commandAwait(dir, args);
  throw new Error("unknown command: " + command + "\n\n" + usage());
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
`;
