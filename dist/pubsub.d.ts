import type { JsonValue } from "./rpc.js";
/** Options for Session.publish(). */
export interface PublishOptions {
    /** How many milliseconds from now this event should live -- a
     * DURATION, not a timestamp (matches every other ttlMs in this SDK,
     * e.g. dht.ts's DHT_DEFAULT_TTL_MS) -- PublishSpec's own `ttl_ms`
     * (frame/pubsub.go) is computed from this. Omitted means no TTL, not
     * zero or an invented default -- macula-go's Publish has no fallback
     * of its own for this field, unlike the DHT puts' TTL. */
    ttlMs?: number;
    /** The realm this PUBLISH is scoped to, as a 64-character hex string
     * (32 bytes) -- see session.ts's CallOptions.realm for the full
     * convention this shares. Omitted means the all-zero realm. Realm is
     * an exact-match routing key: a subscribe() only ever receives this
     * event if its own realm matches exactly, not a prefix or default
     * fallback. */
    realm?: string;
}
/** Options for Session.subscribe(). */
export interface SubscribeOptions {
    /** The realm this SUBSCRIBE listens on -- see PublishOptions.realm's
     * own doc for the format and exact-match semantics. Omitted means the
     * all-zero realm. Must match the realm a publisher actually used, or
     * nothing published under a different realm is ever delivered here. */
    realm?: string;
    /** Called at most once, only if this subscription's background
     * reader exits on its own -- the underlying session/connection died,
     * or some other transport error ended the read loop -- rather than
     * via the stop() subscribe() returned being called. See
     * Session.subscribe()'s own doc for the full story (a real bug this
     * SDK had and fixed: without this signal, such a subscription went
     * silent forever and left the Session unable to close cleanly).
     * Optional: even without a handler here, the subscription still
     * tears itself down automatically and correctly the moment this
     * happens -- this is purely a notification hook for a caller who
     * wants to know why events stopped arriving. */
    onClosed?: (error: Error) => void;
}
/** One delivered EVENT -- macula-go's frame.EventInfo, minus `Realm`
 * (the delivering EVENT's own realm is not surfaced back per-event here
 * -- a caller already knows it, since subscribe()'s own `realm` option
 * is what selected which realm's events reach this handler at all) and
 * `DeliveredVia` (a routing/telemetry detail, not part of this SDK's
 * scope yet). `payload`
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
