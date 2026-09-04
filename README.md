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

> **Status, 2026-09-04:** identity generation, a real transport +
> CONNECT/HELLO handshake, unary RPC (both roles), DHT record
> lookups/publication, pubsub, content transfer, UCAN minting/inspection
> + UCAN-gated calling, and direct-dial (both roles) are all
> **live-verified against the real production fleet**
> (`station-de-frankfurt.macula.io`). Streaming RPC, streaming/content
> direct-dial, cert-chain-authorized direct-dial, and provider-side UCAN
> policy gating don't exist yet — see [What's explicitly not yet
> implemented](#whats-explicitly-not-yet-implemented). Published to npm
> as `@macula-io/ts` with zero install-time scripts — see
> [Packaging](#packaging-genuinely-zero-install-time-scripts). Full
> development history, including every bug found and fixed along the
> way, lives in [CHANGELOG.md](CHANGELOG.md), not here.

## What is this?

A TypeScript SDK for the Macula mesh protocol — real QUIC-based mesh
connectivity from Node.js: identity, sessions, unary RPC, pub/sub,
content transfer, UCAN capability tokens, and direct-dial, all reaching
the real production fleet today. Built as an FFI binding over
[macula-go](https://github.com/macula-io/macula-go) rather than a native
reimplementation — see below for why.

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
| [macula](https://github.com/macula-io/macula) | The reference SDK (Erlang/OTP) |
| [macula-go](https://github.com/macula-io/macula-go) | Go port — same protocol |
| [macula-rust](https://github.com/macula-io/macula-rust) | Native reimplementation (quinn, pure Rust) |
| [macula-dotnet](https://github.com/macula-io/macula-dotnet) | Native reimplementation (System.Net.Quic / msquic) |
| [macula-php](https://github.com/macula-io/macula-php) | FFI binding over macula-go (this package's structural precedent) |
| **macula-ts** | FFI binding over macula-go |
| [macula-station](https://github.com/macula-io/macula-station) | The station: DHT, SWIM, routing, peering |
| [macula-realm](https://github.com/macula-io/macula-realm) | Managed-realm identity + certificate authority |

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
`src/identity.ts` (and everything built on top of it) is the actual
public TypeScript API, never touching the addon directly.

**Memory ownership**, copied from macula-php's `cabi/` rather than
reinvented: every opaque Go value (an identity keypair, a session, or an
inbound "pending call" awaiting a `serve()` handler's reply) crosses the
boundary as a `uintptr_t` from `runtime/cgo.Handle`. Hold it, pass it
back for every operation on that value, and free it exactly once
(`Identity#dispose()` on the TS side; a pending-call handle is freed
automatically by whichever of `macula_pending_call_reply_result`/`_error`
answers it). Fixed-length fields (a 32-byte NodeID or seed) are written
directly into a caller-supplied output buffer. Every exported function
resolves handles through a `recover()`-guarded lookup, never a raw
`cgo.Handle(h)` — `cgo.Handle`'s own `.Value()`/`.Delete()` panic, not
return an error, on a handle this process never issued or already freed.

**RPC payloads cross this boundary as JSON text**, not another handle —
`cabi/wirevalue.go` converts to/from macula-go's `cbor.Value`, ported from
[macula-cli](https://github.com/macula-io/macula-cli)'s
`internal/wirevalue` package (already proven against the same no-bool,
bytes-as-hex-string rules) rather than reinvented. `Session.serve()`
cannot hand a Go closure across the FFI boundary the way `ServeOneCall`
expects, since the actual answer has to come from arbitrary, possibly-
async TypeScript — so `cabi/serve.go` splits that one blocking Go call
into three cgo exports instead (wait-for-call, read the pending call's
procedure/payload, reply), the same split
[macula-php](https://github.com/macula-io/macula-php)'s `cabi/serve.go`
already proved for the identical problem.

Development history (every bug found while building this, and how it was
fixed) is in [CHANGELOG.md](CHANGELOG.md).

## What's implemented

- **Identity** — `Identity.generate()` (a fresh, S/Kademlia
  puzzle-hardened Ed25519 identity), `Identity.fromSeedBytes()`
  (deterministic reconstruction from a saved 32-byte seed),
  `identity.nodeId`/`.privateSeedBytes`/`.dispose()`, and
  `identity.sign(data)` — a generic Ed25519 primitive (no
  application-specific message format baked in; `data` is signed exactly
  as given). Using a disposed `Identity` throws instead of signing with a
  freed handle.
- **Session** — `Session.connect(host, port, identity)` dials a real
  macula-station and completes the CONNECT/HELLO handshake (WebPKI
  trust). `session.remoteAddr`, `session.stationNodeId` (the
  HELLO-verified station identity), `session.close(identity, reason?)`
  (idempotent). Using a session's accessors after `close()` throws
  cleanly rather than crashing.
- **RPC, caller role** — `session.call(procedure, payload, opts?)` sends
  a signed CALL and waits for the matching RESULT/ERROR.
  `payload`/the return value are `JsonValue` (string/number/null/array/
  object — **no boolean**, since macula's wire CBOR has no bool type;
  encode `true`/`false` as `1`/`0` yourself). A BOLT#4 ERROR frame (e.g.
  `unknown_next_peer`) rejects with a `MaculaCallError` carrying the
  numeric `code`, `bolt4Name`, `retryable`, and `detail`. `opts.realm` (a
  64-character hex string) scopes the call to a realm other than the
  all-zero default; `callWithUcan()`/`publish()`/`subscribe()` take the
  identical option.
- **RPC, provider role** — `session.serve(procedure, handler)` advertises
  `procedure` and answers inbound CALLs against it forever, invoking
  `handler(payload)` for each (sync or async). Resolves with an async
  `stop()` that unadvertises and waits for the current poll tick to
  finish. Only one `serve()` per `Session` at a time, and `call()`/
  `serve()` refuse to run concurrently on the same `Session` — both read
  frames off one shared control stream; open a second `Session` for the
  other role.
- **DHT** — `session.findRecordsByType(recordType)`,
  `session.findRecords(key)`, `session.findRecord(key)`, and
  `session.putProcedureAdvertisement(procedure, servingStation, opts?)`/
  `session.putContentAnnouncement(mcid, endpoint, ttlMs?)` — typed
  builders wrapping macula-go's own `dht.NewProcedureAdvertisement`/
  `NewContentAnnouncement` (signed via `dht.Sign`, stored via
  `dht.PutRecord`). There is deliberately no generic
  `putRecord(type, arbitraryPayload)` — a procedure_advertisement/
  content_announcement payload carries raw pubkey/MCID fields that must
  be actual CBOR byte strings, which only the typed builders guarantee.
- **Pubsub** — `session.publish(topic, payload, opts?)` (fire-and-forget,
  no ack on the wire) and `session.subscribe(topic, handler, opts?)`.
  `subscribe()` resolves with an async `stop()` that sends UNSUBSCRIBE
  and does not resolve until the underlying reader goroutine has
  genuinely exited. Only one `subscribe()` (and no active `serve()`) per
  `Session` at a time — `publish()` itself is exempt, since it only ever
  writes, so a `Session` can safely `publish()` on the same topic it's
  `subscribe()`d to.
- **Content transfer** — `session.putContent(data, name?)` /
  `session.getContent(mcid)`, sent on their own dedicated QUIC stream
  (not the shared control stream, so they run safely alongside an active
  `serve()`/`subscribe()`). Data above 256 KiB is chunked and reassembled
  automatically. `mcid` crosses the boundary as a lowercase hex string.
  **This is a one-time TRANSFER mechanism, not durable object storage** —
  a station may forget content after serving it, and there is no
  list/delete operation.
- **UCAN** — `Ucan.mint(issuer, audience, capabilities?, opts?)` (a
  JWT-shaped, EdDSA-signed capability token, UCAN spec `"0.10.0"`) and
  `Ucan.decode(token)` (parses claims WITHOUT verifying signature or
  expiry — `Ucan#isExpired` mirrors macula-go's own semantics). Both are
  pure local operations, no network I/O. `issuer`/`audience` DID strings
  are `did:macula:<hex NodeID>`. `session.callWithUcan(procedure,
  payload, ucanToken, opts?)` attaches a token to an outgoing CALL, for
  invoking a procedure gated behind a provider-side `ucan.Policy.Required`
  policy. **Deliberately places no restriction relating the calling
  identity to the token's own `aud` claim** — macula's UCAN gate is a
  BEARER-token check (verifies signature + expiry against the issuer
  only, never the caller's identity against `aud`), so a client-side
  "does my identity match this token's audience" guard would both reject
  configurations the real wire-level gate accepts and misrepresent a
  security property the mesh doesn't enforce. This SDK does **not**
  expose `ucan.Verify` or `ucan.Policy` — only minting, inspecting, and
  attaching a token are implemented; enforcing one is provider-side, out
  of scope here.
- **Direct-dial** — `session.resolveDirect(procedure, opts?)`,
  `session.callDirect(procedure, payload, opts?)`,
  `session.callDirectWithUcan(procedure, payload, ucanToken, opts?)`
  (caller side) and `session.advertiseDirect(procedure, opts?)` plus a
  standalone `keepAdvertisedDirect(session, procedure, opts?)` helper
  (provider side). Resolves a signed `procedure_advertisement` DHT record
  to its serving station's own signed `station_endpoint`, then dials that
  station directly in one hop instead of depending on advertise-gossip
  having reached whichever station the caller happens to already be
  connected to. Trust is enforced at the application layer: the freshly
  connected peer's HELLO-proven identity is checked against the exact
  pubkey the signed DHT chain resolved. `advertiseDirect()` issues both a
  plain ADVERTISE and the signed DHT record on the same call — both are
  required for `resolveDirect()`+`callDirect()` to actually reach a live
  route. `resolveDirect`/`callDirect`/`callDirectWithUcan`/
  `advertiseDirect` share the same same-Session exclusivity guard as
  `call()`/the DHT methods; a long-lived provider that also serves the
  same procedure needs a separate `Session` (and identity — this fleet
  enforces one connection per identity) to keep re-advertising on, which
  is why `keepAdvertisedDirect()` is a standalone function rather than a
  `Session` method.

- **Pool** — `Pool.connect(seeds, controlIdentity, opts)` holds live
  connections to every configured seed concurrently (not
  dial-one-then-fallback-on-failure), each independently monitored and
  respawned with backoff on disconnect; `publish()`/`call()` fan out
  over live links, `subscribe()` re-establishes automatically on
  reconnect. Ports `macula/src/client/macula_client.erl`'s pool design;
  see `pool.ts`'s own module doc for why it's a set of role-scoped
  `Session`s per seed rather than one, given the single-reader
  constraint below.

Every item above is live-verified against the real production fleet
(`station-de-frankfurt.macula.io`), including negative/error paths and,
where applicable, the actual packaged npm tarball rather than only the
dev build — see [CHANGELOG.md](CHANGELOG.md) for the specific
assertions, bugs found, and fixes for each.

## What's explicitly not yet implemented

Streaming RPC, streaming/content direct-dial (`OpenStreamDirect`,
`PutDirect`/`GetDirect` — plain `Session.call`/`serve` direct-dial is
implemented, see above), cert-chain-authorized direct-dial
(`ResolveWithCertChain`/`CallWithCertChain`/`AdvertiseDirectWithCertChain`
— opt-in even in macula-go itself), provider-side UCAN policy gating
(`ucan.Policy`/`ServeOneCallGated` — this SDK can mint/attach a token but
not enforce one on a served procedure), per-realm `serve`/`advertise`
(these two still only ever use the all-zero realm — `call`/`callWithUcan`/
`publish`/`subscribe`, and DHT's `putProcedureAdvertisement`, all DO now
take an optional realm), a generic "put any DHT record type with an
arbitrary payload" function (see above for why), a `station_endpoint`
record builder (macula-go has none either — stations publish those
themselves, not clients), and `Pinned`/`Insecure` trust modes (`WebPKI`
only so far). Multiple concurrent `subscribe()` topics on one `Session`
still isn't supported at the `Session` level itself — one `subscribe()`
(like one `serve()`) per `Session` at a time; open a second `Session`
for a second topic (`Pool`, above, does exactly this internally to give
each tracked topic its own session). Each of these is a separate, later
slice of work built on top of a working `Session`.

## Testing

```bash
npx vitest run    # default suite, no network
npm run test:live # MACULA_TS_LIVE=1 vitest run src/session.live.test.ts src/rpc.live.test.ts src/dht.live.test.ts src/pubsub.live.test.ts src/content.live.test.ts src/ucan.live.test.ts src/directdial.live.test.ts src/pool.live.test.ts
```

`src/session.live.test.ts`, `src/rpc.live.test.ts`, `src/dht.live.test.ts`,
`src/pubsub.live.test.ts`, `src/content.live.test.ts`,
`src/ucan.live.test.ts`, `src/directdial.live.test.ts`, and
`src/pool.live.test.ts` hit the real
production fleet and are **not** part of default `npm test`/CI — opt in
explicitly, gated behind `MACULA_TS_LIVE`. Same convention as macula-go's
`live` build tag, macula-rust's `#[ignore]`, and macula-dotnet's
`[Trait("Category","Live")]`: real-network tests are written and
runnable, just excluded from the default/CI run so a station outage doesn't
make ordinary CI flaky. `.github/workflows/ci.yml` exposes this as a
manually-triggered (`workflow_dispatch`) job, never run automatically on
push/PR.

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
platform is baked into `prebuilds/` and published as part of the npm
package itself (**not** gitignored — there is nothing to build or fetch
at a consumer's `npm install` time). `package.json` has no `install`,
`postinstall`, or `preinstall` script at all.

Five platforms are covered: `linux-x64`, `linux-arm64`, `darwin-arm64`,
`darwin-x64`, and `win32-x64`. `.github/workflows/prebuilds.yml` builds
each on a real GitHub-hosted runner for that platform (`CGO_ENABLED=1`
needs a matching native C toolchain per target, so cross-compiling
`cabi/`'s Go archive from Linux isn't the right approach here — the same
reason `sharp`/`bcrypt`/etc. use real per-OS runners) and commits the
results back to `main`. `.github/workflows/ci.yml`'s "Confirm the
committed prebuild is not stale" step re-verifies, on every push, that
`linux-x64`'s committed binary still matches a fresh rebuild of current
source, byte for byte. Getting that check — and the Windows build — to
actually hold surfaced three real build-toolchain bugs; see
[CHANGELOG.md](CHANGELOG.md) for the specifics.

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
