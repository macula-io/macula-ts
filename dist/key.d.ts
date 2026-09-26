import { type Handle } from "./binding.js";
/** A crypto profile: "pq_hybrid" (the fleet's) or "pq_pure". */
export type Profile = "pq_hybrid" | "pq_pure";
export declare class NodeKey {
    private handle;
    private constructor();
    /** A new key whose node_id solves the admission puzzle; takes a second or
     * so, off the event loop. */
    static generate(profile?: Profile): Promise<NodeKey>;
    /** The key in the key file at path. A file its group or others can read,
     * or holding a key of another profile, is refused. */
    static load(path: string, profile?: Profile): Promise<NodeKey>;
    /** The key at path, or a new one saved there when the file does not exist. */
    static loadOrCreate(path: string, profile?: Profile): Promise<NodeKey>;
    /** Writes the key to path, readable by its owner only. */
    save(path: string): Promise<void>;
    /** The key's 32-byte node_id. */
    nodeId(): Uint8Array;
    /** The node_id as lowercase hex. */
    nodeIdHex(): string;
    /** The public key as carried on the wire. */
    publicKey(): Uint8Array;
    /** The key's profile. */
    profile(): Profile;
    /** Signs data as given. */
    sign(data: Uint8Array): Promise<Uint8Array>;
    /** Whether signature is valid over data for a public key as carried on the
     * wire (publicKey()), under profile: ML-DSA-87 in pq_pure, and in pq_hybrid
     * the LAMPS composite id-MLDSA87-RSA4096-PSS-SHA512 with the empty context,
     * both halves verified. Anything malformed is false. */
    static verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array, profile?: Profile): boolean;
    /** Frees the native key. The NodeKey is unusable after. */
    free(): void;
    /** @internal */
    live(): Handle;
}
