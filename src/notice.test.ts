// A subscription's inbox carries an event, or a notice that events may have
// been missed (macula-go v0.30.0, CONTRACT.md "Inboxes"). A binding that reads
// only the event fields makes an event out of a gap, with every field
// undefined; these are the items as the ABI writes them, read as what they are.
import { describe, expect, it } from "vitest";
import { itemOf } from "./notice.js";

describe("a subscription's item", () => {
  it("is a notice for each kind the ABI reports missed events with", () => {
    expect(itemOf(JSON.stringify({ kind: "interrupted", from_ms: 1_700_000_000_000, reason: "liveness_lost" })))
      .toEqual({ notice: { kind: "interrupted", fromMs: 1_700_000_000_000, reason: "liveness_lost" } });
    expect(itemOf(JSON.stringify({
      kind: "gap", from_ms: 1_700_000_000_000, to_ms: 1_700_000_060_000, reason: "connection_lost",
    }))).toEqual({
      notice: { kind: "gap", fromMs: 1_700_000_000_000, toMs: 1_700_000_060_000, reason: "connection_lost" },
    });
  });

  it("is an event for an event, whatever else the event carries", () => {
    const event = {
      kind: "event", publisher: "ab".repeat(32), realm: "cd".repeat(32), topic: "acme/demo/greeting_sent_v1",
      seq: 7, published_at: 1_700_000_000_000, payload: { text: "hi" }, delivered_via: "ef".repeat(32),
      sealed: 1, seal_key_id: "0123456789abcdef",
    };
    expect(itemOf(JSON.stringify(event))).toEqual({ event });
  });
});
