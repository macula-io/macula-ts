#!/usr/bin/env bash
# Runs the live station tests (src/*.live.test.ts) the one way this repo runs
# them, by hand and in .github/workflows/live.yml alike, so a local run and a
# CI run carry out exactly the same steps.
#
# Run it from a clean checkout of the commit under test. MACULA_TS_LIVE_STATION
# names the station every live test uses, MACULA_TS_LIVE_OTHER_STATION the
# second station the pool's multi-station test connects to. When
# MACULA_TS_LIVE_WAITS names a file, it is emptied, each registration wait is
# recorded there, and the waits are printed at the end.
#
# Steps: check the checkout is clean -> check this machine has a route to both
# stations -> install without building the addon -> check the addon the tests
# load is the committed prebuild -> npm run test:live -> print the waits.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${MACULA_TS_LIVE_STATION:?set MACULA_TS_LIVE_STATION to the host name of the station every live test uses}"
: "${MACULA_TS_LIVE_OTHER_STATION:?set MACULA_TS_LIVE_OTHER_STATION to the host name of a second station}"

# node-gyp-build then never looks in build/, in the checks or in the tests.
export PREBUILDS_ONLY=1

echo "==> Checking the checkout is clean"
if ! git diff --quiet HEAD --; then
  echo "::error::tracked files have changes, so the tests would not run commit $(git rev-parse HEAD)"
  git status --short
  exit 1
fi
if [ -e build ]; then
  echo "::error::build/ exists, so the tests might not load the committed prebuild"
  exit 1
fi
echo "    commit $(git rev-parse HEAD)"

# A UDP connect() sends nothing, but fails at once when this machine has no
# route to the address. That is what a machine without IPv6, such as a
# GitHub-hosted runner, meets with the public stations, which have IPv6
# addresses only. Checked before anything is installed, so it fails in seconds.
echo "==> Checking this machine has a route to both stations"
node -e '
  const dns = require("node:dns/promises");
  const dgram = require("node:dgram");
  const route = (address, family) => new Promise((resolve) => {
    const socket = dgram.createSocket(family === 6 ? "udp6" : "udp4");
    socket.connect(4433, address, (err) => {
      socket.close();
      resolve(err ? err.code || String(err) : null);
    });
  });
  (async () => {
    let failed = false;
    for (const host of process.argv.slice(1)) {
      let addresses;
      try {
        addresses = await dns.lookup(host, { all: true });
      } catch (err) {
        console.log(`::error::${host} does not resolve: ${err.code || err}`);
        failed = true;
        continue;
      }
      const checked = await Promise.all(addresses.map(async (a) => ({ ...a, problem: await route(a.address, a.family) })));
      for (const a of checked) console.log(`    ${host} ${a.address}: ${a.problem ? `no route (${a.problem})` : "route found"}`);
      if (checked.some((a) => !a.problem)) continue;
      const found = checked.map((a) => `${a.address}: ${a.problem}`).join(", ");
      const ipv6Only = checked.every((a) => a.family === 6)
        ? ` ${host} has IPv6 addresses only, so the live tests need a machine with IPv6, and GitHub-hosted runners have none.`
        : "";
      console.log(`::error::this machine has no route to ${host} (${found}).${ipv6Only}`);
      failed = true;
    }
    process.exit(failed ? 1 : 0);
  })();
' "$MACULA_TS_LIVE_STATION" "$MACULA_TS_LIVE_OTHER_STATION"

# binding.gyp makes npm run `node-gyp rebuild` on install, and --ignore-scripts
# stops it, so no build/ directory appears.
echo "==> npm ci --ignore-scripts"
npm ci --ignore-scripts

echo "==> Checking the tests load the committed prebuild"
# Loads the addon the way src/binding.ts does and reports the .node file the
# process actually opened.
loaded=$(node -e '
  require("node-gyp-build")(process.cwd());
  const nodes = process.report.getReport().sharedObjects.filter((p) => p.endsWith(".node"));
  if (nodes.length !== 1) throw new Error(`expected one loaded .node file, found ${nodes.length}: ${nodes.join(", ")}`);
  console.log(nodes[0]);
')
rel=$(realpath --relative-to=. "$loaded")
case "$rel" in
  prebuilds/*/*.node) ;;
  *) echo "::error::the addon loaded from $rel, not from prebuilds/"; exit 1 ;;
esac
loaded_sha=$(sha256sum "$rel" | awk '{print $1}')
committed_sha=$(git cat-file blob "HEAD:$rel" | sha256sum | awk '{print $1}')
echo "    loaded:           $rel"
echo "    sha256 loaded:    $loaded_sha"
echo "    sha256 committed: $committed_sha"
if [ "$loaded_sha" != "$committed_sha" ]; then
  echo "::error::the loaded $rel does not match the committed file"
  exit 1
fi

if [ -n "${MACULA_TS_LIVE_WAITS:-}" ]; then
  : > "$MACULA_TS_LIVE_WAITS"
fi

echo "==> npm run test:live"
status=0
npm run test:live || status=$?

if [ -n "${MACULA_TS_LIVE_WAITS:-}" ]; then
  echo "==> Registration waits"
  if [ -s "$MACULA_TS_LIVE_WAITS" ]; then
    sort "$MACULA_TS_LIVE_WAITS"
  else
    echo "    none recorded"
  fi
fi
exit "$status"
