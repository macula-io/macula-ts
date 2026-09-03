import type { JsonValue } from "./rpc.js";
/** Options for Session.publish(). */
export interface PublishOptions {
    /** Milliseconds since epoch when this event expires -- PublishSpec's
     * own `ttl_ms` (frame/pubsub.go). Omitted means no TTL, not zero or an
     * invented default -- macula-go's Publish has no fallback of its own
     * for this field, unlike the DHT puts' TTL. */
    ttlMs?: number;
}
/** One delivered EVENT -- macula-go's frame.EventInfo, minus `Realm`
 * (not yet threaded through the public API, matching call()/serve()'s
 * own current all-zero-realm-only gap) and `DeliveredVia` (a
 * routing/telemetry detail, not part of this SDK's scope yet). `payload`
 * follows rpc.ts's JsonValue rules exactly like a CALL payload does --
 * no boolean, embedded bytes as "0x"-prefixed hex (see cabi/wirevalue.go).
 * `publisher` is the raw 32-byte Ed25519 public key of whoever published
 * this event -- NOT verified against the frame's own signature by this
 * SDK, matching findRecord/findRecords/findRecordsByType's identical
 * "does not verify" posture (dht.ts). */
export interface PubsubEvent {
    readonly payload: JsonValue;
    readonly publisher: Uint8Array;
    readonly seq: number;
}
