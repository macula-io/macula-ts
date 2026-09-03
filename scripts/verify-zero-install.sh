#!/usr/bin/env bash
# Re-verifies this package's zero-install-script property from a fully
# clean tree: a consumer running `npm install @macula-io/ts` must never
# invoke a compiler or run an install script -- the matching prebuild
# for their platform/arch must already be sitting in the published
# tarball (see package.json's "files": ["dist", "prebuilds"] and
# README.md's own packaging section).
#
# Steps: wipe every generated artifact -> rebuild the Go static archive
# and native addon from source -> typecheck -> run the offline test
# suite -> compile the TypeScript output -> build every platform/arch
# prebuild -> pack a real tarball -> install that tarball into a fresh,
# throwaway directory with a verbose install log -> assert that log
# shows no node-gyp/compiler invocation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Removing every generated artifact"
rm -rf node_modules build dist prebuilds cabi/build

# build:go FIRST, then npm install: this REPO's own root has a
# binding.gyp (dev-repo convenience only -- excluded from the published
# tarball, see package.json's "files"), which npm's own node-gyp
# auto-rebuild runs during `npm install` here whether we like it or not;
# that rebuild needs cabi/build/libmacula.a + libmacula.h to already
# exist. This ordering constraint is local-dev-only and is NOT part of
# the zero-install-script property itself -- that property is about the
# PACKED TARBALL's install below, which carries no binding.gyp at all.
echo "==> npm run build:go (so this repo's own dev-only binding.gyp rebuild, triggered by npm install below, has something to link)"
npm run build:go

echo "==> npm install (fetches deps; also runs this repo's dev-only node-gyp rebuild -- irrelevant to the published tarball)"
npm install

echo "==> npx tsc --noEmit"
npx tsc --noEmit

echo "==> npm test (offline suite)"
npm test

echo "==> npx tsc (emit dist/)"
npx tsc

echo "==> npm run build:prebuilds (every platform/arch prebuild via prebuildify)"
npm run build:prebuilds

TARBALL_DIR="$(mktemp -d)"
INSTALL_DIR="$(mktemp -d)"
trap 'rm -rf "$TARBALL_DIR" "$INSTALL_DIR"' EXIT

echo "==> npm pack (into $TARBALL_DIR)"
TARBALL="$(npm pack --pack-destination "$TARBALL_DIR" --silent)"
TARBALL_PATH="$TARBALL_DIR/$TARBALL"
echo "    tarball: $TARBALL_PATH"

echo "==> Installing the packed tarball into a fresh, empty directory: $INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y >/dev/null
INSTALL_LOG="$INSTALL_DIR/install.log"
npm install "$TARBALL_PATH" --loglevel verbose >"$INSTALL_LOG" 2>&1

# Deliberately NOT a bare "node-gyp" match: node-gyp-build (a plain JS
# loader, this package's own runtime dependency) legitimately appears in
# a verbose npm log as a package NAME being fetched/cached -- that line
# is not a compile signal and would be a false positive here. What
# actually indicates a compile is node-gyp being INVOKED (an install/
# postinstall lifecycle script actually running it), or real compiler/
# linker/prebuild-install output.
echo "==> Checking the install log for any compile/node-gyp signal"
COMPILE_SIGNAL_PATTERN='node-gyp rebuild|node-gyp configure|node-gyp build|gyp info|gyp ERR|CXX\(target\)|CC\(target\)|SOLINK_MODULE|make: Entering directory|prebuild-install|> node-gyp'
if grep -Eiq "$COMPILE_SIGNAL_PATTERN" "$INSTALL_LOG"; then
  echo "FAIL: install log shows a compile/node-gyp signal -- zero-install-script property broken:"
  grep -Ein "$COMPILE_SIGNAL_PATTERN" "$INSTALL_LOG"
  exit 1
fi
echo "OK: no compiler/node-gyp invocation in the install log ($INSTALL_LOG)"

echo "==> Loading the installed package and calling a real native export (identityGenerate)"
# Dynamic import() (not require()) deliberately: the installed package is
# ESM ("type": "module", dist/index.js), and this throwaway directory's
# own package.json (from `npm init -y`) defaults to CommonJS -- import()
# works from either module type, require() of an ESM package would not.
node -e "
import('@macula-io/ts').then(({ Identity }) => {
  const id = Identity.generate();
  if (id.nodeId.length !== 32) throw new Error('nodeId not 32 bytes');
  id.dispose();
  console.log('OK: Identity.generate()/dispose() worked from the installed tarball, nodeId is 32 bytes');
}).catch((err) => { console.error(err); process.exit(1); });
"

echo "==> Zero-install-script verification PASSED"
