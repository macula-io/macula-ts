// Direct-dial: caller-side resolve+one-hop-call and provider-side
// advertise-direct, built on macula-go's directdial package (see
// cabi/directdial.go's own doc for the trust model -- every candidate
// procedure_advertisement must carry a valid signature before its
// serving_station is trusted at all, the resolved station_endpoint must
// be signed by the station itself, and after the one-hop dial -- which
// trusts neither the TLS certificate nor nothing -- the freshly connected
// peer's own HELLO-proven identity is checked against the exact pubkey
// the signed DHT chain resolved, application-layer pinning instead of
// relying on the dial's own TLS -- and for why AdvertiseDirect publishes
// BOTH a plain ADVERTISE and a signed procedure_advertisement DHT record:
// skipping the plain ADVERTISE lets resolve+dial complete cleanly against
// a station with nothing registered to route the CALL to, a real bug
// macula-go fixed live 2026-08-30). The actual FFI plumbing lives on
// Session (session.ts's resolveDirect/callDirect/callDirectWithUcan/
// advertiseDirect), matching this SDK's own call()/serve() split; this
// file holds the shapes those share, plus keepAdvertisedDirect -- a
// standalone helper mirroring macula-go's own free-function
// KeepAdvertisedDirect, not a Session method (see its own doc for why).
/** How long keepAdvertisedDirect() waits between re-advertise ticks, in
 * milliseconds, when opts.intervalMs is left unset. This is a real
 * production margin against AdvertiseDirectOptions' own 48h default TTL
 * actually expiring between ticks -- not chosen to match macula-go's own
 * KeepAdvertisedDirect live-test interval (1s there, only to keep that
 * particular test fast). A caller passing a much shorter `ttlMs` should
 * pass a correspondingly shorter `intervalMs` too; this constant does not
 * scale itself to `opts.ttlMs`. */
export const KEEP_ADVERTISED_DIRECT_INTERVAL_MS = 15 * 60 * 1000;
/** Re-advertises `procedure` as direct-dial-reachable on `session` (via
 * `session.advertiseDirect()`) immediately, then again every
 * `opts.intervalMs`, until the returned `stop()` is called -- macula-go's
 * own `KeepAdvertisedDirect` free function, ported here as a standalone
 * helper rather than a Session method for the identical reason
 * macula-go's own is a free function taking a `*connection.Session`
 * rather than a method on one: a station's registration for a procedure
 * does not survive the connection that sent it being replaced, so a
 * long-lived provider needs to call `AdvertiseDirect` again on its own
 * schedule, and it is this function's CALLER's job to decide WHICH
 * Session that runs on. See `Session.advertiseDirect()`'s own doc for why
 * that must NOT be a Session with an active `serve()` on it
 * (`advertiseDirect()`'s own `PutRecord` CALL would race `serve()`'s own
 * reads of the same shared control stream): a long-lived provider that
 * also serves `procedure` needs a SEPARATE Session (and identity -- this
 * fleet enforces one connection per identity, kicking whichever connects
 * second) for that, passed here instead of the serving Session.
 *
 * The returned `stop()` is synchronous -- unlike `Session.serve()`'s own
 * async `stop()`, there is no pending tick to wait out and no unadvertise
 * step: `advertiseDirect()`'s own DHT record simply expires on its own
 * TTL once ticks stop, matching macula-go's own `KeepAdvertisedDirect`,
 * which has no corresponding "undo" either. Calling `stop()` more than
 * once is a no-op. */
export function keepAdvertisedDirect(session, procedure, opts = {}) {
    const intervalMs = opts.intervalMs ?? KEEP_ADVERTISED_DIRECT_INTERVAL_MS;
    let stopped = false;
    const tick = () => {
        session.advertiseDirect(procedure, { realm: opts.realm, ttlMs: opts.ttlMs }).catch((err) => {
            opts.onError?.(err);
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    // Node keeps the event loop alive for a pending timer by default --
    // unref() so a program that starts this loop with nothing else keeping
    // it running (no active serve()/subscribe()/etc. elsewhere) can still
    // exit on its own; a real, still-open Session doing other work keeps
    // the process alive on its own merits regardless, unaffected by this.
    timer.unref?.();
    return () => {
        if (stopped)
            return;
        stopped = true;
        clearInterval(timer);
    };
}
//# sourceMappingURL=directdial.js.map