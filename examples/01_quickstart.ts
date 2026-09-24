// Connects to a macula 12 station and calls mcl-echo/echo, which runs on
// another station: the pool finds its trusted advertisement in the DHT and
// dials the station it serves from. Run: npm run build && node
// examples/01_quickstart.ts (with the environment examples/mesh.ts reads).
import { connect, realm } from "./mesh.ts";

const pool = await connect();
console.log("node", pool.nodeId());
console.log("providers", await pool.providers(realm(), "mcl-echo/echo"));
console.log("mcl-echo/echo answered", await pool.call(realm(), "mcl-echo/echo", "hello"));
await pool.close();
