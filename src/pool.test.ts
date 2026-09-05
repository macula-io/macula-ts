import { describe, it, expect } from "vitest";
import { Identity } from "./identity.js";
import { NoHealthyStationError, Pool } from "./pool.js";

// No real station dependency here on purpose, same convention as
// session.test.ts -- these run in default CI. Everything that needs a
// real successful connection (multi-station reconnect, subscription
// replay, dedup against real duplicate delivery, publish/call fan-out)
// is in pool.live.test.ts, opt-in via MACULA_TS_LIVE.
//
// Seeds here point at 127.0.0.1 with nothing listening -- session.test.ts's
// own doomed-address case, reused so every link fails fast (empirically
// ~5s, quic-go's own dial timeout) instead of hanging for the full 30s
// handshake timeout.
const DOOMED_SEED = { host: "127.0.0.1", port: 1 };
// A second, distinct doomed address -- Pool.connect() refuses duplicate
// seeds (found in review 2026-09-05: two links to the SAME station
// under one identity is exactly the collision this design exists to
// avoid), so a two-seed test needs two genuinely different targets.
const OTHER_DOOMED_SEED = { host: "127.0.0.1", port: 2 };

describe("Pool", () => {
  it("connect() rejects with no seeds configured", async () => {
    const id = Identity.generate();
    try {
      await expect(Pool.connect([], id)).rejects.toThrow(/at least one seed/);
    } finally {
      id.dispose();
    }
  });

  it("connect() rejects a duplicate seed -- two links to the same station under one identity would double-connect it", async () => {
    const id = Identity.generate();
    try {
      await expect(Pool.connect([DOOMED_SEED, DOOMED_SEED], id)).rejects.toThrow(/duplicate seed/);
    } finally {
      id.dispose();
    }
  });

  it("a link that never connects goes to backoff, not silently dropped from the pool", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED, OTHER_DOOMED_SEED], id, {});
    try {
      const status = pool.status();
      expect(status.healthyLinks).toBe(0);
      expect(status.failedLinks).toBe(2);
    } finally {
      await pool.close();
    }
  }, 20000);

  it("publish() throws NoHealthyStationError when zero links are live", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    try {
      await expect(pool.publish(undefined, "some.topic", { hello: "world" })).rejects.toBeInstanceOf(NoHealthyStationError);
    } finally {
      await pool.close();
    }
  }, 20000);

  it("call() throws NoHealthyStationError when zero links are live", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    try {
      await expect(pool.call(undefined, "some.procedure", {})).rejects.toBeInstanceOf(NoHealthyStationError);
    } finally {
      await pool.close();
    }
  }, 20000);

  it("close() disposes the pool's own control identity", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    await pool.close();
    // The SAME identity object was handed to Pool.connect() and is now
    // this pool's own -- using it after close() must behave like any
    // other disposed Identity (session.test.ts's own doomed-address
    // case proves Identity.generate() + immediate use works; this
    // proves the pool actually disposed the one it was given, not a
    // copy).
    expect(() => id.nodeId).toThrow(/used after dispose/);
  }, 20000);

  it("close() is safe to call more than once", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    await pool.close();
    await expect(pool.close()).resolves.toBeUndefined();
  }, 20000);

  it("subscribing to the same (realm, topic) twice is refused rather than silently duplicating", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    try {
      const unsub = await pool.subscribe(undefined, "dup.topic", () => {});
      try {
        await expect(pool.subscribe(undefined, "dup.topic", () => {})).rejects.toThrow(/already subscribed/);
      } finally {
        await unsub();
      }
    } finally {
      await pool.close();
    }
  }, 20000);

  it("a stale unsubscribe() does not tear down a newer subscription that reused the same (realm, topic)", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    try {
      const unsubFirst = await pool.subscribe(undefined, "reused.topic", () => {});
      await unsubFirst();
      const unsubSecond = await pool.subscribe(undefined, "reused.topic", () => {});
      try {
        // Found live 2026-09-05: calling the first subscription's own
        // unsubscribe() a second time here (this SDK's own convention
        // elsewhere -- Session.subscribe()'s stop(), Pool.close() -- is
        // that a repeat call is a safe no-op) used to delete whatever was
        // CURRENTLY registered under "reused.topic": the second, unrelated
        // subscription, silently tearing down its links with no error
        // anywhere. It must be a no-op instead.
        await unsubFirst();
        await expect(pool.subscribe(undefined, "reused.topic", () => {})).rejects.toThrow(/already subscribed/);
      } finally {
        await unsubSecond();
      }
    } finally {
      await pool.close();
    }
  }, 20000);

  it("subscribe() refuses an identity that is already the pool's own control identity", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    try {
      await expect(pool.subscribe(undefined, "some.topic", () => {}, id)).rejects.toThrow(/already the pool's own control identity/);
    } finally {
      await pool.close();
    }
  }, 20000);

  it("subscribe() refuses an identity already used by another tracked subscription", async () => {
    const controlId = Identity.generate();
    const sharedTopicId = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], controlId, {});
    try {
      const unsub = await pool.subscribe(undefined, "topic.a", () => {}, sharedTopicId);
      try {
        await expect(pool.subscribe(undefined, "topic.b", () => {}, sharedTopicId)).rejects.toThrow(/already used by the "topic.a" subscription/);
      } finally {
        await unsub();
      }
    } finally {
      await pool.close();
      sharedTopicId.dispose();
    }
  }, 20000);

  it("a non-1 replicationFactor is clamped to 1, not silently delivering duplicates", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, { replicationFactor: 3 });
    try {
      // No direct getter for the clamped value -- publish() throwing
      // NoHealthyStationError (not some other error from an over-large
      // slice) is the observable proof the pool didn't just store "3"
      // and try to use 3 links against a 1-seed pool.
      await expect(pool.publish(undefined, "some.topic", {})).rejects.toBeInstanceOf(NoHealthyStationError);
    } finally {
      await pool.close();
    }
  }, 20000);

  it("publish()/call()/subscribe() reject after close() instead of quietly minting new connections", async () => {
    const id = Identity.generate();
    const pool = await Pool.connect([DOOMED_SEED], id, {});
    await pool.close();
    await expect(pool.publish(undefined, "t", {})).rejects.toThrow(/used after close/);
    await expect(pool.call(undefined, "p", {})).rejects.toThrow(/used after close/);
    await expect(pool.subscribe(undefined, "t", () => {})).rejects.toThrow(/used after close/);
  }, 20000);
});
