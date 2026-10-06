// UCANs (macula 12's D7) over the native addon, against two in-process macula
// 12 stations (test/station.ts): a gated procedure serves only a caller its
// root granted, directly or by delegation, and refuses everyone else before
// the handler runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStations, type TestStations } from "../test/station.js";
import { NodeKey, Pool, ProviderError, StreamError, StreamMode, Ucan, type Capability, type Seed } from "./index.js";

// Starting the stations, and every test here (each dials them), takes seconds
// on a CPU-capped runner (macula-ts#16): explicit timeouts, generous enough for
// one, short enough that a hang still fails.
const STARTING_STATIONS_MS = 60_000;
const DIALS = { timeout: 30_000 };

let env: TestStations;
const seed = (i: number): Seed => ({ host: env.stations[i]!.host, port: env.stations[i]!.port, nodeId: env.stations[i]!.node_id });
const trust = () => [{ realm: env.realmId, key: env.realmKey }];
const caps = (): Capability[] => [{ with: `mri:org:${env.realmName}/${env.org}`, can: "invoke" }];
const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 300;

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
}, STARTING_STATIONS_MS);
afterAll(() => env.stop());

describe("a gated procedure", DIALS, () => {
  it("serves only a caller its root granted, directly or by delegation", async () => {
    const root = await NodeKey.generate("pq_pure");
    const alice = await NodeKey.generate("pq_pure");
    const provider = await node(0, true);
    const procedure = `${env.org}/gated`;
    let entered = 0;
    const served = await provider.serve(env.realmId, procedure, (r) => {
      entered++;
      return { served: r.caller };
    }, { policy: Ucan.ucanRequired(root.nodeIdHex()) });
    const caller = await node(1);
    const exp = inFiveMinutes();
    await eventually("the gated provider is advertised",
      async () => (await caller.providers(env.realmId, procedure)).length > 0);

    const refused: Array<[string, string | undefined, string[]]> = [
      ["no token", undefined, []],
      ["a token for another node", await root.ucan(alice.nodeIdHex(), caps(), exp), []],
      ["a token from another root", await alice.ucan(caller.nodeId(), caps(), exp), []],
    ];
    for (const [name, ucan, proofs] of refused) {
      const call = caller.call(env.realmId, procedure, {}, { ucan, proofs });
      await expect(call, name).rejects.toBeInstanceOf(ProviderError);
      await expect(call, name).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect(entered).toBe(0);

    const granted = await root.ucan(caller.nodeId(), caps(), exp);
    expect(await caller.call(env.realmId, procedure, {}, { ucan: granted })).toEqual({ served: caller.nodeId() });
    const toAlice = await root.ucan(alice.nodeIdHex(), caps(), exp);
    const delegated = await alice.ucan(caller.nodeId(), caps(), exp, { prf: [Ucan.proofId(toAlice)] });
    expect(await caller.call(env.realmId, procedure, {}, { ucan: delegated, proofs: [toAlice] }))
      .toEqual({ served: caller.nodeId() });
    const reported = await caller.callReport(env.realmId, procedure, {}, { ucan: granted });
    expect(reported.result).toEqual({ served: caller.nodeId() });
    expect(entered).toBe(3);

    await served.stop();
    await provider.close();
    await caller.close();
    root.free();
    alice.free();
    }, 30_000);

  it("opens a gated stream only for a caller its root granted", async () => {
    const root = await NodeKey.generate("pq_pure");
    const provider = await node(0, true);
    const procedure = `${env.org}/gated_stream`;
    let entered = 0;
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Server, async (s) => {
      entered++;
      await s.sendValue({ served: 1 });
    }, { policy: Ucan.ucanRequired(root.nodeId()) });
    const caller = await node(1);
    await eventually("the gated stream is advertised",
      async () => (await caller.providers(env.realmId, procedure)).length > 0);

    const refused = await caller.openStream(env.realmId, procedure, StreamMode.Server);
    const refusal = refused.recv();
    await expect(refusal).rejects.toBeInstanceOf(StreamError);
    await expect(refusal).rejects.toMatchObject({ code: "unauthorized" });
    await refused.free();
    expect(entered).toBe(0);

    const granted = await root.ucan(caller.nodeId(), caps(), inFiveMinutes());
    const stream = await caller.openStream(env.realmId, procedure, StreamMode.Server, {}, { ucan: granted });
    expect(await stream.recv()).toMatchObject({ kind: "data", body: { served: 1 } });
    await stream.free();
    expect(entered).toBe(1);

    await served.stop();
    await provider.close();
    await caller.close();
    root.free();
  });
});

describe("what never reaches the wire", DIALS, () => {
  it("refuses an empty UCAN, and proofs with no UCAN to prove", async () => {
    const caller = await node(0);
    await expect(caller.call(env.realmId, `${env.org}/echo`, {}, { ucan: "" })).rejects.toThrow(/never empty/);
    await expect(caller.call(env.realmId, `${env.org}/echo`, {}, { proofs: ["x"] })).rejects.toThrow(/proofs go with/);
    expect(() => Ucan.proofId("")).toThrow(/never empty/);
    await caller.close();
  });

  it("takes a policy's ids as any id is taken, and refuses a member policy with no can", () => {
    const id = "ab".repeat(32);
    expect(Ucan.realmMemberRequired(id.toUpperCase(), "call")).toEqual({ kind: "realm_member_required", key_id: id, can: "call" });
    expect(Ucan.ucanRequired(Uint8Array.from(Buffer.from(id, "hex")))).toEqual({ kind: "ucan_required", issuer: id });
    expect(() => Ucan.realmMemberRequired("abcd", "call")).toThrow();
    expect(() => Ucan.realmMemberRequired(id, "")).toThrow(/names a can/);
  });

  it("refuses an expiry or not-before that is not whole Unix seconds, rather than minting without it", async () => {
    const root = await NodeKey.generate("pq_pure");
    for (const bad of [NaN, Infinity, 1.5]) {
      await expect(root.ucan(root.nodeId(), caps(), inFiveMinutes(), { nbf: bad })).rejects.toThrow(/whole Unix seconds/);
      await expect(root.ucan(root.nodeId(), caps(), bad)).rejects.toThrow(/whole Unix seconds/);
    }
    root.free();
  });

  it("names a parent by the lowercase hex SHA-384 of its text", async () => {
    const root = await NodeKey.generate("pq_pure");
    const token = await root.ucan(root.nodeId(), caps(), inFiveMinutes());
    const { createHash } = await import("node:crypto");
    expect(Ucan.proofId(token)).toBe(createHash("sha384").update(token).digest("hex"));
    root.free();
  });
});
