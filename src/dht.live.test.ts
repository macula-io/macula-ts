import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import { DhtRecordType, type DhtRecord } from "./dht.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = "station-de-frankfurt.macula.io";
const STATION_PORT = 4433;

const HEX32 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{128}$/;

// A fresh, unlikely-to-collide procedure name per test run, matching
// rpc.live.test.ts's own convention -- the shared demo fleet has other
// traffic on it.
function uniqueProcedure(label: string): string {
  return `io.macula.ts.dht_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

// dht.ProcedureKey (macula-go's dht/record.go): SHA-256 of the
// realm-qualified discovery URI (dht.DiscoveryURI: hex(realm) + "/" +
// procedure). Reimplemented here, INDEPENDENTLY of
// Session.putProcedureAdvertisement()'s own internal use of the exact
// same macula-go functions (cabi/dht.go), purely so this test can
// compute, from outside the SDK, the storage key a
// putProcedureAdvertisement() call below should have landed at --
// production code never needs to do this itself, since
// findRecordsByType() doesn't require knowing a key up front.
function procedureKeyHex(realm32: Uint8Array, procedure: string): string {
  const hexRealm = Buffer.from(realm32).toString("hex");
  const uri = `${hexRealm.toUpperCase()}/${procedure}`;
  return createHash("sha256").update(uri, "utf8").digest("hex");
}

function assertWellFormedRecord(rec: DhtRecord): void {
  expect(rec.key).toMatch(HEX32);
  expect(rec.version).toMatch(HEX16);
  expect(rec.signature).toMatch(HEX64);
  expect(typeof rec.type).toBe("number");
  expect(Number.isFinite(rec.createdAt)).toBe(true);
  expect(Number.isFinite(rec.expiresAt)).toBe(true);
  expect(rec.expiresAt).toBeGreaterThan(rec.createdAt);
  // createdAt should be a real recent-ish wall-clock timestamp (ms since
  // epoch), not a zero/garbage value -- bounded loosely (within the
  // last 30 days .. 1 hour in the future) so this doesn't become flaky
  // against a station with a slightly skewed clock.
  const now = Date.now();
  expect(rec.createdAt).toBeGreaterThan(now - 30 * 24 * 60 * 60 * 1000);
  expect(rec.createdAt).toBeLessThan(now + 60 * 60 * 1000);
}

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session DHT records (live station)", () => {
  it(
    "findRecordsByType(StationEndpoint) against the real fleet returns real, well-formed records",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;
      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);

        const records = await session.findRecordsByType(DhtRecordType.StationEndpoint);

        // The station this session is connected to publishes its own
        // station_endpoint record -- a live production fleet with at
        // least this one station should never come back empty.
        expect(records.length).toBeGreaterThan(0);
        for (const rec of records) {
          expect(rec.type).toBe(DhtRecordType.StationEndpoint);
          assertWellFormedRecord(rec);
          // Proof the payload itself was genuinely parsed (cborToJSON),
          // not just opaquely passed through: a station_endpoint's
          // payload always carries a quic_port field, and it must be a
          // plausible port number, not merely "some property exists".
          expect(rec.payload).not.toBeNull();
          expect(typeof rec.payload).toBe("object");
          const payload = rec.payload as Record<string, unknown>;
          expect(typeof payload.quic_port).toBe("number");
          expect(payload.quic_port as number).toBeGreaterThan(0);
          expect(payload.quic_port as number).toBeLessThanOrEqual(65535);
        }
      } finally {
        if (session) await session.close(id, "dht.live.test.ts done (find_records_by_type)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "putProcedureAdvertisement() then findRecord()/findRecords() by its own storage key round-trips the real stored record",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;
      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);
        const stationNodeId = session.stationNodeId;
        const procedure = uniqueProcedure("advertise_roundtrip");
        const allZeroRealm = new Uint8Array(32);

        const stored = await session.putProcedureAdvertisement(procedure, stationNodeId, { ttlMs: 60_000 });
        assertWellFormedRecord(stored);
        expect(stored.type).toBe(DhtRecordType.ProcedureAdvertisement);
        expect(stored.key).toBe(Buffer.from(id.nodeId).toString("hex"));

        const key = procedureKeyHex(allZeroRealm, procedure);
        const keyBytes = Buffer.from(key, "hex");
        expect(keyBytes.length).toBe(32);

        // findRecord: exactly the one record just stored comes back --
        // not a stub, not an empty/null default. A station can take a
        // moment to make a just-published record visible to a
        // find_record on the same connection, so this polls briefly
        // rather than asserting on the very first attempt.
        let found: DhtRecord | null = null;
        const deadline = Date.now() + 10_000;
        while (found === null && Date.now() < deadline) {
          found = await session.findRecord(keyBytes);
          if (found === null) await new Promise((r) => setTimeout(r, 500));
        }
        expect(found).not.toBeNull();
        const rec = found as DhtRecord;
        assertWellFormedRecord(rec);
        expect(rec.type).toBe(DhtRecordType.ProcedureAdvertisement);
        expect(rec.key).toBe(stored.key);
        expect(rec.version).toBe(stored.version);
        expect(rec.signature).toBe(stored.signature);
        // The payload's own procedure_uri field, decoded, must be the
        // exact realm-qualified URI this test's own procedure name
        // produces -- proof the payload was genuinely round-tripped
        // through cborToJSON, not just echoed back opaquely.
        const payload = rec.payload as Record<string, unknown>;
        expect(payload.procedure_uri).toBe(`${Buffer.from(allZeroRealm).toString("hex").toUpperCase()}/${procedure}`);

        // findRecords: the same record, found via the full (possibly
        // multi-entry) signer-deduped multiset at this key.
        const all = await session.findRecords(keyBytes);
        expect(all.length).toBeGreaterThan(0);
        expect(all.some((r) => r.version === stored.version && r.signature === stored.signature)).toBe(true);
      } finally {
        if (session) await session.close(id, "dht.live.test.ts done (put/find roundtrip)");
        id.dispose();
      }
    },
    40000,
  );

  it("findRecord() for a storage key nothing was ever put at resolves null, not a hang or a thrown error", async () => {
    const id = Identity.generate();
    let session: Session | undefined;
    try {
      session = await Session.connect(STATION_HOST, STATION_PORT, id);
      // A key derived from a procedure name guaranteed unique to this
      // run and never advertised by anything.
      const neverPut = procedureKeyHex(new Uint8Array(32), uniqueProcedure("nobody_ever_put_this"));
      const result = await session.findRecord(Buffer.from(neverPut, "hex"));
      expect(result).toBeNull();
    } finally {
      if (session) await session.close(id, "dht.live.test.ts done (not-found case)");
      id.dispose();
    }
  }, 20000);
});
