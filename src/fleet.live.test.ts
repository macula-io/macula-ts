// A live run against one macula 12 station (test/live_station.ts): the pool
// connects pinned, reads the DHT, calls mcl-echo/echo by direct dial, and
// hears its own publication. Runs only with MACULA_TS_LIVE set (npm run
// test:live); it puts nothing in the DHT, and publishes once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveStation } from "../test/live_station.js";
import { NodeKey, Pool, RecordType } from "./index.js";

describe.skipIf(!process.env.MACULA_TS_LIVE)("a live macula 12 station", () => {
  let pool: Pool;
  const live = process.env.MACULA_TS_LIVE ? liveStation() : undefined;

  beforeAll(async () => {
    const key = await NodeKey.generate("pq_hybrid");
    pool = await Pool.connect(key, [{ host: live!.host, port: live!.port, nodeId: live!.nodeId }], {
      realmTrust: [{ realm: live!.realm, key: live!.realmKey }],
    });
  }, 60_000);
  afterAll(async () => pool?.close());

  it("holds verified node records", async () => {
    const { records } = await pool.findRecordsByType(RecordType.NodeRecord);
    expect(records.length).toBeGreaterThan(0);
  }, 30_000);

  it("reaches mcl-echo/echo by direct dial", async () => {
    expect(await pool.call(live!.realm, "mcl-echo/echo", "hello", { timeoutMs: 15_000 })).toBe("hello");
  }, 30_000);

  it("hears its own publication", async () => {
    const heard: string[] = [];
    const topic = "mcl-ts/live/check/publication_heard_v1";
    const sub = await pool.subscribe(live!.realm, topic, (e) => heard.push(String(e.payload)));
    await new Promise((r) => setTimeout(r, 300));
    await pool.publish(live!.realm, topic, "heard");
    const deadline = Date.now() + 10_000;
    while (heard.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await sub.stop();
    expect(heard).toEqual(["heard"]);
  }, 30_000);
});
