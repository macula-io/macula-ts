// Sealed groups (macula 13.2, macula-go v0.27.0-rc.3) through the TypeScript
// API, against the in-process stations (test/station.ts): a stand-in for the
// org's distributor (macula's macula_group_keys) serves group_keys_v1 sealed,
// a member publishes under the group and another opens the event, a plain
// subscription gets it unopened, and refusals come back as GroupError.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStations, type TestStations } from "../test/station.js";
import { GroupError, NodeKey, Pool, type Event, type Seed } from "./index.js";

const STARTING_STATIONS_MS = 60_000;
const DIALS = { timeout: 60_000 };

let env: TestStations;
const seed = (i: number): Seed => ({ host: env.stations[i]!.host, port: env.stations[i]!.port, nodeId: env.stations[i]!.node_id });
const trust = () => [{ realm: env.realmId, key: env.realmKey }];

async function node(kemAdvertise: 0 | 1 = 0, admitted = false): Promise<Pool> {
  const key = await NodeKey.generate("pq_pure");
  if (admitted) await env.admit(key.nodeIdHex());
  // One station: the test stations relay no publication between them.
  return Pool.connect(key, [seed(0)], { realmTrust: trust(), kemAdvertise });
}

const bytes = (fill: number, length: number) => ({ $bytes: Buffer.alloc(length, fill).toString("base64") });

beforeAll(async () => {
  env = await startStations();
}, STARTING_STATIONS_MS);
afterAll(() => env.stop());

describe("a sealed group", DIALS, () => {
  it("carries a member's event sealed, opened under the group and unopened outside it", async () => {
    const distributor = await node(1, true);
    const now = Date.now();
    const epoch = { id: bytes(0x71, 8), key: bytes(0x72, 32), issued_at: now - 1_000,
      publish_until: now - 1_000 + 15 * 60_000, accept_until: now - 1_000 + 15 * 60_000 + 65 * 60_000 };
    const served = await distributor.serve(env.realmId, `${env.org}/group_keys_v1`,
      (r) => ({ prefix: (r.payload as { prefix: string }).prefix, policy: "required", epochs: [epoch] }),
      { confidential: "required" });
    const group = { prefix: `${env.realmName}/${env.org}/chat` };
    const topic = `${group.prefix}/said_v1`;
    const publisher = await node();
    const reader = await node();
    const outsider = await node();

    const opened: Event[] = [];
    const unopened: Event[] = [];
    let sub = null;
    for (let i = 0; sub === null && i < 100; i++) {
      sub = await reader.subscribeGroup(env.realmId, topic, group, (e) => opened.push(e)).catch((e) => {
        if (e instanceof GroupError && e.reason === "no_distributor") return null;
        throw e;
      });
      if (sub === null) await new Promise((r) => setTimeout(r, 200));
    }
    expect(sub).not.toBeNull();
    const plain = await outsider.subscribe(env.realmId, topic, (e) => unopened.push(e));
    await new Promise((r) => setTimeout(r, 500));

    await publisher.publishGroup(env.realmId, topic, { text: "hello" }, group);
    for (let i = 0; (opened.length === 0 || unopened.length === 0) && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    expect(opened[0]).toMatchObject({ topic, sealed: 1, sealKeyId: "7171717171717171", payload: { text: "hello" } });
    expect(opened[0]!.unopened).toBeUndefined();
    expect(unopened[0]).toMatchObject({ sealed: 1, unopened: "no_group", payload: null });

    const held = await publisher.publish(env.realmId, topic, "clear").catch((e) => e);
    expect(held).toBeInstanceOf(GroupError);
    expect(held).toMatchObject({ kind: "group", reason: "group_held", prefix: group.prefix });

    await sub!.stop();
    await plain.stop();
    await served.stop();
    for (const p of [distributor, publisher, reader, outsider]) await p.close();
  });

  it("refuses a prefix that cannot be a group, before anything is sent", async () => {
    const lone = await node();
    const refused = await lone.subscribeGroup(env.realmId, "x/y/said_v1", { prefix: "x/z" }, () => {}).catch((e) => e);
    expect(refused).toMatchObject({ kind: "invalid_argument" });
    await lone.close();
  });
});
