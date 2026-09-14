import { appendFileSync } from "node:fs";
import { beforeEach, describe, it, expect } from "vitest";
import { liveStationHost, requireLiveStation } from "../test/live_station.js";
import { Identity } from "./identity.js";
import { Pool } from "./pool.js";
import { MaculaCallError } from "./rpc.js";
import { Session } from "./session.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live. Never part of default
// `npm test`/CI, same convention as session.live.test.ts -- this depends
// on the real production fleet.
const STATION_HOST = liveStationHost("MACULA_TS_LIVE_STATION");
const OTHER_STATION_HOST = liveStationHost("MACULA_TS_LIVE_OTHER_STATION");
const STATION_PORT = 4433;

function randomTopic(): string {
  return `pool.live.test.${Math.random().toString(16).slice(2)}`;
}

// Records one wait: on the console, and in the file MACULA_TS_LIVE_WAITS names when set, since a
// test run's console output isn't always shown.
function recordWait(line: string): void {
  console.log(line);
  if (process.env.MACULA_TS_LIVE_WAITS) appendFileSync(process.env.MACULA_TS_LIVE_WAITS, `${line}\n`);
}

// How long a test may publish before its subscriber has the event: past the longest registration
// wait measured on a live station (about 300 ms), with a publish every 500 ms. A wait near it is a
// station finding, not a reason to raise it.
const DELIVERY_WAIT_MS = 2000;

// Publishes until the subscriber has the event. SUBSCRIBE is fire-and-forget, so a station can take a
// moment to register it, and an event published before that is not delivered. Publishes again every
// 500 ms until delivered() holds, for up to DELIVERY_WAIT_MS from the first publish. Logs how many
// publishes it took and how long, and returns when the last publish was sent.
async function publishUntilDelivered(label: string, publish: () => Promise<void>, delivered: () => boolean): Promise<number> {
  const start = Date.now();
  let publishes = 0;
  let lastPublishAt = start;
  let nextPublish = start;
  while (!delivered() && Date.now() - start < DELIVERY_WAIT_MS) {
    if (Date.now() >= nextPublish) {
      await publish();
      publishes++;
      lastPublishAt = Date.now();
      nextPublish = lastPublishAt + 500;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const outcome = delivered() ? "delivered" : "not delivered";
  recordWait(`live wait, ${label}: ${outcome} after ${publishes} publish(es), ${Date.now() - start} ms`);
  if (!delivered()) throw new Error(`no event arrived within ${DELIVERY_WAIT_MS}ms of the first publish`);
  return lastPublishAt;
}

describe.skipIf(!process.env.MACULA_TS_LIVE)("Pool (live fleet)", () => {
  beforeEach(() => requireLiveStation("MACULA_TS_LIVE_STATION"), 45_000);
  it("connects to multiple real stations concurrently, all healthy", async () => {
    await requireLiveStation("MACULA_TS_LIVE_OTHER_STATION");
    const id = Identity.generate();
    const pool = await Pool.connect(
      [
        { host: STATION_HOST, port: STATION_PORT },
        { host: OTHER_STATION_HOST, port: STATION_PORT },
      ],
      id,
    );
    try {
      expect(pool.status()).toEqual({ healthyLinks: 2, failedLinks: 0 });
    } finally {
      await pool.close();
    }
  }, 35000);

  it(
    "a real BOLT#4 answer (unknown_next_peer for a procedure nobody serves) does NOT tear down the link that " +
      "answered it -- found in review 2026-09-05: an earlier draft reconnected on every call() error, including " +
      "ones the mesh had already genuinely answered",
    async () => {
      const id = Identity.generate();
      const pool = await Pool.connect([{ host: STATION_HOST, port: STATION_PORT }], id);
      try {
        expect(pool.status().healthyLinks).toBe(1);
        await expect(pool.call(undefined, `pool.live.test.nobody.serves.${Math.random().toString(16).slice(2)}`, {})).rejects.toBeInstanceOf(
          MaculaCallError,
        );
        // The real proof: still healthy immediately after, not "healthy
        // again after a reconnect cycle" -- this link was never torn
        // down in the first place.
        expect(pool.status().healthyLinks).toBe(1);
        // And genuinely still usable on the SAME connection, not a
        // fresh one -- a second call succeeds without any wait.
        await expect(pool.call(undefined, `pool.live.test.nobody.serves.${Math.random().toString(16).slice(2)}`, {})).rejects.toBeInstanceOf(
          MaculaCallError,
        );
        expect(pool.status().healthyLinks).toBe(1);
      } finally {
        await pool.close();
      }
    },
    20000,
  );

  it(
    "a locally-invalid call()/publish() argument (malformed realm) never tears down a healthy control link -- " +
      "found live 2026-09-05: session.call()/session.publish() validate realm before any wire I/O, but an " +
      "earlier draft classified that thrown validation error exactly like a genuine dead-connection error " +
      "and reconnected anyway, over a caller-side argument bug",
    async () => {
      const id = Identity.generate();
      const pool = await Pool.connect([{ host: STATION_HOST, port: STATION_PORT }], id);
      try {
        expect(pool.status().healthyLinks).toBe(1);
        await expect(pool.call("not-a-realm", "some.procedure", {})).rejects.toThrow(/64 hex characters/);
        // The real proof: still healthy immediately after, not "healthy
        // again after a reconnect cycle" -- this link was never touched.
        expect(pool.status().healthyLinks).toBe(1);
        await expect(pool.publish("not-a-realm", "some.topic", {})).rejects.toThrow(/64 hex characters/);
        expect(pool.status().healthyLinks).toBe(1);
      } finally {
        await pool.close();
      }
    },
    20000,
  );

  it(
    "a connection surviving a station going down actually reconnects and becomes usable again -- " +
      "not a mocked retry-logic test: a REAL competing connection under the pool's own control " +
      "identity forces the station's own per-identity dedupe to kick the pool's link, exactly the " +
      "class of disruption this pool exists to recover from",
    async () => {
      const id = Identity.generate();
      const topic = randomTopic();
      // Fast health-check interval so the test doesn't wait on the
      // 10s production default -- proves the same mechanism, just
      // paced for a test rather than a live deployment.
      const pool = await Pool.connect([{ host: STATION_HOST, port: STATION_PORT }], id, { healthCheckIntervalMs: 1500 });
      let intruder: Session | undefined;
      const intruderId = id; // same identity on purpose -- see test name
      try {
        // Baseline: the pool's control link is genuinely usable.
        await pool.publish(undefined, topic, { phase: "before" });
        expect(pool.status().healthyLinks).toBe(1);

        // Force the kick: a second live connection under the SAME
        // identity to the SAME station. macula_station_listener.erl's
        // own per-identity dedupe closes the OLDER of the two -- the
        // pool's own link, since this one dials after it. publish()
        // itself can't be trusted to notice this (fire-and-forget, see
        // pool.ts's own header doc), so this is exactly what the
        // health-check mechanism exists for: give it enough real time
        // to run at least once, detect the dead connection via a
        // failed call() probe, and reconnect.
        intruder = await Session.connect(STATION_HOST, STATION_PORT, intruderId);
        await new Promise((r) => setTimeout(r, 6000));

        expect(pool.status().healthyLinks).toBe(1);
        // The real proof, not just a status flag: the pool is USABLE
        // again, through a genuinely new connection it established on
        // its own.
        await pool.publish(undefined, topic, { phase: "after" });
      } finally {
        if (intruder) await intruder.close(intruderId).catch(() => {});
        await pool.close();
      }
    },
    30000,
  );

  it("subscribe() replays onto a fresh link after its connection is kicked -- events keep arriving, not just the status flag recovering", async () => {
    // A caller-supplied topic identity (subscribe()'s own optional
    // `identity` param, added specifically so this exact scenario is
    // testable against a real station rather than an internal hook):
    // this test holds the same keypair the pool's topic-link uses, so
    // it can force a REAL per-identity kick on that specific link, the
    // same way the reconnect test above does for the control link.
    const topicId = Identity.generate();
    const pubId = Identity.generate();
    const controlId = Identity.generate();
    const topic = randomTopic();
    const pool = await Pool.connect([{ host: STATION_HOST, port: STATION_PORT }], controlId);
    let intruder: Session | undefined;
    let pubSession: Session | undefined;
    try {
      const received: unknown[] = [];
      const unsubscribe = await pool.subscribe(undefined, topic, (evt) => received.push(evt.payload), topicId);
      const sawSeq = (seq: number) => () => received.some((p) => JSON.stringify(p) === JSON.stringify({ seq }));

      pubSession = await Session.connect(STATION_HOST, STATION_PORT, pubId);
      await publishUntilDelivered("pool subscribe", () => pubSession.publish(topic, { seq: 1 }, {}), sawSeq(1));

      // Kick the pool's own topic-subscribe link: a second connection
      // under that SAME identity to the SAME station. This is
      // subscribe()'s own onClosed path (proactive, unlike the control
      // role) -- macula_station_listener.erl's per-identity dedupe
      // closes the older of the two, which is the pool's own link.
      intruder = await Session.connect(STATION_HOST, STATION_PORT, topicId);
      await new Promise((r) => setTimeout(r, 7000)); // kick to land locally + detection + backoff + reconnect + replay

      // The real proof: a FRESH publish, after the kick, is still
      // delivered -- meaning the fresh link the pool respawned was
      // actually re-subscribed to this topic, not just reconnected.
      await publishUntilDelivered("pool replayed subscribe", () => pubSession.publish(topic, { seq: 2 }, {}), sawSeq(2));

      await unsubscribe();
    } finally {
      if (intruder) await intruder.close(topicId).catch(() => {});
      if (pubSession) await pubSession.close(pubId).catch(() => {});
      await pool.close(); // disposes controlId (caller-supplied to Pool.connect); topicId is this test's own to dispose, since it owns it
      pubId.dispose();
      topicId.dispose();
    }
  }, 45000);
});
