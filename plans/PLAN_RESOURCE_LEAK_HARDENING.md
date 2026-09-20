# PLAN_RESOURCE_LEAK_HARDENING.md

**Status:** Survey complete — hardening not started
**Created:** 2026-09-12
**Last Updated:** 2026-09-12

## Overview

Read-only survey of `/home/rl/work/github.com/macula-io/macula-ts` for
memory and resource leaks. This repo is a three-layer TypeScript/Node port
of the macula mesh SDK: `src/*.ts` (thin typed facade), `cabi/*.go`
(cgo exports over `macula-go` v0.7.1, linked as a static c-archive), and
`addon/binding.cc` (N-API glue, `Napi::AsyncWorker` for network I/O,
one `Napi::ThreadSafeFunction` for pubsub delivery). No code was changed.
Key structural difference from the C# sibling: QUIC stream, frame-buffer,
and manifest ownership live inside `macula-go`, not this repo — so several
dotnet findings (F1–F3 stream lifecycle, F6 buffer growth) have no direct
TS-layer equivalent and are recorded as "not present / lives in macula-go"
below. The TS/Node-specific surface (cgo handles with no GC coordination,
TSFN queues, `setInterval`-retained object graphs, poll-loop pending-call
rendezvous) has its own set of findings.

General hygiene found to be GOOD and not repeated here: every
`Napi::AsyncWorker` error path frees the cabi errOut string; the
`Session.#enqueue` chain swallows its own link rejection so one failed
call cannot wedge the queue (session.ts:151-163); `Session.close()` stops
an active subscription before tearing down the connection
(session.ts:264-280); pool close/unsubscribe await `inFlight`/`pendingClose`
before disposing identities (pool.ts:694-714); subscription TSFN release is
correctly deferred until the Go goroutine has exited
(binding.cc:1540-1559); `keepAdvertisedDirect`'s interval is unref'd and
cleared by its stop (directdial.ts:113-126).

---

## Findings (ranked)

### CRITICAL

#### F1. Unbounded native event queue for pubsub delivery (TSFN created with queue size 0)
`addon/binding.cc:1514-1515` (`Napi::ThreadSafeFunction::New(..., 0 /* unlimited queue */, 1)`), fed by `addon/binding.cc:1370-1396` (`OnMaculaEvent`).

`Session.subscribe()` (session.ts:835-916) installs the user's handler as
a TSFN whose queue is explicitly **unlimited**. Every delivered EVENT
makes a heap-allocated `EventCallbackData` (a full copy of topic +
payload JSON, binding.cc:1353-1358, 1373-1378) enqueued via
`NonBlockingCall`. The Go reader goroutine (`cabi/pubsub.go:293-310`)
delivers synchronously into that queue and never blocks on JS, so a
high-rate topic (or a momentarily busy event loop — the SDK's own pool
dedup runs *after* the queue drains, pool.ts:613-615) grows the native
queue without bound. No backpressure, no cap, no drop policy; per-event
native heap. The dotnet sibling used a bounded 256-slot channel for
exactly this reason. Fix direction: pass a bounded `max_queue_size` to
`ThreadSafeFunction::New`, and either drop-with-log or apply a small
native-side coalescing policy when `NonBlockingCall` returns
`napi_queue_full`.

### HIGH

#### F2. No GC/finalizer safety net for Go handles — a dropped `Identity` or `Session` leaks process-lifetime
`src/identity.ts:9-13` (documented for Identity), `src/session.ts:114-186` (Session construction), `cabi/main.go:206-208` (`macula_identity_free`), `cabi/main.go:227-232` + `:276-295` (`macula_session_connect`/`_close`, the only place `deleteHandle(sessionHandle)` runs).

`runtime/cgo.Handle` values are process-global with **no GC
coordination across the FFI boundary**. The only reclaim paths are the
explicit `Identity.dispose()` and `Session.close()`; there is no
finalizer, `FinalizationRegistry`, or N-API finalizer hook anywhere.
A `Session` the application drops without `close()` leaks: its cgo
handle, the Go-side `*connection.Session` (goroutines, buffers), and a
**still-open QUIC connection** (the station keeps a live link until its
own idle timeout) for the life of the process. Same for every
`Identity` minted and forgotten — the exact pattern
`identity.ts:9-13` already admits. This is the TS analog of dotnet
F12, but stronger: dotnet GC reclaims managed objects, while nothing
ever reclaims these. Fix direction: register an N-API finalizer
(`napi_add_finalizer`) on the JS wrapper that calls the matching
`macula_*_free`/close, or a debug-mode registry watchdog for sessions.

#### F3. `Pool` dropped without `close()` retains the entire object graph (live sessions, identities) via its unref'd sweep interval
`src/pool.ts:242-243` (`this.#sweepTimer = setInterval(...)`, unref'd), object graph at `pool.ts:215-225`, close path at `pool.ts:694-714`.

`setInterval` holds a strong reference to its callback, which closes
over the `Pool`, which owns `#controlIdentity`, every `#controlLinks`
session, and every subscription's identity. `unref()` only makes the
timer *not keep the process alive* — it does **not** break the
reference chain, so a caller that drops a Pool without `close()` leaves
the whole graph uncollectable until process exit, with every Go-side
connection still open (no GOODBYE sent). Same shape as dotnet F12's
static registry. Fix direction: a `FinalizationRegistry` on `Pool` (or
on `RoleLink` sessions) that best-effort closes, plus documenting
`close()` as required.

#### F4. `serve()` pending-call rendezvous leaks on a hung handler, and `stop()` hangs forever
`src/session.ts:451-479` (poll loop), `:481-488` (`stop()` awaits `loopDone`), `cabi/serve.go:46-51` (`pendingCall`), `:159-207` (goroutine blocked inside `ServeOneCall`'s handler), reply workers `cabi/serve.go:252-304` + `addon/binding.cc:800-852`.

Each inbound CALL hands the JS loop a `pendingCall` cgo handle; the
Go goroutine stays blocked inside `ServeOneCall`'s handler on
`replyCh` until the JS side replies (`cabi/serve.go:167-178`). If the
user's `handler(payload)` never settles (session.ts:467-477), the
`pendingCall` handle, its goroutine, and both buffered channels are
never reclaimed — and `stop()` never resolves because it awaits
`loopDone`, which awaits the handler (session.ts:482-483). Even
`Session.close()` does not reclaim this: it stops only the
subscription, not the serve loop (session.ts:262-284). If `stop()` is
called while the handler is in flight, the session unadvertise also
never runs. Fix direction: a bounded reply deadline per pendingCall
(auto-send an ERROR reply + reap the handle when the handler exceeds
it), so `stop()` regains the bounded-latency property its own doc
claims.

### MEDIUM

#### F5. Dedup map growth between sweeps
`src/pool.ts:220` (`#dedup`), `:459-464` (`#sweepDedup`), `:613-615` (insertion).

Same finding as dotnet F8: `#dedup` is bounded only by event rate ×
`dedupWindowMs` (default 60 s) and `#sweepDedup()` is a full O(n) scan
every `dedupSweepMs` (default 30 s, pool.ts:241-243). Under sustained
high-rate traffic the map and the sweep cost grow linearly; not
unbounded (entries do age out), but a memory-pressure knob. Fix
direction: bucket the map by time slice so sweeps drop whole buckets,
or cap total entries with oldest-first eviction.

#### F6. Content-get boundary copies the whole payload twice with no size cap; manifest size validation lives in macula-go (dotnet F5 partial)
`addon/binding.cc:1685-1702` (`ContentGetWorker::Execute`), `:1710-1711` (`Buffer::Copy`), `cabi/content.go:133-147` (`macula_content_get`).

dotnet F5's "trust the manifest's declared size" concern is real here
but its fix site is `macula-go`'s `content.Get` (chunk/verify
logic), which this repo only wraps — the TS layer has no manifest
parser to fix. What *is* in this repo: the boundary unconditionally
copies whatever `content.Get` returned into a `std::string`
(binding.cc:1699) and then again into a fresh `Buffer` (:1710-1711),
doubling peak memory for a large blob, with no cap or streaming. A
malicious/oversized manifest therefore drives a large allocation at
this boundary even after any Go-side check. Fix direction: add a
boundary-level size cap before the copies (or a streaming
`Napi::Buffer` with a finalizer taking ownership of the malloc'd
buffer instead of copying), and cross-check the manifest-size
validation in macula-go itself.

#### F7. `close()` nulls `#handle` before the native close; a failed close leaves the Go session permanently leaked with no retry path
`src/session.ts:281-283` (`#handle = null` then `await native.sessionClose`), `cabi/main.go:277-295` (identity-invalid path returns without `deleteHandle(sessionHandle)`).

If `identity.handleForFfi()` throws (identity already disposed —
session.ts:283) or the native close fails at the
`identityFromHandle` guard (`cabi/main.go:283-287`), the Go-side
session handle is never deleted and JS has already lost the only
reference (`#handle === null`), so there is no retry and no reclamation:
an open QUIC connection leaks for the process lifetime. Caller misuse
triggers it, but the failure mode is permanent. Fix direction: in
`macula_session_close`, `deleteHandle(sessionHandle)` unconditionally
on every path after the session lookup; in `Session.close()`, only
null `#handle` after the native call settles (keep a retry/forced-close
path).

### LOW / hygiene

- `addon/binding.cc:53-56` (`ToHandle` Number branch): a fractional or
  out-of-range JS Number is silently truncated via
  `static_cast<uintptr_t>(double)` (NaN is UB); a stale/typo'd handle
  could address an unrelated live cgo object. Validate integrality and
  range.
- `addon/binding.cc:62-68` (`IdentityGenerate`): `identity.Generate()`
  (S/Kademlia puzzle grind, ~2^8 keygen attempts) runs synchronously on
  the JS main thread, blocking the event loop. Not a leak, but move to
  an `AsyncWorker` like the other CPU/IO-heavy calls.
- `src/session.ts:458-463` (`serve()` poll-failure branch): the loop
  exits without clearing `#activeServe` and without offering `stop()`
  any settled path; the Session stays permanently "serving" so every
  later `call()`/`subscribe()` throws until `close()`. Usability wedge,
  not a memory leak.
- `src/pool.ts:449-456`: the backoff `retryTimer` is deliberately NOT
  unref'd (documented "retry forever" contract) — a Pool with a
  permanently failing seed keeps the process alive indefinitely. By
  design, but pair with F3's watchdog so a dropped Pool can't do it.
- `Napi::ThreadSafeFunction` deliberately keeps the event loop alive
  for a healthy subscription (session.ts:248-261 documents why). This
  is intended; F1 only concerns the queue bound, not the liveness.

### Cross-check against the dotnet survey (macula-dotnet PLAN_RESOURCE_LEAK_HARDENING.md)

| dotnet finding | TS status |
|---|---|
| F1 ContentTransfer never releases dedicated stream | **Not present in TS layer.** `content.Put/Get` own their dedicated stream entirely inside macula-go (cabi/content.go:82,133); the FFI boundary exposes no stream handle. Cross-check macula-go's own teardown separately. |
| F2 AcceptAsync abandons accepted stream on non-refusal failures | **Not present** — no stream-accept API in this SDK. |
| F3 OpenAsync leaks stream if STREAM_OPEN write fails | **Not present** — no stream-open API. |
| F4 `when (!ct.IsCancellationRequested)` misclassifies OCE | **Not present** — no `AbortController`/cancellation exists in this SDK; timeouts are Go-side and already distinguished (`serve.go:195` collapses timeout+foreign-call into `noCall`, documented). |
| F5 manifest size trusted (`new byte[manifest.Size]`) | **Partial** — see F6 above; the allocation site is macula-go, the uncapped boundary copy is here. |
| F6 no IDisposable safety net on streams | **Analog** — see F2 above (cgo handle, not stream, is the undisposed resource). |
| F7 unbounded task fan-out per inbound CALL | **Not present** — `serve()` is a strictly sequential poll loop (session.ts:451-479); no fan-out at all. |
| F8 EventDedup growth between sweeps | **Present** — F5 above. |
| F9 fire-and-forget close task unobserved | **Not present** — all close paths are caught/awaited (pool.ts:434-440, 694-714). |
| F10 CTS ownership in RunPublisherAsync | **Not present** — `keepAdvertisedDirect` uses a cleared, unref'd interval (directdial.ts:113-126). |
| F11 dead Subscription objects retained by ended channel | **Not present** — subscriptions are removed from `#subscriptions` on unsubscribe (pool.ts:654-675) and `#activeSubscription` cleared in `realStop` (session.ts:871-874). |
| F12 static OpenSessions registry | **Analog** — F2/F3 above (cgo handle table + sweep-interval retention). |
| EventEmitter listeners not removed | **Not present** — no `EventEmitter` usage anywhere in `src/`. |

---

## Phases

- [ ] Phase 1 — Bound the native event queue (F1): bounded TSFN queue +
      defined overflow policy for pubsub delivery.
- [ ] Phase 2 — Handle lifecycle safety net (F2, F3): N-API finalizers
      (or watchdog) for `Identity`/`Session`/`Pool`; guarantee a dropped
      Pool cannot leave live connections behind.
- [ ] Phase 3 — Provider-role reaping (F4): bounded reply deadline per
      pendingCall so a hung handler cannot wedge `serve()`'s `stop()` or
      leak the rendezvous goroutine.
- [ ] Phase 4 — Memory-pressure bounds (F5, F6): dedup bucket sweep and
      a content-get boundary size cap (plus macula-go manifest cross-check).
- [ ] Phase 5 — Close-path hardening (F7): unconditional Go-side handle
      delete and retryable JS close.
- [ ] Phase 6 — Hygiene (LOW): `ToHandle` validation, async
      `IdentityGenerate`, serve-loop shutdown state.

## Files to Create/Modify

| File | Purpose | Status |
|------|---------|--------|
| `addon/binding.cc` | F1 TSFN queue bound; F6 content size cap; F2 finalizer registration; LOW ToHandle/async-identity | Not started |
| `src/session.ts` | F2 finalizer/watchdog, F4 reply deadline, F7 close ordering, LOW serve-loop state | Not started |
| `src/identity.ts` | F2 finalizer integration | Not started |
| `src/pool.ts` | F3 FinalizationRegistry/watchdog, F5 dedup bucket sweep | Not started |
| `cabi/serve.go` | F4 pendingCall reply deadline/reaping | Not started |
| `cabi/main.go` | F7 unconditional `deleteHandle(sessionHandle)` on close | Not started |
| `cabi/content.go` | F6 boundary cap (or ownership-transfer buffer) | Not started |

## Success Criteria

- [ ] A sustained high-rate EVENT flood against a slow JS handler shows
      flat native memory (TSFN queue capped; drop/coalesce policy in
      effect).
- [ ] A loop that creates and abandons `Session`/`Identity`/`Pool`
      objects shows no growth in live Go handles or open connections
      (finalizer/watchdog reclaims).
- [ ] A `serve()` handler that never resolves still unblocks `stop()`
      within a bounded deadline; the pendingCall handle and goroutine are
      reclaimed; the session can be closed and reused.
- [ ] `Pool` dedup memory stays flat under sustained multi-topic event
      load (bucket sweep).
- [ ] A malformed/huge content manifest fails fast at the FFI boundary
      without a large allocation or double copy.
- [ ] `Session.close()` after identity disposal leaves no leaked Go
      session handle (either a real error with handle freed, or a
      retryable close).
- [ ] All tests green: `npm test` and `npm run typecheck`; `npm run
      build:addon:dev` clean.
