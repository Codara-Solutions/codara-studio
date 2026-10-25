"use strict";

// `cora tool`: call any codara-studio tool from a shell, for agents that do
// not speak MCP (aider, opencode, amp, gemini, droid, a script). It loads the
// same server module the MCP clients and Cora use, so the tool set, the
// caller's pane and workspace, and the results are identical; only the
// transport differs. Images are saved to files and their paths printed.
//
//   cora tool list                          tools available here
//   cora tool help <name>                   one tool's description and arguments
//   cora tool <name> ['{"json":"args"}'] [--arg value ...]

const fs = require("node:fs");
const path = require("node:path");

const { homeDir } = require("../lib/rpc.cjs");

const USAGE = `usage:
  cora tool list [--json]
  cora tool help <name>
  cora tool <name> ['{"arg":"value"}'] [--arg value ...] [--json]

<name> may drop the codara_ prefix: \`cora tool preview_snapshot\`.
Argument values are read as JSON when they parse (numbers, true, objects),
otherwise as text. A flag with no value is true.`;

function serverScript() {
  const candidates = [
    process.env.CODARA_STUDIO_MCP_SERVER,
    // Packaged: resources/cora-cli/commands -> resources/codara-studio-mcp.
    path.join(__dirname, "..", "..", "codara-studio-mcp", "server.js"),
    // Repository checkout: cli/commands -> resources/codara-studio-mcp.
    path.join(__dirname, "..", "..", "resources", "codara-studio-mcp", "server.js"),
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new UsageError(`Codara's tool server was not found (looked in ${candidates.join(", ")}).`);
  return found;
}

class UsageError extends Error {}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Splits argv into the tool name, its arguments and this command's own flags. */
function parseToolArgs(argv) {
  const own = { json: false, home: undefined };
  const args = {};
  let name = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      own.json = true;
    } else if (token === "--home") {
      own.home = argv[++i];
    } else if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = eq > 0 ? token.slice(2, eq) : token.slice(2);
      if (!key) throw new UsageError(`bad flag ${token}`);
      if (eq > 0) args[key] = parseValue(token.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = parseValue(argv[++i]);
      else args[key] = true;
    } else if (name === null) {
      name = token;
    } else {
      const parsed = parseValue(token);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new UsageError(`arguments must be a JSON object or --flags, not ${JSON.stringify(token)}`);
      }
      Object.assign(args, parsed);
    }
  }
  return { name, args, own };
}

function fullName(name) {
  return name.startsWith("codara_") ? name : `codara_${name}`;
}

function firstSentence(text) {
  const match = /^(.+?[.!?])(\s|$)/s.exec(text || "");
  return (match ? match[1] : text || "").replace(/\s+/g, " ");
}

function extensionFor(mimeType) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
}

/**
 * Turns an MCP tool result into printable lines. Image blocks become files
 * under the Codara home, unless the result already names the file it saved.
 * Text loses its control characters: an error can quote a web page, and an
 * escape sequence in it would act on the terminal that prints it.
 */
function renderResult(result, { outDir, now = Date.now() } = {}) {
  const lines = [];
  const texts = (result.content || []).filter((block) => block.type === "text").map((block) => block.text);
  const named = new Set();
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.path === "string") named.add(parsed.path);
    } catch {
      /* plain text */
    }
  }
  let index = 0;
  for (const block of result.content || []) {
    if (block.type === "text") {
      lines.push(String(block.text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
    } else if (block.type === "image" && typeof block.data === "string") {
      if (named.size) continue;
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${index++}.${extensionFor(block.mimeType)}`);
      fs.writeFileSync(file, Buffer.from(block.data, "base64"));
      lines.push(`image: ${file}`);
    }
  }
  return lines;
}

async function tool(argv) {
  const helpTarget = argv[0] === "help" ? argv[1] : undefined;
  let parsed;
  try {
    parsed = parseToolArgs(argv[0] === "help" ? argv.filter((_, i) => i !== 1) : argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { name, args, own } = parsed;
  if (!name || name === "-h" || name === "--help") {
    console.log(USAGE);
    return;
  }
  if (own.home) process.env.CODARA_HOME_DIR = own.home;
  const server = require(serverScript());
  const tools = server.listTools();

  if (name === "list") {
    if (own.json) {
      console.log(JSON.stringify(tools.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema }))));
      return;
    }
    const width = Math.max(...tools.map((entry) => entry.name.length));
    for (const entry of tools) console.log(`${entry.name.padEnd(width)}  ${firstSentence(entry.description)}`);
    return;
  }

  if (name === "help") {
    const target = helpTarget ? fullName(helpTarget) : null;
    const entry = target && tools.find((candidate) => candidate.name === target);
    if (!entry) {
      console.error(target ? `unknown tool: ${target}. Run \`cora tool list\`.` : USAGE);
      process.exitCode = 2;
      return;
    }
    console.log(`${entry.name}\n\n${entry.description}\n`);
    const schema = entry.inputSchema || {};
    const required = new Set(schema.required || []);
    for (const [key, spec] of Object.entries(schema.properties || {})) {
      const type = spec.enum ? spec.enum.join("|") : spec.type || "any";
      console.log(`  --${key} <${type}>${required.has(key) ? " (required)" : ""}${spec.description ? `  ${spec.description}` : ""}`);
    }
    return;
  }

  const toolName = fullName(name);
  if (!tools.some((entry) => entry.name === toolName)) {
    console.error(`unknown tool: ${toolName}. Run \`cora tool list\`.`);
    process.exitCode = 2;
    return;
  }
  const result = await server.callToolByName(toolName, args);
  if (own.json) {
    console.log(JSON.stringify(result));
  } else {
    for (const line of renderResult(result, { outDir: path.join(homeDir({}), "tool-output") })) console.log(line);
  }
  if (result.isError) process.exitCode = 1;
}

module.exports = { tool, parseToolArgs, renderResult, fullName };
