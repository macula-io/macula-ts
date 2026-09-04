// Identity generation + a real handshake against the production fleet.
// Run: npm run build && node examples/01_quickstart.ts
import { Identity, Session } from "../dist/index.js";

const identity = Identity.generate();
console.log("identity node_id:", Buffer.from(identity.nodeId).toString("hex"));

const session = await Session.connect("station-de-frankfurt.macula.io", 4433, identity);
console.log("remote addr:", session.remoteAddr);
console.log("station node_id:", Buffer.from(session.stationNodeId).toString("hex"));

await session.close(identity);
identity.dispose();
console.log("OK");
