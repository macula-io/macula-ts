#!/usr/bin/env bash
# Builds the addon's native half from macula-go's shared C ABI (cabi/) at the
# release in native/MACULA_GO ("<tag> <commit>"), into native/build: macula.h
# (the ABI's contract), the teststation the tests drive, and the library the
# addon links. On Linux and macOS that is libmacula.a (c-archive), linked into
# the addon. On Windows it is macula.dll (c-shared) and its import library
# macula.lib: node-gyp links with MSVC, whose C runtime never runs the MinGW
# constructor that starts Go's runtime in a c-archive, so the first call into
# Go would wait for ever; Go's DLL starts its runtime itself. macula-go comes through `go mod download`, which
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
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    (cd "$dir" && go build -trimpath -buildvcs=false -buildmode=c-shared \
      -ldflags="-extldflags=-Wl,--out-implib,$out/macula.lib" -o "$out/macula.dll" ./cabi)
    rm -f "$out/macula.h" ;;
  *)
    (cd "$dir" && go build -trimpath -buildvcs=false -buildmode=c-archive -o "$out/libmacula.a" ./cabi)
    rm -f "$out/libmacula.h" ;;
esac
cp "$dir/cabi/macula.h" "$out/macula.h"
chmod u+w "$out/macula.h"
(cd "$dir" && go build -trimpath -buildvcs=false -o "$out/teststation" ./teststation/cmd/teststation)
echo "build-native: macula-go $tag ($commit) -> $out"
