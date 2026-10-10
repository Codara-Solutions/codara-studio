#!/usr/bin/env node
"use strict";

// The Capability Center's "Paste a config snippet" box hands whatever a README
// published to src/main/mcp-snippet.ts. This drives the parser directly over
// the shapes users actually copy: Claude/Cursor/VS Code JSON (whole files and
// cut-out fragments), Codex TOML tables, `claude mcp add`, `claude mcp
// add-json`, `codex mcp add`, and a bare command line or URL. Nothing is run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const cache = new Map();
function loadTs(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (cache.has(resolved)) return cache.get(resolved);
  const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    fileName: resolved,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (specifier.startsWith("./")) {
      const candidate = path.join(path.dirname(resolved), `${specifier}.ts`);
      if (fs.existsSync(candidate)) return loadTs(candidate);
    }
    return nativeRequire(specifier);
  };
  cache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  return loaded.exports;
}

const { parseMcpSnippet, splitShellWords } = loadTs(path.join(__dirname, "..", "src", "main", "mcp-snippet.ts"));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};
const servers = (text) => {
  const result = parseMcpSnippet(text);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return result;
};

check("a Claude Desktop mcpServers block yields every server", () => {
  const result = servers(`{
    "mcpServers": {
      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "ghp_x" } },
      "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer t" } }
    }
  }`);
  assert.deepEqual(result.servers, [
    { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_x" } },
    { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer t" } },
  ]);
});

check("VS Code's servers and mcp.servers maps are read too", () => {
  assert.equal(servers(`{ "servers": { "a": { "command": "a-bin" } } }`).servers[0].name, "a");
  assert.equal(servers(`{ "mcp": { "servers": { "b": { "url": "https://b.example/mcp" } } } }`).servers[0].transport, "http");
});

check("a fragment cut out of a map, with its trailing comma, still parses", () => {
  const result = servers(`"playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },`);
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].name, "playwright");
  assert.deepEqual(result.servers[0].args, ["@playwright/mcp@latest"]);
});

check("a single unnamed server object leaves the name for the user", () => {
  const result = servers(`{ "command": "uvx", "args": ["mcp-server-fetch"] }`);
  assert.equal(result.servers[0].name, "");
  assert.equal(result.servers[0].command, "uvx");
});

check("SSE and working directories are kept honest in the notes", () => {
  const result = servers(`{ "mcpServers": { "s": { "type": "sse", "url": "https://s.example/sse" }, "c": { "command": "x", "cwd": "/tmp" } } }`);
  assert.equal(result.servers[0].transport, "http");
  assert.ok(result.notes.some((note) => /SSE/.test(note)));
  assert.ok(result.notes.some((note) => /working directory/.test(note)));
});

check("a Codex TOML table is read with the real parser", () => {
  const result = servers(`[mcp_servers.docs]
command = "npx"
args = [
  "-y",
  "docs-mcp",
]
env = { API_KEY = "k" }
`);
  assert.deepEqual(result.servers, [
    { name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { API_KEY: "k" } },
  ]);
});

check("claude mcp add maps options and stops parsing them after the command", () => {
  const stdio = servers(`claude mcp add -s user -e API_KEY=abc github -- npx -y @modelcontextprotocol/server-github`);
  assert.deepEqual(stdio.servers[0], {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { API_KEY: "abc" },
  });
  assert.ok(stdio.notes.some((note) => /scope/.test(note)));
  // No `--`: the server's own flags (`-y`) still belong to the server.
  const bare = servers(`claude mcp add fetch uvx -y mcp-server-fetch --verbose`);
  assert.deepEqual(bare.servers[0].args, ["-y", "mcp-server-fetch", "--verbose"]);
  const http = servers(`claude mcp add --transport http -H "Authorization: Bearer abc" sentry https://mcp.sentry.dev/mcp`);
  assert.deepEqual(http.servers[0], {
    name: "sentry",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    headers: { Authorization: "Bearer abc" },
  });
});

check("claude mcp add-json reads the quoted JSON", () => {
  const result = servers(`claude mcp add-json weather '{"type":"stdio","command":"/usr/local/bin/weather","args":["--units","metric"]}'`);
  assert.equal(result.servers[0].name, "weather");
  assert.deepEqual(result.servers[0].args, ["--units", "metric"]);
});

check("codex mcp add handles env, url and bearer token variables", () => {
  const stdio = servers(`codex mcp add docs --env TOKEN=t -- npx -y docs-mcp`);
  assert.deepEqual(stdio.servers[0], { name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "t" } });
  const http = servers(`codex mcp add remote --url https://r.example/mcp --bearer-token-env-var R_TOKEN`);
  assert.deepEqual(http.servers[0], {
    name: "remote",
    transport: "http",
    url: "https://r.example/mcp",
    headers: { Authorization: "Bearer ${R_TOKEN}" },
  });
});

check("a bare command line or URL becomes an unnamed draft", () => {
  assert.deepEqual(servers(`npx -y @upstash/context7-mcp`).servers[0], {
    name: "",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env: undefined,
  });
  assert.equal(servers(`https://mcp.example.com/mcp`).servers[0].transport, "http");
});

check("shell words honor quotes, escapes and line continuations", () => {
  assert.deepEqual(splitShellWords(`a 'b c' "d \\"e\\"" f\\ g \\\n h`), ["a", "b c", 'd "e"', "f g", "h"]);
  assert.throws(() => splitShellWords(`a "b`), /unclosed quote/);
});

check("text that is not a server definition is refused with a reason", () => {
  for (const text of ["", "   ", `{ "name": "x" }`, `{ not json`, `claude mcp list`, `claude mcp add onlyname`]) {
    const result = parseMcpSnippet(text);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(text)}`);
    assert.ok(result.error.length > 0);
  }
  assert.equal(parseMcpSnippet("x".repeat(70 * 1024)).ok, false);
});

console.log(`PASS mcp snippet parsing (${passed} checks)`);
