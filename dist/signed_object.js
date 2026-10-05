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
import { bytesOut } from "./wire.js";
/** Verifies object (the CBOR bytes of a signed object that carries its key)
 * under label and profile. Throws UnverifiedError (with its reason) for one that
 * does not verify, and MaculaError for a bad argument. bytes says how bytes in
 * fields come back: "hex" (the default) or "tagged". */
export function verifySignedObject(label, object, profile = "pq_hybrid", bytes) {
    const r = JSON.parse(native.signedObjectVerify(label, object, profile));
    return {
        nodeId: r.node_id,
        key: new Uint8Array(Buffer.from(r.key.$bytes, "base64")),
        tbs: new Uint8Array(Buffer.from(r.tbs.$bytes, "base64")),
        fields: bytesOut(r.fields, bytes),
    };
}
//# sourceMappingURL=signed_object.js.map