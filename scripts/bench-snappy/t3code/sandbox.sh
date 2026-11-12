#!/usr/bin/env bash
# Runs a command inside a bubblewrap sandbox that sees only $T3CODE_BENCH_DIR:
# the real home, /tmp, /run/user (D-Bus, keyring, Wayland) and every sign-in
# are hidden, the environment is cleared, and HOME is the bench folder's own.
# The network stays on (install and build need it). t3code is untrusted code.
set -euo pipefail
T="${T3CODE_BENCH_DIR:?set T3CODE_BENCH_DIR}"
exec bwrap --ro-bind / / --dev /dev --proc /proc \
  --tmpfs /home --tmpfs /tmp --tmpfs /run/user --tmpfs /var/tmp \
  --bind "$T" "$T" \
  --unshare-all --share-net --die-with-parent \
  --clearenv \
  --setenv HOME "$T/home" --setenv USER sandbox --setenv LANG C.UTF-8 \
  --setenv PATH "$T/home/bin:$T/home/.npm-global/bin:$T/node/bin:/usr/bin:/bin" \
  --setenv TMPDIR "$T/home/tmp" \
  --setenv npm_config_prefix "$T/home/.npm-global" \
  --setenv T3CODE_TELEMETRY_ENABLED false \
  --chdir "$T/repo" \
  "$@"
