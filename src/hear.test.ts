// The one place a subscription's item is routed: an event to onEvent, a notice
// that events may have been missed to onNotice, the closing notice to the
// subscription's own promise (macula-go v0.30.0 gives every item a kind). No
// station is needed — these are the items the ABI hands over.
import { describe, expect, it } from "vitest";
import { hear } from "./pool.js";
import type { Event, Notice } from "./index.js";

const delivery = (kind: "event" | "closed", json: string) => ({ kind, json, handle: 0n } as const);

const anEvent = {
  kind: "event", publisher: "ab".repeat(32), realm: "cd".repeat(32), topic: "acme/demo/greeting_sent_v1",
  seq: 7, published_at: 1_700_000_000_000, payload: { text: "hi" }, delivered_via: "ef".repeat(32),
};

const aGap = { kind: "gap", from_ms: 1_700_000_000_000, to_ms: 1_700_000_060_000, reason: "connection_lost" };

/** What hear was handed, in the order it was handed it. */
function heard(kind: "event" | "closed", json: string, onNotice?: (notice: Notice) => void) {
  const events: Event[] = [];
  const notices: Notice[] = [];
  const settled: Array<string | null> = [];
  hear(delivery(kind, json), (e) => events.push(e), { onNotice }, (why) => settled.push(why));
  return { events, notices, settled };
}

describe("what a subscription's item becomes", () => {
  it("hands an event to onEvent, and nothing to onNotice", () => {
    const notices: Notice[] = [];
    const { events, settled } = heard("event", JSON.stringify(anEvent), (n) => notices.push(n));
    expect(events.map((e) => ({ topic: e.topic, seq: e.seq, payload: e.payload })))
      .toEqual([{ topic: anEvent.topic, seq: anEvent.seq, payload: anEvent.payload }]);
    expect(notices).toEqual([]);
    expect(settled).toEqual([]);
  });

  it("hands a notice to onNotice, and never to onEvent", () => {
    const notices: Notice[] = [];
    const { events, settled } = heard("event", JSON.stringify(aGap), (n) => notices.push(n));
    expect(events).toEqual([]);
    expect(notices).toEqual([
      { kind: "gap", fromMs: aGap.from_ms, toMs: aGap.to_ms, reason: aGap.reason },
    ]);
    expect(settled).toEqual([]);
  });

  it("hands a notice nowhere when nobody asked for notices, rather than to onEvent", () => {
    const { events, settled } = heard("event", JSON.stringify(aGap));
    expect(events).toEqual([]);
    expect(settled).toEqual([]);
  });

  it("settles a closing notice: null when it ended as asked, its reason otherwise", () => {
    expect(heard("closed", "").settled).toEqual([null]);
    const { events, settled } = heard("closed", "pool closed");
    expect(events).toEqual([]);
    expect(settled).toEqual(["pool closed"]);
  });
});
