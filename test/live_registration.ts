import { appendFileSync } from "node:fs";
import type { Identity } from "../src/identity.js";
import type { Pool } from "../src/pool.js";
import type { PubsubEvent, SubscribeOptions } from "../src/pubsub.js";
import { MaculaCallError, type JsonValue } from "../src/rpc.js";
import type { ServeOptions, Session } from "../src/session.js";

// serve() and subscribe() return before the station has registered the procedure or the subscription:
// ADVERTISE and SUBSCRIBE are never acknowledged. So live tests reach them only through this module, and
// test/live_registration.test.ts checks that they do.
//
// serveUntilRouted and subscribeUntilDelivered wait until the station routes a call or delivers an
// event, bounded and recorded, before a test relies on it. serveUncalled and subscribeUnpublished are
// for a procedure nothing calls or a topic nothing publishes to, such as a one-role test or a refusal,
// where there is nothing to wait for.

type Stop = () => Promise<void>;

// How long a call may keep getting unknown_next_peer after serve() before the test fails: about six
// times the longest wait measured on a live station (one retry, about 300 ms). A wait near it is a
// station finding, not a reason to raise it.
const ROUTE_WAIT_MS = 2000;

// How long a test may publish before its subscriber has the event: past the longest registration wait
// measured on a live station (about 300 ms), with a publish every 500 ms. A wait near it is a station
// finding, not a reason to raise it.
const DELIVERY_WAIT_MS = 2000;

// How long after the last publish a subscriber that must not get an event is watched: past the Go-side
// reader's 2 s poll interval plus real network latency.
const QUIET_WINDOW_MS = 4000;

// Records one wait: on the console, and in the file MACULA_TS_LIVE_WAITS names when set, since a test
// run's console output isn't always shown.
function recordWait(line: string): void {
  console.log(line);
  if (process.env.MACULA_TS_LIVE_WAITS) appendFileSync(process.env.MACULA_TS_LIVE_WAITS, `${line}\n`);
}

// Calls until the station routes the CALL. Only unknown_next_peer is retried, every 250 ms, for up to
// ROUTE_WAIT_MS; any other outcome is returned or thrown at once. Records how many attempts the call
// took and how long it waited, so registration lag shows in the run.
async function whenRouted<T>(label: string, call: () => Promise<T>): Promise<T> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await call();
      recordWait(`live wait, ${label}: routed on attempt ${attempt} after ${Date.now() - start} ms`);
      return result;
    } catch (err) {
      const routing = err instanceof MaculaCallError && err.bolt4Name === "unknown_next_peer";
      if (!routing) {
        recordWait(`live wait, ${label}: answered on attempt ${attempt} after ${Date.now() - start} ms with ${String(err)}`);
        throw err;
      }
      if (Date.now() - start >= ROUTE_WAIT_MS) {
        recordWait(`live wait, ${label}: still unknown_next_peer on attempt ${attempt} after ${Date.now() - start} ms, giving up`);
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Undoes a registration after what should have followed it failed, keeping the failure as the error
// the test sees. A failure to undo it is printed rather than thrown, so it can't hide the first one.
async function undoAfterFailure(label: string, stop: Stop, failure: unknown): Promise<never> {
  await stop().catch((err: unknown) => console.error(`${label}: stopping after "${String(failure)}" also failed: ${String(err)}`));
  throw failure;
}

// Serves procedure on provider, then makes firstCall until the station routes it. Returns the stop
// function and firstCall's result. If firstCall fails (any error other than unknown_next_peer at once,
// unknown_next_peer once ROUTE_WAIT_MS has passed), it stops serving and throws firstCall's error.
export async function serveUntilRouted<T>(registration: {
  label: string;
  provider: Session;
  procedure: string;
  handler: (payload: JsonValue) => JsonValue | Promise<JsonValue>;
  options?: ServeOptions;
  firstCall: () => Promise<T>;
}): Promise<{ stop: Stop; firstResult: T }> {
  const { label, provider, procedure, handler, options, firstCall } = registration;
  const stop = await provider.serve(procedure, handler, options);
  try {
    return { stop, firstResult: await whenRouted(label, firstCall) };
  } catch (failure) {
    return undoAfterFailure(label, stop, failure);
  }
}

// Subscribes subscriber to topic, then publishes until delivered() holds (see publishUntilDelivered).
// Returns the stop function and when the last publish was sent. If no event arrives in time, it stops
// the subscription and throws.
export async function subscribeUntilDelivered(registration: {
  label: string;
  subscriber: Session;
  topic: string;
  handler: (evt: PubsubEvent) => void;
  options?: SubscribeOptions;
  publish: () => Promise<void>;
  delivered: () => boolean;
}): Promise<{ stop: Stop; lastPublishAt: number }> {
  const { label, subscriber, topic, handler, options, publish, delivered } = registration;
  const stop = await subscriber.subscribe(topic, handler, options);
  try {
    return { stop, lastPublishAt: await publishUntilDelivered(label, publish, delivered) };
  } catch (failure) {
    return undoAfterFailure(label, stop, failure);
  }
}

// subscribeUntilDelivered for a Pool subscription. identity is the topic link's own identity, as
// Pool.subscribe takes it.
export async function poolSubscribeUntilDelivered(registration: {
  label: string;
  pool: Pool;
  realm: string | undefined;
  topic: string;
  handler: (evt: PubsubEvent) => void;
  identity?: Identity;
  publish: () => Promise<void>;
  delivered: () => boolean;
}): Promise<{ stop: Stop; lastPublishAt: number }> {
  const { label, pool, realm, topic, handler, identity, publish, delivered } = registration;
  const stop = await pool.subscribe(realm, topic, handler, identity);
  try {
    return { stop, lastPublishAt: await publishUntilDelivered(label, publish, delivered) };
  } catch (failure) {
    return undoAfterFailure(label, stop, failure);
  }
}

// Publishes until the subscriber has the event. A station can take a moment to register a SUBSCRIBE,
// and an event published before that is not delivered. Publishes again every 500 ms until delivered()
// holds, for up to DELIVERY_WAIT_MS from the first publish. Records how many publishes it took and how
// long, and returns when the last publish was sent. On its own it is for a subscription that has
// already had an event delivered.
export async function publishUntilDelivered(label: string, publish: () => Promise<void>, delivered: () => boolean): Promise<number> {
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

// Waits until QUIET_WINDOW_MS after lastPublishAt, for a subscriber that must not get an event.
export async function quietUntil(lastPublishAt: number): Promise<void> {
  await new Promise((r) => setTimeout(r, Math.max(0, lastPublishAt + QUIET_WINDOW_MS - Date.now())));
}

// Serves procedure on a Session nothing calls, such as to hold the serve role in a one-role test or to
// check that serve() is refused. With no caller there is nothing to wait for.
export function serveUncalled(
  provider: Session,
  procedure: string,
  handler: (payload: JsonValue) => JsonValue | Promise<JsonValue>,
  options?: ServeOptions,
): Promise<Stop> {
  return provider.serve(procedure, handler, options);
}

// Subscribes on a Session nothing publishes to, such as to hold the subscribe role in a one-role test
// or to check that subscribe() is refused. With no publisher there is nothing to wait for.
export function subscribeUnpublished(
  subscriber: Session,
  topic: string,
  handler: (evt: PubsubEvent) => void,
  options?: SubscribeOptions,
): Promise<Stop> {
  return subscriber.subscribe(topic, handler, options);
}
