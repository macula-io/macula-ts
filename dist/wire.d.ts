/** A payload, restricted to what macula's wire CBOR carries: no boolean and
 * no undefined. Encode true/false as 1/0 yourself; a JS boolean reaching the
 * wire is exactly the mistake this type makes impossible at compile time.
 *
 * Bytes have no native JSON shape. Going IN, write them as an object whose
 * ONLY key is "$bytes", holding standard padded base64: `{"$bytes": "AQID"}`
 * is the three bytes 01 02 03. A plain string is always text. Coming OUT,
 * bytes are a "0x"-prefixed lowercase hex string by default, or the same
 * tagged object when you ask for `bytes: "tagged"` (see BytesOutput). */
export type JsonValue = string | number | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/** How bytes in a result, a request, an event or a record reach JavaScript:
 * "hex" (the default) or "tagged" ({"$bytes": "<base64>"}). */
export type BytesOutput = "hex" | "tagged";
/** A value from the native layer, whose bytes are always the tagged
 * {"$bytes": ...} object, with its bytes as `bytes` asks: "0x" hex (the
 * default) or left tagged. */
export declare function bytesOut(value: unknown, bytes: BytesOutput | undefined): JsonValue;
/** A 32-byte id (a node_id, a realm id, a record key): 64 hex characters or
 * 32 bytes. */
export type Id = string | Uint8Array;
/** An Id as the 32 bytes the native layer takes. */
export declare function id32(id: Id, what?: string): Uint8Array;
/** 32 bytes as lowercase hex. */
export declare function hex(bytes: Uint8Array): string;
/** A provider's own ERROR for a call: `handler_error` with the handler's
 * text, `temporary_relay_failure` for a handler that crashed,
 * `unknown_next_peer` for a procedure it does not serve, `sealed_refused`
 * for a sealed call it could not open even resealed once (detail: the key id
 * it holds now as hex, or empty when it holds none), or an admission refusal
 * (`expired`, `request_copy`, `caller_quota`, ...). */
export declare class ProviderError extends Error {
    readonly code: string;
    readonly detail: string;
    constructor(code: string, detail: string);
}
/** A station's signed relay error for a call: it could not relay it, e.g.
 * `unknown_next_peer` for a provider it cannot reach. */
export declare class RelayError extends Error {
    readonly code: string;
    constructor(code: string);
}
/** A stream ended by a STREAM_ERROR: the peer's, a relay error from the
 * station (`relay`), or this side's own (e.g. `resource_exhausted`). */
export declare class StreamError extends Error {
    readonly code: string;
    readonly detail: string;
    readonly relay: boolean;
    constructor(code: string, detail: string, relay: boolean);
}
/** An error the native layer reported: its kind, from macula-go's C ABI
 * (cabi/CONTRACT.md "Errors"), and its message. Provider, relay and content
 * errors have classes of their own; every other kind is this. */
export declare class MaculaError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string);
}
/** A call or stream that could not be kept confidential (macula-go v0.18.0,
 * cabi/CONTRACT.md "Confidentiality"): `no_kem_key` (the provider names no
 * key where one is required, or one this node cannot seal to),
 * `key_mismatch` (the provider's advertisement names another key than its
 * refusal did: `named` and `found`), `reply_not_opened` (a sealed answer that
 * does not open), `clear_answer_to_sealed` (a clear answer that nothing clear
 * may give) or `kem_advertise_disabled` (serving `required` on a pool
 * without kemAdvertise). `named` and `found` are key ids as hex, or null. */
export declare class ConfidentialityError extends MaculaError {
    readonly reason: string;
    readonly named: string | null;
    readonly found: string | null;
    constructor(reason: string, named: string | null, found: string | null, message: string);
}
/** Whether a call, a stream or a served procedure is sealed (macula 13's E2E
 * seal scheme 1): `preferred` seals whenever the provider's advertisement
 * names a KEM key and calls one that names none in the clear, `required`
 * never calls one that names none; a procedure served `off` is served in the
 * clear. A sealed call never falls back to the clear. */
export type Confidential = "preferred" | "required";
/** What a caller's seal report says about the exchange behind a result
 * (macula's DESIGN_E2E_SEAL_REPORT): `sealed` 1 when the request was sealed to
 * the provider's advertised KEM key and the answer opened under that key, 0
 * when it went in the clear; `provider`, the node_id it was addressed to, as
 * hex; `sealKeyId`, the key's 8-byte id as hex, only when sealed. It states
 * that sealing ran on that exchange, nothing more. */
export interface SealReport {
    readonly sealed: 0 | 1;
    readonly provider: string;
    readonly sealKeyId?: string;
}
/** A report as the ABI carries it. */
export declare function sealReport(r: {
    sealed: 0 | 1;
    provider: string;
    seal_key_id?: string;
}): SealReport;
export type ServedConfidential = Confidential | "off";
/** A signed object that did not verify (macula-go "unverified"): `reason` is
 * "malformed" (its shape, its key's form for the profile, or its tbs),
 * "signature_invalid" or "alg_mismatch". */
export declare class UnverifiedError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/** The native layer's error, whose message is the ABI's error JSON, as the
 * class its kind names. */
export declare function nativeError(e: unknown): Error;
/** How long a call waits, in milliseconds, when not told: macula's 5 s. */
export declare const DEFAULT_CALL_TIMEOUT_MS = 5000;
