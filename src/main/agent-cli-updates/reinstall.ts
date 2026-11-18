// The vendor's own bootstrap installer for one version, shown to the user
// when a broken build replaced the previous one in place and nothing on disk
// can put it back. Each form is the one its installer documents:
// claude.ai/install.sh takes the version as its argument ("[stable|latest|VERSION]")
// and install.ps1 as its first parameter; Codex's install.sh takes
// --release and install.ps1 reads CODEX_RELEASE; x.ai/cli/install.sh takes
// the version as its argument ("bash -s 0.1.42"). Grok documents no Windows
// installer, so there is no command for it there.

import type { UpdatableAgentCliToolId } from "@shared/agent-cli-updates";

/** A version as tools publish it; nothing else reaches a command line or a path. */
export const PLAIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Where the native installer keeps one version, beside the build now
 * installed: the version is the only part that changes. Null when the
 * install is not in that layout.
 */
const BUILD_LAYOUTS: Record<UpdatableAgentCliToolId, RegExp> = {
  claude: /^(.*[\\/]\.local[\\/]share[\\/]claude[\\/]versions[\\/])([^\\/]+)()$/i,
  codex: /^(.*[\\/]packages[\\/]standalone[\\/]releases[\\/])([^\\/]+?)((?:-(?:x86_64|aarch64|arm64|i686)-[^\\/]+)?[\\/](?:bin[\\/])?codex(?:\.exe)?)$/i,
  grok: /^(.*[\\/]\.grok[\\/]downloads[\\/]grok-)([^\\/]+?)((?:-(?:linux|darwin|macos|windows|win32)[^\\/]*)?)$/i,
};

export function nativeBuildPath(tool: UpdatableAgentCliToolId, installedRealPath: string, version: string): string | null {
  if (!PLAIN_VERSION.test(version)) return null;
  const match = BUILD_LAYOUTS[tool].exec(installedRealPath);
  return match ? `${match[1]}${version}${match[3]}` : null;
}

export function reinstallCommand(tool: UpdatableAgentCliToolId, version: string, platform: NodeJS.Platform): string | null {
  if (!PLAIN_VERSION.test(version)) return null;
  const windows = platform === "win32";
  switch (tool) {
    case "claude":
      return windows
        ? `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) ${version}`
        : `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`;
    case "codex":
      return windows
        ? `$env:CODEX_RELEASE='${version}'; irm https://chatgpt.com/codex/install.ps1 | iex`
        : `curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${version}`;
    case "grok":
      return windows ? null : `curl -fsSL https://x.ai/cli/install.sh | bash -s ${version}`;
  }
}
