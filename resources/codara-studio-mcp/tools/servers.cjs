"use strict";

// Dev servers Codara keeps running for a workspace and the status of
// Codara's tools. Names start with codara_terminal_ so Cora loads them with
// the terminal family; each one that starts a process belongs in
// FENCE_BRIDGE_SHELL (resources/pi-cora/worker-policy.ts). Entries follow
// the contract in ./index.cjs.

module.exports = {
  order: 900,
  family: "studio",
  budget: 1040,
  tools: [
    {
      name: "codara_terminal_servers",
      rpc: "terminal.servers",
      description:
        "Dev servers of this workspace, run by Codara apart from any agent so they survive agent restarts. list: id, state, health (port check), url. start: id of a saved one, or command (+cwd, port, env) to save; refuses a second copy or a busy port; waits up to 15 s for ready. stop, restart, logs (since=cursor), save, forget. Env values are never stored.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "start", "stop", "restart", "logs", "save", "forget"] },
          id: { type: "string", description: "From list, or a name for a new server" },
          command: { type: "string" },
          cwd: { type: "string" },
          port: { type: "integer" },
          url: { type: "string" },
          env: { type: "object", description: "NAME: value for this start only" },
          autoStart: { type: "boolean", description: "Start when the workspace opens" },
          since: { type: "integer" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { destructive: true, openWorld: true },
    },
  ],
};
