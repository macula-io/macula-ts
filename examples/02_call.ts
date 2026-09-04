// A provider serving a procedure and a caller invoking it -- two real
// Sessions, two real identities, in one process (a real deployment would
// usually be two separate processes; the two-Session shape is what
// matters here, not which process each lives in).
// Run: npm run build && node examples/02_call.ts
import { Identity, Session } from "../dist/index.js";

const providerId = Identity.generate();
const callerId = Identity.generate();

const provider = await Session.connect("station-de-frankfurt.macula.io", 4433, providerId);
const caller = await Session.connect("station-de-frankfurt.macula.io", 4433, callerId);

const procedure = "examples.echo." + Date.now();
const stop = await provider.serve(procedure, (payload) => {
  console.log("provider received:", payload);
  return payload;
});

const result = await caller.call(procedure, { hello: "macula" });
console.log("caller got back:", result);

// A procedure nobody has advertised comes back as a real, structured
// error -- not a generic string, not a hang.
try {
  await caller.call("examples.nonexistent." + Date.now(), {});
} catch (e: any) {
  console.log("expected error for an unadvertised procedure:", e.bolt4Name ?? e.message);
}

await stop();
await provider.close(providerId);
await caller.close(callerId);
providerId.dispose();
callerId.dispose();
console.log("OK");
