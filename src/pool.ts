// Resilient multi-station client -- ports macula/src/client/macula_client.erl's
// pool design (N live links, monitor + respawn-with-backoff, subscription
// replay on reconnect) into this SDK. `Session` (session.ts) and
// `connectWithFallback`/`withSession` (this SDK's consumers, e.g.
// macula-mcp's macula_ts_client.ts) are both dial-one-then-use primitives --
// correct for a one-shot operation, wrong for anything that needs to stay
// reachable across a station's own outage. A Pool holds live connections to
// every configured seed concurrently, not one-then-fallback-on-first-failure;
// a seed that never connects and a link whose connection later dies are the
// same condition (backoff, retry forever) rather than two different code
// paths.
//
// == Why this isn't "one Session per seed" ==
//
// Erlang's macula_client can put N tracked (Realm, Topic) subscriptions
// (plus Call, plus Advertise) on ONE gen_server-owned link, because a BEAM
// mailbox demuxes every message type for that one process regardless of how
// many concerns it's juggling. This SDK's Session has no equivalent: its
// underlying control stream supports exactly one concurrent reader --
// `subscribe()` throws outright if called twice on the same Session
// ("a second concurrent subscribe() on the same Session races; open a
// second Session instead"), and `call()`/`serve()` are mutually exclusive
// with an active subscribe on the same Session for the identical reason
// (macula-go's FrameStream does a raw sequential read into a shared buffer,
// no per-caller demux). Confirmed live 2026-09-04 while porting the Go side
// of this same design: this is a wire-level constraint, not a TS-specific
// gap -- macula-mcp already works around it today by giving lobby_observer.ts
// a dedicated identity+Session PER ROOM TOPIC rather than multiplexing one
// connection.
//
// So a "link" to one station here is a small SET of role-scoped sessions,
// not one session:
//   - one "control" session (this pool's own caller-supplied identity),
//     used for publish() and call() and NEVER subscribed on -- publish() is
//     write-only (explicitly unguarded by the exclusivity rule) and call()'s
//     own internal queue already serialises concurrent calls safely, so one
//     control session per station is enough regardless of call volume.
//   - one additional session PER CURRENTLY-TRACKED TOPIC, under an identity
//     derived from that topic (shared across every station's copy of that
//     topic's session -- reused across stations is safe, since a station's
//     own per-identity dedupe only kicks a SECOND connection to THAT SAME
//     station, never across different stations). Each does exactly one
//     subscribe() and nothing else.
// Every one of these sessions is independently monitored and respawned with
// backoff; a topic session dying just re-subscribes its own one topic on
// respawn (no "replay N subscriptions onto a survivor" step needed, since
// each session only ever carried one). A control link can't also carry a
// liveness-only subscribe without reintroducing the exclusivity problem it
// exists to avoid, and a failed call() genuinely does surface a dead
// connection -- but publish() does not: found live 2026-09-04 that a
// publish() attempt on a session the station had already kicked can still
// locally "succeed" (the frame is handed off before the QUIC stack notices
// its own connection is gone), so a publish-only workload could go
// arbitrarily long without ever discovering a dead control link. Every
// live control link is therefore also health-checked on a timer
// (#armHealthCheck's own doc has the mechanism) -- a periodic call() to a
// procedure name guaranteed never to be advertised, whose failure is
// inspected to tell "a real BOLT#4 unknown_next_peer came back" (alive)
// apart from "this never reached anyone at all" (dead, reconnect).
//
// == Deliberate deviation from the Erlang reference ==
//
// macula_client's own inbound-event dedup keys on (Realm, Publisher, Seq)
// alone, with no Topic. That is the exact shape of a real bug found and
// fixed on the station side 2026-09-04 (macula-station's event_dedup): an
// identity's own auto-published facts and its application-level publishes
// can share one seq-counter space, and two different topics publishing the
// same seq collide under a topic-blind key. This pool's own dedup includes
// Topic from the start.

import { Identity } from "./identity.js";
import type { PubsubEvent } from "./pubsub.js";
import { MaculaCallError, type JsonValue } from "./rpc.js";
import { realmBytesFromHex, Session } from "./session.js";

/** One configured connection target. */
export interface Seed {
  host: string;
  port: number;
}

export interface PoolOptions {
  /** How many currently-live control links a publish() fans out to
   * before resolving -- partial success counts as success, matching
   * macula_client:publish/5's own documented semantics. Default 1.
   * NOT YET FULLY AT PARITY above 1: the Erlang reference stamps ONE
   * seq across every replica specifically so a receiver's own
   * (publisher, seq, topic) dedup collapses the redundant copies into
   * one event. This SDK's Session.publish() has no caller-supplied-seq
   * parameter to do the same (each call mints its own fresh seq), so
   * setting this above 1 would deliver N distinct, non-deduplicable
   * copies to every subscriber -- clamped to 1 until that's fixed. */
  replicationFactor?: number;
  /** How long a recorded (realm, publisher, seq, topic) key is treated
   * as a duplicate before it ages out. Default 60_000, matching the
   * Erlang reference's own `dedup_window_ms` default. */
  dedupWindowMs?: number;
  /** How often the dedup table is swept for expired entries. Default
   * 30_000, matching the Erlang reference's own `dedup_sweep_ms`. */
  dedupSweepMs?: number;
  /** How often a live control link is health-checked (see
   * #armHealthCheck's own doc for why publish() alone can't be trusted
   * to ever notice a dead connection). Default 10_000. */
  healthCheckIntervalMs?: number;
}

export interface PoolStatus {
  /** Seeds whose control link is currently connected. */
  healthyLinks: number;
  /** Seeds whose control link is not currently connected (connecting
   * or backing off). Every configured seed is exactly one or the
   * other -- a link backs off and retries forever, it is never given
   * up on and dropped from the pool, same as the Erlang reference. */
  failedLinks: number;
}

/** Thrown by publish()/call() when the pool has zero live control links
 * to try -- a distinct, identifiable condition from any one link's own
 * transient error, matching macula_client:publish/5's own `{error,
 * {transient, no_healthy_station}}`. */
export class NoHealthyStationError extends Error {
  constructor() {
    super("macula-ts: pool has no currently-live links");
    this.name = "NoHealthyStationError";
  }
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** How often a LIVE control link is health-checked (see #armHealthCheck's
 * own doc for why publish() alone can't be trusted to ever notice a dead
 * connection). Topic-role links need no equivalent -- their own
 * subscribe() already gives them a real, immediate onClosed signal. */
const HEALTH_CHECK_INTERVAL_MS = 10_000;

type LinkStatus = "connecting" | "live" | "backoff";

/** One role-scoped session against one seed: either the station's
 * "control" role (publish/call, shared identity, never subscribes) or a
 * "topic" role (one subscribe(), a dedicated per-topic identity). Every
 * RoleLink is independently connected, monitored and respawned. */
interface RoleLink {
  seed: Seed;
  identity: Identity;
  session: Session | undefined;
  status: LinkStatus;
  reconnectAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Control-role only -- see #armHealthCheck's own doc. Undefined for
   * a topic role, which relies on subscribe()'s own onClosed instead. */
  healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  closing: boolean;
  inFlight: Promise<void> | undefined;
  /** Set by #scheduleReconnect while its own fire-and-forget close of a
   * stale session is still in flight. Found live 2026-09-05: close()/
   * unsubscribe() disposing this link's identity while that close is
   * still on the wire raced the identity's own handle being freed
   * against cabi's own validation of it (cabi/main.go's Close checks
   * the identity handle before acting) -- whichever won, the station
   * side either got no GOODBYE or the close was silently refused,
   * leaking the Go-side session. close()/unsubscribe() must await this
   * (in addition to inFlight) before disposing an identity. */
  pendingClose: Promise<void> | undefined;
  /** Undefined for the control role. Set for a topic role -- what to
   * do once this role's session is (re)connected: subscribe it. Takes
   * the link itself (not just the session) so its own onClosed can
   * reference `link` directly instead of searching for it by session
   * identity -- see `closedDuringConnect`'s own doc for why. */
  onConnected: ((link: RoleLink, session: Session) => Promise<void>) | undefined;
  /** Topic role only. Set by onClosed if the underlying subscribe's
   * background reader ends before `#attachOnce` has finished assigning
   * `session`/"live" -- subscribe-start's own completion and a
   * subsequent "closed" delivery arrive via two independent native
   * async callbacks with no ordering guarantee between them. Checked
   * right after `onConnected` resolves so this link is never marked
   * live carrying a subscription that already silently died. */
  closedDuringConnect: boolean;
}

interface TrackedSubscription {
  realm: string | undefined;
  topic: string;
  handler: (evt: PubsubEvent) => void;
  /** This topic's own dedicated identity, shared across every seed's
   * copy of this subscription. */
  identity: Identity;
  /** Whether this pool minted `identity` itself (true, the default --
   * disposed on unsubscribe) or the caller supplied it via
   * `subscribe()`'s own `identity` parameter (false -- the caller owns
   * its lifecycle; this pool never disposes it). */
  ownsIdentity: boolean;
  /** One RoleLink per seed, all subscribing to this same topic under
   * `identity`. */
  links: RoleLink[];
}

function subKey(realm: string | undefined, topic: string): string {
  return `${realm ?? ""}\0${topic}`;
}

function dedupKey(realm: string | undefined, publisher: Uint8Array, seq: number, topic: string): string {
  return `${realm ?? ""}\0${Buffer.from(publisher).toString("hex")}\0${seq}\0${topic}`;
}

/**
 * A resilient multi-station client: live connections to every configured
 * seed held concurrently, each independently monitored and respawned
 * with backoff on disconnect, every tracked subscription re-established
 * automatically when its own link reconnects. See this module's own
 * header doc for the full design, why a "link" is a small role-scoped
 * session set rather than one Session, and its one deliberate deviation
 * from the Erlang reference (topic-scoped dedup).
 */
export class Pool {
  #controlIdentity: Identity;
  #controlLinks: RoleLink[];
  #seeds: Seed[];
  #subscriptions: Map<string, TrackedSubscription> = new Map();
  #dedup: Map<string, number> = new Map();
  #sweepTimer: ReturnType<typeof setInterval>;
  #replicationFactor: number;
  #dedupWindowMs: number;
  #healthCheckIntervalMs: number;
  #closed = false;

  private constructor(controlIdentity: Identity, seeds: Seed[], opts: PoolOptions) {
    this.#controlIdentity = controlIdentity;
    this.#seeds = seeds;
    const requestedReplication = opts.replicationFactor ?? 1;
    if (requestedReplication !== 1) {
      console.error(
        `macula-ts pool: replicationFactor ${requestedReplication} is not yet supported (each replica would publish ` +
          "a distinct seq, so a receiver's dedup can't collapse them into one event) -- clamping to 1.",
      );
    }
    this.#replicationFactor = 1;
    this.#dedupWindowMs = opts.dedupWindowMs ?? 60_000;
    this.#healthCheckIntervalMs = opts.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
    this.#controlLinks = seeds.map((seed) => this.#newRoleLink(seed, controlIdentity, undefined));
    const sweepMs = opts.dedupSweepMs ?? 30_000;
    this.#sweepTimer = setInterval(() => this.#sweepDedup(), sweepMs);
    this.#sweepTimer.unref?.();
  }

  #newRoleLink(seed: Seed, identity: Identity, onConnected: RoleLink["onConnected"]): RoleLink {
    return {
      seed,
      identity,
      session: undefined,
      status: "connecting",
      reconnectAttempt: 0,
      retryTimer: undefined,
      healthCheckTimer: undefined,
      closing: false,
      inFlight: undefined,
      pendingClose: undefined,
      onConnected,
      closedDuringConnect: false,
    };
  }

  /** Dials the control role against every seed concurrently under
   * `controlIdentity` (the caller's own identity -- publish()/call()
   * are attributed to it on the wire) and resolves once every seed's
   * FIRST connect attempt has settled (success or a logged failure
   * headed into backoff) -- matches tapRoom()'s own "await the first
   * attempt, not the eventual outcome" reasoning (macula-mcp's
   * lobby_observer.ts): a caller that publishes/calls immediately
   * after connect() must not race links still mid-handshake. */
  static async connect(seeds: Seed[], controlIdentity: Identity, opts: PoolOptions = {}): Promise<Pool> {
    if (seeds.length === 0) throw new Error("macula-ts: Pool.connect() needs at least one seed");
    const seen = new Set<string>();
    for (const seed of seeds) {
      const seedKey = `${seed.host}:${seed.port}`;
      if (seen.has(seedKey)) throw new Error(`macula-ts: Pool.connect() given duplicate seed ${seedKey} -- each seed must be a distinct station`);
      seen.add(seedKey);
    }
    const pool = new Pool(controlIdentity, seeds, opts);
    await Promise.all(pool.#controlLinks.map((link) => pool.#attach(link)));
    return pool;
  }

  async #attach(link: RoleLink): Promise<void> {
    const attempt = this.#attachOnce(link);
    link.inFlight = attempt.finally(() => {
      if (link.inFlight === attempt) link.inFlight = undefined;
    });
    await link.inFlight;
  }

  /** (Re)connects one role link and, for a topic role, re-subscribes it.
   * Never throws -- a failure logs and schedules a backoff retry, the
   * same self-healing shape every persistent connection in this
   * ecosystem already uses. */
  async #attachOnce(link: RoleLink): Promise<void> {
    if (link.closing) return;
    // Defensive: a redundant call on an already-live link must never
    // overwrite its session with a second connection under the same
    // identity to the same station (exactly the collision this whole
    // design exists to avoid). #scheduleReconnect's own idempotency
    // guard is what should prevent this from ever being reachable in
    // practice; this is the belt-and-suspenders backstop.
    if (link.session) return;
    link.status = "connecting";
    let session: Session;
    try {
      session = await Session.connect(link.seed.host, link.seed.port, link.identity);
    } catch (err) {
      console.error(`macula-ts pool: connect to ${link.seed.host}:${link.seed.port} failed:`, err);
      this.#scheduleReconnect(link);
      return;
    }
    if (link.closing) {
      await session.close(link.identity).catch(() => {});
      return;
    }
    if (link.onConnected) {
      link.closedDuringConnect = false;
      try {
        await link.onConnected(link, session);
      } catch (err) {
        console.error(`macula-ts pool: subscribe on ${link.seed.host}:${link.seed.port} failed:`, err);
        await session.close(link.identity).catch(() => {});
        this.#scheduleReconnect(link);
        return;
      }
      if (link.closedDuringConnect) {
        console.error(`macula-ts pool: ${link.seed.host}:${link.seed.port}'s subscription closed before it could be marked live -- retrying`);
        await session.close(link.identity).catch(() => {});
        this.#scheduleReconnect(link);
        return;
      }
    }
    link.session = session;
    link.status = "live";
    link.reconnectAttempt = 0;
    if (!link.onConnected) this.#armHealthCheck(link);
  }

  /** Control-role links only (topic roles have their own subscribe()
   * onClosed and never reach here -- `!link.onConnected` is what
   * distinguishes them). publish() is fire-and-forget: found live
   * 2026-09-04 that a publish() attempt on a session the station had
   * already kicked can still locally "succeed" (the frame is handed off
   * before the QUIC stack notices its own connection is gone), so a
   * publish-only caller could go arbitrarily long without this pool
   * ever discovering a dead control link. Every HEALTH_CHECK_INTERVAL_MS
   * while the link is live, this calls a procedure name that is
   * guaranteed never to be advertised (a fresh UUID-shaped string) and
   * inspects the failure: a clean MaculaCallError means a real BOLT#4
   * response came back over the wire (unknown_next_peer, as expected) --
   * the connection is genuinely alive, nothing to do. Any OTHER
   * thrown error means the call never got a wire-level answer at all --
   * the same signal call()'s own doc uses to distinguish a real BOLT#4
   * answer from "this never reached anyone" -- so it's treated exactly
   * like a real operation failure and schedules a reconnect. */
  #armHealthCheck(link: RoleLink): void {
    if (link.healthCheckTimer) clearInterval(link.healthCheckTimer);
    const timer = setInterval(() => {
      const session = link.session;
      if (!session) return;
      this.#probeLiveness(session).then((alive) => {
        if (alive) return;
        if (link.session !== session) return; // already superseded by a reconnect
        console.error(`macula-ts pool: health check on ${link.seed.host}:${link.seed.port} failed`);
        this.#scheduleReconnect(link);
      });
    }, this.#healthCheckIntervalMs);
    timer.unref?.();
    link.healthCheckTimer = timer;
  }

  /** Calls a procedure name guaranteed never to be advertised and
   * classifies the outcome: true if a real BOLT#4 answer came back
   * (the connection is alive, whatever else provoked this probe), false
   * if the call never got a wire-level answer at all (the connection is
   * genuinely dead). Shared by #armHealthCheck's own timer and call()'s
   * handling of an ambiguous failure (see call()'s own doc) -- a plain
   * Error from session.call() means "no wire answer", but that is also
   * exactly what a timed-out call against an otherwise-healthy but
   * momentarily slow provider looks like. Found live 2026-09-05: without
   * this second opinion, call() tore down every live control link in
   * turn on nothing more than one slow provider response. */
  async #probeLiveness(session: Session): Promise<boolean> {
    const probe = `_pool.healthcheck.${Math.random().toString(36).slice(2)}`;
    try {
      await session.call(probe, null, { deadlineMs: this.#healthCheckIntervalMs });
      return true; // a real provider somehow answering a random UUID-shaped name is astronomically unlikely either way
    } catch (err) {
      return err instanceof MaculaCallError; // alive iff a real wire answer came back
    }
  }

  /** Marks `link` for backoff and schedules its next reconnect attempt.
   * Closes whatever session it currently holds first (fire-and-forget,
   * not awaited -- the retry timer must not wait on a graceful close
   * round trip) so a still-alive session from an OPERATION failure
   * (publish()/call() throwing for a reason that doesn't mean the
   * connection itself already died, unlike a subscribe onClosed) is
   * never simply orphaned. Found live 2026-09-04: without this, a
   * publish/call failure left the old session's native handle both
   * leaked AND, worse, still open under this link's identity -- the
   * NEXT connect attempt for this SAME station under that SAME
   * identity then races the still-live old one for the station's own
   * per-identity dedupe kick, with no guarantee which one loses. The
   * close is fired here, before scheduling, so it has the full backoff
   * delay (at least RECONNECT_BASE_MS) to land before a new connect
   * attempt begins.
   *
   * Idempotent per backoff episode: a no-op once `link.status` is
   * already "backoff". Found live in review 2026-09-05: concurrent
   * operations queued on one session (e.g. several call()s serialised
   * by Session's own internal queue) can ALL fail once that session
   * dies, and each one's catch handler calls this -- without this
   * guard, every failure past the first would re-close an
   * already-`undefined` `link.session` (harmless) but ALSO arm a
   * second, third, ... retryTimer, each bumping reconnectAttempt
   * independently, leaving multiple redundant reconnects racing each
   * other. Deliberately NOT guarded against "connecting" -- this is
   * also called from `#attachOnce`'s own failure paths, while status
   * is still "connecting" from the top of that same function, and
   * that path must proceed normally. */
  #scheduleReconnect(link: RoleLink): void {
    if (link.closing) return;
    if (link.status === "backoff") return;
    if (link.healthCheckTimer) {
      clearInterval(link.healthCheckTimer);
      link.healthCheckTimer = undefined;
    }
    const stale = link.session;
    link.status = "backoff";
    link.session = undefined;
    if (stale) {
      const closing = stale.close(link.identity).catch(() => {});
      link.pendingClose = closing;
      void closing.finally(() => {
        if (link.pendingClose === closing) link.pendingClose = undefined;
      });
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** link.reconnectAttempt);
    link.reconnectAttempt += 1;
    const timer = setTimeout(() => {
      const attempt = this.#attachOnce(link);
      link.inFlight = attempt.finally(() => {
        if (link.inFlight === attempt) link.inFlight = undefined;
      });
    }, delay);
    // Deliberately NOT unref()'d, unlike healthCheckTimer/sweepTimer --
    // this pool's own documented contract is "retry forever" for a
    // link in backoff. Found live in review 2026-09-05: a pure
    // subscribe()-only process (no other keep-alive handle: no HTTP
    // listener, no stdio transport) would otherwise exit cleanly the
    // moment its last live connection drops, silently breaking that
    // promise instead of actually retrying through the outage.
    link.retryTimer = timer;
  }

  #sweepDedup(): void {
    const cutoff = Date.now() - this.#dedupWindowMs;
    for (const [key, at] of this.#dedup) {
      if (at < cutoff) this.#dedup.delete(key);
    }
  }

  #liveControlLinks(): RoleLink[] {
    return this.#controlLinks.filter((l) => l.status === "live" && l.session);
  }

  /** Refuses an `identity` that would double-connect to the same
   * station as the control role or another already-tracked
   * subscription -- the station kicks the OLDER of the two, this pool
   * reconnects it, which gets IT kicked in turn: a perpetual ping-pong
   * with no error naming the cause. Compares raw node-id bytes, not
   * object identity, so two separately-loaded Identity instances over
   * the SAME underlying keypair are still caught. */
  #assertIdentityNotAlreadyUsed(identity: Identity): void {
    const nodeIdHex = Buffer.from(identity.nodeId).toString("hex");
    if (nodeIdHex === Buffer.from(this.#controlIdentity.nodeId).toString("hex")) {
      throw new Error("macula-ts pool: this identity is already the pool's own control identity -- reusing it for a subscription would double-connect one identity to one station");
    }
    for (const sub of this.#subscriptions.values()) {
      if (Buffer.from(sub.identity.nodeId).toString("hex") === nodeIdHex) {
        throw new Error(`macula-ts pool: this identity is already used by the "${sub.topic}" subscription -- reusing it here would double-connect one identity to one station`);
      }
    }
  }

  /** Publishes to `replicationFactor` currently-live control links
   * (default 1); partial success counts as success. A link whose
   * publish attempt fails is marked for respawn immediately -- this is
   * this v1's only liveness signal for the control role, since it
   * cannot also carry a liveness-only subscribe (see this module's own
   * header doc). Throws NoHealthyStationError if zero links are live.
   *
   * `realm`/`payload` are validated before any link is touched. Found
   * live 2026-09-05: a malformed realm or an unserializable payload
   * throws inside session.publish() itself, well before any wire I/O --
   * treating that throw as evidence of a dead connection (the pre-fix
   * behavior) tore down a perfectly healthy link over a caller-side
   * argument bug. */
  async publish(realm: string | undefined, topic: string, payload: JsonValue, opts: { ttlMs?: number } = {}): Promise<void> {
    if (this.#closed) throw new Error("macula-ts pool: used after close()");
    realmBytesFromHex(realm);
    JSON.stringify(payload ?? null);
    const targets = this.#liveControlLinks().slice(0, this.#replicationFactor);
    if (targets.length === 0) throw new NoHealthyStationError();
    const results = await Promise.allSettled(
      targets.map(async (link) => {
        const session = link.session;
        if (link.status !== "live" || !session) throw new NoHealthyStationError(); // superseded since targets was captured
        try {
          await session.publish(topic, payload, { realm, ttlMs: opts.ttlMs });
        } catch (err) {
          if (link.session === session) this.#scheduleReconnect(link);
          throw err;
        }
      }),
    );
    if (!results.some((r) => r.status === "fulfilled")) {
      const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      throw first ? first.reason : new Error("macula-ts pool: publish failed on every targeted link");
    }
  }

  /** Calls `procedure` against the pool's live control links in order
   * until one succeeds or all have been tried. Throws
   * NoHealthyStationError if zero links are live.
   *
   * `realm`/`payload` are validated before any link is touched, for the
   * same reason as publish() -- a malformed realm is a caller bug, not
   * evidence of a dead connection, and must never be attributed to one.
   *
   * A `MaculaCallError` (a real BOLT#4 response -- e.g.
   * unknown_next_peer, unauthorized, a procedure nobody serves, a gated
   * call this identity isn't authorized for) does NOT mark its link for
   * respawn: the connection plainly worked, it answered. call() still
   * falls through to the next link either way, matching the Erlang
   * reference's own keep_or_next (macula_client.erl) -- a non-idempotent
   * provider handler genuinely can be re-invoked on each live link this
   * reaches; that is parity with the reference, not a bug this fixes.
   *
   * Any OTHER thrown error (never a wire-level answer at all) is
   * ambiguous, not automatically a dead link: session.call()'s own
   * deadlineMs elapsing looks identical to a genuinely severed
   * connection, but means the far end is merely slow, not gone. Found
   * live 2026-09-05: treating every such error as a dead link meant one
   * slow provider response tore down and reconnected EVERY live control
   * link in turn as call() moved through them re-trying the same call.
   * #probeLiveness's own dedicated liveness call is the tiebreaker --
   * only a link that ALSO fails to get a wire-level answer on that
   * fresh probe is scheduled for reconnect. Each link's own `session`
   * reference is re-checked both before probing and before scheduling a
   * reconnect, in case a concurrent operation already superseded it. */
  async call(realm: string | undefined, procedure: string, payload: JsonValue, opts: { deadlineMs?: number } = {}): Promise<JsonValue> {
    if (this.#closed) throw new Error("macula-ts pool: used after close()");
    realmBytesFromHex(realm);
    JSON.stringify(payload ?? null);
    const targets = this.#liveControlLinks();
    if (targets.length === 0) throw new NoHealthyStationError();
    let lastErr: unknown;
    for (const link of targets) {
      const session = link.session;
      if (link.status !== "live" || !session) continue; // superseded since `targets` was captured
      try {
        return await session.call(procedure, payload, { realm, deadlineMs: opts.deadlineMs });
      } catch (err) {
        lastErr = err;
        if (!(err instanceof MaculaCallError) && link.session === session && !(await this.#probeLiveness(session))) {
          if (link.session === session) this.#scheduleReconnect(link);
        }
      }
    }
    throw lastErr;
  }

  /** Subscribes `handler` to `(realm, topic)`: opens one subscribe-only
   * session against every configured seed, replayed automatically on
   * every future respawn. Mints a dedicated identity for this topic by
   * default (disposed on unsubscribe); pass `identity` to supply the
   * pool's own instead (e.g. for a stable, caller-controlled identity
   * across restarts, matching macula-mcp's own observeRoomIdentityPath
   * pattern) -- the pool never disposes an identity it didn't mint.
   * Returns an unsubscribe function. */
  async subscribe(realm: string | undefined, topic: string, handler: (evt: PubsubEvent) => void, identity?: Identity): Promise<() => Promise<void>> {
    if (this.#closed) throw new Error("macula-ts pool: used after close()");
    const key = subKey(realm, topic);
    if (this.#subscriptions.has(key)) throw new Error(`macula-ts pool: already subscribed to ${topic}${realm ? ` (realm ${realm})` : ""}`);
    if (identity) this.#assertIdentityNotAlreadyUsed(identity);
    const ownsIdentity = identity === undefined;
    const subIdentity = identity ?? Identity.generate();
    const sub: TrackedSubscription = { realm, topic, handler, identity: subIdentity, ownsIdentity, links: [] };
    const onConnected = async (link: RoleLink, session: Session): Promise<void> => {
      await session.subscribe(
        topic,
        (evt) => {
          const dkey = dedupKey(realm, evt.publisher, evt.seq, topic);
          if (this.#dedup.has(dkey)) return;
          this.#dedup.set(dkey, Date.now());
          // A caller's handler throwing must not take down the native
          // callback that invoked it -- found live 2026-09-05: an
          // uncaught exception here crosses back into the N-API
          // callback with no pending-exception handling on the addon
          // side, which Node only warns about today (DEP0168) but is
          // documented to become a fatal, unrecoverable crash under
          // --force-node-api-uncaught-exceptions-policy once that
          // policy's default flips.
          try {
            sub.handler(evt);
          } catch (err) {
            console.error(`macula-ts pool: subscription handler for ${topic} threw:`, err);
          }
        },
        {
          realm,
          onClosed: (err) => {
            if (link.closing) return; // already tearing down -- #scheduleReconnect would bail anyway, don't log a misleading "reconnecting"
            if (link.session === session) {
              console.error(`macula-ts pool: subscription to ${topic} on ${link.seed.host}:${link.seed.port} dropped (${err.message}) -- reconnecting`);
              this.#scheduleReconnect(link);
            } else {
              // subscribe-start hasn't resolved on this side yet (or
              // this link has already moved on) -- flag it so
              // #attachOnce notices once `onConnected` itself returns,
              // rather than marking a link live with a subscription
              // that already silently died. See closedDuringConnect's
              // own doc.
              link.closedDuringConnect = true;
            }
          },
        },
      );
    };
    sub.links = this.#seeds.map((seed) => this.#newRoleLink(seed, subIdentity, onConnected));
    this.#subscriptions.set(key, sub);
    await Promise.all(sub.links.map((link) => this.#attach(link)));
    return async () => {
      // Guards against a stale unsubscribe() firing (possibly a second
      // time, which this SDK's own convention elsewhere treats as safe)
      // after a newer subscription has since taken this same (realm,
      // topic) key -- found live 2026-09-05: without this check, an
      // old unsubscribe() tore down a DIFFERENT, newer subscription's
      // links and deleted it from #subscriptions, silently stopping its
      // handler with no error anywhere.
      if (this.#subscriptions.get(key) !== sub) return;
      const tracked = sub;
      this.#subscriptions.delete(key);
      await Promise.all(
        tracked.links.map(async (link) => {
          link.closing = true;
          if (link.retryTimer) clearTimeout(link.retryTimer);
          if (link.inFlight) await link.inFlight.catch(() => {});
          if (link.pendingClose) await link.pendingClose;
          if (link.session) await link.session.close(link.identity).catch(() => {});
        }),
      );
      if (tracked.ownsIdentity) tracked.identity.dispose();
    };
  }

  /** Live/backing-off CONTROL link counts (publish/call reachability).
   * Every configured seed is exactly one or the other. Per-topic
   * subscription link health is not reflected here -- inspect a
   * specific subscription's own behavior (events arriving or not)
   * instead; exposing N independent per-topic health vectors here
   * would not simplify what a caller actually needs to know. */
  status(): PoolStatus {
    const healthy = this.#liveControlLinks().length;
    return { healthyLinks: healthy, failedLinks: this.#controlLinks.length - healthy };
  }

  /** Closes every control and subscription link and disposes every
   * identity this pool owns (the caller-supplied control identity
   * included). Awaits each link's in-flight connect/reconnect first,
   * so a still-connecting link never has its identity yanked out from
   * under it. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    const allLinks = [...this.#controlLinks, ...[...this.#subscriptions.values()].flatMap((s) => s.links)];
    await Promise.all(
      allLinks.map(async (link) => {
        link.closing = true;
        if (link.retryTimer) clearTimeout(link.retryTimer);
        if (link.healthCheckTimer) clearInterval(link.healthCheckTimer);
        if (link.inFlight) await link.inFlight.catch(() => {});
        if (link.pendingClose) await link.pendingClose;
        if (link.session) await link.session.close(link.identity).catch(() => {});
        link.session = undefined;
        link.status = "backoff"; // reflects reality for status()/#liveControlLinks() if either is called after close()
      }),
    );
    for (const sub of this.#subscriptions.values()) if (sub.ownsIdentity) sub.identity.dispose();
    this.#subscriptions.clear();
    this.#controlIdentity.dispose();
  }
}
