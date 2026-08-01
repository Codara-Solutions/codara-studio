import { app } from "electron";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The page the browser lands on at the end of a subscription sign-in. Pi ships
 * its own success page carrying Pi's mark; when Codara owns the loopback
 * listener (see pi-oauth-callback-server.ts) it serves this one instead so the
 * last thing the user sees before returning is Codara Studio.
 */

const LOGO_MAX_BYTES = 512 * 1024;

let cachedLogo: string | null | undefined;

function iconCandidates(): string[] {
  if (app.isPackaged) return [join(process.resourcesPath, "build", "icon.png")];
  // Development and `electron-vite preview` report different application
  // roots, so walk a small bounded ancestor chain rather than guessing one.
  const candidates: string[] = [];
  let current = app.getAppPath();
  for (let depth = 0; depth <= 4; depth += 1) {
    candidates.push(join(current, "build", "icon.png"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

/** The app icon inlined as a data URI — the page must load with no network. */
function codaraLogoDataUri(): string | null {
  if (cachedLogo !== undefined) return cachedLogo;
  cachedLogo = null;
  for (const candidate of iconCandidates()) {
    try {
      const bytes = readFileSync(candidate);
      if (bytes.byteLength === 0 || bytes.byteLength > LOGO_MAX_BYTES) continue;
      cachedLogo = `data:image/png;base64,${bytes.toString("base64")}`;
      break;
    } catch {
      // Try the next candidate; the page reads fine without a mark.
    }
  }
  return cachedLogo;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(heading: string, message: string): string {
  const logo = codaraLogoDataUri();
  return `<!doctype html>
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
  </style>
</head>
<body>
  <main>
    ${logo ? `<img class="mark" src="${logo}" alt="Codara Studio" />` : ""}
    <div class="wordmark">Codara Studio</div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

export function codaraOAuthSuccessHtml(): string {
  return renderPage(
    "Account connected",
    "You can close this tab and return to Codara Studio.",
  );
}

export function codaraOAuthErrorHtml(message: string): string {
  return renderPage("Sign-in did not complete", message);
}
