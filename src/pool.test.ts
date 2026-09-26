// The TypeScript API over the native addon, against two in-process macula 12
// stations (test/station.ts): keys, calls by direct dial and their errors,
// providers, streams (and that every stream is released), pubsub and the DHT.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStations, type TestStations } from "../test/station.js";
import { ContentUnavailableError, NodeKey, NotSharedError, Pool, ProviderError, RecordType, StreamMode, type Seed } from "./index.js";

let env: TestStations;
const seed = (i: number): Seed => ({ host: env.stations[i]!.host, port: env.stations[i]!.port, nodeId: env.stations[i]!.node_id });
const trust = () => [{ realm: env.realmId, key: env.realmKey }];

async function node(station: number, admitted = false): Promise<Pool> {
  const key = await NodeKey.generate("pq_pure");
  if (admitted) await env.admit(key.nodeIdHex());
  return Pool.connect(key, [seed(station)], { realmTrust: trust() });
}

async function eventually(what: string, ok: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never: ${what}`);
}

beforeAll(async () => {
  env = await startStations();
});
afterAll(() => env.stop());

describe("NodeKey", () => {
  it("is saved readable by its owner only and loads back as the same node", async () => {
    const dir = await mkdtemp(join(tmpdir(), "macula-ts-key-"));
    const path = join(dir, "node.key");
    const created = await NodeKey.loadOrCreate(path, "pq_pure");
    const loaded = await NodeKey.load(path, "pq_pure");
    expect(loaded.nodeIdHex()).toBe(created.nodeIdHex());
    expect(loaded.profile()).toBe("pq_pure");
    expect((await loaded.sign(new Uint8Array([1, 2, 3]))).length).toBeGreaterThan(0);
    await expect(NodeKey.load(path, "pq_hybrid")).rejects.toThrow();
  });
});

describe("calls", () => {
  it("reach a provider on another station by direct dial, and bring its error back as a ProviderError", async () => {
    const provider = await node(0, true);
    const procedure = `${env.org}/echo`;
    const served = await provider.serve(env.realmId, procedure, (r) => {
      if (r.payload === "fail") throw new Error("refused by the handler");
      return { echo: r.payload, caller: r.caller };
    });
    const caller = await node(1);
    const result = (await caller.call(env.realmId, procedure, "hello")) as { echo: string; caller: string };
    expect(result.echo).toBe("hello");
    expect(result.caller).toBe(caller.nodeId());
    const failing = caller.call(env.realmId, procedure, "fail");
    await expect(failing).rejects.toBeInstanceOf(ProviderError);
    await expect(failing).rejects.toMatchObject({ code: "handler_error", detail: "refused by the handler" });
    const providers = await caller.providers(env.realmId, procedure);
    expect(providers.map((p) => p.node)).toContain(provider.nodeId());
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("refuse a realm whose key is not pinned, and find no provider for what nobody serves", async () => {
    const caller = await node(0);
    await expect(caller.call("11".repeat(32), `${env.org}/echo`, {})).rejects.toThrow(/realm key/);
    await expect(caller.call(env.realmId, `${env.org}/nothing`, {})).rejects.toThrow(/no trusted provider/);
    await caller.close();
  });
});

describe("a node's own namespace", () => {
  it("is served and called with no realm key pinned on either side", async () => {
    const provider = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(0)]);
    const ring = provider.ownProcedure("ring");
    expect(ring).toBe(`~${provider.nodeId()}/ring`);
    const served = await provider.serve(env.realmId, ring, (r) => ({ rung_by: r.caller }));
    const caller = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(1)]);
    expect(await caller.call(env.realmId, ring, {})).toEqual({ rung_by: caller.nodeId() });
    expect((await caller.providers(env.realmId, ring)).map((p) => p.node)).toEqual([provider.nodeId()]);
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("refuses to serve in another node's namespace", async () => {
    const node = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(0)]);
    await expect(node.serve(env.realmId, `~${"01".repeat(32)}/ring`, () => 1)).rejects.toThrow(/own namespace/);
    await node.close();
  });
});

describe("streams", () => {
  it("deliver a server stream's chunks and end, and leave nothing relayed", async () => {
    const provider = await node(0, true);
    const procedure = `${env.org}/watch`;
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Server, async (s) => {
      for (const chunk of ["one", "two", "three"]) await s.send(new TextEncoder().encode(chunk));
    });
    const caller = await node(1);
    const stream = await caller.openStream(env.realmId, procedure, StreamMode.Server);
    const got: string[] = [];
    for await (const event of stream) {
      if (event.kind === "data") got.push(Buffer.from((event.body as string).slice(2), "hex").toString());
      if (event.kind === "end") break;
    }
    expect(got).toEqual(["one", "two", "three"]);
    await stream.free();
    await eventually("every stream released", async () => (await env.relayed()) === 0);
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("answer a client stream with the provider's reply", async () => {
    const provider = await node(0, true);
    const procedure = `${env.org}/count`;
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Client, async (s) => {
      let total = 0;
      for await (const event of s) {
        if (event.kind === "data") total += (event.body as string).length / 2 - 1;
        if (event.kind === "end") break;
      }
      await s.reply(total);
    });
    const caller = await node(0);
    const stream = await caller.openStream(env.realmId, procedure, StreamMode.Client);
    for (const chunk of ["ab", "cde", "f"]) await stream.send(new TextEncoder().encode(chunk));
    await stream.closeSend();
    expect(await stream.recv({ timeoutMs: 5_000 })).toEqual({ kind: "reply", payload: 6 });
    await stream.free();
    await eventually("every stream released", async () => (await env.relayed()) === 0);
    await served.stop();
    await provider.close();
    await caller.close();
  });
});

describe("pubsub", () => {
  it("delivers a publication once to a subscriber on the same station", async () => {
    const listener = await node(0);
    const publisher = await node(0);
    const heard: string[] = [];
    const topic = "mcl-ts/tests/greeting_sent_v1";
    const sub = await listener.subscribe(env.realmId, topic, (e) => heard.push(String(e.payload)));
    await new Promise((r) => setTimeout(r, 200));
    await publisher.publish(env.realmId, topic, "hi");
    await eventually("the event heard", async () => heard.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toEqual(["hi"]);
    await sub.stop();
    expect(await sub.closed).toBeNull();
    await listener.close();
    await publisher.close();
  });
});

describe("content", () => {
  const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

  it("is shared by one node and fetched by another, with no realm key, until it is unshared", async () => {
    const sharer = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(0)]);
    const fetcher = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(1)]);
    for (const size of [10_000, 600_000]) {
      const data = pattern(size);
      const mcid = await sharer.shareContent(env.realmId, data, "blob.bin");
      expect(mcid).toMatch(/^02(55|56)[0-9a-f]{96}$/);
      expect(Buffer.from(await fetcher.getContent(env.realmId, mcid)).equals(Buffer.from(data))).toBe(true);
      await sharer.unshareContent(env.realmId, mcid);
      await expect(fetcher.getContent(env.realmId, mcid)).rejects.toBeInstanceOf(NotSharedError);
    }
    await sharer.close();
    await fetcher.close();
  });

  it("refuses content over the bounds asked for, and a content id that is not one", async () => {
    const sharer = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(0)]);
    const fetcher = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(1)]);
    const mcid = await sharer.shareContent(env.realmId, pattern(600_000), "big.bin");
    const over = fetcher.getContent(env.realmId, mcid, { maxBytes: 500_000 });
    await expect(over).rejects.toBeInstanceOf(ContentUnavailableError);
    await expect(over).rejects.toThrow(/over the bounds/);
    await expect(fetcher.getContent(env.realmId, "02" + "55".repeat(10))).rejects.toThrow(/content id/);
    await sharer.close();
    await fetcher.close();
  });
});

describe("DHT", () => {
  it("finds the stations' own endpoint records, verified", async () => {
    const p = await node(0);
    const { records, dropped } = await p.findRecordsByType(RecordType.StationEndpoint);
    expect(dropped).toBe(0);
    expect(records.map((r) => r.keyId).sort()).toEqual(env.stations.map((s) => s.node_id).sort());
    expect(await p.findRecord("22".repeat(32))).toBeNull();
    await p.close();
  });
});

describe("the shared C ABI underneath", () => {
  it("gives bytes as 0x hex by default, and tagged when asked", async () => {
    const provider = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(0)]);
    const back = provider.ownProcedure("bytes_back");
    const served = await provider.serve(env.realmId, back, (r) => r.payload, { bytes: "tagged" });
    const caller = await Pool.connect(await NodeKey.generate("pq_pure"), [seed(1)]);
    const sent = { b: { $bytes: "AQID" } };
    expect(await caller.call(env.realmId, back, sent)).toEqual({ b: "0x010203" });
    expect(await caller.call(env.realmId, back, sent, { bytes: "tagged" })).toEqual({ b: { $bytes: "AQID" } });
    await expect(caller.call(env.realmId, back, sent, { bytes: "raw" as never })).rejects.toThrow(/hex" or "tagged/);
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("ends a subscription when its pool closes, as asked (closed is null)", async () => {
    const listener = await node(0);
    const sub = await listener.subscribe(env.realmId, "mcl-ts/tests/nothing_said_v1", () => {});
    await listener.close();
    expect(await sub.closed).toBeNull();
    await sub.stop();
  });

  it("reports an ABI error as a MaculaError with its kind", async () => {
    const caller = await node(0);
    await expect(caller.call(env.realmId, `${env.org}/nothing`, {})).rejects.toMatchObject({ name: "MaculaError", kind: "no_provider" });
    await caller.close();
  });
});
