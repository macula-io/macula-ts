import { type Handle } from "./binding.js";
import { type Id, type JsonValue } from "./wire.js";
/** A crypto profile: "pq_hybrid" (the fleet's) or "pq_pure". */
export type Profile = "pq_hybrid" | "pq_pure";
/**
 * How a device request is signed (realm proof v2, macula-realm#29): "http" is a
 * join-session body under the realm's JSON rule (an integral number is an
 * integer, a boolean or an integer beyond 2^53 - 1 is refused); "mesh" is a
 * call's payload as this library puts it on the wire.
 */
export type DeviceRequestRule = "http" | "mesh";
/** The procedure a join session over HTTP is signed for. */
export declare const JOIN_SESSION_PROCEDURE = "macula_realm.join_session";
/** The procedure a membership UCAN asked for over the mesh is signed for. */
export declare const MEMBERSHIP_UCAN_PROCEDURE = "macula_realm.membership_ucan";
/** A realm proof v2, as it goes on the wire beside the request's public_key. */
export interface DeviceRequestProof {
    v: 2;
    timestamp: number;
    nonce: string;
    signature: string;
}
export declare class NodeKey {
    private handle;
    private constructor();
    /** A new key whose node_id solves the admission puzzle; takes a second or
     * so, off the event loop. */
    static generate(profile?: Profile): Promise<NodeKey>;
    /** The key in the key file at path. A file its group or others can read,
     * or holding a key of another profile, is refused. */
    static load(path: string, profile?: Profile): Promise<NodeKey>;
    /** The key at path, or a new one saved there when the file does not exist. */
    static loadOrCreate(path: string, profile?: Profile): Promise<NodeKey>;
    /** Writes the key to path, readable by its owner only. */
    save(path: string): Promise<void>;
    /** The key's 32-byte node_id. */
    nodeId(): Uint8Array;
    /** The node_id as lowercase hex. */
    nodeIdHex(): string;
    /** The public key as carried on the wire. */
    publicKey(): Uint8Array;
    /** The key's profile. */
    profile(): Profile;
    /** Signs data as given. */
    sign(data: Uint8Array): Promise<Uint8Array>;
    /**
     * A realm proof v2 (macula-realm#29) that this key made request (every field
     * of it except "proof") for procedure in realm, now and with a fresh nonce.
     * The request's device_info and ttl_seconds, the realm and the procedure are
     * all signed, so the realm refuses a request changed on the way.
     */
    deviceRequestProof(realm: Id, procedure: string, request: {
        [field: string]: JsonValue;
    }, rule: DeviceRequestRule): Promise<DeviceRequestProof>;
    /** The exact bytes a realm proof v2 signs, for a given timestamp and 16-byte
     * nonce: what the realm's vector is checked against. */
    static deviceRequestMessage(publicKey: Uint8Array, realm: Id, procedure: string, timestampMs: number, nonce: Uint8Array, request: {
        [field: string]: JsonValue;
    }, rule: DeviceRequestRule): Uint8Array;
    /** Whether signature is valid over data for a public key as carried on the
     * wire (publicKey()), under profile: ML-DSA-87 in pq_pure, and in pq_hybrid
     * the LAMPS composite id-MLDSA87-RSA4096-PSS-SHA512 with the empty context,
     * both halves verified. Anything malformed is false. */
    static verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array, profile?: Profile): boolean;
    /** Frees the native key. The NodeKey is unusable after. */
    free(): void;
    /** @internal */
    live(): Handle;
}
