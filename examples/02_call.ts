// Calling a procedure nobody has advertised comes back as a real,
// structured error -- not a generic string, not a hang. See
// 01_quickstart.ts for the provider+caller shape (advertise, serve, call
// a real procedure); this is the other half, the error path.
// Run: npm run build && node examples/02_call.ts
import { Identity, Session } from "../dist/index.js";

const callerId = Identity.generate();
const caller = await Session.connect("station-de-frankfurt.macula.io", 4433, callerId);

try {
  await caller.call("examples.nonexistent." + Date.now(), {});
} catch (e: any) {
  console.log("expected error for an unadvertised procedure:", e.bolt4Name ?? e.message);
}

await caller.close(callerId);
callerId.dispose();
console.log("OK");
