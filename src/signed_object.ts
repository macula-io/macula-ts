// Signed objects: macula's {key, tbs, signature} that carries its signer's key,
// as macula_signed_object:verify/3 reads it (macula-go v0.22.0,
// macula_signed_object_verify). The signature covers label || 0x00 ||
// SHA-384(key) || tbs, so an object verifies only under the label it was signed
// under; tbs is decoded only after the signature verifies, and its alg must name
// the profile's algorithm.
//
// The node id returned is derived from the VERIFIED key. A caller that wants
// "signed by P" compares it with the P it chose (a pinned provider), never with
// a node id the signed thing names about itself.
import { native } from "./binding.js";
import type { Profile } from "./key.js";
import { bytesOut, type BytesOutput, type JsonValue } from "./wire.js";

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
export function verifySignedObject(label: string, object: Uint8Array, profile: Profile = "pq_hybrid",
  bytes?: BytesOutput): VerifiedObject {
  const r = JSON.parse(native.signedObjectVerify(label, object, profile)) as {
    node_id: string; key: { $bytes: string }; tbs: { $bytes: string }; fields: unknown;
  };
  return {
    nodeId: r.node_id,
    key: new Uint8Array(Buffer.from(r.key.$bytes, "base64")),
    tbs: new Uint8Array(Buffer.from(r.tbs.$bytes, "base64")),
    fields: bytesOut(r.fields, bytes),
  };
}
