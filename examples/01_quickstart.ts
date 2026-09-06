// Connects to a real macula-station, advertises a trivial echo procedure,
// and calls it. Dials the real production fleet, so this isn't run by
// CI -- see README.md's "Quick start" section, which this file backs.
// Run: npm run build && node examples/01_quickstart.ts
//
// Two identities are used (a provider and a caller) because a station
// kicks a connection the instant a second one arrives under the same
// identity.
import { Identity, Session } from "../dist/index.js";

const providerId = Identity.generate();
const callerId = Identity.generate();

const provider = await Session.connect("station-de-frankfurt.macula.io", 4433, providerId);
const caller = await Session.connect("station-de-frankfurt.macula.io", 4433, callerId);

// Unique per run -- reusing a fixed procedure name across rapid repeated
// runs can hit stale DHT routing state from the prior run's now-dead
// advertiser.
const procedure = `macula_ts.quickstart_echo.${Date.now()}`;

const stop = await provider.serve(procedure, (payload) => payload);
await new Promise((resolve) => setTimeout(resolve, 500)); // ADVERTISE is fire-and-forget; give it a moment to land

const response = await caller.call(procedure, "hello");
console.log("call response:", response);

await stop();
await provider.close(providerId);
await caller.close(callerId);
providerId.dispose();
callerId.dispose();
console.log("OK");
