import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import { ContentNotFoundError } from "./content.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = "station-de-frankfurt.macula.io";
const STATION_PORT = 4433;

const MCID_HEX = /^[0-9a-f]{68}$/;

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session content transfer (live station)", () => {
  it(
    "putContent() then getContent() round-trips a real, non-trivial byte buffer byte-for-byte",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);

        // 600 random bytes -- non-trivial, well under manifest.
        // DefaultChunkSize (256 KiB) so this exercises the single-block
        // path; randomized per run so this never collides with content
        // some earlier run already stored under the same content-derived
        // mcid.
        const data = randomBytes(600);

        const { mcid } = await session.putContent(data, "content.live.test.ts round trip");
        expect(mcid).toMatch(MCID_HEX);

        const fetched = await session.getContent(mcid);
        expect(fetched.length).toBe(data.length);
        expect(Buffer.from(fetched).equals(data)).toBe(true);
      } finally {
        if (session) await session.close(id, "content.live.test.ts done (round trip)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "putContent() with no name still round-trips (name is only used on the chunked path)",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);
        const data = randomBytes(256);

        const { mcid } = await session.putContent(data);
        const fetched = await session.getContent(mcid);
        expect(Buffer.from(fetched).equals(data)).toBe(true);
      } finally {
        if (session) await session.close(id, "content.live.test.ts done (no name)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "getContent() of an mcid nothing has ever stored rejects with ContentNotFoundError, not a generic error",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);

        // A well-formed but never-stored mcid: version=1, codec=0x55
        // (raw block), followed by 32 random bytes standing in for a
        // hash that (with overwhelming probability) nothing has ever
        // produced content for.
        const madeUpMcid = Buffer.concat([Buffer.from([0x01, 0x55]), randomBytes(32)]).toString("hex");

        const err = await session.getContent(madeUpMcid).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ContentNotFoundError);
        expect((err as ContentNotFoundError).mcid).toBe(madeUpMcid);
      } finally {
        if (session) await session.close(id, "content.live.test.ts done (not found)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "putContent()/getContent() run on their own dedicated stream: safe alongside an active serve() on the same Session",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;
      let stopServing: (() => Promise<void>) | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);

        // Unlike call()/findRecord()/subscribe(), which all race an
        // active serve() on the SAME Session's shared control stream
        // (see pubsub.live.test.ts's own exclusivity test), content
        // transfer opens its own fresh QUIC stream every time -- so
        // this must NOT throw the same "races on the shared control
        // stream" error those do.
        stopServing = await session.serve(`io.macula.ts.content_live_test.exclusivity.${Date.now()}`, () => null);

        const data = randomBytes(128);
        const { mcid } = await session.putContent(data);
        const fetched = await session.getContent(mcid);
        expect(Buffer.from(fetched).equals(data)).toBe(true);
      } finally {
        if (stopServing) await stopServing();
        if (session) await session.close(id, "content.live.test.ts done (alongside serve)");
        id.dispose();
      }
    },
    30000,
  );
});
