import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeKey, type Profile } from "./key.js";
import { MaculaError, type JsonValue } from "./wire.js";

// Ownership proof v2 (mcl-om#7) through the ABI: mcl_om's own vector, built by
// mcl_om_ownership_proof on macula 12, never a JavaScript CBOR library.

const ioMacula = createHash("sha256").update("io.macula").digest();
const PROCEDURE = "mcl-graph/learn_link";
const vector = (name: string) =>
  Buffer.from(readFileSync(join(__dirname, "..", "testdata", "ownership_proof_vector", name), "utf8").trim(), "hex");

// The vector's fields: every type a payload carries.
const fields: { [field: string]: JsonValue } = {
  subject: "entity:alpha", predicate: "knows", object: "entity:beta", confidence: 0.75, weight: 3, offset: -7,
  digest: { $bytes: "AQID" }, note: null, tags: ["a", "b"], metadata: { source: "field-notes", page: 12 },
};
const nonce = Uint8Array.from({ length: 16 }, (_, i) => i);

// One key per profile for the file, made before the tests: pq_hybrid's
// ML-DSA-87 plus RSA-4096 key generation takes seconds on a CPU-capped runner
// (macula-ts#16).
const keys = {} as Record<Profile, NodeKey>;
beforeAll(async () => {
  [keys.pq_pure, keys.pq_hybrid] = await Promise.all([NodeKey.generate("pq_pure"), NodeKey.generate("pq_hybrid")]);
}, 120_000);
afterAll(() => Object.values(keys).forEach((key) => key.free()));

describe("an ownership proof", () => {
  it("signs mcl_om's vector, byte for byte, and an Erlang key's signature over it verifies", () => {
    const got = NodeKey.ownershipProofMessage(vector("identity.hex"), ioMacula, PROCEDURE, 1790000000000, nonce, fields);
    expect(Buffer.from(got).toString("hex")).toBe(vector("message.hex").toString("hex"));
    expect(NodeKey.verify(got, vector("signature.hex"), vector("public_key.hex"), "pq_hybrid")).toBe(true);
  });

  it("signs the fields a handler reads: an asserted_by and a text caller change nothing", () => {
    const whole = { ...fields, caller: "claimed", asserted_by: { identity: "x" } };
    const got = NodeKey.ownershipProofMessage(vector("identity.hex"), ioMacula, PROCEDURE, 1790000000000, nonce, whole);
    expect(Buffer.from(got).equals(vector("message.hex"))).toBe(true);
  });

  it.each<Profile>(["pq_pure", "pq_hybrid"])("is, in %s, a payload whose asserted_by verifies over the fields it sends, and over nothing else", async (profile) => {
    const key = keys[profile];
    const payload = await key.ownershipProof(ioMacula, PROCEDURE, fields);
    // As Pool.call puts it on the wire.
    const { asserted_by: block, ...rest } = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(rest).toEqual(fields);
    expect(block.identity).toBe(key.nodeIdHex());
    expect(block.proof.v).toBe(2);
    expect(block.proof.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Math.abs(block.proof.timestamp - Date.now())).toBeLessThan(60_000);
    expect(block.proof.public).toBe(Buffer.from(key.publicKey()).toString("hex"));
    const signed = (f: typeof fields) => NodeKey.ownershipProofMessage(key.nodeId(), ioMacula, PROCEDURE,
      block.proof.timestamp, Buffer.from(block.proof.nonce, "hex"), f);
    const signature = Buffer.from(block.proof.signature, "hex");
    expect(NodeKey.verify(signed(rest), signature, key.publicKey(), profile)).toBe(true);
    expect(NodeKey.verify(signed({ ...rest, weight: 4 }), signature, key.publicKey(), profile)).toBe(false);
    const again = await key.ownershipProof(ioMacula, PROCEDURE, payload);
    expect(again.asserted_by.proof.nonce).not.toBe(block.proof.nonce);
  });

  it("refuses a payload carrying caller, which a station replaces", async () => {
    const refused = keys.pq_pure.ownershipProof(ioMacula, PROCEDURE, { ...fields, caller: "someone" });
    await expect(refused).rejects.toBeInstanceOf(MaculaError);
    await expect(refused).rejects.toMatchObject({ kind: "invalid_argument", message: expect.stringMatching(/caller/) });
  });
});
