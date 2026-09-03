import { type Handle } from "./binding.js";
export declare class Identity {
    #private;
    private constructor();
    /** Mints a fresh identity, grinding an Ed25519 keypair until its
     * NodeID's SHA-256 has the required S/Kademlia puzzle difficulty
     * (macula-go's DefaultPuzzleDifficulty = 8 leading zero bits). This
     * is real work done on the Go side -- not instant, not mocked. */
    static generate(): Identity;
    /** Reconstructs an identity from a previously-saved 32-byte Ed25519
     * seed. Deterministic: does not re-grind the puzzle (a seed that
     * already satisfied it at generation time still does). */
    static fromSeedBytes(seed32: Uint8Array): Identity;
    /** The 32-byte Ed25519 public key this identity is known by on the
     * wire (CONNECT/HELLO's node_id field). */
    get nodeId(): Uint8Array;
    /** The 32-byte Ed25519 seed -- persist this (e.g. to a 0600 file)
     * to reconstruct the identity later via fromSeedBytes. Treat as a
     * private key: anyone with this seed can sign as this identity. */
    get privateSeedBytes(): Uint8Array;
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
    sign(data: Uint8Array): Uint8Array;
    /** Frees the Go-side handle. Safe to call more than once. */
    dispose(): void;
    /** The raw native handle, for Session.connect/close only -- they need
     * it to establish/close a connection under this identity. JS private
     * fields (#handle) are genuinely inaccessible from outside this
     * class body, even to other code in this package, so this method is
     * how Session and Identity cooperate across the FFI boundary. Not
     * part of the intended public API. */
    handleForFfi(): Handle;
}
