#!/usr/bin/env bash
# t3code's Electron inside the same sandbox, used by Playwright as the
# executable. Only the X display is shared (its abstract socket lives in the
# network namespace); TMPDIR is /tmp because t3code's socket paths must stay
# under the 108-byte limit. Arguments pass through.
set -euo pipefail
T="${T3CODE_BENCH_DIR:?set T3CODE_BENCH_DIR}"
exec bwrap --ro-bind / / --dev /dev --proc /proc \
  --tmpfs /home --tmpfs /tmp --tmpfs /run/user --tmpfs /var/tmp \
  --bind "$T" "$T" \
  --unshare-user --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup-try --share-net --die-with-parent \
  --clearenv \
  --setenv HOME "$T/home" --setenv USER sandbox --setenv LANG C.UTF-8 \
  --setenv PATH "$T/home/bin:$T/node/bin:/usr/bin:/bin" \
  --setenv TMPDIR /tmp \
  --setenv T3CODE_TELEMETRY_ENABLED false --setenv DISPLAY "${DISPLAY:?}" --setenv XDG_SESSION_TYPE x11 --setenv GDK_BACKEND x11 \
  --setenv XDG_CONFIG_HOME "$T/home/.config" --setenv XDG_DATA_HOME "$T/home/.local/share" \
  --chdir "$T/repo/apps/desktop" \
  "$T/repo/apps/desktop/node_modules/electron/dist/electron" "$@"
