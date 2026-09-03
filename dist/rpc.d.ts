/** A CALL/RESULT payload, restricted to what macula's wire CBOR can
 * actually represent (cbor.Value's Kind enum: UInt/NegInt/Bytes/Text/
 * List/Map/Null/Float -- no bool, no undefined). There is deliberately
 * no `boolean` in this union: encode true/false as 1/0 yourself, the
 * same rule this project's macula MCP server and macula-cli's own
 * wirevalue package both enforce -- a JS boolean silently reaching the
 * wire is exactly the mistake this type exists to make impossible at
 * compile time.
 *
 * Bytes have no native JSON shape either: represent them as a
 * "0x"-prefixed hex string, cabi's own convention (ported from
 * macula-cli's wirevalue package, see cabi/wirevalue.go) -- a payload
 * or reply containing raw bytes round-trips through call()/serve()
 * unchanged as long as both sides agree on that convention. */
export type JsonValue = string | number | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/** The BOLT#4 fields a failed CALL carries -- see bolt4/bolt4.go's own
 * 17-code table (UnknownNextPeer, TemporaryRelayFailure, Unauthorized,
 * ...). `retryable` is bolt4.Code.IsRetryable()'s verdict, computed
 * Go-side from `code` (cabi/rpc.go), not re-derived here. */
export interface Bolt4ErrorInfo {
    readonly code: number;
    readonly name: string;
    readonly retryable: boolean;
    readonly detail: string | null;
}
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
export declare class MaculaCallError extends Error {
    readonly code: number;
    readonly bolt4Name: string;
    readonly retryable: boolean;
    readonly detail: string | null;
    constructor(info: Bolt4ErrorInfo);
}
/** The JSON envelope cabi/rpc.go's macula_session_call returns --
 * internal to the FFI boundary, not part of the public API. Kept in
 * sync BY HAND with cabi/rpc.go's callEnvelope/callEnvelopeError Go
 * structs; there is no shared schema generating either side. */
export type CallEnvelope = {
    ok: true;
    payload: JsonValue;
} | {
    ok: false;
    bolt4: Bolt4ErrorInfo;
};
/** How long Session.call() waits for a RESULT/ERROR before giving up,
 * in milliseconds -- also becomes the wire's own `deadline_ms` (now +
 * this), matching macula-go's own examples/quickstart/main.go, which
 * derives both from one duration rather than treating the local wait
 * and the wire deadline as independent numbers. */
export declare const DEFAULT_CALL_TIMEOUT_MS = 30000;
/** How long one Session.serve() poll tick blocks waiting for the next
 * inbound CALL before checking whether stop() was requested --
 * mirrors macula-go's own servePollInterval (connection/serve_loop.go),
 * the exact tick length its ServeForever uses internally for the same
 * "poll with a bounded per-tick wait, check for cancellation between
 * ticks" shape. */
export declare const SERVE_POLL_MS = 2000;
