import { randomBytes } from "node:crypto";
import { beforeEach, describe, it, expect } from "vitest";
import {
  publishUntilDelivered,
  quietUntil,
  serveUncalled,
  subscribeUnpublished,
  subscribeUntilDelivered,
} from "../test/live_registration.js";
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
        const payload = { text: "hello from macula-ts pubsub live test", n: 42, nested: { list: [1, 2, 3] } };
        const subscribed = await subscribeUntilDelivered({
          label: "pubsub roundtrip",
          subscriber: session,
          topic,
          handler: (evt) => {
            delivered.push(evt);
          },
          publish: () => session.publish(topic, payload),
          delivered: () => delivered.length > 0,
        });
        stopSubscription = subscribed.stop;

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
        // "AQID" also appears as plain text, which must stay text.
        const payload = { id: { $bytes: "AQID" }, text: "AQID" };
        const subscribed = await subscribeUntilDelivered({
          label: "pubsub bytes",
          subscriber: session,
          topic,
          handler: (evt) => delivered.push(evt),
          options: { bytes: "tagged" },
          publish: () => session.publish(topic, payload),
          delivered: () => delivered.length > 0,
        });
        stopSubscription = subscribed.stop;

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

        stopServing = await serveUncalled(session, uniqueTopic("exclusivity_procedure"), () => null);
        await expect(subscribeUnpublished(session, uniqueTopic("blocked_by_serve"), () => {})).rejects.toThrow(/serve\(/);
        await stopServing();
        stopServing = undefined;

        stopSubscription = await subscribeUnpublished(session, uniqueTopic("exclusivity_topic"), () => {});
        await expect(serveUncalled(session, uniqueTopic("blocked_by_subscribe"), () => null)).rejects.toThrow(/subscribe\(/);
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

        const publisher = publisherSession;
        const topic = uniqueTopic("realm_isolation");
        // A real, random, non-zero 32-byte realm -- not a stand-in
        // value, the same shape every real realm on the mesh takes.
        const otherRealm = randomBytes(32).toString("hex");

        const defaultDelivered: PubsubEvent[] = [];
        const otherDelivered: PubsubEvent[] = [];
        const sawPayload = (events: PubsubEvent[], payload: unknown) => () =>
          events.some((e) => JSON.stringify(e.payload) === JSON.stringify(payload));
        const defaultMarker = { marker: "defaultRealm-event" };
        const otherMarker = { marker: "otherRealm-event" };
        const defaultMarkerAgain = { marker: "defaultRealm-event-again" };

        // Two subscriptions to the SAME topic string, on two separate
        // Sessions (one Session allows only one active subscribe() at a
        // time), differing ONLY in realm -- one left at the default
        // (all-zero), one pinned to otherRealm. Each is confirmed live by
        // an event delivered under its own realm before the test relies on it.
        const defaultSubscribed = await subscribeUntilDelivered({
          label: "pubsub realm A",
          subscriber: defaultSubSession,
          topic,
          handler: (evt) => {
            defaultDelivered.push(evt);
          },
          publish: () => publisher.publish(topic, defaultMarker),
          delivered: sawPayload(defaultDelivered, defaultMarker),
        });
        stopDefaultSub = defaultSubscribed.stop;

        // Publish under otherRealm until the otherRealm subscriber has it,
        // while the default-realm subscription is live.
        const otherSubscribed = await subscribeUntilDelivered({
          label: "pubsub realm B",
          subscriber: otherSubSession,
          topic,
          handler: (evt) => {
            otherDelivered.push(evt);
          },
          options: { realm: otherRealm },
          publish: () => publisher.publish(topic, otherMarker, { realm: otherRealm }),
          delivered: sawPayload(otherDelivered, otherMarker),
        });
        stopOtherSub = otherSubscribed.stop;
        const lastOtherPublish = otherSubscribed.lastPublishAt;

        // Then the default-realm subscriber gets its own full window after the
        // last of those publishes, and must have received none of them.
        await quietUntil(lastOtherPublish);
        expect(sawPayload(defaultDelivered, otherMarker)()).toBe(false);

        // Now publish under the DEFAULT realm (no realm option) again, with
        // both subscriptions live: only the default-realm subscriber should
        // see THIS one -- ruling out "the otherRealm subscriber just receives
        // everything" as an alternative explanation for the isolation observed
        // above. A marker of its own, so a late copy of the first default-realm
        // event can't stand in for it.
        const lastDefaultPublish = await publishUntilDelivered(
          "pubsub realm A again",
          () => publisher.publish(topic, defaultMarkerAgain),
          sawPayload(defaultDelivered, defaultMarkerAgain),
        );

        // And the otherRealm subscriber gets its own full window after the last
        // default-realm publish, and must have received none of those copies.
        await quietUntil(lastDefaultPublish);
        for (const evt of otherDelivered) expect(evt.payload).toEqual(otherMarker);
        for (const evt of defaultDelivered) expect([defaultMarker, defaultMarkerAgain]).toContainEqual(evt.payload);
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
      await expect(subscribeUnpublished(session, topic, () => {}, { realm: "zz".repeat(32) })).rejects.toThrow(/64 hex characters/);
    } finally {
      if (session) await session.close(id, "pubsub.live.test.ts done (malformed realm)");
      id.dispose();
    }
  }, 20000);
});
