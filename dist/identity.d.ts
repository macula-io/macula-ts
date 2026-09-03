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
    /** Frees the Go-side handle. Safe to call more than once. */
    dispose(): void;
}
