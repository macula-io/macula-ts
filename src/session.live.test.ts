import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { Session } from "./session.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live. Never part of
// default `npm test`/CI, since it depends on a real production
// station being reachable -- matching macula-rust's #[ignore] and
// macula-dotnet's [Trait("Category","Live")] convention for the same
// kind of test. Host/port taken from those two SDKs' own committed
// live-station suites, which already proved this station+port+trust
// combination works.
const STATION_HOST = "station-de-frankfurt.macula.io";
const STATION_PORT = 4433;

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session (live station)", () => {
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
