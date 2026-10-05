import type { Profile } from "./key.js";
import { type BytesOutput, type JsonValue } from "./wire.js";
/** A verified signed object. */
export interface VerifiedObject {
    /** The signer's node id, lowercase hex, derived from the verified key. */
    readonly nodeId: string;
    /** The signer's public key, as carried. */
    readonly key: Uint8Array;
    /** The signed bytes, as received. */
    readonly tbs: Uint8Array;
    /** The tbs map, decoded after the signature verified. */
    readonly fields: JsonValue;
}
/** Verifies object (the CBOR bytes of a signed object that carries its key)
 * under label and profile. Throws UnverifiedError (with its reason) for one that
 * does not verify, and MaculaError for a bad argument. bytes says how bytes in
 * fields come back: "hex" (the default) or "tagged". */
export declare function verifySignedObject(label: string, object: Uint8Array, profile?: Profile, bytes?: BytesOutput): VerifiedObject;
