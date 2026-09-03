// Public identity API -- the one real capability this walking
// skeleton proves end-to-end: minting a Macula peer identity (an
// Ed25519 keypair, S/Kademlia puzzle-hardened) via macula-go's own
// identity.Generate(), reached through cabi/'s FFI boundary rather
// than reimplemented here.
//
// An Identity wraps a Go-side handle. It is a disposable, freeable
// resource: call dispose() when done with it (or let the process
// exit -- the Go side doesn't leak across a process lifetime, but a
// long-running host process minting many identities should dispose
// each one). There is no finalizer/GC integration in this skeleton;
// forgetting to call dispose() leaks the Go-side handle for the life
// of the process, exactly as macula-php's identical handle-based
// design does.
import { native } from "./binding.js";
export class Identity {
    #handle;
    constructor(handle) {
        this.#handle = handle;
    }
    /** Mints a fresh identity, grinding an Ed25519 keypair until its
     * NodeID's SHA-256 has the required S/Kademlia puzzle difficulty
     * (macula-go's DefaultPuzzleDifficulty = 8 leading zero bits). This
     * is real work done on the Go side -- not instant, not mocked. */
    static generate() {
        return new Identity(native.identityGenerate());
    }
    /** Reconstructs an identity from a previously-saved 32-byte Ed25519
     * seed. Deterministic: does not re-grind the puzzle (a seed that
     * already satisfied it at generation time still does). */
    static fromSeedBytes(seed32) {
        return new Identity(native.identityFromSeedBytes(seed32));
    }
    #requireHandle() {
        if (this.#handle === null) {
            throw new Error("macula-ts: Identity used after dispose()");
        }
        return this.#handle;
    }
    /** The 32-byte Ed25519 public key this identity is known by on the
     * wire (CONNECT/HELLO's node_id field). */
    get nodeId() {
        return native.identityNodeId(this.#requireHandle());
    }
    /** The 32-byte Ed25519 seed -- persist this (e.g. to a 0600 file)
     * to reconstruct the identity later via fromSeedBytes. Treat as a
     * private key: anyone with this seed can sign as this identity. */
    get privateSeedBytes() {
        return native.identityPrivateBytes(this.#requireHandle());
    }
    /** Signs data with this identity's private key (Ed25519, via
     * macula-go's identity.KeyPair.Sign -- a direct ed25519.Sign wrapper)
     * and returns the raw 64-byte signature. This is a generic signing
     * primitive: no application-specific message format is baked in
     * here or on the Go side -- data is signed exactly as given, byte
     * for byte. A caller that needs a particular byte-layout convention
     * (e.g. an ownership-proof format binding this signature to some
     * other value) builds those bytes itself and passes the result in;
     * that convention is the caller's concern, not this method's.
     * Deterministic: signing the same data twice with the same identity
     * produces the same signature (Ed25519 has no per-signature nonce
     * randomness the way ECDSA does). */
    sign(data) {
        return native.identitySign(this.#requireHandle(), data);
    }
    /** Frees the Go-side handle. Safe to call more than once. */
    dispose() {
        if (this.#handle !== null) {
            native.identityFree(this.#handle);
            this.#handle = null;
        }
    }
    /** The raw native handle, for Session.connect/close only -- they need
     * it to establish/close a connection under this identity. JS private
     * fields (#handle) are genuinely inaccessible from outside this
     * class body, even to other code in this package, so this method is
     * how Session and Identity cooperate across the FFI boundary. Not
     * part of the intended public API. */
    handleForFfi() {
        return this.#requireHandle();
    }
}
//# sourceMappingURL=identity.js.map