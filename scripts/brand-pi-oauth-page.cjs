// Put Codara Studio's mark on the page a subscription sign-in ends on.
//
// The last thing a user sees when connecting an account is the browser tab the
// provider redirects to. Pi renders that page itself, with Pi's logo and Pi's
// wording, and it is the same page for every provider — Anthropic, OpenAI,
// OpenRouter, Radius. From Codara's point of view the user never asked for Pi;
// they asked to connect an account to Cora.
//
// There is no seam to do this at runtime. `dist/auth/oauth/oauth-page.js`
// exports two plain functions that every provider flow imports directly, and
// ESM bindings cannot be reassigned from outside the module — Codara imports
// those provider flows into the main process, so there is not even a child
// process whose loader could be hooked. The one place the substitution can
// happen is on disk, before the tree is packaged, which is what this does.
//
// Runs from `postinstall`, so it re-applies after every install and after any
// Pi upgrade, and the patched file is what electron-builder packages.
//
// Two properties keep it safe to leave running unattended:
//
//   * Idempotent. An already-branded file is recognised and skipped, so
//     running twice (or on a tree restored from cache) is a no-op.
//   * Loud. If Pi's module stops looking the way this expects — a renamed
//     export, a restructured file — nothing is written and the script exits
//     non-zero. A silent no-op would ship Pi's mark to users, which is exactly
//     the outcome this exists to prevent.
//
// scripts/test-pi-oauth-branding.cjs asserts the result.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ICON = path.join(ROOT, "build", "icon.png");
// Written into the generated module so an already-branded file is recognised
// without parsing it.
const MARKER = "codara-oauth-brand-v1";

// Both the nested copy (what Codara's runtime resolver imports, under
// pi-coding-agent's own node_modules) and the hoisted one npm may create.
const CANDIDATES = [
  path.join(
    ROOT, "node_modules", "@earendil-works", "pi-coding-agent",
    "node_modules", "@earendil-works", "pi-ai",
    "dist", "auth", "oauth", "oauth-page.js",
  ),
  path.join(
    ROOT, "node_modules", "@earendil-works", "pi-ai",
    "dist", "auth", "oauth", "oauth-page.js",
  ),
];

function logoDataUri() {
  try {
    const bytes = fs.readFileSync(ICON);
    if (bytes.byteLength === 0) return null;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    // The page reads fine without a mark; the wordmark still says who this is.
    return null;
  }
}

// Deliberately mirrors src/main/orchestration/pi-oauth-callback-page.ts, which
// serves the same page for the one flow Codara hosts its own listener for.
// A user who connects two providers should not meet two different pages.
function brandedModule(logo) {
  const mark = logo ? `<img class="mark" src="${logo}" alt="Codara Studio" />` : "";
  return `// Replaced by scripts/brand-pi-oauth-page.cjs — ${MARKER}
//
// Pi's own version of this module renders Pi's logo and wording. Codara ships
// Pi as an implementation detail of Cora, so the sign-in a user started from
// Codara Studio ends on a Codara Studio page. Same exports, same signatures.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(heading, message, details) {
  return \`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codara Studio</title>
  <style>
    :root {
      color-scheme: light dark;
      --page-bg: #ffffff;
      --text: #18181b;
      --text-dim: #52525b;
      --card-border: rgba(24, 24, 27, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: #0b0b0d;
        --text: #fafafa;
        --text-dim: #a1a1aa;
        --card-border: rgba(250, 250, 250, 0.1);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 460px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .mark {
      width: 64px;
      height: 64px;
      margin-bottom: 22px;
      border-radius: 14px;
      border: 1px solid var(--card-border);
    }
    .wordmark {
      margin-bottom: 22px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-dim);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 650;
    }
    p {
      margin: 0;
      font-size: 15px;
      line-height: 1.7;
      color: var(--text-dim);
    }
    .details {
      margin-top: 18px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: var(--text-dim);
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    ${mark}
    <div class="wordmark">Codara Studio</div>
    <h1>\${escapeHtml(heading)}</h1>
    <p>\${escapeHtml(message)}</p>
    \${details ? \`<div class="details">\${escapeHtml(details)}</div>\` : ""}
  </main>
</body>
</html>\`;
}

// Pi passes provider-specific sentences like "Anthropic authentication
// completed. You can close this window." They name the provider, not Pi, so
// they are kept — only the frame around them changes.
export function oauthSuccessHtml(message) {
  return renderPage("Account connected", message);
}

export function oauthErrorHtml(message, details) {
  return renderPage("Sign-in did not complete", message, details);
}
`;
}

// Pi's module, as this script expects to find it. Checked before overwriting so
// an upstream restructure is reported rather than silently clobbered.
function looksLikePiPage(source) {
  return (
    source.includes("export function oauthSuccessHtml") &&
    source.includes("export function oauthErrorHtml")
  );
}

function main() {
  const logo = logoDataUri();
  const present = CANDIDATES.filter((file) => fs.existsSync(file));
  if (present.length === 0) {
    // Pi is a normal dependency; if it is not installed there is nothing to
    // brand and nothing to complain about (postinstall can run mid-install).
    console.log("[brand-pi-oauth] Pi is not installed; nothing to brand.");
    return;
  }

  const branded = brandedModule(logo);
  let written = 0;
  let skipped = 0;
  for (const file of present) {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes(MARKER)) {
      skipped += 1;
      continue;
    }
    if (!looksLikePiPage(source)) {
      console.error(
        `[brand-pi-oauth] ${file} is neither Pi's OAuth page nor Codara's.\n` +
          "Pi's module has changed shape. Re-check " +
          "scripts/brand-pi-oauth-page.cjs against the new source before " +
          "shipping, or users will meet Pi's mark at the end of a sign-in.",
      );
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(file, branded, "utf8");
    // The stale source map would now point at code that is gone; a wrong map is
    // worse than none for anyone debugging this file.
    const map = `${file}.map`;
    if (fs.existsSync(map)) fs.rmSync(map);
    written += 1;
  }

  if (!logo) {
    console.warn("[brand-pi-oauth] build/icon.png unreadable — page ships without the mark.");
  }
  console.log(
    `[brand-pi-oauth] branded ${written} file(s), ${skipped} already branded.`,
  );
}

main();
