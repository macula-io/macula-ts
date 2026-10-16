// Signed objects (macula_signed_object, macula-go's macula_signed_object_verify):
// verified against the RAG service contract's frozen vector
// (test/fixtures/rag_signed_corpus), one object per profile, each signed by a
// synthetic key under the label "macula-rag corpus v1".
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MaculaError, UnverifiedError, verifySignedObject, type Profile } from "./index.js";

const LABEL = "macula-rag corpus v1";
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "rag_signed_corpus", "signed_corpus.json");

interface Vector { profile: Profile; signed_by: string; corpus_hash: string; signature_base64: string }

async function vectors(): Promise<Vector[]> {
  const bytes = await readFile(file);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("aafafb02b18cb2afa816ec4fdef38b8a2e1a0cba5faba86227b759cbd790b0bf");
  return JSON.parse(bytes.toString("utf8")) as Vector[];
}

const object = (v: Vector): Uint8Array => new Uint8Array(Buffer.from(v.signature_base64, "base64"));
const other = (p: Profile): Profile => (p === "pq_pure" ? "pq_hybrid" : "pq_pure");

describe("verifySignedObject", () => {
  it("verifies each profile's vector to its signer's node id and its signed fields", async () => {
    for (const v of await vectors()) {
      const verified = verifySignedObject(LABEL, object(v), v.profile);
      expect(verified.nodeId).toBe(v.signed_by);
      expect(verified.fields).toMatchObject({ corpus_hash: v.corpus_hash });
      expect(verified.key.length).toBeGreaterThan(2000);
      expect(verified.tbs.length).toBeGreaterThan(0);
    }
  });

  it("refuses an object under the other profile as malformed", async () => {
    for (const v of await vectors()) {
      const err = catchErr(() => verifySignedObject(LABEL, object(v), other(v.profile)));
      expect(err).toBeInstanceOf(UnverifiedError);
      expect((err as UnverifiedError).reason).toBe("malformed");
    }
  });

  it("refuses an object under another label: the signature covers the label", async () => {
    const [v] = await vectors();
    const err = catchErr(() => verifySignedObject("macula-rag corpus v2", object(v!), v!.profile));
    expect(err).toBeInstanceOf(UnverifiedError);
    expect((err as UnverifiedError).reason).toBe("signature_invalid");
  });

  it("refuses an altered object", async () => {
    const [v] = await vectors();
    const altered = object(v!);
    altered[altered.length - 10] ^= 0xff;
    expect(catchErr(() => verifySignedObject(LABEL, altered, v!.profile))).toBeInstanceOf(UnverifiedError);
  });

  // macula#104: alg is read before the signature, so an object naming another
  // profile's algorithm, or one no verifier is registered for, is refused as
  // alg_mismatch on that cheap read, under a signature that does not verify.
  it("refuses a foreign or unregistered alg before the signature, as alg_mismatch", async () => {
    for (const v of await vectors()) {
      const { key, signature } = carriedObject(object(v));
      const bad = signature.slice();
      bad[0]! ^= 0xff;
      for (const alg of [algOf(other(v.profile)), "ML-DSA-65"]) {
        const tbs = cborMap([[cborText("alg"), cborText(alg)]]);
        const forged = cborMap([[cborText("key"), cborBytes(key)], [cborText("tbs"), cborBytes(tbs)],
          [cborText("signature"), cborBytes(bad)]]);
        const err = catchErr(() => verifySignedObject(LABEL, forged, v.profile));
        expect(err, `${v.profile} naming ${alg}`).toBeInstanceOf(UnverifiedError);
        expect((err as UnverifiedError).reason).toBe("alg_mismatch");
      }
    }
  });

  it("refuses an empty label as an argument, not as an unverified object", async () => {
    const [v] = await vectors();
    const err = catchErr(() => verifySignedObject("", object(v!), v!.profile));
    expect(err).toBeInstanceOf(MaculaError);
    expect((err as MaculaError).kind).toBe("invalid_argument");
  });
});

function catchErr(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

const algOf = (p: Profile): string => (p === "pq_pure" ? "ML-DSA-87" : "ML-DSA-87-PS384");

// The little CBOR these tests build and read: definite lengths, text keys,
// byte and text strings, a map of them.
function cborHead(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  return Uint8Array.of(m | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}
const cborBytes = (b: Uint8Array): Uint8Array => Buffer.concat([cborHead(2, b.length), b]);
const cborText = (t: string): Uint8Array => {
  const utf8 = Buffer.from(t, "utf8");
  return Buffer.concat([cborHead(3, utf8.length), utf8]);
};
const cborMap = (entries: [Uint8Array, Uint8Array][]): Uint8Array =>
  new Uint8Array(Buffer.concat([cborHead(5, entries.length), ...entries.flat()]));

/** The key and signature of a signed object's CBOR, {key, tbs, signature}. */
function carriedObject(b: Uint8Array): { key: Uint8Array; signature: Uint8Array } {
  let at = 0;
  const length = (): number => {
    const info = b[at]! & 0x1f;
    at += 1;
    if (info < 24) return info;
    const size = 1 << (info - 24);
    let n = 0;
    for (let i = 0; i < size; i += 1) n = n * 256 + b[at + i]!;
    at += size;
    return n;
  };
  const string = (): Uint8Array => {
    const n = length();
    at += n;
    return b.subarray(at - n, at);
  };
  const fields = new Map<string, Uint8Array>();
  for (let n = length(); n > 0; n -= 1) {
    const name = Buffer.from(string()).toString("utf8");
    fields.set(name, string());
  }
  return { key: fields.get("key")!, signature: fields.get("signature")! };
}
