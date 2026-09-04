// Direct-dial: resolve a procedure's DHT direct-dial advertisement and
// call its serving station in one hop, instead of depending on
// inter-station advertise-gossip having already propagated a route.
// Run: npm run build && node examples/05_direct_dial.ts
import { Identity, Session } from "../dist/index.js";

const providerId = Identity.generate();
const callerId = Identity.generate();

const provider = await Session.connect("station-de-frankfurt.macula.io", 4433, providerId);
const caller = await Session.connect("station-de-frankfurt.macula.io", 4433, callerId);

const procedure = "examples.direct." + Date.now();

// advertiseDirect() publishes BOTH a plain ADVERTISE and a signed
// procedure_advertisement DHT record -- skipping the plain ADVERTISE
// would let resolve+dial complete cleanly against a station with
// nothing registered to actually route the CALL to.
await provider.advertiseDirect(procedure);
const stop = await provider.serve(procedure, (payload) => payload);

const resolved = await caller.resolveDirect(procedure);
console.log("resolved station:", resolved.station.slice(0, 8) + "...", "at", resolved.host + ":" + resolved.port);

const result = await caller.callDirect(procedure, { via: "direct-dial" });
console.log("caller got back:", result);

await stop();
await provider.close(providerId);
await caller.close(callerId);
providerId.dispose();
callerId.dispose();
console.log("OK");
