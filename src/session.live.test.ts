import { beforeEach, describe, it, expect } from "vitest";
import { liveStationHost, requireLiveStation } from "../test/live_station.js";
import { Identity } from "./identity.js";
import { Session } from "./session.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live. Never part of
// default `npm test`/CI, since it depends on a real station being
// reachable -- matching macula-rust's #[ignore] and macula-dotnet's
// [Trait("Category","Live")] convention for the same kind of test. The
// station comes from MACULA_TS_LIVE_STATION, with no default: with
// MACULA_TS_LIVE set, a station that isn't set, or that no session can be
// opened to, fails the tests, naming the variable (test/live_station.ts).
const STATION_HOST = liveStationHost("MACULA_TS_LIVE_STATION");
const STATION_PORT = 4433;

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session (live station)", () => {
  beforeEach(() => requireLiveStation("MACULA_TS_LIVE_STATION"), 45_000);
  it("connect() completes a real CONNECT/HELLO handshake against the production fleet", async () => {
    const id = Identity.generate();
    let session: Session | undefined;
    try {
      session = await Session.connect(STATION_HOST, STATION_PORT, id);

      // The one concrete, falsifiable claim this test exists to prove:
      // a stub could return a fake handle and a fake remoteAddr, but
      // it could not produce a real station NodeID that only exists
      // because frame.Verify checked a live Ed25519 signature over an
      // actual HELLO frame the real station sent back.
      expect(session.stationNodeId.length).toBe(32);
      expect(session.stationNodeId.some((b) => b !== 0)).toBe(true);
      expect(session.remoteAddr.length).toBeGreaterThan(0);
    } finally {
      if (session) await session.close(id, "session.live.test.ts done");
      id.dispose();
    }
  }, 35000);

  it("using a session's accessors after close() throws instead of touching a freed handle", async () => {
    const id = Identity.generate();
    const session = await Session.connect(STATION_HOST, STATION_PORT, id);
    await session.close(id);
    try {
      expect(() => session.remoteAddr).toThrow(/used after close/);
      expect(() => session.stationNodeId).toThrow(/used after close/);
    } finally {
      id.dispose();
    }
  }, 35000);

  it("close() is safe to call more than once", async () => {
    const id = Identity.generate();
    const session = await Session.connect(STATION_HOST, STATION_PORT, id);
    try {
      await session.close(id);
      await expect(session.close(id)).resolves.toBeUndefined();
    } finally {
      id.dispose();
    }
  }, 35000);
});
