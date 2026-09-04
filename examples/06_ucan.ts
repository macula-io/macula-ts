// Mint a UCAN capability token and attach it to a real call. This SDK
// deliberately places no restriction relating the calling identity to
// the token's own `aud` claim -- see the main README for why (macula's
// UCAN gate is a bearer-token check, not audience-matched).
// Run: npm run build && node examples/06_ucan.ts
import { Identity, Session, Ucan } from "../dist/index.js";

const providerId = Identity.generate();
const callerId = Identity.generate();
const audience = Identity.generate(); // deliberately NOT the caller -- see above

const provider = await Session.connect("station-de-frankfurt.macula.io", 4433, providerId);
const caller = await Session.connect("station-de-frankfurt.macula.io", 4433, callerId);

const procedure = "examples.gated." + Date.now();
const stop = await provider.serve(procedure, (payload) => payload);

// Minting is a pure local operation -- no network I/O, no station.
const token = Ucan.mint(providerId, audience.nodeId, [{ with: "mesh", can: "call" }]);
console.log("minted token, issuer:", token.issuer, "audience:", token.audience);

const result = await caller.callWithUcan(procedure, { hello: "gated" }, token);
console.log("caller got back:", result);

await stop();
await provider.close(providerId);
await caller.close(callerId);
providerId.dispose();
callerId.dispose();
audience.dispose();
console.log("OK");
