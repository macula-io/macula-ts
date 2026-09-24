// The shapes every part of the API shares: payload values, ids, and the
// errors a call or a stream ends with.

/** A payload, restricted to what macula's wire CBOR carries: no boolean and
 * no undefined. Encode true/false as 1/0 yourself; a JS boolean reaching the
 * wire is exactly the mistake this type makes impossible at compile time.
 *
 * Bytes have no native JSON shape. Going IN, write them as an object whose
 * ONLY key is "$bytes", holding standard padded base64: `{"$bytes": "AQID"}`
 * is the three bytes 01 02 03. A plain string is always text. Coming OUT,
 * bytes are a "0x"-prefixed lowercase hex string by default, or the same
 * tagged object when you ask for `bytes: "tagged"` (see BytesOutput). */
export type JsonValue = string | number | null | JsonValue[] | { [key: string]: JsonValue };

/** How bytes in a result, a request, an event or a record reach JavaScript:
 * "hex" (the default) or "tagged" ({"$bytes": "<base64>"}). */
export type BytesOutput = "hex" | "tagged";

/** BytesOutput as the integer the native layer takes. */
export function bytesModeFor(bytes: BytesOutput | undefined): number {
  if (bytes === undefined || bytes === "hex") return 0;
  if (bytes === "tagged") return 1;
  throw new Error(`macula-ts: bytes must be "hex" or "tagged", got ${JSON.stringify(bytes)}`);
}

/** A 32-byte id (a node_id, a realm id, a record key): 64 hex characters or
 * 32 bytes. */
export type Id = string | Uint8Array;

/** An Id as the 32 bytes the native layer takes. */
export function id32(id: Id, what = "id"): Uint8Array {
  if (typeof id === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(id)) throw new Error(`macula-ts: ${what} must be 64 hex characters`);
    return Uint8Array.from(Buffer.from(id, "hex"));
  }
  if (id.length !== 32) throw new Error(`macula-ts: ${what} must be 32 bytes, got ${id.length}`);
  return id;
}

/** 32 bytes as lowercase hex. */
export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A provider's own ERROR for a call: `handler_error` with the handler's
 * text, `temporary_relay_failure` for a handler that crashed,
 * `unknown_next_peer` for a procedure it does not serve, or an admission
 * refusal (`expired`, `request_copy`, `caller_quota`, ...). */
export class ProviderError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`macula-ts: the provider answered ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderError";
  }
}

/** A station's signed relay error for a call: it could not relay it, e.g.
 * `unknown_next_peer` for a provider it cannot reach. */
export class RelayError extends Error {
  constructor(readonly code: string) {
    super(`macula-ts: the station could not relay the call: ${code}`);
    this.name = "RelayError";
  }
}

/** A stream ended by a STREAM_ERROR: the peer's, a relay error from the
 * station (`relay`), or this side's own (e.g. `resource_exhausted`). */
export class StreamError extends Error {
  constructor(readonly code: string, readonly detail: string, readonly relay: boolean) {
    super(`macula-ts: stream error ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "StreamError";
  }
}

/** The error the native layer rejects a call with, as the class it names:
 * "provider_error:<code>:<detail>" and "relay_error:<code>" (cabi's
 * callError), any other text as a plain Error. */
export function callError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const provider = /^provider_error:([^:]*):([\s\S]*)$/.exec(message);
  if (provider) return new ProviderError(provider[1] ?? "", provider[2] ?? "");
  const relay = /^relay_error:(.*)$/.exec(message);
  if (relay) return new RelayError(relay[1] ?? "");
  return e instanceof Error ? e : new Error(message);
}

/** How long a call waits, in milliseconds, when not told: macula's 5 s. */
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;
