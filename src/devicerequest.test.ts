import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOIN_SESSION_PROCEDURE, MEMBERSHIP_UCAN_PROCEDURE, NodeKey } from "./key.js";

// Realm proof v2 (macula-realm#29) through the FFI: the realm's own vector,
// apps/macula_realm/test/macula_realm/identity/device_request_proof_vector.hex,
// built by macula-go's encoder, never a JavaScript CBOR library.

const ioMacula = createHash("sha256").update("io.macula").digest();

describe("a device request proof", () => {
  it("signs the realm's vector, byte for byte", () => {
    const want = Buffer.from(readFileSync(join(__dirname, "..", "testdata", "device_request_proof_vector.hex"), "utf8").trim(), "hex");
    const got = NodeKey.deviceRequestMessage(new Uint8Array(2592).fill(7), ioMacula, JOIN_SESSION_PROCEDURE, 1790000000000,
      new Uint8Array(16), { device_info: { hostname: "laptop.local", note: null }, n: 1e2, z: -0, f: 1.5 }, "http");
    expect(Buffer.from(got).equals(want)).toBe(true);
  });

  it("is refused for what the realm refuses", () => {
    const bad = () => NodeKey.deviceRequestMessage(new Uint8Array(2592), ioMacula, JOIN_SESSION_PROCEDURE, 1, new Uint8Array(16),
      { n: 9007199254740992 }, "http");
    expect(bad).toThrow(/beyond 2\^53/);
  });

  it("verifies over the request it names, and over nothing else", async () => {
    const key = await NodeKey.generate("pq_pure");
    try {
      const request = { public_key: Buffer.from(key.publicKey()).toString("base64"), ttl_seconds: 3600 };
      const proof = await key.deviceRequestProof(ioMacula, MEMBERSHIP_UCAN_PROCEDURE, { ...request, proof: { v: 1 } }, "mesh");
      expect(proof.v).toBe(2);
      expect(proof.nonce).toMatch(/^[0-9a-f]{32}$/);
      const signed = (r: typeof request) => NodeKey.deviceRequestMessage(key.publicKey(), ioMacula, MEMBERSHIP_UCAN_PROCEDURE,
        proof.timestamp, Buffer.from(proof.nonce, "hex"), r, "mesh");
      const signature = Buffer.from(proof.signature, "hex");
      expect(NodeKey.verify(signed(request), signature, key.publicKey(), "pq_pure")).toBe(true);
      expect(NodeKey.verify(signed({ ...request, ttl_seconds: 86400 }), signature, key.publicKey(), "pq_pure")).toBe(false);
      const again = await key.deviceRequestProof(ioMacula, MEMBERSHIP_UCAN_PROCEDURE, request, "mesh");
      expect(again.nonce).not.toBe(proof.nonce);
    } finally {
      key.free();
    }
  });
});
