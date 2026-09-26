// A node's identity key, as macula 12 has it: ML-DSA-87 (pq_pure) or the LAMPS
// composite ML-DSA-87 + RSA-4096-PSS (pq_hybrid, the fleet's profile), whose
// node_id solves the admission puzzle. Stored in a key file readable by its
// owner only.
import { access } from "node:fs/promises";
import { native, type Handle } from "./binding.js";
import { hex, id32, type Id, type JsonValue } from "./wire.js";

/** A crypto profile: "pq_hybrid" (the fleet's) or "pq_pure". */
export type Profile = "pq_hybrid" | "pq_pure";

/**
 * How a device request is signed (realm proof v2, macula-realm#29): "http" is a
 * join-session body under the realm's JSON rule (an integral number is an
 * integer, a boolean or an integer beyond 2^53 - 1 is refused); "mesh" is a
 * call's payload as this library puts it on the wire.
 */
export type DeviceRequestRule = "http" | "mesh";

/** The procedure a join session over HTTP is signed for. */
export const JOIN_SESSION_PROCEDURE = "macula_realm.join_session";
/** The procedure a membership UCAN asked for over the mesh is signed for. */
export const MEMBERSHIP_UCAN_PROCEDURE = "macula_realm.membership_ucan";

/** A realm proof v2, as it goes on the wire beside the request's public_key. */
export interface DeviceRequestProof {
  v: 2;
  timestamp: number;
  nonce: string;
  signature: string;
}

const ruleNumber = (rule: DeviceRequestRule): number => (rule === "http" ? 0 : 1);

export class NodeKey {
  private constructor(private handle: Handle | null) {}

  /** A new key whose node_id solves the admission puzzle; takes a second or
   * so, off the event loop. */
  static async generate(profile: Profile = "pq_hybrid"): Promise<NodeKey> {
    return new NodeKey(await native.keyGenerate(profile));
  }

  /** The key in the key file at path. A file its group or others can read,
   * or holding a key of another profile, is refused. */
  static async load(path: string, profile: Profile = "pq_hybrid"): Promise<NodeKey> {
    return new NodeKey(await native.keyLoad(path, profile));
  }

  /** The key at path, or a new one saved there when the file does not exist. */
  static async loadOrCreate(path: string, profile: Profile = "pq_hybrid"): Promise<NodeKey> {
    try {
      await access(path);
    } catch {
      const key = await NodeKey.generate(profile);
      await key.save(path);
      return key;
    }
    return NodeKey.load(path, profile);
  }

  /** Writes the key to path, readable by its owner only. */
  async save(path: string): Promise<void> {
    await native.keySave(this.live(), path);
  }

  /** The key's 32-byte node_id. */
  nodeId(): Uint8Array {
    return native.keyNodeId(this.live());
  }

  /** The node_id as lowercase hex. */
  nodeIdHex(): string {
    return hex(this.nodeId());
  }

  /** The public key as carried on the wire. */
  publicKey(): Uint8Array {
    return native.keyPublicKey(this.live());
  }

  /** The key's profile. */
  profile(): Profile {
    return native.keyProfile(this.live()) as Profile;
  }

  /** Signs data as given. */
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return native.keySign(this.live(), data);
  }

  /**
   * A realm proof v2 (macula-realm#29) that this key made request (every field
   * of it except "proof") for procedure in realm, now and with a fresh nonce.
   * The request's device_info and ttl_seconds, the realm and the procedure are
   * all signed, so the realm refuses a request changed on the way.
   */
  async deviceRequestProof(realm: Id, procedure: string, request: { [field: string]: JsonValue },
    rule: DeviceRequestRule): Promise<DeviceRequestProof> {
    const proof = await native.keyDeviceRequestProof(this.live(), id32(realm, "realm"), procedure, JSON.stringify(request),
      ruleNumber(rule));
    return JSON.parse(proof) as DeviceRequestProof;
  }

  /** The exact bytes a realm proof v2 signs, for a given timestamp and 16-byte
   * nonce: what the realm's vector is checked against. */
  static deviceRequestMessage(publicKey: Uint8Array, realm: Id, procedure: string, timestampMs: number, nonce: Uint8Array,
    request: { [field: string]: JsonValue }, rule: DeviceRequestRule): Uint8Array {
    return native.deviceRequestMessage(publicKey, id32(realm, "realm"), procedure, timestampMs, nonce,
      JSON.stringify(request), ruleNumber(rule));
  }

  /** Whether signature is valid over data for a public key as carried on the
   * wire (publicKey()), under profile: ML-DSA-87 in pq_pure, and in pq_hybrid
   * the LAMPS composite id-MLDSA87-RSA4096-PSS-SHA512 with the empty context,
   * both halves verified. Anything malformed is false. */
  static verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array, profile: Profile = "pq_hybrid"): boolean {
    return native.verify(data, signature, publicKey, profile);
  }

  /** Frees the native key. The NodeKey is unusable after. */
  free(): void {
    if (this.handle !== null) native.keyFree(this.handle);
    this.handle = null;
  }

  /** @internal */
  live(): Handle {
    if (this.handle === null) throw new Error("macula-ts: this NodeKey was freed");
    return this.handle;
  }
}
