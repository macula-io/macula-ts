import { type Id } from "./wire.js";
/** One capability a token grants: `with` an MRI (mri:realm:<realm>,
 * mri:org:<realm>/<org>, mri:proc:<realm>/<org>/<name>), `can` an ability. */
export interface Capability {
    readonly with: string;
    readonly can: string;
}
/** Who may call or open a served procedure: a UCAN chain rooted at a node's
 * identity key (ucanRequired), or at a realm key granting a can
 * (realmMemberRequired). A refused call is a ProviderError of code
 * "unauthorized" ("malformed_frame" for a proof no token names), a refused
 * open a StreamError of the same code. */
export type ServePolicy = {
    readonly kind: "ucan_required";
    readonly issuer: string;
} | {
    readonly kind: "realm_member_required";
    readonly key_id: string;
    readonly can: string;
};
export declare const Ucan: {
    /** The proof id a child token's `prf` names token by: lowercase hex SHA-384
     * of its text. */
    proofId(token: string): string;
    /** A chain rooted at the identity key of the node issuer names. */
    ucanRequired(issuer: Id): ServePolicy;
    /** A chain rooted at the realm key whose id keyId names, granting can. */
    realmMemberRequired(keyId: Id, can: string): ServePolicy;
};
