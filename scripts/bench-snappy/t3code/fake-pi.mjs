#!/usr/bin/env node
// A stand-in for `pi --mode rpc` used to benchmark t3code. Response and event
// shapes come from t3code's own recorded Pi transcript (simple scenario); the
// assistant text is the benchmark's long reply, streamed at a fixed rate.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("0.99.0");
  process.exit(0);
}

const here = new URL(".", import.meta.url).pathname;
const transcript = readFileSync(process.env.FAKE_PI_TRANSCRIPT, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const byLabel = new Map();
for (const entry of transcript) {
  if (entry.type === "emit_inbound" && !byLabel.has(entry.label)) byLabel.set(entry.label, entry.frame);
}
const loadStream = () => JSON.parse(readFileSync(process.env.FAKE_PI_STREAM ?? `${here}stream.json`, "utf8"));
// The harness changes the rate between seeding (fast) and measuring (150/s)
// without restarting t3code, so it is read per turn from a file.
const readRate = () => {
  try {
    return Number(readFileSync(process.env.FAKE_PI_RATE_FILE, "utf8").trim()) || 150;
  } catch {
    return Number(process.env.FAKE_PI_DELTAS_PER_SEC ?? 150);
  }
};
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const clone = (value) => JSON.parse(JSON.stringify(value));

let current = null;
let sessionName = "bench";

function respond(command, request) {
  const template = byLabel.get(`response:${command.type}`);
  const response = template ? clone(template) : { type: "response", command: command.type, success: true };
  response.id = request.id;
  if (command.type === "get_entries") response.data = { entries: [] };
  if (command.type === "get_commands") response.data = { commands: [] };
  if (command.type === "set_session_name") sessionName = command.name ?? sessionName;
  write(response);
}

function startTurn(promptText) {
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  const user = { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() };
  write({ type: "message_start", message: user });
  write({ type: "message_end", message: user });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = { role: "assistant", content: [], api: "openai-completions", provider: "openrouter", model: "deepseek/deepseek-v4-flash", usage, stopReason: "pending", timestamp: Date.now() };
  write({ type: "message_start", message: assistant });
  write({ type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  const chunks = loadStream().chunks;
  const rate = readRate();
  const startedAt = Date.now();
  let index = 0;
  let text = "";
  const finish = (stopReason) => {
    const final = { ...assistant, content: [{ type: "text", text }], stopReason };
    write({ type: "message_update", usage, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
    write({ type: "message_end", message: final });
    write({ type: "turn_end", message: final, toolResults: [] });
    write({ type: "agent_end", messages: [user, final] });
    write({ type: "agent_settled" });
    current = null;
  };
  const tick = () => {
    const due = Math.min(chunks.length, Math.floor(((Date.now() - startedAt) / 1000) * rate) + 1);
    while (index < due) {
      text += chunks[index];
      write({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunks[index] } });
      index += 1;
    }
    if (index >= chunks.length) {
      if (process.env.FAKE_PI_RATE_FILE) {
        try {
          writeFileSync(process.env.FAKE_PI_RATE_FILE.replace(/rate\.txt$/, "last-delta.txt"), String(Date.now()));
        } catch {}
      }
      return finish("stop");
    }
    current.timer = setTimeout(tick, Math.max(1, Math.round(1000 / rate)));
  };
  current = { timer: setTimeout(tick, 0), finish };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === "prompt") {
    write({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    startTurn(String(command.message ?? ""));
    return;
  }
  if (command.type === "abort" && current) {
    clearTimeout(current.timer);
    current.finish("aborted");
  }
  respond(command, command);
});
rl.on("close", () => process.exit(0));
