// UCANs (macula 12's D7): a token is minted with NodeKey.ucan for the node that
// presents it; a gated procedure serves only callers whose chain a ServePolicy
// accepts. libmacula checks each call and open before it reaches TypeScript.
import { native } from "./binding.js";
import { hex, id32 } from "./wire.js";
export const Ucan = {
    /** The proof id a child token's `prf` names token by: lowercase hex SHA-384
     * of its text. */
    proofId(token) {
        if (token === "")
            throw new TypeError("@macula-io/ts: a UCAN is never empty");
        return native.ucanProofId(token);
    },
    /** A chain rooted at the identity key of the node issuer names. */
    ucanRequired(issuer) {
        return { kind: "ucan_required", issuer: hex(id32(issuer, "issuer")) };
    },
    /** A chain rooted at the realm key whose id keyId names, granting can. */
    realmMemberRequired(keyId, can) {
        if (can === "")
            throw new TypeError("@macula-io/ts: a realm member policy names a can");
        return { kind: "realm_member_required", key_id: hex(id32(keyId, "realm key id")), can };
    },
};
//# sourceMappingURL=ucan.js.map