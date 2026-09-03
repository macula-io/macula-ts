import { describe, it, expect } from "vitest";
import { createHash, createPublicKey, verify } from "node:crypto";
import { Identity } from "./identity.js";

// The one concrete, falsifiable claim this walking skeleton exists to
// prove: that generate() reached real macula-go code across the FFI
// boundary, not a stub. A stub could trivially return 32 random bytes
// -- it could NOT make those bytes satisfy the S/Kademlia puzzle
// property below, since that requires macula-go's actual
// grind-until-valid loop (identity.GenerateWithPuzzle).
function leadingZeroBits(buf: Uint8Array): number {
  let n = 0;
  for (const b of buf) {
    if (b === 0) {
      n += 8;
      continue;
    }
    for (let mask = 0x80; mask !== 0; mask >>= 1) {
      if (b & mask) return n;
      n++;
    }
  }
  return n;
}

describe("Identity", () => {
  it("generate() produces a 32-byte NodeID satisfying the S/Kademlia puzzle (difficulty 8)", () => {
    const id = Identity.generate();
    try {
      const nodeId = id.nodeId;
      expect(nodeId.length).toBe(32);

      const puzzleEvidence = createHash("sha256").update(nodeId).digest();
      expect(leadingZeroBits(puzzleEvidence)).toBeGreaterThanOrEqual(8);
    } finally {
      id.dispose();
    }
  });

  it("fromSeedBytes() deterministically reconstructs the same NodeID", () => {
    const original = Identity.generate();
    let seed: Uint8Array;
    let nodeId: Uint8Array;
    try {
      seed = original.privateSeedBytes;
      nodeId = original.nodeId;
    } finally {
      original.dispose();
    }

    const restored = Identity.fromSeedBytes(seed);
    try {
      expect(Buffer.from(restored.nodeId).equals(Buffer.from(nodeId))).toBe(true);
    } finally {
      restored.dispose();
    }
  });

  it("two calls to generate() produce different identities", () => {
    const a = Identity.generate();
    const b = Identity.generate();
    try {
      expect(Buffer.from(a.nodeId).equals(Buffer.from(b.nodeId))).toBe(false);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("using an identity after dispose() throws instead of touching a freed handle", () => {
    const id = Identity.generate();
    id.dispose();
    expect(() => id.nodeId).toThrow(/used after dispose/);
  });

  describe("sign()", () => {
    // Builds a Node KeyObject from this identity's raw 32-byte NodeID
    // (an Ed25519 public key) via the JWK import path -- Node's
    // crypto.verify has no "raw Ed25519 public key bytes" key format of
    // its own to hand a Buffer to directly, but it does support
    // importing a JWK, and OKP/Ed25519 JWKs are just base64url(raw
    // public key bytes) (RFC 8037). This gives an independent verifier
    // (not macula-go, not this SDK's own code) something to check the
    // signature against.
    function verifierFor(nodeId: Uint8Array): ReturnType<typeof createPublicKey> {
      return createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(nodeId).toString("base64url") },
        format: "jwk",
      });
    }

    it("produces a real 64-byte Ed25519 signature verifiable by an independent verifier over the exact data and public key", () => {
      const id = Identity.generate();
      try {
        const nodeId = id.nodeId;
        const data = new TextEncoder().encode("macula-ts: sign() live-verification payload");
        const sig = id.sign(data);

        expect(sig.length).toBe(64);
        expect(verify(null, Buffer.from(data), verifierFor(nodeId), Buffer.from(sig))).toBe(true);

        // Tampering with either the signed data or the signature bytes
        // must invalidate it -- a stub returning 64 arbitrary bytes
        // could satisfy the length check above but could not survive
        // this.
        const tamperedData = Buffer.from(data);
        tamperedData[0] ^= 0xff;
        expect(verify(null, tamperedData, verifierFor(nodeId), Buffer.from(sig))).toBe(false);

        const tamperedSig = Buffer.from(sig);
        tamperedSig[0] ^= 0xff;
        expect(verify(null, Buffer.from(data), verifierFor(nodeId), tamperedSig)).toBe(false);
      } finally {
        id.dispose();
      }
    });

    it("is deterministic: signing the same data twice with the same identity produces the same signature", () => {
      const id = Identity.generate();
      try {
        const data = new TextEncoder().encode("same data, signed twice");
        const sigA = id.sign(data);
        const sigB = id.sign(data);
        expect(Buffer.from(sigA).equals(Buffer.from(sigB))).toBe(true);
      } finally {
        id.dispose();
      }
    });

    it("signing different data produces a different signature", () => {
      const id = Identity.generate();
      try {
        const sigA = id.sign(new TextEncoder().encode("data A"));
        const sigB = id.sign(new TextEncoder().encode("data B"));
        expect(Buffer.from(sigA).equals(Buffer.from(sigB))).toBe(false);
      } finally {
        id.dispose();
      }
    });

    it("throws after dispose() instead of signing with a freed handle", () => {
      const id = Identity.generate();
      id.dispose();
      expect(() => id.sign(new TextEncoder().encode("too late"))).toThrow(/used after dispose/);
    });
  });
});
