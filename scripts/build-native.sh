#!/usr/bin/env bash
# Builds the addon's native half from macula-go's shared C ABI (cabi/) at the
# release in native/MACULA_GO ("<tag> <commit>"): libmacula.a (c-archive, linked
# into the addon), macula.h (the ABI's contract) and the teststation the tests
# drive, all into native/build. macula-go comes through `go mod download`, which
# checks it against the Go checksum database, and its origin commit must be
# the one recorded beside the tag. Needs Go 1.27 and a C compiler (cgo).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
read -r tag commit < "$root/native/MACULA_GO"
out="$root/native/build"
mkdir -p "$out"

info="$(cd "$out" && GOFLAGS=-mod=mod go mod download -json "github.com/macula-io/macula-go@$tag")"
dir="$(node -e 'const i=JSON.parse(process.argv[1]); if(i.Error){console.error(i.Error);process.exit(1)} process.stdout.write(i.Dir)' "$info")"
origin="$(node -e 'const i=JSON.parse(process.argv[1]); process.stdout.write((i.Origin && i.Origin.Hash) || "")' "$info")"
if [ "$origin" != "$commit" ]; then
  echo "build-native: macula-go $tag is $origin, native/MACULA_GO records $commit" >&2
  exit 1
fi

export CGO_ENABLED=1
(cd "$dir" && go build -trimpath -buildvcs=false -buildmode=c-archive -o "$out/libmacula.a" ./cabi)
rm -f "$out/libmacula.h"
cp "$dir/cabi/macula.h" "$out/macula.h"
chmod u+w "$out/macula.h"
(cd "$dir" && go build -trimpath -buildvcs=false -o "$out/teststation" ./teststation/cmd/teststation)
echo "build-native: macula-go $tag ($commit) -> $out"
