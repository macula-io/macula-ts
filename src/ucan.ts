// UCAN (User Controlled Authorization Networks) tokens -- macula's
// JWT-shaped capability tokens (header.payload.signature, base64url,
// EdDSA over Ed25519, UCAN spec version "0.10.0" -- the older JWT-based
// draft, NOT the current non-JWT/IPLD UCAN 1.0 spec; see macula-go's
// ucan/ucan.go for why: no existing library implements 0.10.0, so
// macula-go hand-rolls it to match the Erlang reference SDK and its Rust
// NIF exactly). Minting (Ucan.mint) and decoding/inspecting (Ucan.decode)
// are both pure local operations -- no network I/O, no station involved
// -- reached through cabi/ucan.go's macula_ucan_mint/macula_ucan_decode.
// Session.callWithUcan (session.ts) attaches a minted token to an
// outgoing CALL, for invoking a procedure a provider has gated behind a
// ucan.Policy.Required policy on its own side (macula-go's
// connection.Session.CallWithUCAN).
//
// This module deliberately does NOT expose verification or
// gate-enforcement -- macula-go's ucan.Verify and ucan.Policy (serving a
// procedure gated behind a required issuer) are provider-side concerns,
// out of scope for this slice. See README.md's "What's explicitly not
// yet implemented" section.
//
// A provider gated with ucan.Required accepts a token only when it
// verifies against the required issuer and its `aud` claim is the calling
// identity's NodeID as lowercase hex. Ucan.mint() writes `audience` in
// that form, so mint a token for the identity that will present it; any
// 32-byte NodeID is accepted as the audience, related to the minting
// identity or not. Session.callWithUcan (session.ts) attaches whatever
// token it is given and leaves the check to the provider.
import { native } from "./binding.js";
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
export type UcanFactValue = string | number | boolean | null | UcanFactValue[] | { [key: string]: UcanFactValue };

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

/** The JSON shape cabi/ucan.go's macula_ucan_decode returns -- internal
 * to the FFI boundary, not part of the public API. Kept in sync BY HAND
 * with cabi/ucan.go's own ucanPayloadJSON struct; there is no shared
 * schema generating either side (same convention rpc.ts's CallEnvelope
 * and dht.ts's DhtRecord already document for their own FFI JSON shapes). */
interface UcanPayloadJson {
  issuer: string;
  audience: string;
  capabilities: UcanCapability[];
  expiresAt: number | null;
  notBefore: number | null;
  nonce: string;
  facts: Record<string, UcanFactValue> | null;
  proofs: string[];
}

/** The `iss` claim this module writes for a NodeID:
 * "did:macula:<lowercase hex NodeID>". macula-go's ucan package never
 * parses or resolves it (that's macula_did_nif's job on the Erlang
 * reference, out of scope for both SDKs) -- the cryptographic check a
 * relying party performs is keyed by a raw public key it already has out
 * of band (ucan.Verify's own `publicKey []byte` parameter,
 * ucan/policy.go's `Required(issuerPublicKey []byte)`), never by parsing
 * this string. */
function didFromNodeId(nodeId: Uint8Array): string {
  return `did:macula:${Buffer.from(nodeId).toString("hex")}`;
}

/** The `aud` claim this module writes for a NodeID: its lowercase hex,
 * the form a gated provider compares with the calling identity
 * (macula-go's ucan.Policy.Check). */
function audienceFromNodeId(nodeId: Uint8Array): string {
  return Buffer.from(nodeId).toString("hex");
}

/** A decoded (never verified -- see this module's own doc) UCAN token:
 * its raw wire text plus every claim cabi/ucan.go's macula_ucan_decode
 * exposes. Both Ucan.mint() and Ucan.decode() return this same shape --
 * mint() mints via cabi/ucan.go's macula_ucan_mint, then decodes its own
 * freshly-minted token through the identical Decode path Ucan.decode()
 * uses, rather than duplicating the claims-JSON shape a second time on
 * the Go side. */
export class Ucan {
  /** The raw token text: "header.payload.signature", base64url,
   * dot-joined -- what Session.callWithUcan actually attaches to a CALL,
   * and what a real macula peer/station would carry over the wire in a
   * `ucan_token` frame field. */
  readonly token: string;
  /** The `iss` claim -- an opaque DID string (see didFromNodeId's own
   * doc: not parsed or resolved by this module, carried through as-is). */
  readonly issuer: string;
  /** The `aud` claim: for a token Ucan.mint() wrote, the NodeID, as
   * lowercase hex, of the caller it is for. A gated provider accepts the
   * token only from that caller; this module and Session.callWithUcan
   * don't compare it with any local identity (see this module's own
   * doc). */
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

  private constructor(token: string, payload: UcanPayloadJson) {
    this.token = token;
    this.issuer = payload.issuer;
    this.audience = payload.audience;
    this.capabilities = payload.capabilities;
    this.expiresAt = payload.expiresAt;
    this.notBefore = payload.notBefore;
    this.nonce = payload.nonce;
    this.facts = payload.facts;
    this.proofs = payload.proofs;
  }

  /** Whether this token's `exp` claim is in the past. A token with no
   * `exp` claim at all (`expiresAt === null`) is never expired --
   * mirrors macula-go's `ucan.IsExpired` exactly, including its strict
   * `now > exp` comparison (computed here, not cached, so this reflects
   * the current instant on every read): a token expiring at exactly this
   * second is NOT YET expired. This is purely a local claims check, same
   * as `ucan.IsExpired` itself -- it does not verify the token's
   * signature (see this module's own doc: verification is out of
   * scope). */
  get isExpired(): boolean {
    if (this.expiresAt === null) return false;
    return Math.floor(Date.now() / 1000) > this.expiresAt;
  }

  /** Mints a fresh UCAN token, self-issued and signed by `issuer`'s own
   * private key (macula-go's `ucan.Create`) -- the resulting token
   * verifies against `issuer`'s own public key (NodeID), matching
   * `ucan.Create`'s documented convention. `iss` is written as
   * `did:macula:<hex NodeID>` (`didFromNodeId`) and `aud` as `audience`'s
   * lowercase hex (`audienceFromNodeId`), the form a gated provider
   * compares with the calling identity: pass the NodeID of the identity
   * that will present the token. There is no way to mint with custom
   * claim strings through this method.
   *
   * No network I/O -- this never touches a Session or a station; a
   * token can be minted entirely offline given only an `Identity`. */
  static mint(issuer: Identity, audience: Uint8Array, capabilities: UcanCapability[] = [], opts: UcanMintOptions = {}): Ucan {
    if (audience.length !== 32) {
      throw new Error(`macula-ts: UCAN audience NodeID must be exactly 32 bytes, got ${audience.length}`);
    }
    const token = native.ucanMint(
      issuer.handleForFfi(),
      didFromNodeId(issuer.nodeId),
      audienceFromNodeId(audience),
      JSON.stringify(capabilities ?? []),
      opts.expiresAt,
      opts.notBefore,
      opts.nonce ?? "",
      opts.facts !== undefined ? JSON.stringify(opts.facts) : undefined,
      opts.proofs !== undefined ? JSON.stringify(opts.proofs) : undefined,
    );
    return Ucan.decode(token);
  }

  /** Decodes `token`'s claims WITHOUT verifying its signature or
   * checking expiration (macula-go's `ucan.Decode`) -- `isExpired`
   * above is a local claims check only, never use this (or any field on
   * the result) for an authorization decision; this module deliberately
   * does not expose `ucan.Verify` (see this module's own doc). Throws if
   * `token` isn't a well-formed `header.payload.signature` triple or its
   * payload isn't valid JSON (mirrors `ucan.ErrInvalidToken`). */
  static decode(token: string): Ucan {
    const json = native.ucanDecode(token);
    const payload = JSON.parse(json) as UcanPayloadJson;
    return new Ucan(token, payload);
  }
}
