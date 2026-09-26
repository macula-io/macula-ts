# macula-ts

[![CI](https://img.shields.io/github/actions/workflow/status/macula-io/macula-ts/ci.yml?branch=main&label=CI)](https://github.com/macula-io/macula-ts/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-24.18%2B-339933?logo=node.js)](https://nodejs.org)
[![zero install scripts](https://img.shields.io/badge/install--scripts-zero-success.svg)](#packaging-genuinely-zero-install-time-scripts)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-support-ea4aaa.svg?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rgfaber)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/macula-ts-full-dark.svg">
    <img src="assets/macula-ts-full-light.svg" alt="Macula" width="320">
  </picture>
</p>

<p align="center">
  <strong>TypeScript SDK for the Macula mesh, via FFI over macula-go</strong>
</p>

---

> **Status, 2026-09-26:** on the **macula 12** wire (post-quantum: ML-DSA-87
> identities, as the ML-DSA-87 + RSA-PSS-4096 composite in `pq_hybrid`, the
> fleet's profile; ML-KEM hybrid key exchange; signed requests), over macula-go's
> pool. Calls and streams by direct dial, serving (under an org or in a node's
> own namespace), publish/subscribe, the DHT and node-served content are
> tested against in-process macula 12 stations on every `npm test`.
> UCAN-gated calls are not here yet; see [Not yet
> implemented](#not-yet-implemented). Releases before 0.18.0 speak the retired
> 10.x wire and cannot reach the current fleet.

## What is this?

A TypeScript SDK for the Macula mesh: a node's key, a pool of links to
stations it pins by node_id, calls and streams that reach a provider by direct
dial, serving procedures, publish/subscribe and the DHT, from Node.js. Built as
an FFI binding over [macula-go](https://github.com/macula-io/macula-go) rather
than a native reimplementation; see below for why.

## Why FFI over macula-go, not a native TypeScript reimplementation

Macula's mesh protocol runs over raw QUIC with a custom ALPN string
(`"macula"`, not `"h3"`) and its own length-prefixed, deterministic-CBOR
frame format — not HTTP/3. Node.js has no mature first-party QUIC stack
that's actually usable for this today:

- `node:quic` (Node's own built-in, experimental module) **does** work at
  the transport level — the QUIC+TLS 1.3 handshake with ALPN `"macula"`
  completes and a bidirectional stream opens against the real production
  stations. But it is absent from every currently-supportable official
  Node binary — compile-time gated out of the Node 24 and 26 LTS lines —
  and the one line that does ship it (Node 25.x) is already past its own
  EOL and crashes the process about a second after a successful
  handshake (a native assertion failure in `Endpoint::FindSession`). Not
  viable to depend on today.
- No actively-maintained pure-JS or WASM QUIC implementation currently
  exposes a public client API with custom-ALPN support (the most promising
  one found, [quico](https://github.com/colocohen/quico), documents custom
  ALPN only on its low-level *server* API — its client convenience API is
  HTTP/3-specific).

macula-go, macula-rust, macula-dotnet, and macula-php have all already
proven this protocol works and are actively maintained. Rather than
reimplement QUIC, TLS 1.3 with a hybrid post-quantum key exchange, deterministic CBOR and signed frames a fifth time in a
language with no mature QUIC story of its own, macula-ts reuses macula-go's
already-proven implementation through macula-go's shared C ABI
([`cabi/macula.h`](https://github.com/macula-io/macula-go/blob/master/cabi/macula.h),
contract in `cabi/CONTRACT.md`), the one C ABI every non-Go SDK binds.

## Sibling SDKs

| Repo | Approach |
|---|---|
| [macula](https://github.com/macula-io/macula) | The reference SDK (Erlang/OTP) |
| [macula-go](https://github.com/macula-io/macula-go) | Go port — same protocol |
| [macula-rust](https://github.com/macula-io/macula-rust) | Native reimplementation (quinn, pure Rust) |
| [macula-dotnet](https://github.com/macula-io/macula-dotnet) | Native reimplementation (System.Net.Quic / msquic) |
| [macula-php](https://github.com/macula-io/macula-php) | FFI binding over macula-go (this package's structural precedent) |
| **macula-ts** | FFI binding over macula-go |
| [macula-station](https://github.com/macula-io/macula-station) | The station: DHT, SWIM, routing, peering |
| [macula-realm](https://github.com/macula-io/macula-realm) | Managed-realm identity + certificate authority |

## Quick start

```bash
npm install @macula-io/ts
```

A node needs a station to link to, **pinned by its node_id**, and the key of
each realm it trusts, which the realm publishes. Its own key is created on
first use and kept in a file readable by its owner only.

```ts
import { NodeKey, Pool, StreamMode } from "@macula-io/ts";

const key = await NodeKey.loadOrCreate("node.key");
const pool = await Pool.connect(key, [{ host: "2600:3c0e::2000:c2ff:fed0:f20b", port: 4433, nodeId: stationId }], {
  realmTrust: [{ realm, key: realmKeyHex }],
});

// A call reaches a provider by direct dial: its advertisement from the DHT,
// trusted only when the realm key authorizes it, and its station dialed.
const answer = await pool.call(realm, "mcl-echo/echo", "hello");

// Publish and subscribe; topics name a kind of fact, ids go in the payload.
const sub = await pool.subscribe(realm, "acme/demo/greeting_sent_v1", (e) => console.log(e.payload));
await pool.publish(realm, "acme/demo/greeting_sent_v1", { text: "hi" });

// Serve in this node's own namespace, ~<node_id>/ring: no org, no realm key.
const served = await pool.serve(realm, pool.ownProcedure("ring"), (r) => ({ answered: r.caller }));

// Streams: a server stream's chunks arrive until its end.
const stream = await pool.openStream(realm, "mcl-tube/watch", StreamMode.Server);
for await (const event of stream) if (event.kind === "end") break;
await stream.free();

await pool.close();
```

Runnable versions are in [`examples/`](examples).

### Coming from 0.17 and earlier

Everything moved to the macula 12 wire, and the API with it. There is no
compatibility layer.

- **New identities.** A macula 12 node_id derives from an ML-DSA-87 key (or the
  LAMPS composite in `pq_hybrid`), so no Ed25519 identity carries over.
  `NodeKey.loadOrCreate(path)` makes a new key file; your old seed files are
  left untouched. **Re-join your realms and re-trust your agents**: anything
  that named your old node_id (trust lists, petnames, realm memberships) must
  be redone with the new one.
- `Identity` is now `NodeKey`; `Session` and `Pool` are one `Pool`, whose seeds
  carry the station's `nodeId` and whose `realmTrust` pins realm keys;
  `callDirect` is simply `call`; `resolveDirect` is `providers`.
- Serving an org procedure needs the realm's org directory and the org's
  delegation to your node in the DHT: a realm admits orgs through a human.

## Architecture

```
src/ (TypeScript API)  ──  addon/binding.cc (N-API)  ──  macula-go cabi (C ABI 1, c-archive)  ──  macula-go pool
```

The addon links macula-go's shared C ABI, built as a c-archive from the
macula-go release in `native/MACULA_GO` (`scripts/build-native.sh`, which
takes macula-go through `go mod download` and the Go checksum database and
checks the release's commit). There is no Go code in this repository. Every Go
value crosses as a handle; payloads cross as JSON with no booleans and bytes
as `{"$bytes": "<base64>"}` both ways (this package turns them into `"0x"`
hex by default, or leaves them tagged with `bytes: "tagged"`); an error
crosses as JSON with a fixed kind, which becomes `ProviderError`,
`RelayError`, `NotSharedError`, `ContentUnavailableError` or a `MaculaError`
carrying the kind. Every call that does network I/O runs on a worker thread
(`Napi::AsyncWorker`) and returns a Promise. The ABI never calls back into
Node: each subscription and served procedure has a thread of its own that
takes from its inbox, with a cancel token of its own, and hands each event,
call and session to JavaScript through a `ThreadSafeFunction`.

## What's implemented

| Primitive | Caller | Provider | Notes |
|---|---|---|---|
| Node keys (`NodeKey`) | ✅ | ✅ | `pq_hybrid` (the fleet's) or `pq_pure`; key files readable by the owner only; `sign` and `NodeKey.verify`, pq_hybrid checked against the LAMPS draft's own vector and cross-verified with macula 12.7.0 |
| Pool of station links (`Pool.connect`) | ✅ | ✅ | Seeds pinned by node_id; realm keys pinned; links redialed with subscriptions and served procedures replayed |
| Calls by direct dial (`call`, `providers`) | ✅ | ✅ | `serve`: a thrown error goes back as `handler_error`; errors arrive as `ProviderError` / `RelayError` |
| A node's own namespace (`ownProcedure`) | ✅ | ✅ | `~<node_id>/<name>`: served and called with no org and no realm key; the node's signature authorizes it |
| Streams (`openStream`, `serveStream`) | ✅ | ✅ | Server, client and bidi; a QUIC stream per session, released on every path |
| Publish/subscribe | ✅ | ✅ | Signed publications, delivered once across links |
| DHT (`findRecord`, `findRecords`, `findRecordsByType`, `putRecord`) | ✅ | — | Records verified before they are handed on |
| Realm proof v2 (`NodeKey.deviceRequestProof`) | ✅ | — | macula-realm#29: a join session over HTTP (`"http"`, the realm's JSON rule) or a membership UCAN over the mesh (`"mesh"`), with its device_info and ttl_seconds, the realm and the procedure signed, and a nonce; the realm's own vector reproduced through macula-go's encoder |
| Node-served content (`shareContent`, `unshareContent`, `getContent`) | ✅ | ✅ | macula 12.6.0 (D27): shared on the node's own `~<node_id>/content_v1` and announced; a fetch checks the block, the manifest and every chunk against the content id, bounded, with no realm key; `NotSharedError` / `ContentUnavailableError` |

## Not yet implemented

- **UCAN-gated calls and serving.** macula 12 uses post-quantum UCANs
  (macula-go#2). Calls carry no token yet, and a gated procedure cannot be
  served.

## Testing

```bash
npm test          # builds native/build (libmacula.a and the teststation), then the offline suite
npm run test:live # one live station, see below
```

`npm test` runs `src/pool.test.ts` against macula-go's own
`teststation/cmd/teststation` at the pinned release, a helper that runs two
in-process macula 12 stations sharing
a DHT, with a test realm that admits the test's provider nodes. It exercises
keys, calls by direct dial and their errors, providers, server and client
streams (and that no stream is left unreleased), pubsub and the DHT, through
the real addon. No network is needed.

`src/lamps.test.ts` holds pq_hybrid, the LAMPS composite
id-MLDSA87-RSA4096-PSS-SHA512, to `draft-ietf-lamps-pq-composite-sigs`' own
vector (the one macula and macula-go check), and to composites that crossed
both ways with macula 12.x. `scripts/cross-verify-macula.sh` renews those: this
SDK signs, macula (from hex, in the image macula's own CI runs in) verifies
and signs its own, and this SDK verifies it.

`src/fleet.live.test.ts` runs against one real station and is not part of
`npm test`. It needs `MACULA_TS_LIVE_SEED` (host:port), `MACULA_TS_LIVE_STATION_ID`
(the station's node_id), `MACULA_TS_LIVE_REALM` and `MACULA_TS_LIVE_REALM_KEY`;
an unset one fails the run naming it. It reads the DHT, calls `mcl-echo/echo`
by direct dial and hears its own publication.
`.github/workflows/live.yml` runs it when dispatched by hand, on an addon it
builds from the commit's source.

## Packaging: genuinely zero install-time scripts

An earlier version of this package used [koffi](https://koffi.dev) (a
generic dynamic FFI bridge) to load `libmacula.so` at runtime. That was
replaced — koffi has its own native `install` script and ships no
prebuilt binaries in its npm tarball, so it inherited the exact class of
npm-install-script friction that
[macula-mcp's better-sqlite3 dependency caused](https://github.com/macula-io/macula-mcp/blob/main/CHANGELOG.md)
before that project moved to `node:sqlite`. No actively-maintained
generic Node FFI library was found that avoids this.

Instead, `addon/binding.cc` is a small addon purpose-built for exactly
macula-ts's own exported functions (not a generic bridge), packaged with
[`prebuildify`](https://github.com/prebuild/prebuildify) +
[`node-gyp-build`](https://github.com/prebuild/node-gyp-build) — the same
pattern used by `sharp`, `bcrypt`, and other native modules that need zero
consumer-side compilation. The compiled `.node` binary for each supported
platform is in the npm package's `prebuilds/` (there is nothing to build or
fetch at a consumer's `npm install`). `package.json` has no `install`,
`postinstall`, `preinstall` or `prepublishOnly` script at all.

Five platforms are covered: `linux-x64`, `linux-arm64`, `darwin-arm64`,
`darwin-x64`, and `win32-x64`. `.github/workflows/prebuild-matrix.yml` builds
each from source on a real GitHub-hosted runner for that platform (cgo needs
the platform's own C toolchain, so no cross-compiling), loads it and generates
a key with it before uploading it. The release workflow attests each prebuild
(build provenance) and packs all five into the package it publishes; CI runs
the same matrix on every push, then installs the packed package into an empty
project and checks the install compiled nothing. Prebuilds are never committed
(macula-ts#2).

## Development

```bash
npm run build:go   # builds native/build (libmacula.a, macula.h, teststation)
                    # from macula-go at native/MACULA_GO -- must run BEFORE
                    # npm install, since binding.gyp's mere presence in
                    # this repo (not in the published package) makes npm
                    # implicitly run `node-gyp rebuild` as part of
                    # install, and that rebuild links against this archive
npm install         # builds the native addon (via the implicit node-gyp
                    # rebuild above) and installs JS deps
npm run typecheck
npm test            # builds native/build first
npm run build:prebuilds   # this platform's prebuild, into prebuilds/ (never committed)
npm run build             # local dev build: addon + tsc
```

Requires Go >=1.27 and a C compiler (to build macula-go's cabi), a C++
toolchain (for `addon/`), and Node
>=24.18.1 (see `engines` in `package.json` — matches the same floor
macula-mcp landed on for `node:sqlite`; earlier Node lines don't ship it).
None of this is required to *consume* the published package — only to
work on macula-ts itself.

## License

Apache-2.0
