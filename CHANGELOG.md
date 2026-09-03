# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-09-03

DHT record client operations, live-verified against the real production
fleet. Builds directly on 0.4.0's RPC layer -- `dht.FindRecord`/
`FindRecords`/`FindRecordsByType`/`PutRecord` (macula-go's `dht` package)
are themselves thin CALL wrappers to the mesh's own reserved `_dht.*`
procedures, so this composes with `connection.Session` exactly like
`Session.call()` does, no new transport-level plumbing.

### Added

- `cabi/dht.go`: `macula_dht_find_records_by_type`, `macula_dht_find_records`,
  `macula_dht_find_record` -- thin wrappers over `dht.FindRecordsByType`/
  `FindRecords`/`FindRecord`. `macula_dht_find_record` distinguishes
  `dht.ErrNotFound` (an expected, common outcome, surfaced via a
  `notFoundOut` int flag) from a real transport failure (`errOut`), the
  same two-signal shape `macula_serve_wait_for_call`'s `noCallOut`
  already established for "keep polling" vs. "actually broken". Records
  cross as JSON (`dhtRecordJSON`) -- payload reuses `cborToJSON`
  exactly like an RPC reply; `key`/`version`/`signature` (raw bytes with
  no native JSON shape) cross as lowercase hex, deliberately distinct
  from `wirevalue.go`'s own `"0x"`-prefixed convention for bytes found
  *inside* a payload.
- `cabi/dht.go`: `macula_dht_put_procedure_advertisement` and
  `macula_dht_put_content_announcement` -- typed builders wrapping
  macula-go's REAL `dht.NewProcedureAdvertisement`/
  `NewContentAnnouncement` constructors (then `dht.Sign` + `dht.PutRecord`),
  not a generic JSON-payload path. See "Fixed" below for why a generic
  path was tried first and rejected. `macula_dht_put_procedure_advertisement`
  also builds the realm-qualified discovery URI itself via macula-go's
  own `dht.DiscoveryURI(realm, procedure)` rather than taking a
  pre-qualified string from the caller.
- `addon/binding.cc`: `DhtFindRecordsByTypeWorker`, `DhtFindRecordsWorker`,
  `DhtFindRecordWorker`, `DhtPutProcedureAdvertisementWorker`,
  `DhtPutContentAnnouncementWorker` -- all `Napi::AsyncWorker`-backed
  (each is a signed CALL under the hood, real network I/O), same
  reasoning as `SessionCallWorker`. `ReadKey32` is `ReadOptionalRealm`'s
  mandatory counterpart for a DHT storage key (no meaningful "use a
  default" reading for a lookup key the way there is for a realm).
- `src/dht.ts`: `DhtRecordType` (the three type tags -- `station_endpoint`
  is listed because `find*()` can return one, even though macula-go has
  no client-side constructor for it, stations publish those themselves),
  `DhtRecord`, `DHT_DEFAULT_TTL_MS`.
- `src/session.ts`: `Session.findRecordsByType(recordType)`,
  `.findRecords(key)`, `.findRecord(key)` (resolves `null` for
  not-found, matching `dht.ErrNotFound`'s "expected, not exceptional"
  status), `.putProcedureAdvertisement(procedure, servingStation, opts?)`,
  `.putContentAnnouncement(mcid, endpoint, ttlMs?)`. All five reuse
  `call()`'s same-Session exclusivity guard against an active `serve()`
  (factored out into `#requireHandleNotServing`, `call()` itself
  refactored to use it too, behavior unchanged) -- these all end up on
  the same shared control stream a CALL does, since `dht.FindRecord` et
  al. are themselves just `connection.Session.Call` under the hood.
- `src/dht.live.test.ts` (opt-in via `MACULA_TS_LIVE`):
  `findRecordsByType(StationEndpoint)` against the real fleet, each
  returned record's `quic_port` payload field decoded and range-checked;
  `putProcedureAdvertisement()` followed by `findRecord()`/`findRecords()`
  on that record's own storage key round-tripping the exact stored
  record (`version`/`signature` match, `procedure_uri` payload field
  decoded correctly); `findRecord()` for a key nothing was ever put at
  resolving `null` cleanly.
- `package.json`'s `test:live` script now runs all three live suites.

### Fixed

- A first draft exposed one generic `macula_dht_put_record(recordType,
  key, payloadJSON, ttlMs)` accepting an arbitrary JSON payload for any
  record type, mirroring how RPC payloads already cross this boundary.
  Caught before shipping: `procedure_advertisement`'s
  `advertiser_node`/`serving_station` fields (and
  `content_announcement`'s `announcer_node`/`mcid`) are raw pubkey/MCID
  bytes that MUST round-trip as CBOR byte strings (major type 2) for a
  real resolver's `bytesField()` reads to succeed -- and
  `wirevalue.go`'s `jsonToCbor`, by its own doc, has no path that
  produces CBOR bytes going *in* (only `cborToJSON` produces the
  `"0x"`-hex convention going *out*). The generic path signed and stored
  successfully while silently writing those fields as CBOR TEXT instead
  -- a record no real reader could parse. Replaced with the two typed
  builders described above, which call macula-go's real constructors
  (already correctly byte-typed) instead of reimplementing that encoding
  here.
- A second bug, caught by the live round-trip test itself (not by
  inspection): an early version of `Session.putProcedureAdvertisement()`
  took a bare procedure name and passed it straight through to
  `dht.NewProcedureAdvertisement` as `procedureURI`. That constructor's
  own doc says `procedureURI` must be the realm-qualified discovery URI
  (`dht.DiscoveryURI(realm, procedure)`) "or the DHT storage key will
  not agree" between advertiser and resolver -- exactly what happened:
  `putProcedureAdvertisement()` stored successfully, but the live test's
  own independently-computed storage key (correctly using
  `DiscoveryURI`) never found it, because the stored record's actual key
  was different. Fixed by having `macula_dht_put_procedure_advertisement`
  build the qualified URI internally via `dht.DiscoveryURI`, so a caller
  supplies a plain procedure name and an optional realm and can no
  longer get this wrong.

### Verified

- All three `dht.live.test.ts` scenarios passed against
  `station-de-frankfurt.macula.io:4433` (also re-run together with
  `session.live.test.ts`/`rpc.live.test.ts` via `npm run test:live`,
  9/9 passing, and again from a fully clean rebuild --
  `node_modules`/`build`/`dist`/`prebuilds`/`cabi/build` removed,
  `build:go` -> `install` -> `build:prebuilds` -> `tsc`, then the live
  suite re-run against that clean build).
- `findRecordsByType(StationEndpoint)` returns real station-published
  records from the live fleet (not empty, not stubbed) -- each one's
  `key`/`version`/`signature` checked as well-formed hex of the right
  length, `createdAt`/`expiresAt` checked as plausible recent
  timestamps with `expiresAt > createdAt`, and `quic_port` (decoded out
  of the payload) checked as a real port number -- proof the payload was
  genuinely parsed via `cborToJSON`, not opaquely passed through.
- `putContentAnnouncement()` (built, but not part of the committed
  suite -- only `findRecordsByType`/`findRecord`/`findRecords`/
  `putProcedureAdvertisement` are, matching this stage's explicit scope)
  was still probed directly against the live station before being
  considered done: put, then found via `findRecord()` on its own
  `dht.ContentKey`-derived storage key, with `endpoint` and `mcid`
  payload fields round-tripping correctly.
- Deliberately probed, not just the happy path: a garbage/never-issued
  session handle passed to every new `dht*` native export throws a
  clean error instead of crashing the process (all five); a wrong-length
  key/servingStation/mcid (31, 33, or non-34 bytes where 32 or 34 is
  required) throws a clean `RangeError` from the addon's own argument
  validation before ever reaching the Go side.
- Zero-install-script property re-verified after this change (same
  fresh-tarball-install check as prior releases): a real `npm pack`
  tarball installed into a directory with no source tree present,
  verbose install log showing only the two declared runtime
  dependencies fetched -- no `node-gyp`/compiler invocation -- and a
  consumer-side script confirming `DhtRecordType` and
  `Session.prototype.findRecordsByType`/`putProcedureAdvertisement`/
  `putContentAnnouncement` are present and callable from the published
  package alone.

### Known gaps (deferred, not forgotten)

- Only `linux-x64` prebuild coverage.
- No generic "put any DHT record type with an arbitrary JSON payload"
  function, and no `station_endpoint` builder (macula-go has neither
  either -- see this release's "Fixed" section and README.md).
- Pubsub, content transfer, streaming RPC, UCAN, direct-dial,
  `Pinned`/`Insecure` trust modes. `call()`/`serve()` still default to
  the all-zero realm only (unchanged this release);
  `putProcedureAdvertisement()` is the first public method that DOES
  take an explicit realm.

## [0.4.0] - 2026-09-03

Unary RPC, both roles: `Session.call()` (caller) and `Session.serve()`
(provider), live-verified against the real production fleet. Builds
directly on 0.3.0's transport/handshake layer with no changes to that
layer's shape.

### Added

- `cabi/wirevalue.go`: `jsonToCbor`/`cborToJSON` -- JSON<->`cbor.Value`
  bridge for RPC payloads, ported from
  [macula-cli](https://github.com/macula-io/macula-cli)'s
  `internal/wirevalue` package rather than reinvented (same no-bool,
  bytes-as-"0x"-hex-string rules).
- `cabi/rpc.go`: `macula_session_call` -- caller role, wraps
  `connection.Session.Call`. Returns a JSON envelope
  (`{ok:true,payload}` or `{ok:false,bolt4:{code,name,retryable,detail}}`)
  distinguishing "never got a wire-level answer" (a Go `error`, surfaced
  via `errOut`) from "got a real BOLT#4 ERROR frame" (`frame.CallResponse
  .IsError`, not a Go error at all).
- `cabi/serve.go`: `macula_session_advertise`/`_unadvertise`
  (`connection.Session.Advertise`/`Unadvertise`) and a three-call split of
  `connection.Session.ServeOneCall` -- `macula_serve_wait_for_call`
  (blocks for the next matching CALL, `lookup` filters by realm+procedure
  so a mismatched CALL is answered `unknown_next_peer` by macula-go
  itself rather than by us), `macula_pending_call_procedure`/
  `_payload_json` (local reads), `macula_pending_call_reply_result`/
  `_error` (resume the blocked goroutine, wait for the actual reply
  frame to send, then free the pending-call handle). Same three-call
  split [macula-php](https://github.com/macula-io/macula-php)'s
  `cabi/serve.go` already proved for the identical "can't hand a Go
  closure across this boundary" problem. `pendingCallFromHandle` mirrors
  `identityFromHandle`/`sessionFromHandle`'s `recover()`-guarded lookup
  for the new handle type.
- `addon/binding.cc`: `SessionCallWorker`, `SessionAdvertiseWorker`,
  `ServeWaitForCallWorker`, `PendingCallReplyWorker` -- all
  `Napi::AsyncWorker`-backed (real network I/O each). `PendingCallProcedure`/
  `PendingCallPayloadJson` stay synchronous (local reads only, same
  reasoning as `SessionRemoteAddr`/`SessionStationNodeId`).
- `src/rpc.ts`: `JsonValue` (the wire's own restrictions encoded as a
  TypeScript type -- no `boolean` in the union, so passing one is a
  compile error), `Bolt4ErrorInfo`, `MaculaCallError`.
- `src/session.ts`: `Session.call(procedure, payload, opts?)` and
  `Session.serve(procedure, handler)`. `Session` now retains the
  connecting `Identity` privately so `call()`/`serve()` don't force
  every caller to re-pass it (macula-go's own `connection.Session` has
  no such field -- every Go-side signing call takes `identity.KeyPair`
  explicitly; this is a convenience this wrapper adds). `close()`'s
  existing explicit-`identity`-parameter contract is unchanged. Only one
  `serve()` registration is allowed per `Session`, and `call()`/`serve()`
  refuse to run concurrently on the same `Session` (both throw
  immediately) -- matches macula-go's own documented "mixing roles on
  one control stream races" limitation on `Call`/`ServeOneCall`.
- `src/rpc.live.test.ts` (opt-in via `MACULA_TS_LIVE`): a provider's
  `serve()` answering a caller's `call()` with the real round-tripped
  payload over two real `Session`s; calling an unadvertised procedure
  coming back a real `unknown_next_peer`; a throwing handler coming back
  a real `unknown_error`.
- `package.json`'s `test:live` script now runs both live suites
  (`session.live.test.ts` and `rpc.live.test.ts`).

### Verified

- All three `rpc.live.test.ts` scenarios passed against
  `station-de-frankfurt.macula.io:4433` (also re-run together with
  `session.live.test.ts` via `npm run test:live`, 6/6 passing).
- Deliberately probed, not just the happy path (all against the real
  station except the garbage-handle cases, which don't need one): a
  garbage/never-issued pending-call handle passed to every
  `pending_call_*` export throws a clean error instead of crashing the
  process; a garbage session handle passed to `sessionCall`/
  `sessionAdvertise` likewise; a JS boolean payload (forced past
  `JsonValue`'s type check with `as any`) is rejected before ever
  reaching the wire; a second concurrent `serve()` on one `Session`
  throws; `call()` while `serve()` is active on the same `Session`
  throws; a `stop()`ped `serve()` procedure is genuinely unadvertised
  (a follow-up `call()` comes back `unknown_next_peer`, not still
  answered); `call()`/`serve()` after `close()` throw "used after
  close()" instead of touching a freed handle.
- Zero-install-script property re-verified after this change: `npm
  run build:go` -> `npm install` -> `npm run build:prebuilds` -> `npx
  tsc` from a fully clean tree (`node_modules`/`build`/`dist`/
  `prebuilds`/`cabi/build` all removed first), then a real packed
  tarball installed into a fresh directory with a verbose install log
  showing only the two declared runtime dependencies fetched -- no
  `node-gyp`/compiler invocation at all.

### Known gaps (deferred, not forgotten)

- Only `linux-x64` prebuild coverage.
- Realm is threaded through the FFI layer (`cabi/rpc.go`/`serve.go` both
  accept an optional 32-byte realm) but not yet exposed on the public
  `Session.call`/`serve` TypeScript API -- both currently always use the
  all-zero realm.
- Pubsub, DHT, content transfer, streaming RPC, UCAN, direct-dial,
  `Pinned`/`Insecure` trust modes.

## [0.3.0] - 2026-09-03

Transport + handshake: `Session.connect`/`close`, live-verified against the
real production fleet. Builds directly on 0.2.0's addon/packaging with no
changes to that layer's shape.

### Added

- `cabi/main.go`: `macula_session_connect`, `macula_session_remote_addr`,
  `macula_session_station_node_id`, `macula_session_close` -- thin exports
  over macula-go's `connection.Connect`/`Session.Close` (WebPKI trust only
  so far; `Pinned`/`Insecure` are future work). `sessionFromHandle` mirrors
  `identityFromHandle`'s `recover()`-guarded lookup for the new handle type.
- `addon/binding.cc`: `SessionConnect`/`SessionClose` are the first
  `Napi::AsyncWorker`-backed exports in this addon -- both are real network
  I/O (a QUIC dial + signed handshake round trip for connect; a 250ms drain
  sleep + write for close), so both run on a libuv threadpool thread and
  resolve/reject a real `Promise`, never blocking Node's main thread.
  `SessionRemoteAddr`/`SessionStationNodeId` stay synchronous (pure local
  memory reads, no I/O, same shape as the identity accessors).
- `src/session.ts`: `Session.connect()` / `.remoteAddr` / `.stationNodeId` /
  `.close()`. Mirrors `Identity`'s handle-lifecycle pattern (post-close
  accessors throw, `close()` is idempotent) rather than inventing a new
  convention. Adds `Identity#handleForFfi()` (package-internal) since JS
  private fields are unreachable from outside a class body even within the
  same package -- `Session` needs `Identity`'s raw handle to connect/close.
- `src/session.test.ts` (offline, default CI): a doomed `connect()`
  rejects with a real, bounded error instead of hanging forever.
- `src/session.live.test.ts` (opt-in via `MACULA_TS_LIVE`, see README.md):
  a real handshake against `station-de-frankfurt.macula.io:4433`,
  post-close accessor guards, double-close idempotency -- all against an
  actual connected session, not fakeable offline.
- `.github/workflows/ci.yml`: a `workflow_dispatch`-only `test-live` job
  running the live suite manually; the default push/PR job is unchanged
  (still never touches the network beyond what `session.test.ts`'s doomed
  localhost dial already did).

### Verified

- Real handshake against the real Frankfurt station: CONNECT sent,
  Ed25519-signed HELLO received back and signature-verified,
  `session.stationNodeId` is the station's real 32-byte NodeID (not all
  zero) -- ~70-380ms depending on run.
- Async boundary confirmed directly, not assumed: a concurrent
  `setInterval(10ms)` kept firing for the full duration of an in-flight
  real `connect()` call (6 ticks during a 70ms connect), proving the main
  thread was never blocked.
- 5 consecutive real connect/close cycles against the production station:
  no crash, no leak, no hang, same station NodeID every time.
- Post-close accessor guard and double-close idempotency, both against a
  real connected-then-closed session (not simulated).
- Zero-install-script property re-verified after this change (same fresh
  packed-tarball-install check as 0.2.0): still holds.

### Known gaps (deferred, not forgotten)

- Only `linux-x64` prebuild coverage.
- RPC (`call`/`serve`), pubsub, DHT, content transfer, streaming, UCAN,
  `Pinned`/`Insecure` trust modes.

## [0.2.0] - 2026-09-03

Replaced koffi (a generic FFI bridge) with a purpose-built native addon,
so the package genuinely needs zero install-time scripts -- the gap the
previous release deferred.

### Changed

- `cabi/` now builds with `go build -buildmode=c-archive` (producing
  `libmacula.a` + `libmacula.h`) instead of `-buildmode=c-shared`. No
  changes to `cabi/main.go` itself -- only the build mode.
- `addon/binding.cc`: a new, purpose-built N-API addon
  ([node-addon-api](https://github.com/nodejs/node-addon-api)) wrapping
  exactly macula-ts's own exported functions -- not a generic FFI bridge.
  Links `libmacula.a` in statically, so the resulting `.node` file is
  self-contained (no separate `.so` to locate at runtime). Also fixes a
  latent bug the koffi-era binding.ts's own doc comment admitted to: the
  `errOut` C string from a failed call is now actually freed via
  `macula_free_string` instead of leaked.
- `src/binding.ts`: loads the addon via
  [`node-gyp-build`](https://github.com/prebuild/node-gyp-build) instead
  of koffi's runtime signature declarations. `identity.ts`'s public API
  is unchanged.
- Packaged with [`prebuildify`](https://github.com/prebuild/prebuildify):
  the compiled `linux-x64` `.node` binary is committed under `prebuilds/`
  and shipped as part of the npm package. `package.json` has no
  `install`/`postinstall`/`preinstall` script.

### Removed

- `koffi` dependency entirely.

### Verified

- A real packed tarball (`npm pack`) installed into a directory with no
  source tree present: completed in well under a second, zero compiler
  invocation, zero network fetch of a prebuilt binary -- the addon loads
  purely from the bundled `prebuilds/` directory. CI's last step now
  re-runs this exact check on every push.
- 500-iteration generate/read/free loop, a deliberate double-free, and a
  garbage/never-issued handle -- none crash the process (the
  `recover()`-guarded handle lookups from 0.1.0 hold under the new
  binding too); all produce unique NodeIDs; the seed round-trip still
  matches.

### Known gaps (deferred, not forgotten)

- Only `linux-x64` is covered. No cross-platform prebuilt matrix
  (`darwin`/`win32`, `arm64`) yet.
- Everything past identity: transport/handshake, RPC, pubsub, DHT, content
  transfer, streaming, UCAN.

## [0.1.0] - 2026-09-03

Initial walking skeleton. FFI binding over macula-go's C-shared build
(`cabi/`, loaded via [koffi](https://koffi.dev)), proving the FFI plumbing
works end-to-end with one real operation.

### Added

- `cabi/`: a Go module (`go build -buildmode=c-shared`) exporting
  `macula_identity_generate`, `macula_identity_from_seed_bytes`,
  `macula_identity_node_id`, `macula_identity_private_bytes`,
  `macula_identity_free`, `macula_free_string` — mirroring macula-php's
  `cabi/` handle-based memory-ownership convention.
- `Identity.generate()` / `Identity.fromSeedBytes()` / `#nodeId` /
  `#privateSeedBytes` / `#dispose()` — a real TypeScript wrapper over
  macula-go's `identity.Generate()`, not a stub. Verified by asserting the
  S/Kademlia puzzle property (>=8 leading zero bits on SHA-256(NodeID)) on
  the returned identity, a property no stub could satisfy.
- CI (`ubuntu-latest` only): build `cabi/`, `npm test`, `npm run typecheck`.

### Fixed

- `cgo.Handle.Value()`/`.Delete()` panic (not error) on an invalid or
  already-freed handle. An arbitrary `uintptr_t` from the TypeScript side
  took the whole process down before this was caught during development
  and fixed with `recover()`-guarded lookup helpers
  (`identityFromHandle`/`deleteHandle` in `cabi/main.go`).

### Known gaps (deferred, not forgotten)

- `koffi` carries its own native install script and ships no prebuilt
  binaries in its npm tarball — the same class of postinstall friction
  `macula-mcp` retired by moving off `better-sqlite3`. No better
  alternative exists today; proper packaging (likely a dedicated
  N-API/napi-rs addon with per-platform `optionalDependencies`) is future
  work. See README.md.
- `cabi/` builds for Linux only; no cross-platform prebuilt matrix yet.
- Everything past identity: transport/handshake, RPC, pubsub, DHT, content
  transfer, streaming, UCAN.
