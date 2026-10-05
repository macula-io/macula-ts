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
