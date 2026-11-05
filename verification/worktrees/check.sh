#!/bin/sh
# Model-check the worktree lifecycle specs with TLC, in Docker, with limits.
#
#   verification/worktrees/check.sh                           # every config
#   verification/worktrees/check.sh WorktreeLifecycle_auto    # one config (name without .cfg)
#
# Each .cfg says on its first line what TLC must answer: `pass`, the name of
# the invariant it must break, `deadlock`, or `temporal`. The script fails if
# any answer differs, so a model that stops catching a known bug fails too.
# Counterexamples are written to verification/worktrees/out/<config>.out.
#
# Limits: TLC_CPUS (default 4) and TLC_MEM (default 4g) cap the container.
# TLC_LOCAL=1 runs TLC with the `java` on PATH instead of Docker (CI runners
# have no Docker daemon). The pod's own CPU and memory limits are the cap; the
# heap is TLC_MEM and each config gets TLC_TIMEOUT seconds (default 900).
# Downloads once: tla2tools.jar (2.3 MB) into ~/.cache/codara-tla, and the
# Java image (about 90 MB compressed) on first use.
set -eu

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
IMAGE=eclipse-temurin:21-jre@sha256:0b99b3376fbb50dbf9c0af8535fdd5b8eb0d3fdfc8b1e4967f383b6919f6901a
CPUS=${TLC_CPUS:-4}
MEM=${TLC_MEM:-4g}

here=$(cd "$(dirname "$0")" && pwd)
cache=${XDG_CACHE_HOME:-$HOME/.cache}/codara-tla
jar=$cache/tla2tools-$TLA_VERSION.jar
out=$here/out
mkdir -p "$cache" "$out"

if [ ! -f "$jar" ]; then
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  echo "$TLA_SHA256  $jar.part" | sha256sum -c --quiet - || { rm -f "$jar.part"; echo "tla2tools.jar checksum mismatch" >&2; exit 1; }
  mv "$jar.part" "$jar"
fi
echo "$TLA_SHA256  $jar" | sha256sum -c --quiet - || { echo "tla2tools.jar checksum mismatch: delete $jar" >&2; exit 1; }

if [ $# -gt 0 ]; then configs="$*"; else configs=$(cd "$here" && ls *.cfg | sed 's/\.cfg$//'); fi

heap=$(echo "$MEM" | sed 's/g$//')
heap=$((heap * 3 / 4))g
failed=0
for name in $configs; do
  cfg=$here/$name.cfg
  [ -f "$cfg" ] || { echo "no such config: $name" >&2; exit 2; }
  module=${name%%_*}
  expect=$(sed -n '1s/^\\\* expect: \([A-Za-z]*\)$/\1/p' "$cfg")
  if [ -z "$expect" ]; then
    echo "FAIL  $name: its first line must be \\* expect: <pass|deadlock|temporal|InvariantName>" >&2
    failed=1
    continue
  fi
  # A config that must fail runs on one worker, so its counterexample is the
  # same on every run; the passing ones are the big ones and use them all.
  if [ "$expect" = pass ]; then workers=$CPUS; else workers=1; fi
  start=$(date +%s)
  if [ "${TLC_LOCAL:-}" = 1 ]; then
    meta=$(mktemp -d)
    (cd "$here" && timeout "${TLC_TIMEOUT:-900}" java -XX:+UseParallelGC "-Xmx$heap" -cp "$jar" tlc2.TLC \
      -workers "$workers" -metadir "$meta" -config "$name.cfg" "$module.tla") > "$out/$name.out" 2>&1 || true
    rm -rf "$meta"
  else
    docker run --rm --cpus "$CPUS" -m "$MEM" --network none \
      -v "$jar:/tla/tla2tools.jar:ro" -v "$here:/spec:ro" -w /spec "$IMAGE" \
      java -XX:+UseParallelGC "-Xmx$heap" -cp /tla/tla2tools.jar tlc2.TLC \
        -workers "$workers" -metadir /tmp/tlc -config "$name.cfg" "$module.tla" > "$out/$name.out" 2>&1 || true
  fi
  took=$(( $(date +%s) - start ))
  if grep -q "No error has been found" "$out/$name.out"; then got=pass
  elif grep -q "Deadlock reached" "$out/$name.out"; then got=deadlock
  elif grep -q "Temporal properties were violated" "$out/$name.out"; then got=temporal
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$out/$name.out" | head -1)
  fi
  states=$(sed -n 's/^\([0-9]*\) states generated, \([0-9]*\) distinct.*/\2 states/p' "$out/$name.out" | tail -1)
  if [ -n "$got" ] && [ "$got" = "$expect" ]; then
    printf 'ok    %-38s %-26s %s, %ss\n' "$name" "$expect" "${states:-?}" "$took"
  else
    printf 'FAIL  %-38s expected %s, got %s (see %s)\n' "$name" "$expect" "${got:-error}" "out/$name.out"
    failed=1
  fi
done
exit $failed
