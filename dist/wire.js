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
 * `unknown_next_peer` for a procedure it does not serve, `sealed_refused`
 * for a sealed call it could not open even resealed once (detail: the key id
 * it holds now as hex, or empty when it holds none), or an admission refusal
 * (`expired`, `request_copy`, `caller_quota`, ...). */
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
/** A call or stream that could not be kept confidential (macula-go v0.18.0,
 * cabi/CONTRACT.md "Confidentiality"): `no_kem_key` (the provider names no
 * key where one is required, or one this node cannot seal to),
 * `key_mismatch` (the provider's advertisement names another key than its
 * refusal did: `named` and `found`), `reply_not_opened` (a sealed answer that
 * does not open), `clear_answer_to_sealed` (a clear answer that nothing clear
 * may give) or `kem_advertise_disabled` (serving `required` on a pool
 * without kemAdvertise). `named` and `found` are key ids as hex, or null. */
export class ConfidentialityError extends MaculaError {
    reason;
    named;
    found;
    constructor(reason, named, found, message) {
        super("confidentiality", message);
        this.reason = reason;
        this.named = named;
        this.found = found;
        this.name = "ConfidentialityError";
    }
}
/** A report as the ABI carries it. */
export function sealReport(r) {
    return r.seal_key_id === undefined ? { sealed: r.sealed, provider: r.provider }
        : { sealed: r.sealed, provider: r.provider, sealKeyId: r.seal_key_id };
}
/** A signed object that did not verify (macula-go "unverified"): `reason` is
 * "malformed" (its shape, its key's form for the profile, or its tbs),
 * "signature_invalid" or "alg_mismatch" (an alg other than the profile's,
 * registered or not, refused before the signature). */
export class UnverifiedError extends Error {
    reason;
    constructor(reason) {
        super(`signed object not verified: ${reason}`);
        this.reason = reason;
        this.name = "UnverifiedError";
    }
}
/** A sealed group's refusal or failure (macula-go cabi "Sealed groups"):
 * `reason` is one of `not_a_member`, `membership_unknown`, `unknown_epoch`,
 * `epoch_expired`, `no_distributor`, `no_group` and `tag_invalid`, or
 * `group_held` for a clear publish under a group this pool holds, with its
 * `prefix`. */
export class GroupError extends MaculaError {
    reason;
    prefix;
    constructor(reason, prefix, message) {
        super("group", message);
        this.reason = reason;
        this.prefix = prefix;
        this.name = "GroupError";
    }
}
/** The network refused it (macula-go cabi kind `refused`). For a serve or
 * subscribe (since macula-go v0.27.0-rc.4, macula#12) the station's verdict:
 * `reason` is the station's (`too_many_providers`, `advertiser_quota`,
 * `name_too_long`, `record_refused`, `not_authorized`, `too_many_realms`,
 * `refused`) or `unacknowledged` when no station answered within 30 seconds,
 * `registration` is `advertise` or `subscribe`, and `station` the station's
 * node_id as hex. Any other refusal (an admission, a key) has them null. */
export class RefusedError extends MaculaError {
    reason;
    registration;
    station;
    constructor(reason, registration, station, message) {
        super("refused", message);
        this.reason = reason;
        this.registration = registration;
        this.station = station;
        this.name = "RefusedError";
    }
}
/** A string field or null, for the error classes that carry it as such. */
function optionalString(v) {
    return typeof v === "string" ? v : null;
}
/** The ABI's error JSON, when the text is one; undefined otherwise. */
function errorPayload(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || typeof parsed.kind !== "string") {
        return undefined;
    }
    return parsed;
}
/** Provider and station refusals. */
function transportError(kind, error, message) {
    switch (kind) {
        case "provider_error":
            return new ProviderError(String(error.code ?? ""), typeof error.detail === "string" ? error.detail : "");
        case "relay_error":
            return new RelayError(String(error.code ?? ""));
        case "not_shared":
            return new NotSharedError();
        case "unavailable":
            return new ContentUnavailableError(Array.isArray(error.failures) ? error.failures.map(String).join("; ") : message);
        default:
            return undefined;
    }
}
function confidentialityError(error, message) {
    return new ConfidentialityError(String(error.reason ?? ""), typeof error.named === "string" ? error.named : null, typeof error.found === "string" ? error.found : null, message);
}
function groupError(error, message) {
    return new GroupError(String(error.reason ?? ""), typeof error.prefix === "string" ? error.prefix : null, message);
}
/** Verification, confidentiality and group refusals. */
function securityError(kind, error, message) {
    switch (kind) {
        case "unverified":
            return new UnverifiedError(String(error.reason ?? ""));
        case "confidentiality":
            return confidentialityError(error, message);
        case "group":
            return groupError(error, message);
        default:
            return undefined;
    }
}
/** The station's own refusal, with its registration and station when it named them. */
function refusedError(error, message) {
    return new RefusedError(optionalString(error.reason), optionalString(error.registration), optionalString(error.station), message);
}
/** The native layer's error, whose message is the ABI's error JSON, as the
 * class its kind names. */
export function nativeError(e) {
    const text = e instanceof Error ? e.message : String(e);
    const error = errorPayload(text);
    if (error === undefined)
        return e instanceof Error ? e : new Error(text);
    const kind = error.kind;
    const message = typeof error.message === "string" ? error.message : kind;
    const known = transportError(kind, error, message) ?? securityError(kind, error, message);
    if (known !== undefined)
        return known;
    return kind === "refused" ? refusedError(error, message) : new MaculaError(kind, message);
}
/** How long a call waits, in milliseconds, when not told: macula's 5 s. */
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
//# sourceMappingURL=wire.js.map