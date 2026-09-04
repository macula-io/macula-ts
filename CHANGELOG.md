# Changelog

All notable changes to this project will be documented in this file.

## [0.13.3] - 2026-09-04

0.13.2's fix didn't work either -- it reset package.json/package-lock.json
to the clean git state *before* `npm publish` ran, but `npm publish`
itself invokes the `prepublishOnly` lifecycle script internally, after
any pre-publish check a workflow can add around it, and `prepublishOnly`
runs `build:prebuilds`, whose `prebuildify --napi --strip` call is what
actually writes the stray `"install": "node-gyp rebuild"` key -- visible
directly in 0.13.2's own CI log (`prepublishOnly -> build:prebuilds ->
prebuildify` executing between the earlier clean-state check and the
real upload). Confirmed by inspecting the log, not guessed.

Fixed at the actual source this time: `build:prebuilds` now runs `npm
pkg delete scripts.install` immediately after `prebuildify --napi
--strip`, unconditionally (a no-op if the key isn't present). This
could not be verified locally -- the injection has never reproduced on
a local machine, only in CI (npm 11.19.1 there vs 11.14.1 locally; the
precise trigger inside prebuildify is still not fully understood) -- so
`release.yml` no longer just trusts the fix: it now actually runs the
real prepublish sequence (`build:prebuilds && tsc`) as its own explicit
step, in the same CI environment a real publish would use, and hard-
fails the job if `scripts.install` is present afterward, before ever
reaching `npm publish`. 0.13.0, 0.13.1, and 0.13.2 were all deprecated
on npm pointing at this version.

## [0.13.2] - 2026-09-04

Both 0.13.0 (manual `npm publish`) and 0.13.1 (published via `release.yml`'s
CI pipeline) shipped a stray `"install": "node-gyp rebuild"` in the
*published* `package.json` -- exactly the native-compile-at-install
regression this package's whole packaging architecture exists to avoid.
0.13.1's own changelog entry blamed an uncommitted local edit and claimed
publishing via CI would fix it; that diagnosis was wrong, disproven by
0.13.1 itself shipping the same defect straight out of a clean CI
checkout. The real trigger: this repo's `binding.gyp` presence makes a
plain `npm install` (run in `release.yml`, deliberately, to also verify
the ordinary dev-install path builds the addon) take npm's own implicit
"no explicit install script -> run node-gyp rebuild" default -- and
something in that path leaves state that a *later* `npm publish` in the
same working directory then picks up and embeds, even though git only
ever has the clean version (confirmed: no commit in this repo's history
ever added this key, and a `npm pack` run in a fresh checkout with no
prior `npm install` never reproduces it). The exact internal npm
mechanism connecting the two isn't fully pinned down.

Rather than continue chasing that mechanism, `release.yml` now forces
the working tree back to the exact git-committed state for
`package.json`/`package-lock.json` immediately before packing/publishing,
and hard-fails the job if `scripts.install` is somehow still present
after that reset -- so this class of bug cannot reach a published
package again regardless of what any earlier build/test step does to
the working directory. Both 0.13.0 and 0.13.1 were deprecated on npm
pointing at this version.

## [0.13.0] - 2026-09-04

First release published to npm. In addition to the package-metadata
work that makes that possible (`keywords`, `exports`, `sideEffects`
added to `package.json` for correct resolution by bundlers and
tree-shaking), this release also includes:

### Added

- `assets/macula-ts-full-{dark,light}.svg` — this repo's first logo,
  mirroring the shared mesh-icon template every sibling SDK (macula-go,
  macula-rust, macula-dotnet, macula-php) already uses verbatim, with a
  TypeScript badge (brand-blue `#3178C6` circle, white "TS") in the
  mascot-badge slot.
- `examples/` — six real, runnable scripts against the live production
  fleet (quickstart, call, publish/subscribe, content, direct-dial,
  UCAN), matching macula-php's numbered-examples convention. All six
  live-verified in this same pass, not just typechecked.
- README restructured to match every sibling's opening convention: badge
  row (CI, License, Node version, "zero install scripts", GitHub
  Sponsors), centered logo, tagline, dated status blockquote, a `## What
  is this?` section, and a deeper narrative `## Status` section with
  dated entries citing the specific bugs found along the way (mirroring
  macula-go's `## Status` section shape). The `Sibling SDKs` table now
  also links `macula-io/macula` (the Erlang reference), `macula-station`,
  and `macula-realm`, not just the four language ports. `## Live tests`
  merged into one `## Testing` section covering both suites.

## [0.12.0]

### Added

- Direct-dial: `Session.resolveDirect(procedure, opts?)`,
  `Session.callDirect(procedure, payload, opts?)`,
  `Session.callDirectWithUcan(procedure, payload, ucanToken, opts?)`
  (caller side), `Session.advertiseDirect(procedure, opts?)` and a
  standalone `keepAdvertisedDirect(session, procedure, opts?)` helper
  (provider side) — thin FFI wrappers over macula-go's `directdial`
  package (`Resolve`, `Call`, `CallWithUCAN`, `AdvertiseDirect`), not a
  reimplementation of any of its protocol logic. Resolves a signed
  `procedure_advertisement` DHT record to its serving station's own
  signed `station_endpoint`, retrying past DHT-propagation lag
  internally (macula-go's fixed ~50×100ms schedule, not configurable
  here), then dials that station directly in one hop instead of relying
  on ordinary advertise-gossip having reached whatever station the
  caller happens to be connected to. Trust is enforced at the
  application layer, not by the dial's TLS: the freshly connected peer's
  own HELLO-proven identity is checked against the exact pubkey the
  signed DHT chain resolved, inside macula-go, before the CALL is ever
  sent — this SDK surfaces the outcome, it doesn't re-implement the
  check.
  New Go-side cabi file `cabi/directdial.go`
  (`macula_directdial_resolve`/`_call`/`_call_with_ucan`/`_advertise`, all
  four backed by `Napi::AsyncWorker` in `addon/binding.cc` since all four
  are real network I/O — `_call`/`_call_with_ucan` additionally open,
  pin, and close a fresh one-hop connection entirely internally, never
  surfaced as a `Session` on the TypeScript side); reuses `rpc.go`'s own
  `callResponseToEnvelope` for `callDirect`/`callDirectWithUcan`'s
  envelope rather than duplicating that mapping a second time, and
  `dht.DefaultTTL` for `advertiseDirect`'s own TTL default — no new
  Go-side handle type introduced (every function here reuses this SDK's
  existing session/identity handles and their `recover()`-guarded
  lookups).
  `advertiseDirect()` mirrors `directdial.AdvertiseDirect` exactly: a
  plain ADVERTISE *and* a signed `procedure_advertisement` DHT record,
  both on the same call — macula-go's own doc explains why both are
  required (skipping the plain ADVERTISE lets resolve+dial complete
  cleanly against a station with nothing registered to route the CALL
  to, a real bug found live 2026-08-30 by verifying an actual RESULT came
  back through direct-dial rather than accepting a clean
  `unknown_next_peer` as sufficient proof — this SDK inherits that fix by
  construction, not by re-deriving it).
  `resolveDirect`/`callDirect`/`callDirectWithUcan`/`advertiseDirect` are
  all subject to the SAME same-Session exclusivity guard
  (`#requireHandleNotServing`) `call()`/the DHT methods already use, and
  for the identical reason extended to a new case:
  `advertiseDirect()`'s own `PutRecord` CALL must not run on a Session
  whose receive loop belongs to an active `serve()` (its own reply would
  be consumed by `serve()`'s poll loop instead and the put would time
  out) — a long-lived provider that also serves the same procedure needs
  a SEPARATE `Session` (and identity — this fleet enforces one connection
  per identity, kicking whichever connects second) to keep re-advertising
  on, which is exactly why `keepAdvertisedDirect()` (`directdial.ts`) is
  a standalone function taking whichever `Session` it's given, not a
  `Session` method — mirroring macula-go's own `KeepAdvertisedDirect`
  free function for the same reason.
- **Live-verified against the real production fleet, self-contained**:
  every live assertion makes its OWN test procedure direct-dial-reachable
  via `advertiseDirect()` first, then reaches it purely through
  `resolveDirect()`/`callDirect()` — proving both the caller and provider
  halves for real against the real fleet using only code this session
  controls, not dependent on finding a pre-existing direct-dialable
  procedure on the shared demo fleet (the same self-verification shape
  the RPC stage's own live test uses for `call()`/`serve()`).
  `resolveDirect()` returns the REAL station the provider Session is
  connected to (`target.station` checked byte-for-byte against
  `providerSession.stationNodeId`, not just "resolve didn't throw"), with
  a real, non-empty host and a plausible port; `callDirect()` then
  completes a genuine one-hop round trip through that resolved station,
  the provider's `serve()` handler actually invoked and its exact
  echoed-payload reply received back. `callDirectWithUcan()` attaches a
  freshly minted `Ucan` to a real direct-dial CALL and completes it
  end to end against the same kind of ungated procedure — an **honest,
  stated limitation** carried over from `callWithUcan()`'s own live test:
  this SDK has no served-side UCAN policy gate (`ucan.Policy`/
  `ServeOneCallGated`, out of scope — see README's "What's explicitly not
  yet implemented"), so this proves the client-side attach-and-call
  mechanism reaches an ungated procedure over direct-dial, not that a
  provider enforces the token; macula-go's own
  `directdial_live_test.go`'s `TestLiveDirectDialUCANGatedRoundTrip`
  already proves the enforcement side of this exact protocol against a
  real gated provider. A negative case was probed directly, not just the
  happy path: `resolveDirect()`/`callDirect()` against a procedure nobody
  ever called `advertiseDirect()` for fail with a real, clear error
  (macula-go's `ErrProcedureNotAdvertised`, wrapped) after macula-go's own
  bounded ~5s DHT-retry window — confirmed to actually take over a
  second (not fail suspiciously instantly on some unrelated client-side
  bug) and confirmed NOT to hang past that window either; `callDirect()`'s
  own resulting rejection is a plain `Error`, specifically NOT a
  `MaculaCallError`, since a resolve failure never reaches a real peer at
  all and so is never a wire-level BOLT#4 answer — matching
  `callDirect`/`callDirectWithUcan`'s own documented errOut/envelope
  split. New live test file `src/directdial.live.test.ts` (gated by
  `MACULA_TS_LIVE`, added to `npm run test:live`, unchanged from every
  other live test file's own convention).
- Also re-verified against the actual packaged, installed npm tarball,
  not just the source tree: a real `advertiseDirect()` → `resolveDirect()`
  → `callDirect()` round trip against the live production fleet, using
  only the installed `@macula-io/ts` package in a fresh, empty directory
  with no source tree present — same standard every prior slice in this
  SDK has held itself to.
- `scripts/verify-zero-install.sh` re-run for this change specifically:
  PASSED (no `node-gyp`/compiler signal in the fresh tarball install's
  verbose log; `Identity.generate()`/`dispose()` confirmed working from
  the installed package afterward).

### What's still explicitly not implemented for direct-dial

Streaming direct-dial (`OpenStreamDirect`), content direct-dial
(`PutDirect`/`GetDirect`), cert-chain-authorized direct-dial
(`ResolveWithCertChain`/`CallWithCertChain`/`AdvertiseDirectWithCertChain`
— Slice 7c Direction B, opt-in even in macula-go itself), and
provider-side UCAN policy gating (shared with plain `callWithUcan()` —
see above). Each is a separate, later slice of work built on top of this
one, matching macula-go's own package structure.

## [0.11.0]

### Added

- `realm?: string` on `Session.call`/`callWithUcan`/`publish`/`subscribe`
  — a 64-character lowercase (or uppercase) hex string, 32 bytes, the
  same hex convention `DhtRecord`'s `key`/`version`/`signature` fields
  already use, rather than `putProcedureAdvertisement`'s pre-existing
  raw-byte `Uint8Array` convention for its own `opts.realm`. Omitted
  means the all-zero realm, the sole default every one of these methods
  used exclusively before this option existed. Realm is an exact-match
  routing key: a `call()`/`callWithUcan()` under a realm the target
  procedure isn't advertised under comes back a genuine
  `unknown_next_peer`, and a `subscribe()` only ever receives a
  `publish()` made under the identical realm.
  On inspection (not assumed from the task description that opened this
  work), `cabi/rpc.go`'s `macula_session_call`/
  `macula_session_call_with_ucan`, `cabi/pubsub.go`'s
  `macula_session_publish`/`macula_session_subscribe_start`, and
  `addon/binding.cc`'s `ReadOptionalRealm` plus the four matching
  `AsyncWorker`s were already fully wired for an optional 32-byte realm
  all the way to `src/binding.ts`'s `native.*` layer — `Session`'s own
  public methods were the only place still hardcoding `undefined`. No
  changes were needed to `cabi/rpc.go`, `cabi/pubsub.go`, or
  `addon/binding.cc`; `session.ts`/`rpc.ts`/`pubsub.ts` convert the new
  public hex-string option to that already-working raw-byte convention
  internally (`realmBytesFromHex`, `session.ts`), which also means the
  addon did not need to be rebuilt for this change (the committed
  `prebuilds/linux-x64` binary is byte-identical before and after).
  `serve()`/`advertise` deliberately still only use the all-zero realm —
  out of scope for this slice, unchanged; see README.md's "What's
  explicitly not yet implemented". DHT's `findRecord`/`findRecords`/
  `findRecordsByType`/`putRecord` were deliberately left untouched too —
  those always use the DHT's own reserved all-zero realm internally, a
  protocol-level constant, not a general-purpose parameter.
- **Live-verified against the real production fleet, proving realm
  actually changes wire behavior rather than being accepted and
  ignored**: the SAME procedure name, advertised once (necessarily under
  the default realm, since `serve()` has no realm option), answers a
  `call()` and a `callWithUcan()` under that default realm and comes
  back a genuine, structured `unknown_next_peer` under a different, real
  32-byte realm (`crypto.randomBytes(32)`, not a placeholder) — on the
  same two live `Session`s throughout, then confirmed reachable under
  the default realm once more, ruling out "the provider stopped
  answering" as an alternative explanation for the negative result.
  Pubsub proven with two simultaneous live subscriptions to the SAME
  topic on separate `Session`s, one on the default realm and one on a
  different real realm: a `publish()` under the non-default realm
  reaches only its own subscriber, and a subsequent `publish()` under
  the default realm reaches only the default-realm subscriber — each
  direction confirmed not to leak into the other. A malformed realm
  (wrong length, non-hex characters) is rejected synchronously by
  `realmBytesFromHex` before any of these four methods ever encodes,
  signs, or sends a frame. New live tests in `src/rpc.live.test.ts`,
  `src/ucan.live.test.ts`, and `src/pubsub.live.test.ts` (all gated by
  `MACULA_TS_LIVE`, unchanged from every other live test file's own
  convention).
- `scripts/verify-zero-install.sh` — the zero-install-script
  re-verification this project's own contribution discipline requires
  before every change, as a runnable script instead of a one-off shell
  transcript: wipes every generated artifact, rebuilds Go + the addon +
  every prebuild, runs the offline suite and `tsc`, packs a real
  tarball, installs it into a fresh empty directory with a verbose
  install log, and asserts that log carries no compiler/`node-gyp`
  signal — then loads the installed package and calls a real native
  export (`Identity.generate()`) to confirm it actually works, not just
  that the log looked clean. Re-run for this change specifically: PASSED
  (3 packages added to the fresh install — this package plus its two
  declared runtime dependencies — no `node-gyp rebuild` lifecycle
  script, no compiler/linker output).

## [0.10.0]

### Added

- `Identity.sign(data)` — a generic Ed25519 signing primitive, reached
  through `cabi/identity_sign.go` (new: `macula_identity_sign`, a direct
  wrapper over macula-go's existing `identity.KeyPair.Sign`, which itself
  wraps `ed25519.Sign`) and `addon/binding.cc`'s new `IdentitySign`. Pure
  local computation — no network I/O — so, like `identityNodeId` and
  `ucanMint`/`ucanDecode`, it's a plain synchronous call on both the Go
  and N-API sides, not `Napi::AsyncWorker`-backed. Deliberately bakes in
  no application-specific message format anywhere on this path: `data`
  crosses the FFI boundary as an opaque byte buffer and is signed exactly
  as given; whatever byte-layout convention a caller needs (e.g. an
  ownership-proof format binding this signature to some other value) is
  that caller's own concern, built from plain bytes before calling this.
  Verified against an independent verifier — Node's own `crypto.verify`
  (via a JWK import of the identity's raw 32-byte NodeID, RFC 8037's
  OKP/Ed25519 JWK shape — not macula-go, not this SDK's own code) — that
  the signature is genuinely valid Ed25519 over the exact data and the
  exact public key, and that tampering with either the data or the
  signature afterward invalidates it; a stub returning 64 arbitrary bytes
  could satisfy a length check but not that. Also verified: signing the
  same data twice with the same identity produces the same signature
  (Ed25519 has no per-signature nonce randomness the way ECDSA does);
  signing different data produces a different signature; `sign()` after
  `dispose()` throws cleanly instead of touching a freed handle (probed
  directly against the raw addon export, both a garbage handle and a
  freed one, confirming neither takes the process down). Re-verified the
  zero-install-script packaging guarantee end to end for this change
  specifically: `npm pack` + install into a fresh empty directory, no
  compile signals in the verbose install log, `binding.gyp`/`addon/`/
  `cabi/` absent from the installed package, and the independent-verifier
  check above re-run successfully against that installed, prebuilt
  package (not just the local dev build).

## [0.9.0]

Two real, live-measured concurrency bugs found by an adversarial review
of the RPC/DHT/pubsub/content/UCAN work, fixed and re-verified — see
README.md's new "Concurrency safety" section for the user-facing
description.

### Fixed

- **Concurrent control-stream operations could permanently brick a
  Session.** `Session.call()`/`callWithUcan()`/the DHT methods only
  guarded against an *already-registered* `serve()`/`subscribe()` — two
  concurrent `call()`s (no serve/subscribe involved at all) had nothing
  stopping them from racing macula-go's `connection/frame_stream.go`
  `RecvFrame`, which mutates a shared buffer with no mutex of its own.
  Reproduced live: `Promise.all` of 4 concurrent `call()`s left every
  later read on that same Session permanently failing to decode any
  frame ("claimed frame length ... exceeds the 16777215-byte cap").
  Fixed with a per-Session async queue (`Session#enqueue`) that every
  control-stream-reading operation now funnels through — `call`,
  `callWithUcan`, `findRecord`/`findRecords`/`findRecordsByType`,
  `putProcedureAdvertisement`/`putContentAnnouncement`, `serve()`'s
  advertise + each poll tick + unadvertise, `subscribe()`'s start +
  stop. `publish()`/`putContent()`/`getContent()` are unaffected (a
  pure write, and each own dedicated QUIC stream, respectively — neither
  reads the shared stream). Also closed the race window in the existing
  `serve()`/`subscribe()` exclusivity guards: `#activeServe`/
  `#activeSubscription` are now marked synchronously, before either
  method's first `await`, not after — the old ordering left a window a
  concurrent call could slip through while the initial network call
  (advertise / subscribe-send) was still in flight.
  Re-verified live: the exact 4-concurrent-`call()` reproduction now
  succeeds cleanly (all 4 resolve), and a follow-up ordinary `call()` on
  the same Session afterward still succeeds — the Session is never left
  bricked. A concurrent-`subscribe()` reproduction (two `subscribe()`
  calls racing on one Session) now correctly allows only one to succeed.

- **A subscription whose connection died was silent and hung the
  process forever.** `cabi/pubsub.go`'s background reader goroutine only
  ever reported its exit into an internal channel, never to JS; the
  `ThreadSafeFunction` (which deliberately keeps Node's event loop alive
  for a *healthy* subscription) was only released via the explicit
  `stop()` path, never when the goroutine exited on its own; and
  `Session.close()` awaited a failed `stop()` before nulling its handle,
  so a dead subscription's `close()` call would itself fail, leaving the
  Session's handle (and its underlying QUIC connection) permanently
  leaked. Reproduced live at the raw native layer: killing a session out
  from under an active subscription (not via its own `stop()`) delivered
  no signal at all, and the process needed to be force-killed after 15s+
  rather than exiting on its own.
  Fixed: `cabi/pubsub.go`'s reader goroutine now delivers a terminal
  "closed" signal (with the real underlying error) through the same
  `ThreadSafeFunction` used for ordinary events whenever it exits for
  any reason other than its own requested stop (`context.Canceled`) —
  `addon/binding.cc`'s `OnMaculaSubscriptionClosed` mirrors the existing
  `OnMaculaEvent` delivery path. `Session.subscribe()` now accepts an
  optional `opts.onClosed(error)` callback and reacts to a "closed"
  signal by automatically tearing the subscription down (releasing the
  native handle, clearing internal state) whether or not a caller
  provided one. `Session.subscribe()`'s returned `stop()` is now
  idempotent and safe to call from more than one place (the caller's own
  code, and this internal auto-teardown) without double-invoking the
  native stop. `Session.close()` now swallows a failed subscription
  `stop()` instead of letting it abort closing — it always proceeds to
  actually close the underlying session and null its handle.
  Re-verified live: the raw-layer reproduction above now delivers the
  real underlying error through the "closed" signal, and the process
  exits naturally with no external kill needed. Confirmed the legitimate
  case is unaffected: a program that only `subscribe()`s and does
  nothing else still stays alive for the life of a genuinely healthy
  subscription (verified it is NOT killed early by this fix).

- `PublishOptions.ttlMs`'s doc comment said "milliseconds since epoch";
  the field is (and was always treated by the code as) a *duration* in
  milliseconds, matching every other `ttlMs` in this SDK — fixed the doc
  only, the actual behavior was already correct.

- Stale doc comments: `cabi/main.go`'s header still said "No
  pubsub/content transfer/streaming/UCAN yet" (all but streaming now
  exist); `.github/workflows/ci.yml` still said "no cross-platform
  prebuilt matrix yet" (five platforms exist since 0.8.0, built by the
  separate `prebuilds.yml`).

## [Unreleased]

Real cross-platform prebuild distribution, built on all prior protocol
work (no changes to `cabi/main.go`, `addon/binding.cc`, or any protocol
logic this round — packaging/CI only). `prebuilds/` now ships five
platforms instead of one: `linux-x64`, `linux-arm64`, `darwin-arm64`,
`darwin-x64`, `win32-x64` (`git ls-files prebuilds/` shows all five).

### Added

- `.github/workflows/prebuilds.yml`: a build matrix across real
  GitHub-hosted runners (`ubuntu-latest`, `ubuntu-24.04-arm`,
  `macos-latest`, `macos-15-intel`, `windows-latest`) — `CGO_ENABLED=1`
  needs a matching native C toolchain per target, so cross-compiling
  `cabi/`'s Go archive from Linux isn't the right approach here, the
  same reason `sharp`/`bcrypt` and other real native npm packages use
  per-OS runners for this. Each leg builds the Go c-archive, the N-API
  addon (`node-gyp rebuild`), and that platform's `prebuildify` output;
  a final job collects whichever legs succeeded (not gated on all of
  them) and commits `prebuilds/` back to `main`. Triggered by a push
  touching `cabi/`, `addon/`, `binding.gyp`, or `package.json`, or
  manually via `workflow_dispatch`.
- `binding.gyp`: an `OS=="win"` conditions block (library linking only
  — `ws2_32`, `ntdll`, `userenv`, `bcrypt`), the missing piece for
  Windows that only ever had `linux`/`mac` conditions before.

### Fixed

Three real, live-verified bugs surfaced by actually running the new
workflow on real infrastructure rather than assuming the YAML was
correct (per this repo's own discipline: don't declare something done
without watching it actually happen):

- **Windows `build:go` never ran.** `package.json`'s script used POSIX
  inline env-var-prefix syntax (`CGO_ENABLED=1 go build ...`). npm
  always runs `package.json` scripts through `cmd.exe` on Windows
  regardless of which shell invoked `npm run` — confirmed live: it
  still failed even when the enclosing CI step used an MSYS2 bash
  shell, because npm itself re-spawns `cmd.exe` for the script content.
  Replaced with `go env -w CGO_ENABLED=1` ahead of the build, a single
  command with no OS-specific quoting.
- **`macos-13` is gone.** The originally-planned plain-Intel runner
  queued indefinitely across two separate workflow runs and never got a
  runner. GitHub fully retired the macOS 13 image on 2025-12-08.
  Swapped for `macos-15-intel`, GitHub's documented replacement (the
  last x64 macOS image it ships, supported until August 2027) — picked
  up a runner immediately.
- **The pre-existing "Confirm the committed prebuild is not stale" CI
  check had failed on every single commit since 21a3a7f** (verified via
  `gh run list` history) — not something this round introduced, but
  directly in the way of proving the new pipeline actually works, so
  fixed rather than worked around. Root cause, found via a temporary
  diagnostic artifact and `go version -m`: Go's default `-buildvcs=auto`
  stamps the *current* git commit hash into the binary, so a committed
  build artifact structurally can never match a fresh rebuild done at
  any later commit. `build:go` now passes `-buildvcs=false` (and
  `-trimpath`, standard practice for reproducible Go builds, added
  alongside it though it wasn't the deciding factor on its own). The
  check has now passed clean end to end, confirmed live.

### Known gaps

- `test-live` (the manually-triggered job that runs the real-station
  test suite in CI) fails with `sendmsg: network is unreachable` — a
  pre-existing, unrelated limitation: standard GitHub-hosted runners
  have no IPv6 egress, and the station this SDK targets is IPv6-only.
  Not touched this round; out of scope for a packaging/CI stage that
  changes no protocol code. This stage's own verification was the
  offline `npx vitest run` (green, live tests correctly skipped) plus a
  full local zero-install-script re-verification (fresh `npm pack` +
  install into an empty directory, no gyp/go/compile signals in a
  verbose install log) — neither needs network access to the mesh.

## [0.8.0] - 2026-09-03

UCAN: `Ucan.mint()`/`Ucan.decode()` (offline, no network I/O) and
`Session.callWithUcan()` (attaching a token to a real CALL), live-verified
against the real production fleet. Builds on 0.7.0's RPC layer --
`connection.Session.CallWithUCAN` is `Call` plus one attached token, so
this composes directly with the existing `call()`/`session.ts` shape, no
new transport-level plumbing. Ported from macula-php's `cabi/ucan.go`
(`macula_call_with_ucan`), the identical FFI-over-macula-go pattern this
project already uses, adapted to this project's own JSON-payload and
`recover()`-guarded handle conventions rather than PHP's raw-bytes
scalar-tuple one.

### Added

- `cabi/ucan.go`: `macula_ucan_mint` -- `ucan.Create`, self-issued and
  signed by an existing identity handle; `macula_ucan_decode` --
  `ucan.Decode` (parses claims WITHOUT verifying signature or expiry, the
  same non-verifying contract `ucan.Decode` itself documents). Both are
  pure local operations (no network I/O) and export synchronously, called
  directly from `addon/binding.cc` rather than through an
  `Napi::AsyncWorker` -- the same convention `macula_identity_generate`
  already established for local, fast operations. Neither introduces a
  new `cgo.Handle` type: a minted token crosses as plain ASCII text (a
  JWT is already base64url + "."), decoded claims as a JSON string --
  simpler than macula-php's own handle-based `ucan.Payload`/token
  accessors, and with no new handle-safety surface to get wrong.
  `macula_session_call_with_ucan` -- `rpc.go`'s `macula_session_call`
  plus one attached `ucanToken` parameter, reusing its
  `callEnvelope`/`callResponseToEnvelope` verbatim; real network I/O, so
  this one DOES run through an `Napi::AsyncWorker`
  (`SessionCallWithUcanWorker`).
- `addon/binding.cc`: `UcanMint`/`UcanDecode` (plain synchronous
  functions), `SessionCallWithUcanWorker`/`SessionCallWithUcan` (same
  `Napi::AsyncWorker` shape as `SessionCallWorker`).
- `src/ucan.ts`: `Ucan` (mint/decode, `issuer`/`audience`/`capabilities`/
  `expiresAt`/`notBefore`/`nonce`/`facts`/`proofs`/`isExpired`
  accessors), `UcanCapability`, `UcanFactValue` (deliberately DOES include
  `boolean` -- a UCAN token's `fct` claim crosses this boundary as plain
  JSON via Go's `encoding/json`, never macula's CBOR mesh wire, so
  `rpc.ts`'s "no bool on the wire" rule does not apply to it), and
  `UcanMintOptions`. `issuer`/`audience` DID strings are built
  automatically as `did:macula:<hex NodeID>`, matching macula-go's own
  tests (`ucan/ucan_test.go`, `connection/serve_ucan_test.go`) and
  `examples/ucan/main.go` exactly rather than this SDK inventing a
  different convention.
- `src/session.ts`: `Session.callWithUcan(procedure, payload, ucanToken,
  opts?)` -- `call()`, attaching a UCAN token (a `Ucan` or a raw token
  string). Subject to the identical same-Session exclusivity guard as
  `call()` (`#requireHandleNotServing`) -- both end up on the same shared
  control stream.
- `src/index.ts`: exports `Ucan`, `UcanCapability`, `UcanFactValue`,
  `UcanMintOptions`.
- `src/ucan.test.ts` (offline, default CI, 10 tests): a full mint round
  trip through every claim (issuer/audience/capabilities/expiresAt/
  notBefore/nonce/facts/proofs); mint with no options producing a token
  with no expiry/notBefore/nonce/facts claims; `decode()` as `mint()`'s
  own inverse; `isExpired` true for a past `exp` and false for a future
  one; two different issuer identities producing different `iss` claims
  and different tokens; `mint()` accepting an audience unrelated to any
  real identity (see "no audience-matching guard" below); `mint()`
  rejecting a wrong-length audience; `mint()` with a disposed identity
  throwing instead of touching a freed handle; `decode()` of a malformed
  token throwing; `decode()` of a token with a tampered payload segment
  still parsing (proves this is genuinely non-verifying, not a
  verify-then-decode that only happens to succeed on well-formed input).
- `src/ucan.live.test.ts` (opt-in via `MACULA_TS_LIVE`, 3 tests): a
  freshly minted `Ucan` attached via `callWithUcan()` to a real CALL
  against a real advertised procedure, completing with the real
  round-tripped RESULT; the same with a raw token string instead of a
  `Ucan`; calling an unadvertised procedure with a token attached still
  coming back a real `unknown_next_peer` (a token doesn't change ordinary
  CALL error behavior). See "Known gaps" below for what this suite
  deliberately does NOT prove.
- `package.json`'s `test:live` script now runs all six live suites.

### Design decision: no audience-matching guard

This SDK's own research into the real verify chain (Erlang's
`authorize_policy` + `macula_ucan_nif:verify/2`, identical across every
SDK port including macula-go) established that macula's UCAN gate is a
BEARER-token check: it verifies a token's signature and expiry against
its own issuer, and never checks the calling identity against the
token's `aud` claim. Accordingly, neither `Ucan.mint()` nor
`Session.callWithUcan()` implements any client-side "does my identity
match this token's audience" guard -- `mint()` accepts any 32-byte
audience with no relationship check to the issuing identity (tested
directly in `ucan.test.ts`), and `callWithUcan()` attaches whatever token
bytes it is given unconditionally. Adding such a guard would both reject
configurations the real wire-level gate accepts fine and misrepresent a
security property the mesh does not actually enforce.

### Verified

- All 10 `ucan.test.ts` cases and all 3 `ucan.live.test.ts` cases passed
  (also re-run together with the other five live suites via `npm run
  test:live`, 18/18 passing).
- Handle safety probed directly at the native layer (not just through the
  public API): a garbage/never-issued identity handle passed to
  `ucanMint` throws cleanly (`"macula-ts/cabi: invalid identity handle"`)
  instead of crashing the process, through the same
  `recover()`-guarded `identityFromHandle` lookup every other export in
  this cabi already uses -- this slice introduces no handle type of its
  own for that lookup to get wrong in a new way.
- Zero-install-script property re-verified after this change, from a
  fully clean tree (`node_modules`/`build`/`dist`/`prebuilds`/
  `cabi/build` all removed first): `build:go` -> `install` ->
  `typecheck` -> `test` -> `tsc` -> `build:prebuilds`, then a real packed
  tarball installed into a fresh directory with a verbose install log
  showing only the two declared runtime dependencies fetched -- no
  `node-gyp`/compiler invocation at all -- and a standalone script using
  only the installed `@macula-io/ts` package minted and decoded a real
  UCAN token end to end (issuer/audience/expiresAt/facts/isExpired all
  round-tripped correctly), confirming the new API works from the
  published package alone, not just the dev build.

### Known gaps (deferred, not forgotten)

- **Provider-side UCAN policy gating is not implemented** -- macula-go's
  `ucan.Policy`/`Session.ServeOneCallGated` (refusing an inbound CALL
  before a handler runs unless its attached token verifies against a
  required issuer) has no counterpart here. This SDK can mint a token and
  attach it to an outgoing call, but cannot stand up a served procedure
  that actually enforces one. `ucan.live.test.ts` proves the
  attach-and-call mechanism reaches the wire and completes against a real
  (ungated) procedure -- it does NOT prove enforcement, since there is no
  gated procedure on the live fleet for this SDK to call without also
  building that missing provider-side piece. macula-go's own
  `connection/serve_ucan_test.go` and
  `directdial/directdial_live_test.go`'s
  `TestLiveDirectDialUCANGatedRoundTrip` already prove enforcement works
  for this exact protocol when a gated provider is present.
- `ucan.ComputeCID`/proof-chain validation is not exposed -- `proofs` is
  carried through `Ucan.mint()`'s options and `Ucan#proofs` as opaque
  strings, never computed or checked here.
- Only `linux-x64` prebuild coverage (unchanged).
- Streaming RPC, direct-dial, `Pinned`/`Insecure` trust modes (unchanged).

## [0.7.0] - 2026-09-03

Content transfer: `Session.putContent()`/`Session.getContent()`,
live-verified against the real production fleet -- both against a dev
build and, separately, against the actual packaged, installed npm
tarball. Builds directly on 0.6.0's `Session.connect()` -- unlike every
prior slice (`call`/`serve`, the DHT methods, `publish`/`subscribe`),
this one reads and writes its OWN dedicated QUIC stream, not the shared
control stream, so it introduces no new same-Session exclusivity rule.

### Added

- `cabi/content.go`: `macula_content_put` -- `content.Put`, chunking
  automatically above `manifest.DefaultChunkSize` (256 KiB) and
  returning the hex-encoded 34-byte MCID. `macula_content_get` --
  `content.Get`, including its own client-side hash re-check against the
  requested MCID (a station may only be *relaying* content it doesn't
  itself store, so its answer is never trusted blindly -- see
  `content/content.go`'s own doc). `*notFoundOut` distinguishes
  `content.ErrNotFound` (an expected, routine outcome) from a real
  transport failure, the same convention `macula_dht_find_record`
  already established. `macula_free_bytes` frees the malloc'd buffer
  `macula_content_get` returns on success -- content is arbitrary binary
  data, not guaranteed-NUL-terminable text, so unlike every other
  `*C.char`-returning export in this cabi it cannot cross as a C string.
  Neither function introduces a new Go-side handle type -- both reuse the
  existing session/identity handles and their `recover()`-guarded
  lookups, so no new handle-safety surface was added.
- `addon/binding.cc`: `ContentPutWorker`/`ContentGetWorker`
  (`Napi::AsyncWorker`, same shape as every other network-touching
  worker here -- real I/O, off Node's main thread).
- `src/content.ts`: `ContentNotFoundError`, and this module's own doc
  comment on the one thing every consumer needs to know before using
  this at all -- **content transfer is a one-time TRANSFER mechanism,
  not durable object storage**. A station may forget content after
  serving it; there is no list/delete operation.
- `src/session.ts`: `Session.putContent(data, name?)` and
  `Session.getContent(mcid)`. Deliberately **not** routed through
  `#requireHandleNotServing` (the guard `call()`/`serve()`/the DHT
  methods/`subscribe()` all share) -- `content.Put`/`Get` each open a
  *fresh* `Session.OpenDedicatedStream` QUIC stream of their own on the
  Go side, never touching the shared control stream those others read
  from, so they never race a concurrent `serve()`/`subscribe()` (or each
  other) on the same `Session` -- confirmed live, not just reasoned
  about (see below).
- `src/content.live.test.ts` (opt-in via `MACULA_TS_LIVE`): a 600-byte
  random buffer round-tripped byte-for-byte through `putContent()`/
  `getContent()`; the same round trip with no `name` given (proving
  `name`'s documented "chunked path only" behavior doesn't break the
  single-block path); `getContent()` of a well-formed but never-stored
  mcid rejecting with `ContentNotFoundError` specifically; `putContent()`/
  `getContent()` succeeding while a `serve()` is active on the same
  `Session` -- the actual, live proof of the dedicated-stream
  no-exclusivity-guard claim above, exercising exactly the combination
  `pubsub.live.test.ts`'s own exclusivity test proves throws for
  `call()`/`subscribe()` instead.
- `package.json`'s `test:live` script now runs all five live suites.

### Fixed

- A real bug found through the exact kind of handle/input probing this
  project's own discipline calls for, not by inspection: passing a
  correctly-hex-decoded but wrong-*length* mcid to `getContent()`
  produced the literal string `%!w(<nil>)` inside the thrown error
  message -- `macula_content_get`'s Go code folded two different failure
  cases (a hex-decode error, and a right-hex-but-wrong-length value)
  into one `fmt.Errorf("...: %w", err)`, and the second case passes a
  `nil` `err` into that `%w`, which Go's `fmt` package renders as that
  garbled placeholder rather than nothing. Split into two separate,
  correctly-worded error paths; re-verified live against a real station
  that the resulting message is now a clean, readable sentence.
- Probed directly and confirmed already-safe (no new bug, but verified
  rather than assumed): garbage session/identity handles, an
  already-freed identity handle, and an empty data buffer passed to
  `putContent`/`getContent` all reject with a clean JS error and never
  crash the process -- through the same `recover()`-guarded
  `sessionFromHandle`/`identityFromHandle` lookups every other export in
  this cabi already uses; content transfer introduces no handle type of
  its own for this to get wrong in a new way.

## [0.6.0] - 2026-09-03

Pubsub: `Session.publish()`/`Session.subscribe()`, live-verified against
the real production fleet -- both against a dev build and, separately,
against the actual packaged, installed npm tarball. Builds directly on
0.5.0's RPC/DHT layer; the same `connection.Session` `Session.connect()`
already hands back.

### Added

- `cabi/pubsub.go`: `macula_session_publish` -- `connection.Session.Publish`,
  same fire-and-forget worker shape as `macula_session_advertise`. `seq`
  is minted by a process-wide monotonic counter (this SDK's `publish()`
  has no `seq` parameter of its own yet), the same shape macula-go's own
  unexported `factSeq()` telemetry counter uses. `macula_session_subscribe_start`/
  `_stop` -- a whole running background reader loop, not a single
  request/response: `_start` sends SUBSCRIBE then starts a goroutine
  running macula-go's own `Session.RunSubscriber` (deliberately not
  reimplemented on top of the lower-level `RecvEvent`, which treats ANY
  non-EVENT frame on this shared control stream as fatal --
  `RunSubscriber` already gets right, from its own prior live debugging,
  that one must be skipped instead); `_stop` cancels it and BLOCKS until
  the goroutine has actually exited (UNSUBSCRIBE sent, no further
  delivery possible), not merely until a stop was requested. Delivery
  itself crosses the FFI boundary through a C function pointer
  (`macula_event_callback`) the addon supplies, called from the reader
  goroutine's own OS thread via a `callEventCallback` C trampoline (cgo
  cannot invoke a C function pointer value directly) -- this is the
  first place in this SDK where Go calls back into the addon on its own
  schedule rather than only ever answering a JS-initiated request.
- `addon/binding.cc`: `SessionPublishWorker` (same shape as
  `SessionAdvertiseWorker`); `SubscriptionContext` (owns one
  `Napi::ThreadSafeFunction` per subscription), `OnMaculaEvent` (the
  `extern "C"` function the Go-side trampoline calls, doing nothing but
  `NonBlockingCall` -- never touches a `Napi::Env`/V8 handle off the
  main thread, same rule every `AsyncWorker` here already follows),
  `SessionSubscribeStartWorker`/`SessionSubscribeStopWorker`. A
  `g_subscriptions` map (Go subscription handle -> `SubscriptionContext*`,
  main-thread-only, no locking needed) lets `SessionSubscribeStop` find
  the TSFN to release, since JS only ever holds the Go-side handle.
- `src/pubsub.ts`: `PublishOptions`, `PubsubEvent` -- the same
  `rpc.ts`/`dht.ts` shape split (Session, in `session.ts`, is the actual
  FFI entry point).
- `src/session.ts`: `Session.publish(topic, payload, opts?)` and
  `Session.subscribe(topic, handler)`. `publish()` is deliberately NOT
  subject to the same-Session exclusivity guard `call()`/`serve()`/the
  DHT methods share (`#requireHandleNotServing`) -- it only ever writes,
  never reads off the shared control stream, so (unlike those) it can
  run safely on the SAME Session a `subscribe()` of its own is active
  on, which the live round-trip test below depends on. `subscribe()` DOES
  share that guard (extended to also block on an active subscription,
  and vice versa for `serve()`) -- its background reader reads frames
  off the same stream on its own schedule, exactly like `serve()`'s poll
  loop does, so mixing either with `call()`/the DHT methods/each other
  races the same way. Only one `subscribe()` per `Session` at a time
  (matching `serve()`'s own one-at-a-time rule) -- open a second
  `Session` for a second topic.
- `src/pubsub.live.test.ts` (opt-in via `MACULA_TS_LIVE`): a `subscribe()`
  receiving the SAME Session's own `publish()`, payload/publisher/seq all
  checked; `stop()` verified to actually halt delivery (publish again
  immediately after `stop()` resolves, confirm nothing further arrives,
  not just that nothing happened to arrive yet); `subscribe()` while
  `serve()` is active (and `serve()`/`call()` while `subscribe()` is
  active) all throwing immediately.
- `package.json`'s `test:live` script now runs all four live suites.

### Fixed

- A real bug found through the exact kind of probing this stage's own
  task called for, not by inspection: a still-active `subscribe()`'s
  background reader goroutine holds a live `Napi::ThreadSafeFunction`,
  which -- deliberately, so that a program doing nothing but
  `subscribe()` and waiting stays alive for events to arrive at all --
  keeps Node's event loop alive on its own, unlike every other handle
  this SDK hands out. That same property meant closing a `Session` out
  from under an active subscription (without calling its own `stop()`
  first) hung the process forever instead of merely leaking a handle --
  confirmed live: a script that `subscribe()`d then `close()`d never
  exited on its own even after 20s, while the identical script with no
  `subscribe()` at all exited instantly. Fixed by having `Session.close()`
  stop an active subscription first (sending its UNSUBSCRIBE over the
  still-open connection before that connection goes away), so forgetting
  the returned `stop()` fails safe instead of fails hung. Verified this
  did NOT break the legitimate case the live TSFN ref exists for: a
  separate probe script that only `subscribe()`s and does nothing else
  was confirmed to stay alive (not exit early) for as long as it was
  given to run.

### Verified

- Both `pubsub.live.test.ts` scenarios passed against
  `station-de-frankfurt.macula.io:4433`, individually and as part of the
  full `npm run test:live` (11/11 passing across all four live suites).
- Separately re-verified against the actual packaged, installed npm
  tarball (not the dev build): a real `npm pack` tarball installed into
  a fresh directory with no source tree present, then a standalone
  script using only the installed `@macula-io/ts` package performed a
  real `subscribe()`/`publish()` round trip against the live station and
  got back the exact payload sent.
- Deliberately probed, not just the happy path: a garbage/never-issued
  session handle passed to `sessionPublish`/`sessionSubscribeStart`
  throws a clean error instead of crashing the process; a
  garbage/never-issued subscription handle passed to
  `sessionSubscribeStop` throws cleanly; calling the same `stop()`
  function twice throws cleanly on the second call instead of
  double-freeing or hanging; `subscribe()` after `close()` throws "used
  after close()" instead of touching a freed handle; closing a Session
  with an active, never-stopped subscription no longer hangs the process
  (see "Fixed" above) and was confirmed to still close and exit cleanly.
- Zero-install-script property re-verified after this change, from a
  fully clean tree (`node_modules`/`build`/`dist`/`prebuilds`/
  `cabi/build` all removed first): `build:go` -> `install` -> `typecheck`
  -> `test` -> `tsc` -> `build:prebuilds`, then a real packed tarball
  installed into a fresh directory with a verbose install log showing
  only the two declared runtime dependencies fetched -- no
  `node-gyp`/compiler invocation at all -- and (see above) a real live
  pubsub round trip performed from that installed package alone.

### Known gaps (deferred, not forgotten)

- Only `linux-x64` prebuild coverage.
- `publish()`/`subscribe()` default to the all-zero realm only, matching
  `call()`/`serve()`'s own existing gap -- realm isn't yet a public
  parameter on any of the four.
- Only one `subscribe()` (and no active `serve()`) per `Session` at a
  time -- no multiplexing several topics' worth of EVENT delivery
  through one background reader; open a second `Session` per additional
  topic for now.
- `publish()` has no exposed `seq`/ordering/dedup semantics -- `seq` is
  minted internally by a process-wide counter, not caller-controlled.
- Content transfer, streaming RPC, UCAN, direct-dial, `Pinned`/`Insecure`
  trust modes.

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
