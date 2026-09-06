#!/usr/bin/env node
"use strict";

// GitHub's manifest flow requires a signed-in browser. Credentials go directly
// to the environment secret through stdin; no private key is written to disk.
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const REPOSITORY = "Codara-Solutions/codara-studio";
const ENVIRONMENT = "release-tag";

function gh(args, input) {
  const result = spawnSync("gh", args, { input, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`GitHub CLI failed: ${args[0]} ${args[1] || ""} (check your account permissions)`);
  return result.stdout;
}

function configureEnvironment() {
  const route = `repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
  let existing;
  const result = spawnSync("gh", ["api", route], { encoding: "utf8", windowsHide: true });
  if (result.status === 0) existing = JSON.parse(result.stdout);
  else if (!result.stderr.includes("404")) throw new Error("Cannot inspect the release-tag environment");
  if (!existing) {
    gh(["api", "--method", "PUT", route, "--input", "-"], JSON.stringify({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    }));
  } else if (!existing.deployment_branch_policy?.custom_branch_policies) {
    throw new Error("Existing release-tag environment must restrict deployment branches to main");
  }
  const policies = JSON.parse(gh(["api", `${route}/deployment-branch-policies`])).branch_policies;
  if (policies.some((policy) => policy.name !== "main" || policy.type !== "branch")) {
    throw new Error("Existing release-tag environment allows deployments outside the main branch");
  }
  if (!policies.length) gh(["api", "--method", "POST", `${route}/deployment-branch-policies`, "--input", "-"],
    JSON.stringify({ name: "main", type: "branch" }));
}

function setup() {
  configureEnvironment();
  const state = crypto.randomBytes(32).toString("hex");
  let origin, busy = false, configured = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action https://github.com; frame-ancestors 'none'");
    if (req.headers.host !== new URL(origin).host || req.method !== "GET") {
      res.writeHead(403).end("Forbidden"); return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname === `/start/${state}`) {
      const manifest = {
        name: "Codara Studio Release Tags", url: `https://github.com/${REPOSITORY}`,
        description: "Creates release tags for Codara Studio. Install only on codara-studio.",
        public: false, hook_attributes: { url: "https://example.invalid/unused", active: false },
        redirect_url: `${origin}/callback`, default_permissions: { contents: "write", workflows: "write" },
        default_events: [],
      };
      const escaped = JSON.stringify(manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><meta charset="utf-8"><title>Codara Studio release App</title><h1>Set up release tagging</h1><p>This creates a private, organization-owned App with Contents and Workflows write permissions. Install it only on codara-studio.</p><p>The private key is stored directly in the main-only release-tag environment.</p><form method="post" action="https://github.com/organizations/Codara-Solutions/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escaped}"><button>Create App on GitHub</button></form>`);
      return;
    }
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state ||
        !/^[a-f0-9]+$/i.test(url.searchParams.get("code") || "") || busy || configured) {
      res.writeHead(400).end("Invalid or already-used setup callback"); return;
    }
    busy = true;
    try {
      const response = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, {
        method: "POST", headers: { accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`App registration failed: HTTP ${response.status}`);
      const app = await response.json();
      if (app.owner?.login !== "Codara-Solutions" || app.permissions.contents !== "write" ||
          app.permissions.workflows !== "write" || typeof app.pem !== "string") throw new Error("Unexpected App registration");
      gh(["secret", "set", "RELEASE_APP_PRIVATE_KEY", "--repo", REPOSITORY, "--env", ENVIRONMENT], app.pem);
      gh(["variable", "set", "RELEASE_APP_ID", "--repo", REPOSITORY, "--env", ENVIRONMENT, "--body", String(app.id)]);
      app.pem = "";
      configured = true;
      console.log(`Configured App ${app.slug} (${app.id}) in ${ENVIRONMENT}. Install it only on codara-studio.`);
      res.writeHead(303, { Location: `https://github.com/apps/${app.slug}/installations/new` }).end();
    } catch (err) {
      console.error(err.message);
      res.writeHead(500).end("Setup did not finish. See the local terminal for the non-secret error. If the App was created, configure its key in the release-tag environment before retrying.");
    } finally { busy = false; }
  });
  server.listen(0, "127.0.0.1", () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    console.log(`Open ${origin}/start/${state}`);
  });
  setTimeout(() => server.close(), 55 * 60 * 1000).unref();
}

module.exports = { configureEnvironment };
if (require.main === module) {
  try { setup(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
