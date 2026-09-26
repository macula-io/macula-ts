// The shapes every part of the API shares: payload values, ids, and the
// errors a call or a stream ends with.
import { ContentUnavailableError, NotSharedError } from "./content.js";
/** A value from the native layer, whose bytes are always the tagged
 * {"$bytes": ...} object, with its bytes as `bytes` asks: "0x" hex (the
 * default) or left tagged. */
export function bytesOut(value, bytes) {
    if (bytes !== undefined && bytes !== "hex" && bytes !== "tagged") {
        throw new Error(`macula-ts: bytes must be "hex" or "tagged", got ${JSON.stringify(bytes)}`);
    }
    if (bytes === "tagged")
        return value;
    return hexBytes(value);
}
function hexBytes(value) {
    if (Array.isArray(value))
        return value.map(hexBytes);
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 1 && entries[0][0] === "$bytes" && typeof entries[0][1] === "string") {
            return "0x" + Buffer.from(entries[0][1], "base64").toString("hex");
        }
        return Object.fromEntries(entries.map(([k, v]) => [k, hexBytes(v)]));
    }
    return value;
}
/** An Id as the 32 bytes the native layer takes. */
export function id32(id, what = "id") {
    if (typeof id === "string") {
        if (!/^[0-9a-fA-F]{64}$/.test(id))
            throw new Error(`macula-ts: ${what} must be 64 hex characters`);
        return Uint8Array.from(Buffer.from(id, "hex"));
    }
    if (id.length !== 32)
        throw new Error(`macula-ts: ${what} must be 32 bytes, got ${id.length}`);
    return id;
}
/** 32 bytes as lowercase hex. */
export function hex(bytes) {
    return Buffer.from(bytes).toString("hex");
}
/** A provider's own ERROR for a call: `handler_error` with the handler's
 * text, `temporary_relay_failure` for a handler that crashed,
 * `unknown_next_peer` for a procedure it does not serve, or an admission
 * refusal (`expired`, `request_copy`, `caller_quota`, ...). */
export class ProviderError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(`macula-ts: the provider answered ${code}${detail ? `: ${detail}` : ""}`);
        this.code = code;
        this.detail = detail;
        this.name = "ProviderError";
    }
}
/** A station's signed relay error for a call: it could not relay it, e.g.
 * `unknown_next_peer` for a provider it cannot reach. */
export class RelayError extends Error {
    code;
    constructor(code) {
        super(`macula-ts: the station could not relay the call: ${code}`);
        this.code = code;
        this.name = "RelayError";
    }
}
/** A stream ended by a STREAM_ERROR: the peer's, a relay error from the
 * station (`relay`), or this side's own (e.g. `resource_exhausted`). */
export class StreamError extends Error {
    code;
    detail;
    relay;
    constructor(code, detail, relay) {
        super(`macula-ts: stream error ${code}${detail ? `: ${detail}` : ""}`);
        this.code = code;
        this.detail = detail;
        this.relay = relay;
        this.name = "StreamError";
    }
}
/** An error the native layer reported: its kind, from macula-go's C ABI
 * (cabi/CONTRACT.md "Errors"), and its message. Provider, relay and content
 * errors have classes of their own; every other kind is this. */
export class MaculaError extends Error {
    kind;
    constructor(kind, message) {
        super(`macula-ts: ${message}`);
        this.kind = kind;
        this.name = "MaculaError";
    }
}
/** The native layer's error, whose message is the ABI's error JSON, as the
 * class its kind names. */
export function nativeError(e) {
    const text = e instanceof Error ? e.message : String(e);
    let error;
    try {
        error = JSON.parse(text);
    }
    catch {
        return e instanceof Error ? e : new Error(text);
    }
    if (typeof error !== "object" || error === null || typeof error.kind !== "string") {
        return e instanceof Error ? e : new Error(text);
    }
    const message = typeof error.message === "string" ? error.message : error.kind;
    switch (error.kind) {
        case "provider_error":
            return new ProviderError(String(error.code ?? ""), typeof error.detail === "string" ? error.detail : "");
        case "relay_error":
            return new RelayError(String(error.code ?? ""));
        case "not_shared":
            return new NotSharedError();
        case "unavailable":
            return new ContentUnavailableError(Array.isArray(error.failures) ? error.failures.map(String).join("; ") : message);
        default:
            return new MaculaError(error.kind, message);
    }
}
/** How long a call waits, in milliseconds, when not told: macula's 5 s. */
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
//# sourceMappingURL=wire.js.map