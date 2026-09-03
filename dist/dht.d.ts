import type { JsonValue } from "./rpc.js";
/** Record type tags -- macula-go's dht.Type* constants (dht/record.go).
 * There is no client-side constructor for StationEndpoint in macula-go
 * (stations publish those themselves, not clients) -- it's listed here
 * because Session.findRecord/findRecords/findRecordsByType can still
 * return one, not because a Session.putRecord* method can build one. */
export declare enum DhtRecordType {
    ProcedureAdvertisement = 6,
    ContentAnnouncement = 17,
    StationEndpoint = 18
}
/** A signed, TTL'd DHT record envelope -- mirrors macula-go's dht.Record
 * (dht/record.go). `key`/`version`/`signature` are raw bytes with no
 * native JSON shape, so they cross the FFI boundary as lowercase hex
 * strings -- deliberately NOT rpc.ts's own "0x"-prefixed convention for
 * bytes embedded inside a payload (see cabi/dht.go's own doc for why:
 * these three fields never go through jsonToCbor/cborToJSON at all,
 * wirevalue.go's "0x"-hex convention is specifically for bytes found
 * *inside* a cbor.Value payload, which these aren't). `payload` DID go
 * through that conversion (it's the record's own cbor.Value map) and
 * follows rpc.ts's JsonValue rules exactly like a CALL payload does --
 * no boolean, embedded bytes as "0x"-prefixed hex. Note that a
 * procedure_advertisement/content_announcement's own advertiser_node/
 * serving_station/announcer_node/mcid payload fields are themselves raw
 * bytes on the wire (CBOR byte strings) but surface here as the SAME
 * "0x"-prefixed hex JsonValue strings cborToJSON gives any embedded
 * bytes -- consistent with every other payload field this SDK decodes,
 * just called out since they look similar to this record's own
 * top-level key/version/signature while following the other convention.
 *
 * This SDK does not verify a record's signature or check its expiry on
 * the caller's behalf (matching macula-go's own FindRecord/FindRecords/
 * FindRecordsByType, which say the same in their own doc comments) --
 * a caller that needs to trust a record's payload must check both
 * itself (against `key`, `signature`, and `expiresAt`) before relying
 * on it. */
export interface DhtRecord {
    readonly type: DhtRecordType | number;
    /** Hex-encoded, 32 bytes: the envelope signer's Ed25519 public key. */
    readonly key: string;
    /** Hex-encoded, 16 bytes: a UUIDv7. */
    readonly version: string;
    /** Milliseconds since epoch. */
    readonly createdAt: number;
    /** Milliseconds since epoch. */
    readonly expiresAt: number;
    readonly payload: JsonValue;
    /** Hex-encoded, 64 bytes. */
    readonly signature: string;
}
/** Default TTL for a record built by Session.putProcedureAdvertisement()/
 * putContentAnnouncement() when the caller doesn't specify one --
 * matches macula-go's dht.DefaultTTL (48h). */
export declare const DHT_DEFAULT_TTL_MS: number;
