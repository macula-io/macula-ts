// A worker thread subscribes, then is terminated while publications keep
// arriving for it: the process must exit cleanly, with no listener thread
// left calling into the torn-down worker.
import { Worker } from "node:worker_threads";
import { NodeKey, Pool } from "../../dist/index.js";

const [host, port, nodeId, realm] = process.argv.slice(2);
const seed = { host, port: Number(port), nodeId };
const topic = "mcl-ts/tests/teardown_heard_v1";

const worker = new Worker(`
  import { parentPort, workerData } from "node:worker_threads";
  import { NodeKey, Pool } from ${JSON.stringify(new URL("../../dist/index.js", import.meta.url).href)};
  const pool = await Pool.connect(await NodeKey.generate("pq_pure"), [workerData.seed]);
  await pool.subscribe(workerData.realm, workerData.topic, () => {});
  parentPort.postMessage("subscribed");
`, { eval: true, workerData: { seed, realm, topic }, type: "module" });
await new Promise((resolve) => worker.once("message", resolve));
await new Promise((r) => setTimeout(r, 300));
await worker.terminate();

const publisher = await Pool.connect(await NodeKey.generate("pq_pure"), [seed]);
await Promise.all(Array.from({ length: 200 }, (_, i) => publisher.publish(realm, topic, i)));
await new Promise((r) => setTimeout(r, 500));
await publisher.close();
console.log("teardown survived");
