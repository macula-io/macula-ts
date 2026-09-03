// Unary RPC -- the caller and provider roles built on top of a
// handshaked Session's control stream, via macula-go's own
// Session.Call (caller) and Session.Advertise + Session.ServeOneCall
// (provider) -- see connection/connection.go and connection/serve.go.
// The actual FFI plumbing lives on Session (session.ts); this file
// holds the shapes both directions share: the JSON-only payload model
// and the structured BOLT#4 error macula-go's own bolt4 package
// defines (bolt4/bolt4.go, 17 codes).
/** Thrown by Session.call() when the provider (or a relay in between)
 * answered with a real BOLT#4 ERROR frame instead of a RESULT -- e.g.
 * calling a procedure nobody has advertised comes back
 * unknown_next_peer; a provider handler that threw comes back
 * unknown_error (macula-go's connection/serve.go maps every handler
 * error to that one code, matching macula_station_link.erl's own
 * handle_inbound_call/2); a provider handler that panicked (recovered)
 * comes back temporary_relay_failure. Distinct from a plain
 * Error/rejection out of call() itself, which means this CALL never
 * got a wire-level answer at all (a local timeout, a dead connection,
 * a payload macula's CBOR can't represent). */
export class MaculaCallError extends Error {
    code;
    bolt4Name;
    retryable;
    detail;
    constructor(info) {
        super(`macula-ts: CALL failed: ${info.name} (bolt4 code ${info.code})${info.detail ? `: ${info.detail}` : ""}`);
        this.name = "MaculaCallError";
        this.code = info.code;
        this.bolt4Name = info.name;
        this.retryable = info.retryable;
        this.detail = info.detail;
    }
}
/** How long Session.call() waits for a RESULT/ERROR before giving up,
 * in milliseconds -- also becomes the wire's own `deadline_ms` (now +
 * this), matching macula-go's own examples/quickstart/main.go, which
 * derives both from one duration rather than treating the local wait
 * and the wire deadline as independent numbers. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** How long one Session.serve() poll tick blocks waiting for the next
 * inbound CALL before checking whether stop() was requested --
 * mirrors macula-go's own servePollInterval (connection/serve_loop.go),
 * the exact tick length its ServeForever uses internally for the same
 * "poll with a bounded per-tick wait, check for cancellation between
 * ticks" shape. */
export const SERVE_POLL_MS = 2_000;
//# sourceMappingURL=rpc.js.map