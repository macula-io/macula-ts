// Serves an org procedure until interrupted. The realm must have admitted
// the org and the org delegated its procedures to this node (serving without
// an org comes with the self-named ~<node id>/<name> form, not yet here).
// Run: MACULA_PROCEDURE=acme/echo node examples/02_serve.ts
import { connect, realm } from "./mesh.ts";

const procedure = process.env.MACULA_PROCEDURE ?? "acme/echo";
const pool = await connect();
const served = await pool.serve(realm(), procedure, (request) => {
  console.log("call from", request.caller);
  return request.payload;
});
console.log(`serving ${procedure} as ${pool.nodeId()}; Ctrl-C to stop`);
process.on("SIGINT", async () => {
  await served.stop();
  await pool.close();
  process.exit(0);
});
