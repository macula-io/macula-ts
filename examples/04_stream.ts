// Serves a server stream and reads it from a second node: three chunks, then
// the end. Like 02_serve.ts, serving needs an org the realm admitted and its
// delegation to the serving node (key file MACULA_KEY).
// Run: MACULA_PROCEDURE=acme/watch node examples/04_stream.ts
import { StreamMode } from "../dist/index.js";
import { connect, realm } from "./mesh.ts";

const procedure = process.env.MACULA_PROCEDURE ?? "acme/watch";
const provider = await connect();
const served = await provider.serveStream(realm(), procedure, StreamMode.Server, async (stream) => {
  for (const chunk of ["one", "two", "three"]) await stream.send(new TextEncoder().encode(chunk));
});
const caller = await connect("caller.key");
const stream = await caller.openStream(realm(), procedure, StreamMode.Server);
for await (const event of stream) {
  if (event.kind === "data") console.log("chunk", event.body);
  if (event.kind === "end") break;
}
await stream.free();
await served.stop();
await provider.close();
await caller.close();
