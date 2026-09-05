import { Identity } from "./identity.js";
import type { PubsubEvent } from "./pubsub.js";
import { type JsonValue } from "./rpc.js";
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
export declare class NoHealthyStationError extends Error {
    constructor();
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
export declare class Pool {
    #private;
    private constructor();
    /** Dials the control role against every seed concurrently under
     * `controlIdentity` (the caller's own identity -- publish()/call()
     * are attributed to it on the wire) and resolves once every seed's
     * FIRST connect attempt has settled (success or a logged failure
     * headed into backoff) -- matches tapRoom()'s own "await the first
     * attempt, not the eventual outcome" reasoning (macula-mcp's
     * lobby_observer.ts): a caller that publishes/calls immediately
     * after connect() must not race links still mid-handshake. */
    static connect(seeds: Seed[], controlIdentity: Identity, opts?: PoolOptions): Promise<Pool>;
    /** Publishes to `replicationFactor` currently-live control links
     * (default 1); partial success counts as success. A link whose
     * publish attempt fails is marked for respawn immediately -- this is
     * this v1's only liveness signal for the control role, since it
     * cannot also carry a liveness-only subscribe (see this module's own
     * header doc). Throws NoHealthyStationError if zero links are live. */
    publish(realm: string | undefined, topic: string, payload: JsonValue, opts?: {
        ttlMs?: number;
    }): Promise<void>;
    /** Calls `procedure` against the pool's live control links in order
     * until one succeeds or all have been tried. Throws
     * NoHealthyStationError if zero links are live.
     *
     * A `MaculaCallError` (a real BOLT#4 response -- e.g.
     * unknown_next_peer, unauthorized) does NOT mark its link for
     * respawn: the connection plainly worked, it answered. Found in
     * review 2026-09-05: treating every thrown error as evidence of a
     * dead connection meant a single genuinely-answered error (a
     * procedure nobody serves, a bad realm, a gated call this identity
     * isn't authorized for) tore down and reconnected EVERY live control
     * link in turn as call() moved through them re-trying the same
     * doomed call -- and for a non-idempotent provider handler, actually
     * re-invoked it on each one. Only an error that never got a
     * wire-level answer at all (the same distinction call()'s own doc on
     * Session draws) is treated as a dead link. Each link's own `session`
     * reference is re-checked before scheduling a reconnect, in case a
     * concurrent operation already superseded it between this loop
     * starting and this iteration running. */
    call(realm: string | undefined, procedure: string, payload: JsonValue, opts?: {
        deadlineMs?: number;
    }): Promise<JsonValue>;
    /** Subscribes `handler` to `(realm, topic)`: opens one subscribe-only
     * session against every configured seed, replayed automatically on
     * every future respawn. Mints a dedicated identity for this topic by
     * default (disposed on unsubscribe); pass `identity` to supply the
     * pool's own instead (e.g. for a stable, caller-controlled identity
     * across restarts, matching macula-mcp's own observeRoomIdentityPath
     * pattern) -- the pool never disposes an identity it didn't mint.
     * Returns an unsubscribe function. */
    subscribe(realm: string | undefined, topic: string, handler: (evt: PubsubEvent) => void, identity?: Identity): Promise<() => Promise<void>>;
    /** Live/backing-off CONTROL link counts (publish/call reachability).
     * Every configured seed is exactly one or the other. Per-topic
     * subscription link health is not reflected here -- inspect a
     * specific subscription's own behavior (events arriving or not)
     * instead; exposing N independent per-topic health vectors here
     * would not simplify what a caller actually needs to know. */
    status(): PoolStatus;
    /** Closes every control and subscription link and disposes every
     * identity this pool owns (the caller-supplied control identity
     * included). Awaits each link's in-flight connect/reconnect first,
     * so a still-connecting link never has its identity yanked out from
     * under it. */
    close(): Promise<void>;
}
