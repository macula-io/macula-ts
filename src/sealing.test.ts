// Sealing (macula 13's E2E seal scheme 1, macula-go v0.18.0) through the
// TypeScript API, against two in-process stations (test/station.ts): a
// provider that names its KEM key is called sealed, one that names none in the
// clear, and what cannot be kept confidential fails as a ConfidentialityError.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStations, type TestStations } from "../test/station.js";
import { native } from "./binding.js";
import { ConfidentialityError, MaculaError, NodeKey, Pool, StreamMode, type Seed } from "./index.js";

let env: TestStations;
const seed = (i: number): Seed => ({ host: env.stations[i]!.host, port: env.stations[i]!.port, nodeId: env.stations[i]!.node_id });

async function node(station: number, kemAdvertise: 0 | 1 = 0): Promise<Pool> {
  return Pool.connect(await NodeKey.generate("pq_pure"), [seed(station)], { kemAdvertise });
}

beforeAll(async () => {
  env = await startStations();
});
afterAll(() => env.stop());

describe("a sealed call", () => {
  it("reaches a provider that names its key, from another station, sealed required and by default", async () => {
    const provider = await node(0, 1);
    const procedure = provider.ownProcedure("sealed_echo");
    const served = await provider.serve(env.realmId, procedure, (r) => ({ echoed: r.payload, sealed: r.sealed }),
      { confidential: "required" });
    const caller = await node(1);
    expect(await caller.call(env.realmId, procedure, { word: "hush" }, { confidential: "required" }))
      .toEqual({ echoed: { word: "hush" }, sealed: 1 });
    expect(await caller.call(env.realmId, procedure, { word: "again" }))
      .toEqual({ echoed: { word: "again" }, sealed: 1 });
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("goes to the provider pinned, alongside confidential", async () => {
    const provider = await node(0, 1);
    const other = await node(0, 1);
    const procedure = provider.ownProcedure("pinned");
    const served = await provider.serve(env.realmId, procedure, () => provider.nodeId());
    const caller = await node(1);
    expect(await caller.call(env.realmId, procedure, {}, { provider: provider.nodeId(), confidential: "required" }))
      .toBe(provider.nodeId());
    const nobody = await caller.call(env.realmId, procedure, {}, { provider: other.nodeId() }).catch((e) => e);
    expect(nobody).toBeInstanceOf(MaculaError);
    expect(nobody.kind).toBe("no_provider");
    await served.stop();
    await provider.close();
    await other.close();
    await caller.close();
  });

  it("goes in the clear by default to a provider that names no key, and required refuses it", async () => {
    const provider = await node(0);
    const procedure = provider.ownProcedure("clear_echo");
    const served = await provider.serve(env.realmId, procedure, (r) => ({ sealed: r.sealed }));
    const caller = await node(1);
    expect(await caller.call(env.realmId, procedure, {})).toEqual({ sealed: 0 });
    const refused = await caller.call(env.realmId, procedure, {}, { confidential: "required" }).catch((e) => e);
    expect(refused).toBeInstanceOf(ConfidentialityError);
    expect(refused).toMatchObject({ kind: "confidentiality", reason: "no_kem_key", named: null, found: null });
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("is refused off on the caller's side, which only an advertisement naming no key decides", async () => {
    const caller = await node(1);
    const off = await caller.call(env.realmId, caller.ownProcedure("x"), {},
      { confidential: "off" as unknown as "required" }).catch((e) => e);
    expect(off).toBeInstanceOf(MaculaError);
    expect(off.kind).toBe("invalid_argument");
    await caller.close();
  });
});

describe("serving confidentially", () => {
  it("required needs kemAdvertise, and says so", async () => {
    const provider = await node(0);
    const refused = await provider.serve(env.realmId, provider.ownProcedure("x"), () => 1, { confidential: "required" })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(ConfidentialityError);
    expect(refused.reason).toBe("kem_advertise_disabled");
    await provider.close();
  });

  it("off serves in the clear even from a node that names its key", async () => {
    const provider = await node(0, 1);
    const procedure = provider.ownProcedure("off_echo");
    const served = await provider.serve(env.realmId, procedure, (r) => ({ sealed: r.sealed }), { confidential: "off" });
    const caller = await node(1);
    expect(await caller.call(env.realmId, procedure, {})).toEqual({ sealed: 0 });
    await served.stop();
    await provider.close();
    await caller.close();
  });
});

describe("a sealed stream", () => {
  it("opens sealed to a provider that names its key, and its session says so", async () => {
    const provider = await node(0, 1);
    const procedure = provider.ownProcedure("sealed_count");
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Client, async (s, request) => {
      let total = 0;
      for await (const event of s) {
        if (event.kind === "data") total += (event.body as string).length / 2 - 1;
        if (event.kind === "end") break;
      }
      await s.reply({ total, sealed: request.sealed });
    }, { confidential: "required" });
    const caller = await node(1);
    const stream = await caller.openStream(env.realmId, procedure, StreamMode.Client, {}, { confidential: "required" });
    for (const chunk of ["ab", "cde"]) await stream.send(new TextEncoder().encode(chunk));
    await stream.closeSend();
    expect(await stream.recv({ timeoutMs: 5_000 })).toEqual({ kind: "reply", payload: { total: 5, sealed: 1 } });
    await stream.free();
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("required will not open one to a provider that names no key", async () => {
    const provider = await node(0);
    const procedure = provider.ownProcedure("clear_watch");
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Server, async () => {});
    const caller = await node(1);
    const refused = await caller.openStream(env.realmId, procedure, StreamMode.Server, {}, { confidential: "required" })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(ConfidentialityError);
    expect(refused.reason).toBe("no_kem_key");
    await served.stop();
    await provider.close();
    await caller.close();
  });
});

describe("the addon underneath", () => {
  it("refuses options that are not a JSON string, rather than reading them as none", async () => {
    const caller = await node(1);
    const pool = (caller as unknown as { handle: bigint }).handle;
    const realm = Buffer.from(env.realmId, "hex");
    const wrong = new Uint8Array(32) as unknown as string;
    expect(() => native.poolCall(pool, realm, "x", "{}", wrong, 1_000)).toThrow(TypeError);
    expect(() => native.poolOpenStream(pool, realm, "x", StreamMode.Server, "{}", wrong, 0, 1_000)).toThrow(TypeError);
    expect(() => native.poolServe(pool, realm, "x", wrong, () => {})).toThrow(TypeError);
    expect(() => native.poolServeStream(pool, realm, "x", StreamMode.Server, wrong, () => {})).toThrow(TypeError);
    await caller.close();
  });
});

// The caller's seal report (macula's DESIGN_E2E_SEAL_REPORT, macula-go v0.19.0):
// that the exchange behind a result was sealed, to which provider and key.
describe("the seal report", () => {
  it("says a call to a provider that names its key went sealed, to that provider and key", async () => {
    const provider = await node(0, 1);
    const procedure = provider.ownProcedure("reported");
    const served = await provider.serve(env.realmId, procedure, (r) => ({ echoed: r.payload }));
    const caller = await node(1);
    const { result, report } = await caller.callReport(env.realmId, procedure, { word: "hush" });
    expect(result).toEqual({ echoed: { word: "hush" } });
    expect(report.sealed).toBe(1);
    expect(report.provider).toBe(provider.nodeId());
    expect(report.sealKeyId).toMatch(/^[0-9a-f]{16}$/);
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("says a call to a provider that names no key went in the clear, with no key id", async () => {
    const provider = await node(0);
    const procedure = provider.ownProcedure("reported_clear");
    const served = await provider.serve(env.realmId, procedure, () => 1);
    const caller = await node(1);
    const { result, report } = await caller.callReport(env.realmId, procedure, {});
    expect(result).toBe(1);
    expect(report).toStrictEqual({ sealed: 0, provider: provider.nodeId() });
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("settles a stream's report on the provider's first chunk, keeps it after the end, and gives the provider none", async () => {
    const provider = await node(0, 1);
    const procedure = provider.ownProcedure("reported_watch");
    let providerSide: unknown = null;
    // The provider holds its chunk until the caller has seen the report
    // unsettled, so the order is by construction, not by a timer.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Server, async (s) => {
      providerSide = (() => { try { return s.report(); } catch (e) { return e; } })();
      await released;
      await s.send(new TextEncoder().encode("one"));
    }, { confidential: "required" });
    const caller = await node(1);
    const stream = await caller.openStream(env.realmId, procedure, StreamMode.Server, {}, { confidential: "required" });
    const early = (() => { try { return stream.report(); } catch (e) { return e; } })();
    expect(early).toBeInstanceOf(MaculaError);
    expect((early as MaculaError).kind).toBe("not_settled");
    release();
    expect((await stream.recv({ timeoutMs: 5_000 }))?.kind).toBe("data");
    const settled = stream.report();
    expect(settled.sealed).toBe(1);
    expect(settled.provider).toBe(provider.nodeId());
    expect(settled.sealKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect((await stream.recv({ timeoutMs: 5_000 }))?.kind).toBe("end");
    expect(stream.report()).toStrictEqual(settled);
    expect(providerSide).toBeInstanceOf(MaculaError);
    expect((providerSide as MaculaError).kind).toBe("not_a_caller");
    await stream.free();
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("has none for a sealed stream the provider ends before any chunk or reply", async () => {
    const provider = await node(0, 1);
    const procedure = provider.ownProcedure("ended_unsettled");
    const served = await provider.serveStream(env.realmId, procedure, StreamMode.Server, async () => {},
      { confidential: "required" });
    const caller = await node(1);
    const stream = await caller.openStream(env.realmId, procedure, StreamMode.Server, {}, { confidential: "required" });
    expect((await stream.recv({ timeoutMs: 5_000 }))?.kind).toBe("end");
    const none = (() => { try { return stream.report(); } catch (e) { return e; } })();
    expect(none).toBeInstanceOf(MaculaError);
    expect((none as MaculaError).kind).toBe("not_settled");
    await stream.free();
    await served.stop();
    await provider.close();
    await caller.close();
  });

  it("is refused as an option on openStream, where a stream reports through report()", async () => {
    const caller = await node(1);
    const refused = await caller.openStream(env.realmId, caller.ownProcedure("x"), StreamMode.Server, {},
      { report: 1 } as never).catch((e) => e);
    expect(refused).toBeInstanceOf(MaculaError);
    expect(refused.kind).toBe("invalid_argument");
    await caller.close();
  });
});
