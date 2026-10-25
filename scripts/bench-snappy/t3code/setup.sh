#!/usr/bin/env bash
# Prepares $T3CODE_BENCH_DIR for the t3code side of the benchmark: clones
# t3code, fetches a checksum-verified Node, installs a fake `pi` that streams
# the benchmark's reply, then installs and builds t3code inside the sandbox.
#
#   T3CODE_BENCH_DIR=/path/to/empty/folder scripts/bench-snappy/t3code/setup.sh
#
# Optional: T3CODE_REF (commit or branch), NODE_VERSION (default 26.12.1).
set -euo pipefail
T="${T3CODE_BENCH_DIR:?set T3CODE_BENCH_DIR}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_VERSION="${NODE_VERSION:-26.12.1}"
mkdir -p "$T/home/bin" "$T/home/tmp"

if [ ! -d "$T/repo/.git" ]; then
  git clone https://github.com/pingdotgg/t3code.git "$T/repo"
fi
if [ -n "${T3CODE_REF:-}" ]; then
  git -C "$T/repo" fetch origin "$T3CODE_REF" && git -C "$T/repo" checkout --detach FETCH_HEAD
fi

if [ ! -x "$T/node/bin/node" ]; then
  archive="node-v$NODE_VERSION-linux-x64.tar.xz"
  (cd "$T" && curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$archive" \
    && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $archive\$" | sha256sum -c - \
    && tar xf "$archive" && mv "node-v$NODE_VERSION-linux-x64" node && rm "$archive")
fi

cp "$HERE/fake-pi.mjs" "$T/home/bin/fake-pi.mjs"
cat > "$T/home/bin/pi" <<PI
#!/bin/sh
export FAKE_PI_TRANSCRIPT="$T/repo/apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson"
export FAKE_PI_STREAM="$T/home/bin/stream.json"
export FAKE_PI_RATE_FILE="$T/home/bin/rate.txt"
exec node "\$(dirname "\$0")/fake-pi.mjs" "\$@"
PI
chmod +x "$T/home/bin/pi"

pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$T/repo/package.json")"
"$HERE/sandbox.sh" npm install -g "pnpm@$pnpm_version"
"$HERE/sandbox.sh" pnpm install --frozen-lockfile
"$HERE/sandbox.sh" bash -c 'pnpm --filter @t3tools/desktop run ensure:electron && pnpm run build:desktop'
git -C "$T/repo" log -1 --format='t3code ready at %H (%cd)'
