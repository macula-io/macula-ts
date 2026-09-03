import type { CallOptions, Session } from "./session.js";
/** What Session.resolveDirect() resolves with: `procedure`'s
 * currently-advertised serving station and its dialable host/port
 * (macula-go's `directdial.Resolve`). */
export interface DirectDialTarget {
    /** Hex-encoded, 32 bytes: the resolved station's NodeID (Ed25519
     * public key) -- the SAME identity Session.callDirect()/
     * callDirectWithUcan() pin the one-hop dial against internally before
     * trusting it. */
    readonly station: string;
    readonly host: string;
    readonly port: number;
}
/** Options for Session.advertiseDirect(). */
export interface AdvertiseDirectOptions {
    /** Same 64-character hex realm convention as CallOptions.realm --
     * MUST match whatever realm resolveDirect()/callDirect()/
     * callDirectWithUcan() (or the Erlang/Rust/Go equivalent) resolve
     * under, or the two sides derive a different discovery URI and resolve
     * comes back exactly as if this was never called at all (see
     * directdial.go's own DiscoveryURI note). Omitted means the all-zero
     * realm, this SDK's sole default before this option existed. */
    realm?: string;
    /** Milliseconds. Defaults to DHT_DEFAULT_TTL_MS (48h) -- matches
     * macula-go's own dht.DefaultTTL, applied Go-side for ttlMs<=0 (not
     * duplicated as a second default here; this SDK's default is threaded
     * through explicitly instead, matching putProcedureAdvertisement's own
     * convention). */
    ttlMs?: number;
}
/** How long keepAdvertisedDirect() waits between re-advertise ticks, in
 * milliseconds, when opts.intervalMs is left unset. This is a real
 * production margin against AdvertiseDirectOptions' own 48h default TTL
 * actually expiring between ticks -- not chosen to match macula-go's own
 * KeepAdvertisedDirect live-test interval (1s there, only to keep that
 * particular test fast). A caller passing a much shorter `ttlMs` should
 * pass a correspondingly shorter `intervalMs` too; this constant does not
 * scale itself to `opts.ttlMs`. */
export declare const KEEP_ADVERTISED_DIRECT_INTERVAL_MS: number;
/** Options for keepAdvertisedDirect(). */
export interface KeepAdvertisedDirectOptions extends AdvertiseDirectOptions {
    /** Milliseconds between re-advertise ticks. Defaults to
     * KEEP_ADVERTISED_DIRECT_INTERVAL_MS. */
    intervalMs?: number;
    /** Called with a tick's own thrown error when a re-advertise tick
     * fails -- a network blip, a genuinely dead session, etc. Matches
     * macula-go's own KeepAdvertisedDirect: a failed tick is reported, not
     * fatal -- this loop tries again at the next interval regardless, and
     * cannot detect or repair a dead Session on its own (a separate, larger
     * concern this does not attempt to solve). Omit to drop the error
     * silently. */
    onError?: (err: unknown) => void;
}
/** Re-advertises `procedure` as direct-dial-reachable on `session` (via
 * `session.advertiseDirect()`) immediately, then again every
 * `opts.intervalMs`, until the returned `stop()` is called -- macula-go's
 * own `KeepAdvertisedDirect` free function, ported here as a standalone
 * helper rather than a Session method for the identical reason
 * macula-go's own is a free function taking a `*connection.Session`
 * rather than a method on one: a station's registration for a procedure
 * does not survive the connection that sent it being replaced, so a
 * long-lived provider needs to call `AdvertiseDirect` again on its own
 * schedule, and it is this function's CALLER's job to decide WHICH
 * Session that runs on. See `Session.advertiseDirect()`'s own doc for why
 * that must NOT be a Session with an active `serve()` on it
 * (`advertiseDirect()`'s own `PutRecord` CALL would race `serve()`'s own
 * reads of the same shared control stream): a long-lived provider that
 * also serves `procedure` needs a SEPARATE Session (and identity -- this
 * fleet enforces one connection per identity, kicking whichever connects
 * second) for that, passed here instead of the serving Session.
 *
 * The returned `stop()` is synchronous -- unlike `Session.serve()`'s own
 * async `stop()`, there is no pending tick to wait out and no unadvertise
 * step: `advertiseDirect()`'s own DHT record simply expires on its own
 * TTL once ticks stop, matching macula-go's own `KeepAdvertisedDirect`,
 * which has no corresponding "undo" either. Calling `stop()` more than
 * once is a no-op. */
export declare function keepAdvertisedDirect(session: Session, procedure: string, opts?: KeepAdvertisedDirectOptions): () => void;
export type { CallOptions };
