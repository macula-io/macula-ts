import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it, expect } from "vitest";
import { liveStationHost, requireLiveStation } from "../test/live_station.js";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import type { PubsubEvent } from "./pubsub.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = liveStationHost("MACULA_TS_LIVE_STATION");
const STATION_PORT = 4433;

// A fresh, unlikely-to-collide topic per test run, matching rpc.live.test.ts/
// dht.live.test.ts's own uniqueProcedure() convention -- the shared demo
// fleet has other real traffic on it.
function uniqueTopic(label: string): string {
  return `io.macula.ts.pubsub_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
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

// How long after the last publish a subscriber that must not get an event is watched: past the
// Go-side reader's 2 s poll interval plus real network latency.
const QUIET_WINDOW_MS = 4000;

async function quietUntil(lastPublishAt: number): Promise<void> {
  await new Promise((r) => setTimeout(r, Math.max(0, lastPublishAt + QUIET_WINDOW_MS - Date.now())));
}

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session pubsub (live station)", () => {
  beforeEach(() => requireLiveStation("MACULA_TS_LIVE_STATION"), 45_000);
  it(
    "subscribe() receives this same Session's own publish() with the correct payload, and stop() genuinely stops delivery",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;
      let stopSubscription: (() => Promise<void>) | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);
        const topic = uniqueTopic("roundtrip");

        const delivered: PubsubEvent[] = [];
        stopSubscription = await session.subscribe(topic, (evt) => {
          delivered.push(evt);
        });

        const payload = { text: "hello from macula-ts pubsub live test", n: 42, nested: { list: [1, 2, 3] } };
        await publishUntilDelivered("pubsub roundtrip", () => session.publish(topic, payload), () => delivered.length > 0);

        const evt = delivered[0];
        expect(evt.payload).toEqual(payload);
        expect(evt.publisher.length).toBe(32);
        expect(Buffer.from(evt.publisher).equals(Buffer.from(id.nodeId))).toBe(true);
        expect(Number.isInteger(evt.seq)).toBe(true);
        expect(evt.seq).toBeGreaterThan(0);

        // stop() must not resolve until the Go-side reader goroutine has
        // actually sent UNSUBSCRIBE and exited -- verified here by
        // publishing AGAIN immediately after stop() resolves and
        // confirming nothing further is ever delivered, not merely that
        // no event happened to arrive yet.
        await stopSubscription();
        stopSubscription = undefined;
        const deliveredBeforeStop = delivered.length;

        await session.publish(topic, { after: "unsubscribe -- must not be delivered" });
        // Long enough to comfortably exceed the Go-side reader's own
        // poll interval (connection.subscriberPollInterval, 2s) plus
        // real network latency, so this is a genuine "nothing arrived"
        // observation, not a race against delivery.
        await new Promise((r) => setTimeout(r, 4000));
        expect(delivered.length).toBe(deliveredBeforeStop);
        for (const each of delivered) expect(each.payload).toEqual(payload);
      } finally {
        if (stopSubscription) await stopSubscription();
        if (session) await session.close(id, "pubsub.live.test.ts done (roundtrip)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    'subscribe() with bytes: "tagged" delivers a published {"$bytes": base64} value as that same tagged object',
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;
      let stopSubscription: (() => Promise<void>) | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);
        const topic = uniqueTopic("bytes");

        const delivered: PubsubEvent[] = [];
        stopSubscription = await session.subscribe(topic, (evt) => delivered.push(evt), { bytes: "tagged" });

        // "AQID" also appears as plain text, which must stay text.
        const payload = { id: { $bytes: "AQID" }, text: "AQID" };
        await publishUntilDelivered("pubsub bytes", () => session.publish(topic, payload), () => delivered.length > 0);

        expect(delivered[0].payload).toEqual(payload);
      } finally {
        if (stopSubscription) await stopSubscription();
        if (session) await session.close(id, "pubsub.live.test.ts done (bytes)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "subscribe() while serve() is active on the same Session throws, and vice versa -- a Session takes one role at a time",
    async () => {
      const id = Identity.generate();
      let session: Session | undefined;
      let stopServing: (() => Promise<void>) | undefined;
      let stopSubscription: (() => Promise<void>) | undefined;

      try {
        session = await Session.connect(STATION_HOST, STATION_PORT, id);

        stopServing = await session.serve(uniqueTopic("exclusivity_procedure"), () => null);
        await expect(session.subscribe(uniqueTopic("blocked_by_serve"), () => {})).rejects.toThrow(/serve\(/);
        await stopServing();
        stopServing = undefined;

        stopSubscription = await session.subscribe(uniqueTopic("exclusivity_topic"), () => {});
        await expect(session.serve(uniqueTopic("blocked_by_subscribe"), () => null)).rejects.toThrow(/subscribe\(/);
        await expect(session.call(uniqueTopic("blocked_by_subscribe_call"), null)).rejects.toThrow(/subscribe\(/);
        await stopSubscription();
        stopSubscription = undefined;
      } finally {
        if (stopServing) await stopServing();
        if (stopSubscription) await stopSubscription();
        if (session) await session.close(id, "pubsub.live.test.ts done (exclusivity)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "publish()/subscribe()'s realm option actually changes wire behavior: a subscriber on realm A never sees an " +
      "event published under a different real realm B, and a subscriber on B never sees one published under A " +
      "(the default) -- proven with two live subscriptions on the same topic at once, not just a single-realm probe",
    async () => {
      const publisherId = Identity.generate();
      const defaultSubId = Identity.generate();
      const otherSubId = Identity.generate();
      let publisherSession: Session | undefined;
      let defaultSubSession: Session | undefined;
      let otherSubSession: Session | undefined;
      let stopDefaultSub: (() => Promise<void>) | undefined;
      let stopOtherSub: (() => Promise<void>) | undefined;

      try {
        [publisherSession, defaultSubSession, otherSubSession] = await Promise.all([
          Session.connect(STATION_HOST, STATION_PORT, publisherId),
          Session.connect(STATION_HOST, STATION_PORT, defaultSubId),
          Session.connect(STATION_HOST, STATION_PORT, otherSubId),
        ]);

        const topic = uniqueTopic("realm_isolation");
        // A real, random, non-zero 32-byte realm -- not a stand-in
        // value, the same shape every real realm on the mesh takes.
        const otherRealm = randomBytes(32).toString("hex");

        const defaultDelivered: PubsubEvent[] = [];
        const otherDelivered: PubsubEvent[] = [];

        // Two subscriptions to the SAME topic string, on two separate
        // Sessions (one Session allows only one active subscribe() at a
        // time), differing ONLY in realm -- one left at the default
        // (all-zero), one pinned to otherRealm.
        stopDefaultSub = await defaultSubSession.subscribe(topic, (evt) => {
          defaultDelivered.push(evt);
        });
        stopOtherSub = await otherSubSession.subscribe(topic, (evt) => {
          otherDelivered.push(evt);
        }, { realm: otherRealm });

        // Publish under otherRealm until the otherRealm subscriber has it.
        const otherMarker = { marker: "otherRealm-event" };
        const lastOtherPublish = await publishUntilDelivered(
          "pubsub realm B",
          () => publisherSession.publish(topic, otherMarker, { realm: otherRealm }),
          () => otherDelivered.length > 0,
        );
        expect(otherDelivered[0].payload).toEqual(otherMarker);

        // Then the default-realm subscriber gets its own full window after the
        // last of those publishes, and must have received none of them.
        await quietUntil(lastOtherPublish);
        expect(defaultDelivered.length).toBe(0);

        // Now publish under the DEFAULT realm (no realm option): only
        // the default-realm subscriber should see THIS one -- ruling
        // out "the otherRealm subscriber just receives everything" as
        // an alternative explanation for the isolation observed above.
        const defaultMarker = { marker: "defaultRealm-event" };
        const otherBeforeDefault = otherDelivered.length;
        const lastDefaultPublish = await publishUntilDelivered(
          "pubsub realm A",
          () => publisherSession.publish(topic, defaultMarker),
          () => defaultDelivered.length > 0,
        );
        expect(defaultDelivered[0].payload).toEqual(defaultMarker);

        // And the otherRealm subscriber gets its own full window after the last
        // default-realm publish, and must have received none of those copies.
        await quietUntil(lastDefaultPublish);
        expect(otherDelivered.slice(otherBeforeDefault).filter((e) => JSON.stringify(e.payload) === JSON.stringify(defaultMarker))).toEqual([]);
        for (const evt of otherDelivered) expect(evt.payload).toEqual(otherMarker);
        for (const evt of defaultDelivered) expect(evt.payload).toEqual(defaultMarker);
      } finally {
        if (stopDefaultSub) await stopDefaultSub();
        if (stopOtherSub) await stopOtherSub();
        if (publisherSession) await publisherSession.close(publisherId, "pubsub.live.test.ts done (realm isolation, publisher)");
        if (defaultSubSession) await defaultSubSession.close(defaultSubId, "pubsub.live.test.ts done (realm isolation, default sub)");
        if (otherSubSession) await otherSubSession.close(otherSubId, "pubsub.live.test.ts done (realm isolation, other sub)");
        publisherId.dispose();
        defaultSubId.dispose();
        otherSubId.dispose();
      }
    },
    40000,
  );

  it("publish()/subscribe() reject a malformed realm before ever touching the network", async () => {
    const id = Identity.generate();
    let session: Session | undefined;
    try {
      session = await Session.connect(STATION_HOST, STATION_PORT, id);
      const topic = uniqueTopic("malformed_realm_never_sent");

      await expect(session.publish(topic, null, { realm: "not-hex" })).rejects.toThrow(/64 hex characters/);
      await expect(session.publish(topic, null, { realm: "ab" })).rejects.toThrow(/64 hex characters/);
      await expect(session.subscribe(topic, () => {}, { realm: "zz".repeat(32) })).rejects.toThrow(/64 hex characters/);
    } finally {
      if (session) await session.close(id, "pubsub.live.test.ts done (malformed realm)");
      id.dispose();
    }
  }, 20000);
});
