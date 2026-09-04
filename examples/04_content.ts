// putContent()/getContent() -- a one-time TRANSFER mechanism, not durable
// object storage (a station may forget content after serving it, and
// there's no list/delete operation -- see the main README).
// Run: npm run build && node examples/04_content.ts
import { Identity, Session } from "../dist/index.js";

const identity = Identity.generate();
const session = await Session.connect("station-de-frankfurt.macula.io", 4433, identity);

const data = Buffer.from("hello from macula-ts's examples/04_content.ts");
const { mcid } = await session.putContent(data, "example.txt");
console.log("stored, mcid:", mcid);

const fetched = await session.getContent(mcid);
console.log("round trip matches:", Buffer.from(fetched).equals(data));

await session.close(identity);
identity.dispose();
console.log("OK");
