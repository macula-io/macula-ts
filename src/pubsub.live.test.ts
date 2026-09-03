import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { Session } from "./session.js";
import type { PubsubEvent } from "./pubsub.js";

// Opt-in only: MACULA_TS_LIVE=1 npm run test:live -- see
// session.live.test.ts for why (real production station, not run in
// default CI).
const STATION_HOST = "station-de-frankfurt.macula.io";
const STATION_PORT = 4433;

// A fresh, unlikely-to-collide topic per test run, matching rpc.live.test.ts/
// dht.live.test.ts's own uniqueProcedure() convention -- the shared demo
// fleet has other real traffic on it.
function uniqueTopic(label: string): string {
  return `io.macula.ts.pubsub_live_test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

// Resolves with the next event delivered to a subscribe() handler, or
// rejects after timeoutMs -- turns the callback-shaped subscribe() API
// into something a test can straightforwardly await.
function nextEvent(timeoutMs: number): { promise: Promise<PubsubEvent>; onEvent: (evt: PubsubEvent) => void } {
  let onEvent!: (evt: PubsubEvent) => void;
  const promise = new Promise<PubsubEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event arrived within ${timeoutMs}ms`)), timeoutMs);
    onEvent = (evt) => {
      clearTimeout(timer);
      resolve(evt);
    };
  });
  return { promise, onEvent };
}

describe.skipIf(!process.env.MACULA_TS_LIVE)("Session pubsub (live station)", () => {
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
        const first = nextEvent(10_000);
        stopSubscription = await session.subscribe(topic, (evt) => {
          delivered.push(evt);
          first.onEvent(evt);
        });

        const payload = { text: "hello from macula-ts pubsub live test", n: 42, nested: { list: [1, 2, 3] } };
        await session.publish(topic, payload);

        const evt = await first.promise;
        expect(evt.payload).toEqual(payload);
        expect(evt.publisher.length).toBe(32);
        expect(Buffer.from(evt.publisher).equals(Buffer.from(id.nodeId))).toBe(true);
        expect(Number.isInteger(evt.seq)).toBe(true);
        expect(evt.seq).toBeGreaterThan(0);
        expect(delivered.length).toBe(1);

        // stop() must not resolve until the Go-side reader goroutine has
        // actually sent UNSUBSCRIBE and exited -- verified here by
        // publishing AGAIN immediately after stop() resolves and
        // confirming nothing further is ever delivered, not merely that
        // no event happened to arrive yet.
        await stopSubscription();
        stopSubscription = undefined;

        await session.publish(topic, { after: "unsubscribe -- must not be delivered" });
        // Long enough to comfortably exceed the Go-side reader's own
        // poll interval (connection.subscriberPollInterval, 2s) plus
        // real network latency, so this is a genuine "nothing arrived"
        // observation, not a race against delivery.
        await new Promise((r) => setTimeout(r, 4000));
        expect(delivered.length).toBe(1);
      } finally {
        if (stopSubscription) await stopSubscription();
        if (session) await session.close(id, "pubsub.live.test.ts done (roundtrip)");
        id.dispose();
      }
    },
    30000,
  );

  it(
    "subscribe() while serve() is active on the same Session throws, and vice versa -- both read the shared control stream",
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
        const firstOnOther = nextEvent(10_000);
        const firstOnDefault = nextEvent(10_000);

        // Two subscriptions to the SAME topic string, on two separate
        // Sessions (one Session allows only one active subscribe() at a
        // time), differing ONLY in realm -- one left at the default
        // (all-zero), one pinned to otherRealm.
        stopDefaultSub = await defaultSubSession.subscribe(topic, (evt) => {
          defaultDelivered.push(evt);
          firstOnDefault.onEvent(evt);
        });
        stopOtherSub = await otherSubSession.subscribe(topic, (evt) => {
          otherDelivered.push(evt);
          firstOnOther.onEvent(evt);
        }, { realm: otherRealm });

        // Publish under otherRealm: only the otherRealm subscriber
        // should ever see this.
        await publisherSession.publish(topic, { marker: "otherRealm-event" }, { realm: otherRealm });
        const otherEvt = await firstOnOther.promise;
        expect(otherEvt.payload).toEqual({ marker: "otherRealm-event" });

        // Give the default-realm subscriber every chance to have wrongly
        // received it too -- long enough to exceed real network latency
        // plus the Go-side reader's own poll interval (matches the
        // roundtrip test's own 4s margin above).
        await new Promise((r) => setTimeout(r, 4000));
        expect(defaultDelivered.length).toBe(0);
        expect(otherDelivered.length).toBe(1);

        // Now publish under the DEFAULT realm (no realm option): only
        // the default-realm subscriber should see THIS one -- ruling
        // out "the otherRealm subscriber just receives everything" as
        // an alternative explanation for the isolation observed above.
        await publisherSession.publish(topic, { marker: "defaultRealm-event" });
        const defaultEvt = await firstOnDefault.promise;
        expect(defaultEvt.payload).toEqual({ marker: "defaultRealm-event" });

        await new Promise((r) => setTimeout(r, 4000));
        expect(defaultDelivered.length).toBe(1);
        expect(otherDelivered.length).toBe(1); // unchanged -- still just the one otherRealm event
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
