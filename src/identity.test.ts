import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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
});
