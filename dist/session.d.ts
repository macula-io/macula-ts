import { Identity } from "./identity.js";
import { type JsonValue } from "./rpc.js";
/** Options for Session.call(). */
export interface CallOptions {
    /** How long to wait for a RESULT/ERROR before giving up, in
     * milliseconds. Also becomes the wire's own `deadline_ms` (now +
     * this) -- see rpc.ts's DEFAULT_CALL_TIMEOUT_MS for why both share
     * one number. */
    deadlineMs?: number;
}
export declare class Session {
    #private;
    private constructor();
    /** Dials host:port and completes the full CONNECT/HELLO handshake
     * against a real macula-station, via macula-go's connection.Connect
     * (WebPKI trust -- standard CA-bundle validation, matching what the
     * production fleet actually presents; Pinned/Insecure trust modes
     * aren't exposed yet).
     *
     * This is real network I/O -- a QUIC dial plus a signed round trip,
     * bounded by macula-go's own ~30s handshake timeout -- so it's async
     * on both sides of the FFI boundary (see addon/binding.cc's
     * ConnectWorker): awaiting this never blocks Node's event loop.
     *
     * `identity` must stay non-disposed for the life of the returned
     * Session -- close() needs it again to sign GOODBYE. */
    static connect(host: string, port: number, identity: Identity): Promise<Session>;
    /** The address this session's underlying QUIC connection is with. */
    get remoteAddr(): string;
    /** The station's HELLO-verified 32-byte NodeID (Ed25519 public key)
     * -- proof, beyond "connect() didn't throw", that this is a real,
     * application-layer-verified session and not just a QUIC/TLS
     * handshake: frame.Verify already checked this NodeID's signature
     * over the HELLO frame inside connect(), this just surfaces it. */
    get stationNodeId(): Uint8Array;
    /** Sends a signed GOODBYE and closes the connection. Safe to call
     * more than once -- a second call is a no-op, matching Identity's
     * dispose() convention. `identity` must be the same (non-disposed)
     * identity used to open this session; Close needs it to sign
     * GOODBYE. Like connect(), this is real network I/O (a drain sleep
     * plus a write) and runs off the main thread on the native side. */
    close(identity: Identity, reason?: string): Promise<void>;
    /** Caller role: sends a signed CALL for `procedure` and waits for the
     * matching RESULT or ERROR (macula-go's connection.Session.Call).
     * `payload` is JSON, converted to a cbor.Value on the Go side
     * (cabi/wirevalue.go) -- see rpc.ts's JsonValue for the wire's own
     * restrictions (no booleans, bytes as hex strings).
     *
     * Resolves with the RESULT's payload on success. Rejects with a
     * MaculaCallError (rpc.ts) when a real BOLT#4 ERROR frame came back
     * instead -- e.g. `unknown_next_peer` for a procedure nobody has
     * advertised -- carrying its code/name/retryable triple rather than
     * a generic message; rejects with a plain Error for everything that
     * isn't a wire-level answer at all (a local timeout, a dead session,
     * a payload the wire can't represent).
     *
     * Real network I/O -- a signed frame out and a wait for the reply,
     * up to opts.deadlineMs -- so this runs off the main thread on the
     * native side, like connect()/close(). Do not call this
     * concurrently with an active serve() on the SAME Session: both read
     * frames off the one shared control stream, and macula-go's own
     * ServeOneCall/Call docs both warn that mixing roles on one
     * connection races (an unrelated frame arriving first is discarded,
     * not queued) -- open a second Session for the other role instead,
     * exactly what this SDK's own live test does. */
    call(procedure: string, payload: JsonValue, opts?: CallOptions): Promise<JsonValue>;
    /** Provider role: advertises `procedure` (macula-go's
     * connection.Session.Advertise) and answers inbound CALLs against it
     * forever, invoking `handler` for each one (payload in, reply or
     * thrown error out -- `handler` may be async), until the returned
     * stop function is called. A thrown/rejected `handler` becomes a
     * BOLT#4 UnknownError reply carrying the thrown value's message as
     * detail (matching macula-go's connection/serve.go, which maps every
     * handler error to that one code); a `handler` that panics on the Go
     * side instead (not reachable from here -- there is no Go code
     * between this and the JS handler) would map to
     * TemporaryRelayFailure, per that same file.
     *
     * Only one serve() registration is allowed per Session at a time --
     * see call()'s own doc on why mixing roles (or two server loops) on
     * one connection is unsafe, not just inadvisable; open a second
     * Session for a second procedure instead of trying to serve two
     * procedures off one.
     *
     * The returned stop function is async: it unadvertises the
     * procedure (a real network write) and waits for the current poll
     * tick to finish (up to rpc.ts's SERVE_POLL_MS) before resolving --
     * there is no way to interrupt a Go-side wait already in flight, the
     * same bounded-latency shape macula-go's own ServeForever has
     * internally. */
    serve(procedure: string, handler: (payload: JsonValue) => JsonValue | Promise<JsonValue>): Promise<() => Promise<void>>;
}
