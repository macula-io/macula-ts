#!/usr/bin/env bash
# Cross-verifies pq_hybrid composites (the LAMPS id-MLDSA87-RSA4096-PSS-SHA512)
# both ways between this SDK and macula 12.x, and writes what crossed to
# test/fixtures/macula_12_cross for src/lamps.test.ts to hold:
#
#   1. this SDK makes a pq_hybrid key and signs a message (ts_signed/);
#   2. macula, from hex, in the image macula's own CI runs in, verifies that
#      signature (and refuses it altered), then makes a pq_hybrid key of its
#      own and signs a message (macula_signed/);
#   3. this SDK verifies macula's signature: vitest run src/lamps.test.ts.
#
# Needs npm run build done, and podman. MACULA_CI_IMAGE
# overrides the image; the default is the one macula v12.7.0's test job pins.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${MACULA_CI_IMAGE:-ghcr.io/macula-io/macula-ci-otp@sha256:aff1d39bc4aa29d13044b90b38e9b7f4b757d50818cc11c5bb7e84cdbf82ac70}"
OUT="$ROOT/test/fixtures/macula_12_cross"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cross-verify-macula.XXXXXX")"
trap 'podman unshare rm -rf "$WORK" 2>/dev/null || rm -rf "$WORK"' EXIT

mkdir -p "$OUT/ts_signed" "$OUT/macula_signed"
node "$ROOT/scripts/cross-verify-macula/ts_sign.mjs" "$OUT/ts_signed"

cp -r "$ROOT/scripts/cross-verify-macula/." "$WORK/project"
cp -r "$OUT" "$WORK/cross"
podman run --rm --cpus=4 --memory=8g --user root \
  -v "$WORK:/w:Z" -w /w/project "$IMAGE" sh -euc '
    rebar3 compile >/dev/null
    erl -noshell -pa _build/default/lib/*/ebin \
      -eval "cross_verify_macula:main(\"/w/cross\"), halt()."'
cp "$WORK/cross/macula_signed/"*.bin "$OUT/macula_signed/"

cd "$ROOT" && npx vitest run src/lamps.test.ts
