// A node's identity key, as macula 12 has it: ML-DSA-87 (pq_pure) or the LAMPS
// composite ML-DSA-87 + RSA-4096-PSS (pq_hybrid, the fleet's profile), whose
// node_id solves the admission puzzle. Stored in a key file readable by its
// owner only.
import { access } from "node:fs/promises";
import { native } from "./binding.js";
import { hex } from "./wire.js";
export class NodeKey {
    handle;
    constructor(handle) {
        this.handle = handle;
    }
    /** A new key whose node_id solves the admission puzzle; takes a second or
     * so, off the event loop. */
    static async generate(profile = "pq_hybrid") {
        return new NodeKey(await native.keyGenerate(profile));
    }
    /** The key in the key file at path. A file its group or others can read,
     * or holding a key of another profile, is refused. */
    static async load(path, profile = "pq_hybrid") {
        return new NodeKey(await native.keyLoad(path, profile));
    }
    /** The key at path, or a new one saved there when the file does not exist. */
    static async loadOrCreate(path, profile = "pq_hybrid") {
        try {
            await access(path);
        }
        catch {
            const key = await NodeKey.generate(profile);
            await key.save(path);
            return key;
        }
        return NodeKey.load(path, profile);
    }
    /** Writes the key to path, readable by its owner only. */
    async save(path) {
        await native.keySave(this.live(), path);
    }
    /** The key's 32-byte node_id. */
    nodeId() {
        return native.keyNodeId(this.live());
    }
    /** The node_id as lowercase hex. */
    nodeIdHex() {
        return hex(this.nodeId());
    }
    /** The public key as carried on the wire. */
    publicKey() {
        return native.keyPublicKey(this.live());
    }
    /** The key's profile. */
    profile() {
        return native.keyProfile(this.live());
    }
    /** Signs data as given. */
    async sign(data) {
        return native.keySign(this.live(), data);
    }
    /** Whether signature is valid over data for a public key as carried on the
     * wire (publicKey()), under profile: ML-DSA-87 in pq_pure, and in pq_hybrid
     * the LAMPS composite id-MLDSA87-RSA4096-PSS-SHA512 with the empty context,
     * both halves verified. Anything malformed is false. */
    static verify(data, signature, publicKey, profile = "pq_hybrid") {
        return native.verify(data, signature, publicKey, profile);
    }
    /** Frees the native key. The NodeKey is unusable after. */
    free() {
        if (this.handle !== null)
            native.keyFree(this.handle);
        this.handle = null;
    }
    /** @internal */
    live() {
        if (this.handle === null)
            throw new Error("macula-ts: this NodeKey was freed");
        return this.handle;
    }
}
//# sourceMappingURL=key.js.map