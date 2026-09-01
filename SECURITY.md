# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability
reporting on this repository (Security tab, "Report a vulnerability", which
opens a draft security advisory visible only to you and the maintainers). Do
not open a public issue for a security problem. There is no dedicated security
email address yet; the advisory flow is the supported channel.

Include what you can: affected version or commit, reproduction steps, and
impact as you understand it. You will get a response in the advisory thread,
and credit in the fix notes unless you ask otherwise.

## Scope

- The Codara Studio desktop application (this repository), including the
  orchestration engine, automations, terminal and remote-access surfaces, the
  bundled MCP server, the Claude Code hook, and the `cora` CLI.
- The release and auto-update pipeline: the build and publish scripts in
  `scripts/`, the GitHub Actions workflows, the update feed, and the
  installers it serves.
- The release infrastructure and the update event feed behind
  `studio.codarasolutions.com`. That server's code is not in this repository;
  reports about it are still welcome here.

Vulnerabilities in third-party dependencies are in scope when Codara Studio
uses the dependency in an exploitable way; otherwise report them upstream.

## What the app exposes locally

Codara Studio runs a loopback HTTP JSON-RPC server for its MCP server, the
`cora` CLI, and the Claude Code hook. It binds to `127.0.0.1` on a random
port, requires a per-process bearer token, and advertises both in
`~/.codarastudio/agent-socket.json` (mode 0600). Any process running as your
user that can read that file can drive the app. Remote access (phone pairing)
uses a Noise IK channel pinned to the desktop's static key; pairing is only
accepted from loopback or private networks and needs your approval in the app.
See `docs/remote-access.md` and `docs/on-your-machine.md`.

## Verifying downloads

macOS builds are code-signed with a Developer ID certificate and notarized by
Apple. Windows builds are currently unsigned; SmartScreen will warn on first
run and the updater cannot verify a publisher signature, so integrity rests on
the hash in the update feed served over HTTPS.

To verify a Windows installer, compare its SHA-512 against the `sha512` field
published for that file in `https://studio.codarasolutions.com/releases/latest.yml`
(macOS: `latest-mac.yml`). The feed stores the hash base64-encoded, so convert
before comparing:

```sh
shasum -a 512 "Codara Studio Setup X.Y.Z.exe" | cut -d' ' -f1 | xxd -r -p | base64
```

On Windows PowerShell:

```powershell
[Convert]::ToBase64String((Get-FileHash -Algorithm SHA512 ".\Codara Studio Setup X.Y.Z.exe").Hash -split '(..)' | ? { $_ } | % { [byte]"0x$_" })
```

The feed and the installer are served from the same origin, so this is an
integrity check against corrupted downloads, not proof of authorship.
