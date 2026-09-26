// This SDK's half of scripts/cross-verify-macula.sh: a pq_hybrid key made for
// the run and never saved signs a message; the message, the public key as
// carried and the signature go to argv[2] for macula to verify.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeKey } from "../../dist/index.js";

const dir = process.argv[2];
const key = await NodeKey.generate("pq_hybrid");
const message = new TextEncoder().encode("signed by macula-ts");
const signature = await key.sign(message);
if (!NodeKey.verify(message, signature, key.publicKey(), "pq_hybrid")) {
  console.error("macula-ts does not verify its own composite");
  process.exit(1);
}
await writeFile(join(dir, "m.bin"), message);
await writeFile(join(dir, "pk.bin"), key.publicKey());
await writeFile(join(dir, "s.bin"), signature);
key.free();
console.log(`ts_signed: ${signature.length}-byte composite by macula-ts written`);
