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
  orchestration engine, automations, terminal and remote-access surfaces.
- The release and auto-update pipeline: the build and publish scripts in
  `scripts/`, the update feed, and the installers it serves.
- The webhook receiver and release infrastructure behind
  `studio.codarasolutions.com`.

Vulnerabilities in third-party dependencies are in scope when Codara Studio
uses the dependency in an exploitable way; otherwise report them upstream.

## Verifying downloads

macOS builds are code-signed with a Developer ID certificate and notarized by
Apple. Windows builds are currently unsigned; SmartScreen will warn on first
run. To verify a Windows installer, compare its SHA-512 against the `sha512`
field published for that file in the update feed at
`https://studio.codarasolutions.com/releases/latest.yml` (macOS:
`latest-mac.yml`).
