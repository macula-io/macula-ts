// Subscribes to a topic, publishes one message, and prints it as heard.
// Topics name a kind of fact; ids go in the payload.
import { connect, realm } from "./mesh.ts";

const topic = "acme/demo/greeting_sent_v1";
const pool = await connect();
const sub = await pool.subscribe(realm(), topic, (e) => console.log("heard", e.payload, "from", e.publisher));
await new Promise((r) => setTimeout(r, 300));
await pool.publish(realm(), topic, { text: "hello" });
await new Promise((r) => setTimeout(r, 2_000));
await sub.stop();
await pool.close();
