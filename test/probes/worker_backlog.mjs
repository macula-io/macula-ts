// A worker is terminated while deliveries are queued for its listener (its
// callback holds its loop on the first event while the rest queue): the
// process must survive, and keep working.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const topic = "mcl-ts/tests/backlog_heard_v1";
const { NodeKey, Pool } = await import(new URL("../../dist/index.js", import.meta.url).href);

if (isMainThread) {
  const [host, port, nodeId, realm] = process.argv.slice(2);
  const seed = { host, port: Number(port), nodeId };
  const publisher = await Pool.connect(await NodeKey.generate("pq_pure"), [seed]);
  const worker = new Worker(new URL(import.meta.url), { workerData: { seed, realm } });
  await new Promise((resolve) => worker.on("message", (m) => m === "subscribed" && resolve()));
  await Promise.all(Array.from({ length: 40 }, (_, i) => publisher.publish(realm, topic, i)));
  await new Promise((r) => setTimeout(r, 1000));
  await worker.terminate();
  for (let i = 0; i < 50; i++) await publisher.publish(realm, topic, i);
  await new Promise((r) => setTimeout(r, 300));
  await publisher.close();
  console.log("backlog teardown survived");
} else {
  const pool = await Pool.connect(await NodeKey.generate("pq_pure"), [workerData.seed]);
  let first = true;
  await pool.subscribe(workerData.realm, topic, () => {
    if (first) {
      first = false;
      const until = Date.now() + 5000;
      while (Date.now() < until) { /* hold the loop */ }
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  parentPort.postMessage("subscribed");
  await new Promise(() => {});
}
