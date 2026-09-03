# macula-ts

**Status: early, not feature-complete.** FFI binding over
[macula-go](https://github.com/macula-io/macula-go) via a Go C-shared
library. Identity generation and a real transport + CONNECT/HELLO
handshake against the production fleet both work end-to-end today. RPC,
pubsub, DHT, content transfer, streaming, and UCAN don't exist yet.

## Why FFI over macula-go, not a native TypeScript reimplementation

Macula's mesh protocol runs over raw QUIC with a custom ALPN string
(`"macula"`, not `"h3"`) and its own length-prefixed, deterministic-CBOR
frame format — not HTTP/3. Node.js has no mature first-party QUIC stack
that's actually usable for this today:

- `node:quic` (Node's own built-in, experimental module) **does** work at
  the transport level — this was live-tested in the session that produced
  this repo against the real production stations at
  `station-de-frankfurt.macula.io` and `station-de-falkenstein.macula.io`:
  the QUIC+TLS 1.3 handshake with ALPN `"macula"` completes and a
  bidirectional stream opens, once the API is used correctly. But it is
  absent from every currently-supportable official Node binary — it's
  compile-time gated out of the Node 24 and 26 LTS lines, and the one line
  that does ship it (Node 25.x) is already past its own EOL and crashes the
  process about a second after a successful handshake (a native assertion
  failure in `Endpoint::FindSession`, reproduced consistently). Not viable
  to depend on today.
- No actively-maintained pure-JS or WASM QUIC implementation currently
  exposes a public client API with custom-ALPN support (the most promising
  one found, [quico](https://github.com/colocohen/quico), documents custom
  ALPN only on its low-level *server* API — its client convenience API is
  HTTP/3-specific).

macula-go, macula-rust, macula-dotnet, and macula-php have all already
proven this protocol works and are actively maintained. Rather than
reimplement QUIC + deterministic CBOR + Ed25519 framing a fifth time in a
language with no mature QUIC story of its own, macula-ts reuses macula-go's
already-proven implementation through FFI — the same tradeoff
[macula-php](https://github.com/macula-io/macula-php) already made
successfully (see its `cabi/` directory, which this package's own `cabi/`
is structurally modeled on, including its handle-based memory-ownership
convention).

## Sibling SDKs

| Repo | Approach |
|---|---|
| [macula-go](https://github.com/macula-io/macula-go) | Reference implementation |
| [macula-rust](https://github.com/macula-io/macula-rust) | Native reimplementation (quinn, pure Rust) |
| [macula-dotnet](https://github.com/macula-io/macula-dotnet) | Native reimplementation (System.Net.Quic / msquic) |
| [macula-php](https://github.com/macula-io/macula-php) | FFI binding over macula-go (this package's structural precedent) |
| **macula-ts** | FFI binding over macula-go |

## Architecture

```
src/*.ts  --(node-gyp-build)-->  addon/binding.cc (N-API)  --(static link)-->  cabi/  --(cgo)-->  macula-go
```

`cabi/` is a Go module that imports `macula-go` and builds with
`go build -buildmode=c-archive` into a C ABI static archive (`libmacula.a`
+ `libmacula.h`) — not a shared library. `addon/binding.cc` is a small,
purpose-built [node-addon-api](https://github.com/nodejs/node-addon-api)
N-API addon (not a generic FFI bridge) that links `libmacula.a` in
statically, so the resulting `.node` file is self-contained: nothing to
locate or `dlopen` at runtime, no separate shared library to ship
alongside it. `src/binding.ts` loads that addon via
[`node-gyp-build`](https://github.com/prebuild/node-gyp-build) (a
zero-dependency runtime loader) and re-exports its typed functions;
`src/identity.ts` (and everything built on top of it later) is the actual
public TypeScript API, never touching the addon directly.

**Memory ownership**, copied from macula-php's `cabi/` rather than
reinvented: every opaque Go value (currently: an identity keypair) crosses
the boundary as a `uintptr_t` from `runtime/cgo.Handle`. Hold it, pass it
back for every operation on that value, and free it exactly once
(`Identity#dispose()` on the TS side). Fixed-length fields (a 32-byte
NodeID or seed) are written directly into a caller-supplied output buffer.

A real bug was found and fixed while building this skeleton: `cgo.Handle`'s
`.Value()` and `.Delete()` **panic** — not return an error — on a handle
this process never issued or already freed. An arbitrary/garbage `uintptr_t`
from the TypeScript side (or a use-after-free) took the whole process down
before this was caught and fixed with a `recover()`-guarded lookup
(`cabi/main.go`'s `identityFromHandle`/`deleteHandle`). Every exported
function resolves handles through those, never through `cgo.Handle(h)`
directly.

## What's implemented

- `Identity.generate()` — mints a fresh, S/Kademlia puzzle-hardened Ed25519
  identity via macula-go's real `identity.Generate()` (not mocked — the
  test suite asserts the puzzle property on the returned NodeID, which a
  stub could not satisfy).
- `Identity.fromSeedBytes()` — deterministic reconstruction from a saved
  32-byte seed.
- `identity.nodeId`, `identity.privateSeedBytes`, `identity.dispose()`.
- `Session.connect(host, port, identity)` — dials a real macula-station and
  completes the full CONNECT/HELLO handshake via macula-go's
  `connection.Connect` (WebPKI trust). **Live-verified against the real
  production fleet** (`station-de-frankfurt.macula.io:4433`): a real
  Ed25519-signed CONNECT sent, a real HELLO received back and
  signature-verified, in ~70-380ms depending on run. Async on both sides of
  the FFI boundary (`Napi::AsyncWorker`, not a sync call wrapped in
  `Promise.resolve()`) — confirmed directly by measuring the event loop
  kept ticking (a concurrent `setInterval` fired repeatedly) for the full
  duration of an in-flight real `connect()` call, not just assumed from the
  implementation shape.
- `session.remoteAddr`, `session.stationNodeId` (the HELLO-verified station
  identity — proof this is a real application-layer session, not just a
  QUIC/TLS handshake), `session.close(identity, reason?)`.
- Session lifecycle safety, live-verified: using a session's accessors
  after `close()` throws a clean error (not a crash); `close()` is
  idempotent (safe to call twice); 5 consecutive real connect/close cycles
  against the production station ran clean with no leak, crash, or hang.

## What's explicitly not yet implemented

RPC (`call`/`serve`), pubsub (`publish`/`watch`), DHT
(`find_record`/`put_record`), content transfer, streaming RPC, UCAN,
direct-dial, and `Pinned`/`Insecure` trust modes (`WebPKI` only so far).
Each of these is a separate, later slice of work built on top of a working
`Session`.

## Live tests

`src/session.live.test.ts` hits the real production fleet and is **not**
part of default `npm test`/CI — opt in explicitly:

```bash
npm run test:live   # MACULA_TS_LIVE=1 vitest run src/session.live.test.ts
```

Matches macula-rust's `#[ignore]` and macula-dotnet's
`[Trait("Category","Live")]` convention: real-network tests are written and
runnable, just excluded from the default/CI run so a station outage doesn't
make ordinary CI flaky. `.github/workflows/ci.yml` exposes this as a
manually-triggered (`workflow_dispatch`) job, never run automatically on
push/PR.

## Packaging: genuinely zero install-time scripts

An earlier version of this package used [koffi](https://koffi.dev) (a
generic dynamic FFI bridge) to load `libmacula.so` at runtime. That was
replaced — koffi has its own native `install` script
(`cnoke.cjs --prebuild --release`) and ships no prebuilt binaries in its
npm tarball, so it inherited the exact class of npm-install-script
friction that
[macula-mcp's better-sqlite3 dependency caused](https://github.com/macula-io/macula-mcp/blob/main/CHANGELOG.md)
before that project moved to `node:sqlite`. No actively-maintained generic
Node FFI library was found that avoids this (checked; the `ffi-napi`/
`node-ffi-napi` family is worse on this exact point).

Instead, `addon/binding.cc` is a small addon purpose-built for exactly
macula-ts's own exported functions (not a generic bridge), packaged with
[`prebuildify`](https://github.com/prebuild/prebuildify) +
[`node-gyp-build`](https://github.com/prebuild/node-gyp-build) — the same
pattern used by `sharp`, `bcrypt`, and other native modules that need zero
consumer-side compilation. The compiled `.node` binary for each supported
platform is baked into `prebuilds/` and published as part of the npm
package itself (**not** gitignored — that's the point: there is nothing to
build or fetch at a consumer's `npm install` time). `package.json` has no
`install`, `postinstall`, or `preinstall` script at all. This was verified
directly, not assumed: the real packed tarball was installed into a fresh
directory with no source tree present, and confirmed to complete in
under a second with zero compiler invocation and a working end-to-end
call through the addon.

Only `linux-x64` is covered today (this skeleton's own dev platform) — no
cross-platform build matrix (`darwin`/`win32`, `arm64`) exists yet.
`.github/workflows/ci.yml` runs `ubuntu-latest` only, and its own final
step re-verifies the zero-compile consumer install on every push.

## Development

```bash
npm run build:go   # builds cabi/build/libmacula.a -- must run BEFORE
                    # npm install, since binding.gyp's mere presence in
                    # this repo (not in the published package) makes npm
                    # implicitly run `node-gyp rebuild` as part of
                    # install, and that rebuild links against this archive
npm install         # builds the native addon (via the implicit node-gyp
                    # rebuild above) and installs JS deps
npm run typecheck
npm test
npm run build:prebuilds   # regenerate prebuilds/ after touching addon/ or cabi/ -- commit the result
npm run build             # local dev build: addon + tsc
```

Requires Go >=1.27 (for `cabi/`), a C++ toolchain (for `addon/`), and Node
>=24.18.1 (see `engines` in `package.json` — matches the same floor
macula-mcp landed on for `node:sqlite`; earlier Node lines don't ship it).
None of this is required to *consume* the published package — only to
work on macula-ts itself.

## License

Apache-2.0
