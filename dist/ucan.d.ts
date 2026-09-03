import type { Identity } from "./identity.js";
/** One entry in a UCAN token's capability list -- mirrors macula-go's
 * ucan.Capability (`with`/`can` json tags) exactly; this module doesn't
 * interpret `with`/`can` in any way, it only carries them. */
export interface UcanCapability {
    readonly with: string;
    readonly can: string;
}
/** Arbitrary JSON value for a UCAN token's `fct` (facts) claim.
 * Deliberately DIFFERENT from rpc.ts's JsonValue: a UCAN token's payload
 * crosses this boundary as plain JSON (Go's encoding/json) over the
 * token's own base64url-encoded JWT body, never macula's CBOR mesh wire
 * -- so, unlike an RPC payload, a JSON boolean here is valid and is
 * NOT rejected (rpc.ts's "no bool on the wire" rule is about the CBOR
 * wire specifically, not about JSON in general). */
export type UcanFactValue = string | number | boolean | null | UcanFactValue[] | {
    [key: string]: UcanFactValue;
};
/** Optional claims for Ucan.mint() -- mirrors macula-go's ucan.CreateOpts. */
export interface UcanMintOptions {
    /** Unix seconds. Omit for a token with no expiry claim at all (never
     * expires, per ucan.IsExpired's own "no exp claim = never expired"
     * rule) -- NOT the same as passing an already-past timestamp. */
    expiresAt?: number;
    /** Unix seconds; the token is not valid before this instant. */
    notBefore?: number;
    /** An arbitrary nonce string, omitted from the token entirely if left
     * unset (matching ucan.CreateOpts.Nonce's own ""-means-absent rule --
     * there is no way to mint a token with an explicit empty-string nonce
     * claim, since macula-go's own Create() cannot express that either). */
    nonce?: string;
    /** Arbitrary application-defined facts, carried in the token's `fct`
     * claim (Go's `map[string]interface{}`, plain JSON -- see
     * UcanFactValue's own doc on why booleans are fine here specifically). */
    facts?: Record<string, UcanFactValue>;
    /** CIDs (Ucan.token's own ucan.ComputeCID shape) of parent tokens this
     * one delegates from. Not computed or validated by this module --
     * carried through as opaque strings. */
    proofs?: string[];
}
/** A decoded (never verified -- see this module's own doc) UCAN token:
 * its raw wire text plus every claim cabi/ucan.go's macula_ucan_decode
 * exposes. Both Ucan.mint() and Ucan.decode() return this same shape --
 * mint() mints via cabi/ucan.go's macula_ucan_mint, then decodes its own
 * freshly-minted token through the identical Decode path Ucan.decode()
 * uses, rather than duplicating the claims-JSON shape a second time on
 * the Go side. */
export declare class Ucan {
    /** The raw token text: "header.payload.signature", base64url,
     * dot-joined -- what Session.callWithUcan actually attaches to a CALL,
     * and what a real macula peer/station would carry over the wire in a
     * `ucan_token` frame field. */
    readonly token: string;
    /** The `iss` claim -- an opaque DID string (see didFromNodeId's own
     * doc: not parsed or resolved by this module, carried through as-is). */
    readonly issuer: string;
    /** The `aud` claim. NOT checked against any local identity by this
     * module or by Session.callWithUcan -- see this module's own doc on
     * why: the real gate is bearer-token, not audience-matched. */
    readonly audience: string;
    readonly capabilities: readonly UcanCapability[];
    /** The `exp` claim, unix seconds, or `null` if this token has none
     * (never expires). */
    readonly expiresAt: number | null;
    /** The `nbf` claim, unix seconds, or `null` if absent. */
    readonly notBefore: number | null;
    /** The `nnc` claim, or `""` if absent (mirrors ucan.Payload.Nonce's
     * own "" -- absent convention; there is no way to distinguish an
     * explicit empty-string nonce from a wholly absent one, since
     * macula-go's own Decode can't either). */
    readonly nonce: string;
    /** The `fct` claim, or `null` if absent. */
    readonly facts: Readonly<Record<string, UcanFactValue>> | null;
    /** The `prf` claim -- CIDs of parent tokens this one delegates from. */
    readonly proofs: readonly string[];
    private constructor();
    /** Whether this token's `exp` claim is in the past. A token with no
     * `exp` claim at all (`expiresAt === null`) is never expired --
     * mirrors macula-go's `ucan.IsExpired` exactly, including its strict
     * `now > exp` comparison (computed here, not cached, so this reflects
     * the current instant on every read): a token expiring at exactly this
     * second is NOT YET expired. This is purely a local claims check, same
     * as `ucan.IsExpired` itself -- it does not verify the token's
     * signature (see this module's own doc: verification is out of
     * scope). */
    get isExpired(): boolean;
    /** Mints a fresh UCAN token, self-issued and signed by `issuer`'s own
     * private key (macula-go's `ucan.Create`) -- the resulting token
     * verifies against `issuer`'s own public key (NodeID), matching
     * `ucan.Create`'s documented convention. `issuer`'s and `audience`'s
     * DID strings are both built automatically as
     * `did:macula:<hex NodeID>` (see `didFromNodeId`'s own doc for why:
     * this ecosystem's own established convention, not invented here) --
     * there is no way to mint with a custom DID string through this
     * method.
     *
     * No network I/O -- this never touches a Session or a station; a
     * token can be minted entirely offline given only an `Identity`. */
    static mint(issuer: Identity, audience: Uint8Array, capabilities?: UcanCapability[], opts?: UcanMintOptions): Ucan;
    /** Decodes `token`'s claims WITHOUT verifying its signature or
     * checking expiration (macula-go's `ucan.Decode`) -- `isExpired`
     * above is a local claims check only, never use this (or any field on
     * the result) for an authorization decision; this module deliberately
     * does not expose `ucan.Verify` (see this module's own doc). Throws if
     * `token` isn't a well-formed `header.payload.signature` triple or its
     * payload isn't valid JSON (mirrors `ucan.ErrInvalidToken`). */
    static decode(token: string): Ucan;
}
