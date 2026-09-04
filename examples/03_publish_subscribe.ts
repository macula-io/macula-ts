// subscribe() + publish() on the same Session -- a subscriber does
// receive its own publish (confirmed live elsewhere in this SDK's own
// test suite; this example just demonstrates the shape).
// Run: npm run build && node examples/03_publish_subscribe.ts
import { Identity, Session } from "../dist/index.js";

const identity = Identity.generate();
const session = await Session.connect("station-de-frankfurt.macula.io", 4433, identity);

const topic = "examples.chat." + Date.now();

let resolveReceived: () => void;
const received = new Promise<void>((resolve) => {
  resolveReceived = resolve;
});

const stop = await session.subscribe(topic, (event) => {
  console.log("received:", event.payload, "from", Buffer.from(event.publisher).toString("hex").slice(0, 8) + "...");
  resolveReceived();
});

// subscribe() resolves once the SUBSCRIBE frame has actually reached the
// wire, so publishing immediately after is safe -- no artificial delay
// needed here.
await session.publish(topic, { message: "hello mesh" });
await received;

await stop();
await session.close(identity);
identity.dispose();
console.log("OK");
