import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { Ucan } from "./ucan.js";

// All of this is offline -- Ucan.mint()/decode() never touch a Session
// or a station (see ucan.ts's own module doc), so unlike session.live.test.ts
// this whole suite runs as part of default `npm test`/CI, not gated
// behind MACULA_TS_LIVE.

describe("Ucan", () => {
  it("mint() round-trips issuer/audience/capabilities/expiration/notBefore/nonce/facts/proofs through the FFI boundary", () => {
    const issuer = Identity.generate();
    const audience = Identity.generate();
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const notBefore = Math.floor(Date.now() / 1000) - 60;
      const caps = [
        { with: "mri:test:live", can: "call" },
        { with: "mri:test:live", can: "invoke" },
      ];
      const ucan = Ucan.mint(issuer, audience.nodeId, caps, {
        expiresAt,
        notBefore,
        nonce: "a-real-nonce",
        facts: { reason: "macula-ts ucan test", count: 3, real: true, nested: { ok: true } },
        proofs: ["parent-token-cid-1", "parent-token-cid-2"],
      });

      // The token itself is a real JWT-shaped triple, not an opaque
      // blob -- proof mint() reached macula-go's real ucan.Create, not a
      // stub that could return anything.
      expect(ucan.token.split(".")).toHaveLength(3);

      expect(ucan.issuer).toBe(`did:macula:${Buffer.from(issuer.nodeId).toString("hex")}`);
      expect(ucan.audience).toBe(`did:macula:${Buffer.from(audience.nodeId).toString("hex")}`);
      expect(ucan.capabilities).toEqual(caps);
      expect(ucan.expiresAt).toBe(expiresAt);
      expect(ucan.notBefore).toBe(notBefore);
      expect(ucan.nonce).toBe("a-real-nonce");
      expect(ucan.facts).toEqual({ reason: "macula-ts ucan test", count: 3, real: true, nested: { ok: true } });
      expect(ucan.proofs).toEqual(["parent-token-cid-1", "parent-token-cid-2"]);
    } finally {
      issuer.dispose();
      audience.dispose();
    }
  });

  it("mint() with no options produces a token with no expiry/notBefore/nonce/facts claims", () => {
    const issuer = Identity.generate();
    const audience = Identity.generate();
    try {
      const ucan = Ucan.mint(issuer, audience.nodeId);
      expect(ucan.capabilities).toEqual([]);
      expect(ucan.expiresAt).toBeNull();
      expect(ucan.notBefore).toBeNull();
      expect(ucan.nonce).toBe("");
      expect(ucan.facts).toBeNull();
      expect(ucan.proofs).toEqual([]);
      expect(ucan.isExpired).toBe(false);
    } finally {
      issuer.dispose();
      audience.dispose();
    }
  });

  it("decode() is Ucan.mint()'s own inverse -- a token minted here decodes identically when parsed fresh from its own text", () => {
    const issuer = Identity.generate();
    const audience = Identity.generate();
    try {
      const minted = Ucan.mint(issuer, audience.nodeId, [{ with: "mri:x", can: "y" }]);
      const decoded = Ucan.decode(minted.token);
      expect(decoded.token).toBe(minted.token);
      expect(decoded.issuer).toBe(minted.issuer);
      expect(decoded.audience).toBe(minted.audience);
      expect(decoded.capabilities).toEqual(minted.capabilities);
    } finally {
      issuer.dispose();
      audience.dispose();
    }
  });

  it("isExpired reflects a past exp claim as true and a future one as false", () => {
    const issuer = Identity.generate();
    const audience = Identity.generate();
    try {
      const expired = Ucan.mint(issuer, audience.nodeId, [], { expiresAt: Math.floor(Date.now() / 1000) - 3600 });
      expect(expired.isExpired).toBe(true);

      const notYetExpired = Ucan.mint(issuer, audience.nodeId, [], { expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      expect(notYetExpired.isExpired).toBe(false);
    } finally {
      issuer.dispose();
      audience.dispose();
    }
  });

  it("two mints from different issuer identities produce different `iss` claims (and different tokens)", () => {
    const a = Identity.generate();
    const b = Identity.generate();
    const audience = Identity.generate();
    try {
      const ucanA = Ucan.mint(a, audience.nodeId);
      const ucanB = Ucan.mint(b, audience.nodeId);
      expect(ucanA.issuer).not.toBe(ucanB.issuer);
      expect(ucanA.token).not.toBe(ucanB.token);
    } finally {
      a.dispose();
      b.dispose();
      audience.dispose();
    }
  });

  it("Ucan.mint() places no restriction relating issuer to audience -- an audience unrelated to any real identity is accepted, matching the mesh's own bearer-token gate", () => {
    const issuer = Identity.generate();
    try {
      const unrelatedAudience = new Uint8Array(32).fill(0xab);
      const ucan = Ucan.mint(issuer, unrelatedAudience);
      expect(ucan.audience).toBe(`did:macula:${Buffer.from(unrelatedAudience).toString("hex")}`);
    } finally {
      issuer.dispose();
    }
  });

  it("mint() rejects an audience that isn't exactly 32 bytes", () => {
    const issuer = Identity.generate();
    try {
      expect(() => Ucan.mint(issuer, new Uint8Array(31))).toThrow(/32 bytes/);
      expect(() => Ucan.mint(issuer, new Uint8Array(33))).toThrow(/32 bytes/);
    } finally {
      issuer.dispose();
    }
  });

  it("mint() with a disposed issuer identity throws instead of touching a freed handle", () => {
    const issuer = Identity.generate();
    const audience = Identity.generate();
    issuer.dispose();
    try {
      expect(() => Ucan.mint(issuer, audience.nodeId)).toThrow();
    } finally {
      audience.dispose();
    }
  });

  it("decode() of a malformed token throws instead of returning garbage", () => {
    expect(() => Ucan.decode("not-a-real-token")).toThrow();
    expect(() => Ucan.decode("only.two")).toThrow();
    expect(() => Ucan.decode("")).toThrow();
  });

  it("decode() of a token with a tampered payload segment still decodes the claims (Decode never verifies the signature)", () => {
    const issuer = Identity.generate();
    const audience = Identity.generate();
    try {
      const minted = Ucan.mint(issuer, audience.nodeId, [{ with: "mri:x", can: "y" }]);
      const [headerB64, payloadB64] = minted.token.split(".");
      // Swap in a completely different, syntactically-valid payload
      // from a second, unrelated token minted by a different issuer --
      // decode() must still happily parse it (it never checks the
      // signature against headerB64+payloadB64 at all), proving this is
      // genuinely a non-verifying decode, not a verify-then-decode that
      // happens to succeed on well-formed input only.
      const other = Identity.generate();
      try {
        const otherMinted = Ucan.mint(other, audience.nodeId, [{ with: "mri:other", can: "z" }]);
        const [, otherPayloadB64] = otherMinted.token.split(".");
        const tampered = `${headerB64}.${otherPayloadB64}.deadbeef`;
        const decoded = Ucan.decode(tampered);
        expect(decoded.capabilities).toEqual([{ with: "mri:other", can: "z" }]);
        expect(decoded.issuer).toBe(otherMinted.issuer);
      } finally {
        other.dispose();
      }
    } finally {
      issuer.dispose();
      audience.dispose();
    }
  });
});
