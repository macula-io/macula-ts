/** A CALL/RESULT payload, restricted to what macula's wire CBOR can
 * actually represent (cbor.Value's Kind enum: UInt/NegInt/Bytes/Text/
 * List/Map/Null/Float -- no bool, no undefined). There is deliberately
 * no `boolean` in this union: encode true/false as 1/0 yourself, the
 * same rule this project's macula MCP server and macula-cli's own
 * wirevalue package both enforce -- a JS boolean silently reaching the
 * wire is exactly the mistake this type exists to make impossible at
 * compile time.
 *
 * Bytes have no native JSON shape either. Going IN, write them as an
 * object whose ONLY key is "$bytes", holding standard padded base64
 * (RFC 4648 section 4): `{"$bytes": "AQID"}` is the three bytes 01 02 03.
 * Any other value under that sole key is rejected, an object with more
 * keys stays an ordinary map, and a plain string is always text, even
 * one that looks like hex -- so the sole-key "$bytes" object is
 * reserved. Coming OUT, bytes are a "0x"-prefixed lowercase hex string
 * by default, or that same tagged object when the call, serve() or
 * subscribe() asked for `bytes: "tagged"` (see BytesOutput), which lets
 * a returned value be sent straight back. See cabi/wirevalue.go. */
export type JsonValue = string | number | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/** How bytes in a RESULT, an inbound CALL or an EVENT payload reach
 * JavaScript: "hex" (the default) as a "0x"-prefixed lowercase hex
 * string, "tagged" as `{"$bytes": "<base64>"}`, the same form a payload
 * uses going IN. The choice is made on the Go side, per call, serve()
 * or subscribe(), because only Go still knows which values were bytes:
 * once rendered as hex, bytes and a text value that looks like "0x..."
 * can no longer be told apart. */
export type BytesOutput = "hex" | "tagged";
/** BytesOutput as the integer cabi's bytesOutput takes. An unknown value
 * (reachable from plain JavaScript) throws instead of silently falling
 * back to hex. Internal to the FFI boundary. */
export declare function bytesModeFor(bytes: BytesOutput | undefined): number;
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
