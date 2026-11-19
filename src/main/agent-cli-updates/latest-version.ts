// The newest published version of each agent CLI.
//
// Each lookup is one anonymous GET of a public file that names the package and
// nothing else: npm's registry entry for the package's dist tag, or the Grok
// installer's own channel file. No cookies, no machine or user details.

import { parseCliVersion, type UpdatableAgentCliToolId } from "@shared/agent-cli-updates";

import { NPM_PACKAGES } from "./install-plan";

const FETCH_TIMEOUT_MS = 15_000;
/** A version answer is a few hundred bytes; npm's "latest" document a few KB. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** Claude Code's update channel (its `autoUpdatesChannel` setting). */
export type ClaudeUpdateChannel = "latest" | "stable";

export interface LatestLookup {
  tool: UpdatableAgentCliToolId;
  method: "native" | "npm" | "manual";
  claudeChannel?: ClaudeUpdateChannel;
}

export type FetchText = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

const GROK_CHANNEL_URLS = [
  "https://x.ai/cli/stable",
  "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
];

function registryUrl(pkg: string, tag: string): string {
  return `https://registry.npmjs.org/${pkg}/${tag}`;
}

/** The URLs to try in order; the first that answers with a version wins. */
export function latestVersionUrls(lookup: LatestLookup): string[] {
  // Grok's native installer reads its stable channel file; every other install follows npm.
  if (lookup.tool === "grok" && lookup.method === "native") return [...GROK_CHANNEL_URLS];
  const tag = lookup.tool === "claude" && lookup.claudeChannel === "stable" ? "stable" : "latest";
  return [registryUrl(NPM_PACKAGES[lookup.tool], tag)];
}

function versionFromBody(text: string): string | null {
  const body = text.trim();
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as { version?: unknown };
      return typeof parsed.version === "string" ? parseCliVersion(parsed.version) : null;
    } catch {
      return null;
    }
  }
  // A channel file holds the bare version on its first line.
  const first = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(first) ? first : null;
}

export const defaultFetchText: FetchText = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    credentials: "omit",
    headers: { accept: "application/json, text/plain" },
  });
  return { ok: response.ok, status: response.status, text: await readLimitedText(response, MAX_ANSWER_BYTES) };
};

/** The body as text, refused past `maxBytes` without reading the rest. */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`answered with more than ${Math.round(maxBytes / 1024)} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchLatestVersion(
  lookup: LatestLookup,
  fetchText: FetchText = defaultFetchText,
): Promise<string> {
  const failures: string[] = [];
  for (const url of latestVersionUrls(lookup)) {
    try {
      const response = await fetchText(url);
      if (!response.ok) {
        failures.push(`${new URL(url).host} answered ${response.status}`);
        continue;
      }
      const version = versionFromBody(response.text);
      if (version) return version;
      failures.push(`${new URL(url).host} sent no version`);
    } catch (error) {
      failures.push(`${new URL(url).host}: ${(error as Error).message}`);
    }
  }
  throw new Error(`Could not read the newest version (${failures.join("; ")}).`);
}

/** Claude Code's channel from its settings file's text; "latest" unless it says "stable". */
export function claudeChannelFromSettings(text: string | null): ClaudeUpdateChannel {
  if (!text) return "latest";
  try {
    const parsed = JSON.parse(text) as { autoUpdatesChannel?: unknown };
    return parsed.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}
