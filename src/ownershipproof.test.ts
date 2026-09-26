import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKey } from "./key.js";
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

interface AssertedBy {
  identity: string;
  proof: { v: number; timestamp: number; nonce: string; signature: string; public: string };
}

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

  it("is a payload whose asserted_by verifies over its fields, and over nothing else", async () => {
    const key = await NodeKey.generate("pq_pure");
    try {
      const payload = await key.ownershipProof(ioMacula, PROCEDURE, fields);
      const { asserted_by: block, ...rest } = payload as unknown as { asserted_by: AssertedBy } & typeof fields;
      expect(rest).toEqual(fields);
      expect(block.identity).toBe(key.nodeIdHex());
      expect(block.proof.v).toBe(2);
      expect(block.proof.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(Math.abs(block.proof.timestamp - Date.now())).toBeLessThan(60_000);
      expect(block.proof.public).toBe(Buffer.from(key.publicKey()).toString("hex"));
      const signed = (f: typeof fields) => NodeKey.ownershipProofMessage(key.nodeId(), ioMacula, PROCEDURE,
        block.proof.timestamp, Buffer.from(block.proof.nonce, "hex"), f);
      const signature = Buffer.from(block.proof.signature, "hex");
      expect(NodeKey.verify(signed(fields), signature, key.publicKey(), "pq_pure")).toBe(true);
      expect(NodeKey.verify(signed({ ...fields, weight: 4 }), signature, key.publicKey(), "pq_pure")).toBe(false);
      const again = await key.ownershipProof(ioMacula, PROCEDURE, payload);
      const next = (again as unknown as { asserted_by: AssertedBy }).asserted_by;
      expect(next.proof.nonce).not.toBe(block.proof.nonce);
    } finally {
      key.free();
    }
  });

  it("refuses a payload carrying caller, which a station replaces", async () => {
    const key = await NodeKey.generate("pq_pure");
    try {
      const refused = key.ownershipProof(ioMacula, PROCEDURE, { ...fields, caller: "someone" });
      await expect(refused).rejects.toBeInstanceOf(MaculaError);
      await expect(refused).rejects.toMatchObject({ kind: "invalid_argument", message: expect.stringMatching(/caller/) });
    } finally {
      key.free();
    }
  });
});
