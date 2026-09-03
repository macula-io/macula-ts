# macula-ts

**Status: early, not feature-complete.** FFI binding over
[macula-go](https://github.com/macula-io/macula-go) via a Go C-shared
library. Identity generation, a real transport + CONNECT/HELLO handshake,
unary RPC (both roles — caller and provider), DHT record lookups/
publication, pubsub (publish/subscribe, both directions), content
transfer, UCAN minting/inspection + UCAN-gated calling, and direct-dial
(resolve + one-hop dial, both roles — caller and provider) against the
production fleet all work end-to-end today. Streaming RPC, streaming/
content direct-dial, cert-chain-authorized direct-dial, and UCAN policy
gating on the *provider* side (this SDK can attach a token to a call, but
cannot yet enforce one on a served procedure) don't exist yet.

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
reinvented: every opaque Go value (an identity keypair, a session, or —
new this slice — an inbound "pending call" awaiting a `serve()` handler's
reply) crosses the boundary as a `uintptr_t` from `runtime/cgo.Handle`.
Hold it, pass it back for every operation on that value, and free it
exactly once (`Identity#dispose()` on the TS side; a pending-call handle
is freed automatically by whichever of `macula_pending_call_reply_result`/
`_error` answers it — see `cabi/serve.go`). Fixed-length fields (a 32-byte
NodeID or seed) are written directly into a caller-supplied output buffer.

**RPC payloads cross this boundary as JSON text**, not another handle —
`cabi/wirevalue.go` converts to/from macula-go's `cbor.Value`, ported from
[macula-cli](https://github.com/macula-io/macula-cli)'s
`internal/wirevalue` package (already proven against the same no-bool,
bytes-as-hex-string rules) rather than reinvented. `Session.call()`'s
provider-side counterpart, `Session.serve()`, cannot hand a Go closure
across the FFI boundary the way `ServeOneCall` itself expects (Go's own
`connection.CallHandler` type) — since the actual answer has to come from
arbitrary, possibly-async TypeScript — so `cabi/serve.go` splits that one
blocking Go call into three cgo exports instead (wait-for-call, read the
pending call's procedure/payload, reply), the same split
[macula-php](https://github.com/macula-io/macula-php)'s `cabi/serve.go`
already proved for the identical problem.

A real bug was found and fixed while building this skeleton: `cgo.Handle`'s
`.Value()` and `.Delete()` **panic** — not return an error — on a handle
this process never issued or already freed. An arbitrary/garbage `uintptr_t`
from the TypeScript side (or a use-after-free) took the whole process down
before this was caught and fixed with a `recover()`-guarded lookup
(`cabi/main.go`'s `identityFromHandle`/`deleteHandle`). Every exported
function resolves handles through those, never through `cgo.Handle(h)`
directly.

## Concurrency safety (fixed after an adversarial review found real bugs)

macula-go's `connection/frame_stream.go` `RecvFrame` mutates a Session's
shared control-stream buffer with no mutex of its own — two reads racing
it can permanently corrupt that Session's stream. Two real, live-measured
bugs from this were found and fixed:

- **Concurrent operations on one Session no longer race or brick it.**
  Previously, `Session.call()`/`callWithUcan()`/the DHT methods only
  refused to run while a `serve()`/`subscribe()` was *already
  registered* — nothing stopped two ordinary `call()`s (or a `call()`
  racing a DHT method) from racing each other, since neither role flag
  was set in that case. Reproduced live: `Promise.all` of 4 concurrent
  `call()`s on one Session left *every later read on that same Session*
  permanently failing to decode any frame at all — not just that one
  batch. Every control-stream-reading operation (`call`, `callWithUcan`,
  the DHT methods, `serve()`'s advertise + each poll tick + unadvertise,
  `subscribe()`'s start + stop) now funnels through one per-Session async
  queue, so only one is ever in flight at a time. `publish()`,
  `putContent()`, `getContent()` are unaffected — they don't read this
  shared stream at all (see their own docs).
- **A subscription whose connection dies is no longer silent.**
  Previously, if the underlying session/connection died while a
  `subscribe()` was active (a station restart, say), the handler was
  never called again, nothing rejected, and — because the subscription's
  `ThreadSafeFunction` deliberately keeps Node's event loop alive for a
  healthy subscription — the process hung forever with no way to notice
  or recover; `Session.close()` on that Session then failed too, leaving
  its handle permanently open. `subscribe()` now takes an optional
  `opts.onClosed(error)` callback, called once if this happens; even
  without it, the subscription now tears itself down automatically and
  correctly the moment the connection dies, and `Session.close()` no
  longer lets a failed subscription teardown stop it from actually
  closing.

Both were reproduced against the real production fleet, fixed, then
re-verified against the same reproduction plus the existing live/offline
suites — see `CHANGELOG.md`'s corresponding entry for the exact
before/after evidence.

## What's implemented

- `Identity.generate()` — mints a fresh, S/Kademlia puzzle-hardened Ed25519
  identity via macula-go's real `identity.Generate()` (not mocked — the
  test suite asserts the puzzle property on the returned NodeID, which a
  stub could not satisfy).
- `Identity.fromSeedBytes()` — deterministic reconstruction from a saved
  32-byte seed.
- `identity.nodeId`, `identity.privateSeedBytes`, `identity.dispose()`.
- `identity.sign(data)` — a generic Ed25519 signing primitive over
  macula-go's `identity.KeyPair.Sign` (a direct `ed25519.Sign` wrapper): no
  application-specific message format is baked in anywhere on this path,
  `data` is signed exactly as given and the raw 64-byte signature comes
  back unmodified. Verified against an independent verifier (Node's own
  `crypto.verify`, not macula-go and not this SDK's own code) that the
  signature is genuinely valid Ed25519 over the exact data and the exact
  public key — a stub returning 64 arbitrary bytes could not survive that
  check, nor tampering with either the data or the signature afterward.
  Deterministic (signing the same data twice yields the same signature,
  since Ed25519 has no per-signature nonce randomness); using a disposed
  `Identity` throws instead of signing with a freed handle.
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

- `session.call(procedure, payload, opts?)` — caller role: sends a signed
  CALL and waits for the matching RESULT or ERROR via macula-go's
  `connection.Session.Call`. `payload`/the return value are `JsonValue`
  (string/number/null/array/object — **no boolean**, since macula's wire
  CBOR has no bool type at all; encode `true`/`false` as `1`/`0`
  yourself). A real BOLT#4 ERROR frame (e.g. `unknown_next_peer` for a
  procedure nobody has advertised) rejects with a `MaculaCallError`
  carrying the numeric `code`, `bolt4Name`, `retryable`, and `detail` —
  not a generic string error. `opts.realm` (a 64-character hex string —
  32 bytes, the same hex convention `DhtRecord`'s `key`/`version`/
  `signature` fields already use) scopes this CALL to a realm other than
  the all-zero default; `callWithUcan()`/`publish()`/`subscribe()` take
  the identical option. `cabi/rpc.go`, `cabi/pubsub.go`, and
  `addon/binding.cc` were, on inspection, already fully wired for an
  optional realm all the way through the FFI boundary — `Session`'s own
  public methods were the only place still hardcoding the all-zero
  realm; this class converts the public hex string to the native layer's
  existing raw-byte convention internally.
- `session.serve(procedure, handler)` — provider role: advertises
  `procedure` (`connection.Session.Advertise`) and answers inbound CALLs
  against it forever (`connection.Session.ServeOneCall`, looped), invoking
  `handler(payload)` for each one — `handler` may be sync or async.
  Resolves with an async `stop()` function that unadvertises the procedure
  and waits for the current poll tick to finish. Only one `serve()`
  registration is allowed per `Session` at a time, and `call()`/`serve()`
  refuse to run concurrently on the same `Session` — both read frames off
  one shared control stream, and mixing roles on it races (matches
  macula-go's own documented limitation on `ServeOneCall`/`Call`); open a
  second `Session` for the other role instead.
- **Live-verified against the real production fleet**: a provider's
  `serve()` answering a caller's `call()` on the same procedure with the
  real round-tripped payload (two real `Session`s, two real identities); a
  `call()` to a procedure nobody has advertised coming back as a real,
  structured `unknown_next_peer` (not a hang); a provider `handler` that
  throws coming back as a real, structured `unknown_error` with the
  thrown message as `detail`. Also probed directly (not just the happy
  path): a JS boolean payload is rejected before ever reaching the wire;
  a second concurrent `serve()` and a `call()` while `serve()` is active
  both throw immediately; a `stop()`ped procedure is genuinely
  unadvertised (a follow-up `call()` to it comes back `unknown_next_peer`,
  not still answered); every new Go-side handle (a "pending call") is
  resolved through the same `recover()`-guarded lookup as identity/session
  handles — a garbage or already-answered handle throws a clean JS error
  instead of crashing the process. `opts.realm` proven to change real wire
  behavior, not just accepted and ignored: the SAME procedure name (via
  `call()` and separately via `callWithUcan()`), advertised once under the
  default realm, answers a `call()` under that same default realm and
  comes back a genuine `unknown_next_peer` under a different, randomly
  generated 32-byte realm — on the same two live `Session`s, ruling out
  "the provider stopped answering" as an alternative explanation. A
  malformed realm (wrong length, non-hex characters) is rejected
  synchronously before ever touching the network.

- DHT record client operations — `session.findRecordsByType(recordType)`,
  `session.findRecords(key)`, `session.findRecord(key)` (macula-go's
  `dht.FindRecordsByType`/`FindRecords`/`FindRecord`, thin CALL wrappers
  to the mesh's own reserved `_dht.*` procedures under the DHT's own
  all-zero realm, threaded internally — never passed from the TS side),
  and `session.putProcedureAdvertisement(procedure, servingStation,
  opts?)` / `session.putContentAnnouncement(mcid, endpoint, ttlMs?)`
  (macula-go's real `dht.NewProcedureAdvertisement`/
  `NewContentAnnouncement` constructors, signed via `dht.Sign` and
  stored via `dht.PutRecord`). There is deliberately no single generic
  `putRecord(type, arbitraryPayload)` — see below.
- **Live-verified against the real production fleet**:
  `findRecordsByType(StationEndpoint)` returns real records the fleet's
  own stations publish, each one's `quic_port` payload field decoded and
  checked as a plausible port number (proof the payload was genuinely
  parsed via `cborToJSON`, not opaquely passed through);
  `putProcedureAdvertisement()` followed by `findRecord()`/
  `findRecords()` on that record's own computed storage key
  round-trips the exact same signed record (`version`/`signature`
  match) with its `procedure_uri` payload field decoded correctly;
  `findRecord()` for a storage key nothing was ever put at resolves
  `null` cleanly, not a hang or a thrown error;
  `putContentAnnouncement()` similarly round-trips through
  `findRecord()` with `endpoint` and `mcid` payload fields intact
  (probed directly during development, not part of the committed
  suite — `findRecordsByType`/`findRecord`/`findRecords`/
  `putProcedureAdvertisement` are the ones this stage's live test
  actually asserts on every run).
- A real bug was found and fixed while building this: a first draft
  exposed one generic `macula_dht_put_record(type, key, payloadJSON,
  ttl)` taking an arbitrary JSON payload for any record type, the same
  shape RPC payloads already use. That's wrong for DHT records
  specifically — `procedure_advertisement`/`content_announcement`
  payloads carry raw 32/34-byte pubkey/MCID fields that MUST be actual
  CBOR byte strings for a real resolver's `bytesField()` reads to
  succeed, and `wirevalue.go`'s `jsonToCbor` (by its own doc) has no
  path that produces CBOR bytes going *in* — only `cborToJSON` produces
  the `"0x"`-hex convention going *out*. The generic path would have
  signed and stored successfully while silently writing those fields as
  CBOR text instead, producing a record no real reader could parse.
  Replaced with two typed builders wrapping macula-go's own
  `dht.NewProcedureAdvertisement`/`NewContentAnnouncement` (which build
  those fields correctly) instead of reimplementing that encoding here.
  A second, separate bug (caught by the live round-trip test itself,
  not by inspection): `NewProcedureAdvertisement`'s `procedureURI` must
  be the realm-qualified `dht.DiscoveryURI(realm, procedure)`, not a
  bare procedure name, or the advertiser and any resolver compute
  different storage keys and `findRecord()` never finds what
  `putProcedureAdvertisement()` just stored — confirmed by first getting
  this wrong in the test itself. Fixed by having
  `putProcedureAdvertisement()` build the qualified URI internally
  (`dht.DiscoveryURI`) from a plain `procedure` string and an optional
  `realm`, rather than trusting every caller to hex-encode and
  concatenate it correctly by hand.

- Pubsub — `session.publish(topic, payload, opts?)` (macula-go's
  `connection.Session.Publish`, fire-and-forget, no ack on the wire) and
  `session.subscribe(topic, handler, opts?)` (macula-go's
  `connection.Session.RunSubscriber`, driving a background reader
  goroutine on the Go side — NOT reimplemented on top of the lower-level
  `RecvEvent`, see `cabi/pubsub.go`'s own doc for why). `subscribe()`
  resolves with an async `stop()` that sends the matching UNSUBSCRIBE
  and does not resolve until that goroutine has genuinely exited — the
  actual guarantee behind "no further event after this", not just "a
  stop was requested". This is the first place in this SDK where the Go
  side calls back INTO JS asynchronously, on its own schedule, rather
  than only ever answering a JS-initiated request — via a
  `Napi::ThreadSafeFunction` wired to that goroutine (`addon/binding.cc`).
  Only one `subscribe()` (and no active `serve()`) is allowed per
  `Session` at a time, for the identical shared-control-stream reason
  `call()`/`serve()` are mutually exclusive; `publish()` itself is NOT
  subject to that guard — it only ever writes, so it can run safely on
  the same `Session` a `subscribe()` of its own is active on (exactly
  what receiving your own publish needs). Both take an `opts.realm` (the
  same 64-character hex convention as `CallOptions.realm`) scoping which
  realm the PUBLISH/SUBSCRIBE is on — omitted means the all-zero realm.
- **Live-verified against the real production fleet**: a `subscribe()`
  receiving that SAME `Session`'s own `publish()` with the exact payload,
  publisher pubkey, and a positive `seq` intact; `stop()` genuinely
  halting delivery, confirmed by publishing again immediately after
  `stop()` resolves and observing nothing further arrive; `subscribe()`
  while `serve()` is active (and vice versa) both throwing immediately,
  matching `call()`'s own exclusivity behavior. Also re-run against the
  actual packaged, installed tarball (not just the dev build) — a real
  publish/subscribe round trip using only the published package, no
  source tree present. `opts.realm` proven to change real wire behavior
  with two simultaneous live subscriptions to the SAME topic on separate
  `Session`s — one on the default realm, one on a different, randomly
  generated 32-byte realm: a `publish()` under the non-default realm is
  delivered ONLY to the subscriber on that realm, and a subsequent
  `publish()` under the default realm is delivered ONLY to the
  default-realm subscriber, each confirmed not to leak to the other.
- A real bug was found and fixed while building this: a still-active
  `subscribe()`'s background reader goroutine holds a live
  `Napi::ThreadSafeFunction`, which — deliberately, unlike every other
  handle this SDK hands out — keeps Node's event loop alive on its own,
  since a program that does nothing but `subscribe()` and wait has
  nothing else to keep it running while events arrive. That same
  property meant closing a `Session` out from under an active
  subscription, without calling its `stop()` first, hung the process
  forever instead of merely leaking a handle — confirmed live (a script
  that `subscribe()`d then `close()`d never exited on its own, even
  after 20s; the identical script with no `subscribe()` at all exited
  instantly). Fixed by having `close()` stop an active subscription
  first, so forgetting the returned `stop()` fails safe instead of fails
  hung; a legitimate "just `subscribe()` and wait" program was
  separately confirmed to still stay alive as long as needed (the fix
  does not unref the `ThreadSafeFunction` itself, which would have
  broken that).

- Content transfer — `session.putContent(data, name?)` / `session.getContent(mcid)`
  (macula-go's `content.Put`/`content.Get`, ordinary CALL/RESULT against
  four reserved `_content.*` procedures — `put_block`/`get_block`/
  `put_manifest`/`get_manifest` — but sent on their OWN dedicated QUIC
  stream, `Session.OpenDedicatedStream`, **not** the shared control
  stream `call()`/`serve()`/the DHT methods/`subscribe()` all read from).
  `data` above `manifest.DefaultChunkSize` (256 KiB) is chunked and
  reassembled automatically, with `name` attached to the resulting
  manifest — a single-block put ignores `name` entirely, matching
  `content.Put`'s own documented behavior. `mcid` crosses the FFI
  boundary as a lowercase hex string (68 hex chars = 34 bytes), the same
  "raw identifier → hex" convention `DhtRecord.key`/`version`/`signature`
  already use. **This is a one-time TRANSFER mechanism, not durable
  object storage** — a station may forget content after serving it, and
  there is no list/delete operation; don't build anything that assumes
  otherwise. Because `Put`/`Get` each open a *fresh* dedicated stream,
  neither is subject to `Session`'s same-Session exclusivity guard —
  `putContent()`/`getContent()` run safely alongside an active
  `serve()`/`subscribe()` (or each other) on the same `Session`, unlike
  `call()`/the DHT methods.
- **Live-verified against the real production fleet**: a 600-byte random
  buffer `putContent()`'d then `getContent()`'d back byte-for-byte
  identical; the same round trip with no `name` given; `getContent()` of
  a well-formed but never-stored mcid rejecting with a typed
  `ContentNotFoundError` (not a generic error or a hang); `putContent()`/
  `getContent()` running successfully while a `serve()` is active on the
  same `Session` (proving the dedicated-stream, no-exclusivity-guard
  claim above, not just asserting it). Handle safety was probed directly
  (garbage session/identity handles, an already-freed identity handle,
  an empty data buffer, and malformed/wrong-length mcid hex) — every
  case rejects with a clean JS error, never a process crash, through the
  same `recover()`-guarded handle lookups `session.call()` already uses
  (content transfer introduces no new Go-side handle type). Also
  re-verified against the actual packaged, installed npm tarball — a
  real `putContent`/`getContent` round trip using only the published
  package, no source tree present.
- A real bug was found and fixed while probing this directly: a
  malformed-but-correctly-decoded-length mcid hex (right byte count,
  garbage bytes) versus a wrong-*length* mcid hex both fell into one
  `fmt.Errorf("...: %w", err)` on the Go side, and the wrong-length case
  passes a `nil` `err` into that `%w` — Go's `fmt` package renders that
  as the literal string `%!w(<nil>)` inside the thrown JS error message.
  Split into two separate, correctly-worded error paths.

- UCAN — `Ucan.mint(issuer, audience, capabilities?, opts?)` (macula-go's
  `ucan.Create`: a JWT-shaped, EdDSA-signed capability token, UCAN spec
  version `"0.10.0"` — the older JWT-based draft macula's whole ecosystem
  uses, not the current non-JWT/IPLD UCAN 1.0 spec) and
  `Ucan.decode(token)` (macula-go's `ucan.Decode` — parses claims WITHOUT
  verifying the signature or checking expiry; `Ucan#isExpired` is a local
  claims check only, mirroring `ucan.IsExpired`'s exact semantics: no
  `exp` claim means never expired, and a token expiring at exactly the
  current second is not YET expired). `issuer`/`audience` DID strings are
  built automatically as `did:macula:<hex NodeID>`, matching macula-go's
  own tests/examples rather than inventing a different convention. Both
  are pure local operations — no network I/O, no station involved, a
  token can be minted entirely offline. This SDK does **not** expose
  `ucan.Verify` or `ucan.Policy` (gating a *served* procedure behind a
  required issuer) — only minting, inspecting, and attaching a token to
  an outgoing call are implemented; enforcing one is provider-side, out
  of scope for this slice.
- `session.callWithUcan(procedure, payload, ucanToken, opts?)` — `call()`,
  attaching a UCAN token to the outgoing CALL (macula-go's
  `connection.Session.CallWithUCAN`), for invoking a procedure a provider
  has gated behind a `ucan.Policy.Required` policy on its own side.
  `ucanToken` accepts either a `Ucan` (its `.token` is attached) or a raw
  token string. **Deliberately places no restriction relating the calling
  identity to the token's own `aud` claim** — this SDK's own research
  into the real verify chain (Erlang's `authorize_policy` +
  `macula_ucan_nif:verify/2`, identical across every SDK port including
  macula-go) established that macula's UCAN gate is a BEARER-token check:
  it verifies the token's signature and expiry against its issuer only,
  never the caller's identity against `aud`. A client-side "does my
  identity match this token's audience" guard would both reject
  configurations the real wire-level gate accepts fine and misrepresent
  a security property the mesh does not actually enforce — so neither
  `Ucan.mint()` nor `callWithUcan()` implements one.
- Introduces **no new Go-side handle type** — `Ucan` carries no `cgo.Handle`
  at all (a minted token crosses the FFI boundary as plain ASCII text,
  decoded claims as JSON), so there is no new handle-safety surface for a
  `cgo.Handle.Value()`/`.Delete()` panic to hide in; `callWithUcan()`
  reuses the same session/identity handles (and their `recover()`-guarded
  lookups) `call()` already uses.
- **Live-verified against the real production fleet**: a freshly minted
  `Ucan` (via `Ucan.mint()`, offline) attached to a real CALL via
  `callWithUcan()` against a real advertised procedure, completing with
  the real round-tripped RESULT payload — proving the client-side
  attach-and-call mechanism reaches the wire and completes end to end;
  the same with a raw token string instead of a `Ucan` object; a call to
  a procedure nobody has advertised still coming back a real, structured
  `unknown_next_peer` (a UCAN token doesn't change ordinary CALL error
  behavior); `opts.realm` changing wire behavior for `callWithUcan()`
  exactly like it does for plain `call()` — the same procedure reachable
  under the default realm and `unknown_next_peer` under a different real
  realm, token attached throughout. **Honest limitation**: this SDK has
  no served-side UCAN
  policy gate (see above), so the live test proves attach-and-call works,
  not that a provider actually *enforces* the token — there is no gated
  procedure on the live fleet this SDK can stand up to prove that side
  without also implementing provider-side gating, which is out of scope
  here. macula-go's own `connection/serve_ucan_test.go` and
  `directdial/directdial_live_test.go` (its `TestLiveDirectDialUCANGatedRoundTrip`)
  already prove the enforcement side of this exact protocol works when a
  gated provider is present — this SDK exercises the same
  `connection.Session.CallWithUCAN` those use, just without a gated peer
  of its own to call.
- `Ucan.mint()`/`Ucan.decode()` were also probed directly, not just the
  happy path: an audience that isn't exactly 32 bytes throws before ever
  reaching the Go side; minting with a disposed `Identity` throws instead
  of touching a freed handle; a garbage/never-issued identity handle
  passed at the native layer throws cleanly instead of crashing the
  process; `decode()` of a malformed (wrong segment count, empty, not
  base64url) token throws instead of returning garbage; `decode()` of a
  token with a tampered payload segment still parses successfully
  (confirms this is genuinely a non-verifying decode, not a
  verify-then-decode that happens to succeed only on well-formed input).

- Direct-dial — `session.resolveDirect(procedure, opts?)`,
  `session.callDirect(procedure, payload, opts?)`,
  `session.callDirectWithUcan(procedure, payload, ucanToken, opts?)`
  (caller side: macula-go's `directdial.Resolve`/`Call`/`CallWithUCAN`)
  and `session.advertiseDirect(procedure, opts?)` plus a standalone
  `keepAdvertisedDirect(session, procedure, opts?)` helper (provider
  side: `directdial.AdvertiseDirect`, and a port of its own
  `KeepAdvertisedDirect` free function). Resolves a signed
  `procedure_advertisement` DHT record to its serving station's own
  signed `station_endpoint`, retrying past DHT-propagation lag
  internally, then dials that station directly in one hop instead of
  depending on ordinary advertise-gossip having reached whichever
  station the caller happens to already be connected to. Trust is
  enforced at the application layer, not the dial's TLS: the freshly
  connected peer's own HELLO-proven identity is checked against the
  exact pubkey the signed DHT chain resolved, entirely inside macula-go
  — this SDK surfaces the outcome (a clean rejection on mismatch), it
  doesn't re-implement the check. `advertiseDirect()` mirrors
  `directdial.AdvertiseDirect` exactly: a plain ADVERTISE **and** a
  signed `procedure_advertisement` DHT record, both on the same call —
  skipping the plain ADVERTISE would let resolve+dial complete cleanly
  against a station with nothing registered to route the CALL to, a real
  bug macula-go fixed live 2026-08-30 (found by verifying an actual
  RESULT came back through direct-dial, not just accepting a clean
  `unknown_next_peer` as proof enough) — this SDK inherits that fix by
  construction.
- `resolveDirect`/`callDirect`/`callDirectWithUcan`/`advertiseDirect` are
  all subject to the same same-Session exclusivity guard `call()`/the
  DHT methods already use, extended to a new case: `advertiseDirect()`'s
  own `PutRecord` CALL must not run on a Session whose receive loop
  belongs to an active `serve()` (its reply would be consumed by
  `serve()`'s poll loop instead and the put would time out) — a
  long-lived provider that also serves the same procedure needs a
  SEPARATE `Session` (and identity — this fleet enforces one connection
  per identity, kicking whichever connects second) to keep
  re-advertising on, which is exactly why `keepAdvertisedDirect()` is a
  standalone function taking whichever `Session` it's given, not a
  `Session` method — mirroring why macula-go's own `KeepAdvertisedDirect`
  is a free function too.
- **Live-verified against the real production fleet, self-contained**:
  every assertion makes its OWN test procedure direct-dial-reachable via
  `advertiseDirect()` first, then reaches it purely through
  `resolveDirect()`/`callDirect()` — proving both roles for real using
  only code this session controls, the same self-verification shape the
  RPC stage's own live test uses for `call()`/`serve()`, not dependent on
  finding a pre-existing direct-dialable procedure on the shared demo
  fleet. `resolveDirect()`'s resolved station checked byte-for-byte
  against the provider `Session`'s own `stationNodeId`, with a real,
  non-empty host and plausible port; `callDirect()` then completes a
  genuine one-hop round trip through that resolved station, the
  provider's `serve()` handler actually invoked and its exact reply
  received back. `callDirectWithUcan()` attaches a freshly minted `Ucan`
  to a real direct-dial CALL and completes it end to end against an
  ungated procedure — same **honest limitation** as plain
  `callWithUcan()`'s own live test: no served-side UCAN policy gate in
  this SDK, so this proves attach-and-call reaches the wire over
  direct-dial, not that a provider enforces the token (macula-go's own
  `directdial_live_test.go`'s `TestLiveDirectDialUCANGatedRoundTrip`
  proves the enforcement side against a real gated provider). A negative
  case was probed directly: `resolveDirect()`/`callDirect()` against a
  procedure nobody ever `advertiseDirect()`d fail with a real, clear
  error after macula-go's own bounded ~5s DHT-retry window — confirmed to
  actually take over a second (not an instant, suspicious client-side
  failure) and confirmed not to hang past that window; `callDirect()`'s
  resulting rejection is a plain `Error`, specifically **not** a
  `MaculaCallError`, since a resolve failure never reaches a real peer at
  all. Also re-verified against the actual packaged, installed npm
  tarball — a real `advertiseDirect()` → `resolveDirect()` →
  `callDirect()` round trip against the live fleet using only the
  installed package, no source tree present.

## What's explicitly not yet implemented

Streaming RPC, streaming/content direct-dial (`OpenStreamDirect`,
`PutDirect`/`GetDirect` — plain `Session.call`/`serve` direct-dial is
implemented, see above), cert-chain-authorized direct-dial
(`ResolveWithCertChain`/`CallWithCertChain`/`AdvertiseDirectWithCertChain`
— Slice 7c Direction B, opt-in even in macula-go itself), provider-side
UCAN policy gating (`ucan.Policy`/`ServeOneCallGated` — this SDK can
mint/attach a token but not enforce one on a served procedure), per-realm
`serve`/`advertise`
(these two still only ever use the all-zero realm — `call`/`callWithUcan`/
`publish`/`subscribe`, and DHT's `putProcedureAdvertisement`, all DO now
take an optional realm), a generic "put any DHT record type
with an arbitrary payload" function (see above for why), a
`station_endpoint` record builder (macula-go has none either — stations
publish those themselves, not clients), and `Pinned`/`Insecure` trust
modes (`WebPKI` only so far). Multiple concurrent `subscribe()` topics on
one `Session` also isn't supported yet — one `subscribe()` (like one
`serve()`) per `Session` at a time; open a second `Session` for a second
topic. Each of these is a separate, later slice of work built on top of a
working `Session`.

## Live tests

`src/session.live.test.ts`, `src/rpc.live.test.ts`, `src/dht.live.test.ts`,
`src/pubsub.live.test.ts`, `src/content.live.test.ts`,
`src/ucan.live.test.ts`, and `src/directdial.live.test.ts` hit the real
production fleet and are **not** part of default `npm test`/CI — opt in
explicitly:

```bash
npm run test:live   # MACULA_TS_LIVE=1 vitest run src/session.live.test.ts src/rpc.live.test.ts src/dht.live.test.ts src/pubsub.live.test.ts src/content.live.test.ts src/ucan.live.test.ts src/directdial.live.test.ts
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

Five platforms are covered: `linux-x64`, `linux-arm64`, `darwin-arm64`,
`darwin-x64`, and `win32-x64` (`git ls-files prebuilds/` shows all five).
`.github/workflows/prebuilds.yml` builds each on a **real** GitHub-hosted
runner for that platform — `CGO_ENABLED=1` needs a matching, native C
toolchain per target, so cross-compiling cabi/'s Go archive from Linux
isn't the right approach here, the same reason `sharp`/`bcrypt`/etc. use
real per-OS runners for this rather than cross-compiling. It's triggered
by a push touching `cabi/`, `addon/`, `binding.gyp`, or `package.json`,
or manually via `workflow_dispatch`; a final job collects whichever
platforms built successfully and commits `prebuilds/` back to `main`
(the workflow doesn't wait for every platform to succeed before
committing the ones that did). `.github/workflows/ci.yml`'s own
"Confirm the committed prebuild is not stale" step re-verifies, on every
push, that `linux-x64`'s committed binary still matches a fresh rebuild
of current source — byte for byte, not just "compiles". Getting that
check to actually hold took two real fixes, both live-verified against
the GitHub Actions build, not assumed:

- Go's default `-buildvcs=auto` stamps the *current* git commit hash
  into the binary. A committed artifact that embeds the hash of the
  tree it was built from is structurally never "not stale" against a
  check run at any later commit — including the very commit that adds
  the file. `build:go` now passes `-buildvcs=false`.
- `-trimpath` normalizes the absolute build-time paths cgo would
  otherwise bake into the object (including its own temp directory),
  standard practice for reproducible Go builds and kept alongside the
  fix above even though it wasn't, on its own, the deciding factor.

Windows needed one more thing `binding.gyp` didn't have: an
`OS=="win"` conditions block (library linking only — `ws2_32`, `ntdll`,
`userenv`, `bcrypt`, the usual set a Go c-archive needs there) and a
portable `build:go` script — npm always runs `package.json` scripts
through `cmd.exe` on Windows regardless of which shell invoked
`npm run`, so the original POSIX inline-env-var syntax
(`CGO_ENABLED=1 go build ...`) failed there even when the enclosing CI
step used an MSYS2 bash shell; replaced with `go env -w CGO_ENABLED=1`
ahead of the build, a single command with no OS-specific quoting.
`cabi`'s archive is built there with a MinGW64 gcc (installed via
`msys2/setup-msys2`, since cgo needs a gcc-compatible compiler and MSVC
— what `node-gyp` itself uses for `addon/binding.cc` — doesn't qualify),
and links cleanly against the MSVC-built addon: the two toolchains'
plain-C, `extern "C"` object output is COFF-format-compatible.

One platform GitHub itself took off the table mid-session: `macos-13`
(the originally-planned plain-Intel runner) queued indefinitely and
never got a runner — GitHub fully retired that image on 2025-12-08.
`macos-15-intel`, GitHub's documented replacement (the last x64 macOS
image it ships, supported until August 2027), picked up a runner
immediately once swapped in.

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
