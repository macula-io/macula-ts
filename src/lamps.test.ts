// pq_hybrid is the LAMPS composite id-MLDSA87-RSA4096-PSS-SHA512
// (draft-ietf-lamps-pq-composite-sigs), and this holds the public API to the
// draft's own vector, the vector macula and macula-go check: the draft's
// signature verifies and every alteration of it is refused; the draft's key,
// loaded as a node key, carries the draft's public key and signs composites
// that verify under it; and signatures cross both ways with macula 12.x
// (test/fixtures/macula_12_cross, written by scripts/cross-verify-macula.sh).
// No station is needed.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKey } from "./index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const fixture = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(fixtures, name)));
const draft = (name: string) => fixture(`lamps_mldsa87_rsa4096_pss_sha512/${name}`);

// The ML-DSA-87 half of a composite signature, in bytes.
const MLDSA_SIGNATURE_BYTES = 4627;

// The draft's bytes as macula v12.7.0 carries them (test/fixtures/), pinned by
// sha256 so a drifted copy fails here rather than passing on bytes nobody else
// signed. The same sums macula-go pins.
const PINNED: Record<string, string> = {
  "lamps_mldsa87_rsa4096_pss_sha512/m.bin": "ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c",
  "lamps_mldsa87_rsa4096_pss_sha512/pk.bin": "88560e139b35d0738857f9c8e29bbcfb108e3539bd2bf6f4994bb4b34beb019d",
  "lamps_mldsa87_rsa4096_pss_sha512/sk.bin": "0d4c65edb8735b5b677ea88050662406c7affd8e29ae27184726822a5ca889ce",
  "lamps_mldsa87_rsa4096_pss_sha512/s.bin": "95e17c93e9c1d6b5c3c4bae9d8687cd1606e232dca0af38e437e7e2e16894303",
  "lamps_mldsa87_rsa4096_pss_sha512/s_with_context.bin":
    "7261d9aeaaee3eb2612bb868d00d8eb6e174717bc427e8e6fa24cb7a73dcdeec",
  "lamps_composite_zero_dropped/sig.bin": "4e43a85def2b0acec014724d7d4b23ac86685ef35f28a9be85d9aff4a7cd30cd",
};

function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[at] = out[at]! ^ 1;
  return out;
}

const withByte = (bytes: Uint8Array, byte: number): Uint8Array => Uint8Array.from([...bytes, byte]);

// A pq_hybrid identity key file (macula-go's seed form): the magic, the
// purpose (identity, 1), the profile (pq_hybrid, 2) and two halves, each its
// algorithm tag and its public and private keys, four-byte big-endian
// length-prefixed.
function keyFile(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const half = (tag: number, pub: Uint8Array, priv: Uint8Array): Buffer => {
    const len = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    return Buffer.concat([Buffer.from([tag]), len(pub.length), pub, len(priv.length), priv]);
  };
  return Buffer.concat([
    Buffer.from("macula-node-key-seed-v1\0", "latin1"),
    Buffer.from([1, 2, 2]),
    half(1, pk.subarray(0, 2592), sk.subarray(0, 32)),
    half(2, pk.subarray(2592), sk.subarray(32)),
  ]);
}

describe("the LAMPS draft's vector", () => {
  it("is the bytes macula pins", async () => {
    for (const [name, sha256] of Object.entries(PINNED)) {
      expect(createHash("sha256").update(await fixture(name)).digest("hex"), name).toBe(sha256);
    }
  });

  it("verifies the draft's signature, and refuses every alteration of it", async () => {
    const [m, pk, s] = [await draft("m.bin"), await draft("pk.bin"), await draft("s.bin")];
    expect(NodeKey.verify(m, s, pk, "pq_hybrid")).toBe(true);
    expect(NodeKey.verify(withByte(m, 0), s, pk, "pq_hybrid")).toBe(false);
    expect(NodeKey.verify(m, flipped(s, 10), pk, "pq_hybrid")).toBe(false);
    expect(NodeKey.verify(m, flipped(s, MLDSA_SIGNATURE_BYTES + 10), pk, "pq_hybrid")).toBe(false);
    expect(NodeKey.verify(m, s, pk, "pq_pure")).toBe(false);
  });

  it("refuses the draft's signature made with a context: every Macula object signs with the empty one", async () => {
    expect(NodeKey.verify(await draft("m.bin"), await draft("s_with_context.bin"), await draft("pk.bin"), "pq_hybrid"))
      .toBe(false);
  });

  it("refuses a composite whose RSA-PSS half lost its leading zero byte, by its length alone", async () => {
    const zeroDropped = await fixture("lamps_composite_zero_dropped/sig.bin");
    expect(zeroDropped.length).toBe(MLDSA_SIGNATURE_BYTES + 511);
    expect(NodeKey.verify(await draft("m.bin"), zeroDropped, await draft("pk.bin"), "pq_hybrid")).toBe(false);
  });

  it("signs through the public API with the draft's key, loaded as a node key, under the draft's public key", async () => {
    const [m, pk] = [await draft("m.bin"), await draft("pk.bin")];
    const dir = await mkdtemp(join(tmpdir(), "macula-ts-lamps-"));
    try {
      const path = join(dir, "draft.key");
      await writeFile(path, keyFile(await draft("sk.bin"), pk));
      await chmod(path, 0o600);
      const key = await NodeKey.load(path, "pq_hybrid");
      expect(key.profile()).toBe("pq_hybrid");
      expect(Buffer.from(key.publicKey()).equals(Buffer.from(pk))).toBe(true);
      const signature = await key.sign(m);
      expect(signature.length).toBe((await draft("s.bin")).length);
      expect(NodeKey.verify(m, signature, pk, "pq_hybrid")).toBe(true);
      expect(NodeKey.verify(m, flipped(signature, MLDSA_SIGNATURE_BYTES + 10), pk, "pq_hybrid")).toBe(false);
      key.free();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies a generated pq_hybrid key's signature under its public key only", async () => {
    const key = await NodeKey.generate("pq_hybrid");
    const message = new TextEncoder().encode("a fact");
    const signature = await key.sign(message);
    expect(NodeKey.verify(message, signature, key.publicKey(), "pq_hybrid")).toBe(true);
    expect(NodeKey.verify(message, signature, await draft("pk.bin"), "pq_hybrid")).toBe(false);
    key.free();
  });
});

describe("cross-verification with macula 12.x", () => {
  const cross = async (signer: string) =>
    [`macula_12_cross/${signer}/m.bin`, `macula_12_cross/${signer}/pk.bin`, `macula_12_cross/${signer}/s.bin`].map(
      fixture);

  it("verifies a composite macula signed with a key of its own", async () => {
    const [m, pk, s] = await Promise.all(await cross("macula_signed"));
    expect(NodeKey.verify(m!, s!, pk!, "pq_hybrid")).toBe(true);
    expect(NodeKey.verify(m!, flipped(s!, MLDSA_SIGNATURE_BYTES + 10), pk!, "pq_hybrid")).toBe(false);
  });

  it("verifies the composite this SDK signed and macula verified", async () => {
    const [m, pk, s] = await Promise.all(await cross("ts_signed"));
    expect(NodeKey.verify(m!, s!, pk!, "pq_hybrid")).toBe(true);
  });
});
