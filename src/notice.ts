// A subscription's inbox carries an event, or a notice that events may have
// been missed: macula-go gives every item a "kind" (CONTRACT.md "Inboxes"),
// and a binding that reads only the event fields makes an event out of a gap,
// with every field undefined. This is the reader that tells one from the
// other, and the notice it hands on.
//
// Internal to the package: pool.ts gives a notice to a subscriber's onNotice,
// and an event to onEvent. The type is public (index.ts re-exports it).
import type { JsonValue } from "./wire.js";

/** What a subscription reports when its events may have been missed: its link
 * to the station ended (`interrupted`, from when that link last heard from its
 * station, for `reason`), or a new link carries the subscription again
 * (`gap`, and what fell between `fromMs` and `toMs` may be gone; macula-go
 * v0.30.0). A notice comes only where another link did not carry the
 * subscription through, and never at the first subscribe. */
export type Notice =
  | { readonly kind: "interrupted"; readonly fromMs: number; readonly reason: string }
  | { readonly kind: "gap"; readonly fromMs: number; readonly toMs: number; readonly reason: string };

/** An event as the ABI writes it, before the package's own shape. */
export interface InboxEvent {
  readonly publisher: string;
  readonly realm: string;
  readonly topic: string;
  readonly seq: number;
  readonly published_at: number;
  readonly payload: JsonValue;
  readonly delivered_via: string;
  readonly sealed?: 1;
  readonly seal_key_id?: string;
  readonly unopened?: string;
}

/** One item from a subscription's inbox: what it is, and nothing else. */
export type InboxItem =
  | { readonly notice: Notice }
  | { readonly event: InboxEvent };

/** A notice as the ABI writes it. */
type NoticeItem =
  | { readonly kind: "interrupted"; readonly from_ms: number; readonly reason: string }
  | { readonly kind: "gap"; readonly from_ms: number; readonly to_ms: number; readonly reason: string };

/** A notice's internal shape in the notice it becomes. */
function noticeOf(item: NoticeItem): Notice {
  return item.kind === "gap"
    ? { kind: "gap", fromMs: item.from_ms, toMs: item.to_ms, reason: item.reason }
    : { kind: "interrupted", fromMs: item.from_ms, reason: item.reason };
}

/** Reads one item a subscription handed over, as the ABI wrote it. The JSON
 * is the library's own (CONTRACT.md "Inboxes"), cast once here: everything
 * past this point is the package's shape. */
export function itemOf(json: string): InboxItem {
  const item = JSON.parse(json) as { kind?: string };
  if (item.kind === "interrupted" || item.kind === "gap") return { notice: noticeOf(item as NoticeItem) };
  return { event: item as unknown as InboxEvent };
}
