# macula-ts

**Status: early walking skeleton.** FFI binding over [macula-go](https://github.com/macula-io/macula-go)
via a Go C-shared library, not feature-complete. Right now this package can
do exactly one thing: mint and reconstruct a Macula peer identity. It does
not yet dial a station, speak the CONNECT/HELLO handshake, or make any RPC
call.

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
src/*.ts  --(koffi)-->  build/libmacula.so  --(cgo)-->  macula-go
```

`cabi/` is a Go module that imports `macula-go` and builds with
`go build -buildmode=c-shared` into a C ABI shared library. `src/binding.ts`
loads that library via [koffi](https://koffi.dev) and declares its exact
exported function signatures; `src/identity.ts` (and everything built on top
of it later) is the actual public TypeScript API, never touching the raw
FFI layer directly.

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

## What's explicitly not yet implemented

Everything else every sibling SDK has: the QUIC transport / CONNECT-HELLO
handshake, RPC (`call`/`serve`), pubsub (`publish`/`watch`), DHT
(`find_record`/`put_record`), content transfer, streaming RPC, UCAN,
direct-dial. Each of these is a separate, later slice of work — this repo
only proves the FFI plumbing itself works end-to-end with one real
operation.

## Known packaging gap

`koffi` (the FFI library `src/binding.ts` uses to load `libmacula.so`) has
its own native `install` script (`cnoke.cjs --prebuild --release`) and
ships no prebuilt binaries directly in its npm tarball — meaning it
inherits the same class of npm-install-script friction that
[macula-mcp's better-sqlite3 dependency caused](https://github.com/macula-io/macula-mcp/blob/main/CHANGELOG.md)
before that project moved to `node:sqlite`. There is currently no
equally-capable, actively-maintained Node FFI library that ships genuinely
zero-postinstall-script prebuilts (checked before choosing koffi over the
`ffi-napi`/`node-ffi-napi` family, which are worse on this exact point).
Proper packaging — most likely a dedicated N-API/napi-rs addon published
with per-platform `optionalDependencies` and no install script at all,
mirroring how `@swc/core`/`esbuild` ship — is deferred work, same as the
cross-platform build matrix below.

`npm run build:native` currently only produces a Linux `.so` (this
skeleton's own dev platform). No cross-platform CI build matrix
(`.dylib`/`.dll`, multi-arch) exists yet — `.github/workflows/ci.yml` runs
`ubuntu-latest` only.

## Development

```bash
npm install       # also runs build:native via the "prepare" script
npm run typecheck
npm test
npm run build
```

Requires Go >=1.27 (for `cabi/`) and Node >=24.18.1 (see `engines` in
`package.json` — matches the same floor macula-mcp landed on for
`node:sqlite`; earlier Node lines don't ship it).

## License

Apache-2.0
