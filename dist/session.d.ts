import { DhtRecordType, type DhtRecord } from "./dht.js";
import { Identity } from "./identity.js";
import type { PublishOptions, PubsubEvent } from "./pubsub.js";
import { type JsonValue } from "./rpc.js";
import { Ucan } from "./ucan.js";
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
     * plus a write) and runs off the main thread on the native side.
     *
     * Stops an active subscribe() FIRST, if there is one, sending its
     * UNSUBSCRIBE over the still-open connection before that connection
     * goes away -- unlike every other resource this SDK hands out (an
     * Identity, an unstopped serve() loop), an unstopped subscription
     * left dangling here does not just leak memory: its background reader
     * goroutine holds a live Napi::ThreadSafeFunction, which deliberately
     * keeps Node's event loop alive on its own (see subscribe()'s own doc
     * -- a program that does nothing but subscribe() and wait needs
     * exactly this to stay alive for events to arrive at all). Verified
     * live: closing a Session out from under an active subscription
     * without this hung the process forever, not merely leaked a handle
     * -- close() closing it first is what makes "forgot to call the
     * returned stop()" fail safe instead of fail hung. */
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
    /** Caller role: call(), attaching `ucanToken` to the outgoing CALL
     * (macula-go's `connection.Session.CallWithUCAN`) -- for invoking a
     * procedure a provider has gated behind a `ucan.Policy.Required`
     * policy on its own side (this SDK does not implement that provider
     * side itself -- see ucan.ts's own module doc). `ucanToken` may be a
     * `Ucan` (as returned by `Ucan.mint()`/`Ucan.decode()` -- its `.token`
     * is attached) or a raw token string directly.
     *
     * Same resolve/reject shape as `call()` in every other respect: the
     * RESULT's payload on success, a `MaculaCallError` for a real BOLT#4
     * ERROR frame (e.g. `unauthorized` for a token that fails the
     * provider's policy check, or `unknown_next_peer` for a procedure
     * nobody has advertised), a plain `Error` for anything that never got
     * a wire-level answer at all.
     *
     * Deliberately attaches whatever token bytes it is given with NO local
     * check relating this Session's own identity to `ucanToken`'s `aud`
     * claim -- see ucan.ts's own module doc for why: macula's UCAN gate is
     * a bearer-token check (signature + expiry against the token's
     * issuer), and the real wire-level gate never looks at the caller's
     * identity against `aud` either. A client-side guard here would both
     * reject configurations the mesh accepts fine and misrepresent a
     * security property that isn't actually enforced.
     *
     * Real network I/O, off the main thread on the native side, and
     * subject to the identical same-Session exclusivity rule as `call()`
     * (`#requireHandleNotServing`) -- both end up on the same shared
     * control stream. */
    callWithUcan(procedure: string, payload: JsonValue, ucanToken: string | Ucan, opts?: CallOptions): Promise<JsonValue>;
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
    /** DHT: returns every record of `recordType` currently visible from
     * the station this Session is connected to (macula-go's
     * dht.FindRecordsByType, via a signed CALL to `_dht.find_records_by_type`
     * under the DHT's own reserved realm -- threaded internally, this
     * method never touches a realm itself). Coverage depends on that
     * station's own view of the mesh, not a global guarantee. Neither
     * this nor findRecord/findRecords verifies a returned record's
     * signature or checks its expiry -- see DhtRecord's own doc (dht.ts).
     *
     * Real network I/O, off the main thread on the native side, exactly
     * like call() -- and subject to the same same-Session exclusivity
     * rule as call() (see #requireHandleNotServing's own doc): do not
     * call this while serve() is active on the same Session. */
    findRecordsByType(recordType: DhtRecordType | number): Promise<DhtRecord[]>;
    /** DHT: returns every record stored at `key` -- the full
     * signer-deduped multiset at that storage key (macula-go's
     * dht.FindRecords), e.g. every procedure_advertisement for one
     * procedure, not just the first one found. `key` must be exactly 32
     * bytes -- see dht/record.go's ProcedureKey/StationEndpointKey/
     * ContentKey (macula-go) for how those are derived from the thing
     * being looked up. Same I/O and exclusivity notes as
     * findRecordsByType(). */
    findRecords(key: Uint8Array): Promise<DhtRecord[]>;
    /** DHT: returns ONE record by storage key (macula-go's
     * dht.FindRecord). Resolves `null` when none exists -- mirrors
     * macula-go's own dht.ErrNotFound, translated to a value instead of a
     * thrown error since "not found" is an expected, routine outcome
     * here, not exceptional. Same I/O and exclusivity notes as
     * findRecordsByType(). */
    findRecord(key: Uint8Array): Promise<DhtRecord | null>;
    /** DHT: builds the realm-qualified discovery URI (macula-go's
     * dht.DiscoveryURI), then builds (dht.NewProcedureAdvertisement),
     * signs, and stores a procedure_advertisement naming this Session's
     * own Identity as `procedure`'s advertiser and `servingStation` (32
     * bytes -- a station's NodeID, typically this Session's own
     * `stationNodeId`) as the station that serves it.
     *
     * `realm` should be the SAME realm `procedure` is (or will be) served
     * under via `serve()` -- defaults to the all-zero realm, matching
     * `call()`/`serve()`'s own current default (see their own docs' known
     * gap: realm isn't yet a public parameter on either). This method
     * builds the qualified URI itself (dht.DiscoveryURI) rather than
     * taking a pre-qualified string, since NewProcedureAdvertisement's own
     * doc is explicit that "the advertiser and the resolver must derive
     * the identical URI or the DHT storage key will not agree" -- a
     * caller-supplied pre-qualified string invites exactly that class of
     * bug (verified directly: an earlier draft of this SDK's own live
     * test got this wrong by hand-qualifying the URI itself, and its
     * following findRecord() came back not-found until this method built
     * the URI internally instead).
     *
     * Wraps macula-go's REAL constructor rather than a generic
     * JSON-payload builder deliberately -- see cabi/dht.go's own doc on
     * why: two of this record type's payload fields (advertiser_node,
     * serving_station) are raw 32-byte pubkeys that must be actual CBOR
     * byte strings for a real resolver to read, and this SDK's generic
     * JSON<->cbor.Value conversion (rpc.ts's JsonValue, wirevalue.go) has
     * no way to produce those going IN -- only OUT, as "0x"-prefixed hex
     * (see DhtRecord's own doc). `ttlMs` defaults to DHT_DEFAULT_TTL_MS
     * (48h). Resolves with the signed record actually stored. Same I/O
     * and exclusivity notes as findRecordsByType(). */
    putProcedureAdvertisement(procedure: string, servingStation: Uint8Array, opts?: {
        realm?: Uint8Array;
        ttlMs?: number;
    }): Promise<DhtRecord>;
    /** DHT: builds (macula-go's dht.NewContentAnnouncement), signs, and
     * stores a content_announcement naming this Session's own Identity as
     * `mcid`'s (34 bytes) announcer, reachable at `endpoint` (a dialable
     * seed URL, e.g. "https://host:4433" -- NOT a station_endpoint's
     * split host/port). Same reasoning as putProcedureAdvertisement()'s
     * own doc for wrapping macula-go's real constructor instead of a
     * generic JSON-payload builder (announcer_node/mcid are the same kind
     * of raw-byte field). `ttlMs` defaults to DHT_DEFAULT_TTL_MS (48h).
     * Same I/O and exclusivity notes as findRecordsByType(). */
    putContentAnnouncement(mcid: Uint8Array, endpoint: string, ttlMs?: number): Promise<DhtRecord>;
    /** Pubsub: sends a signed PUBLISH for `topic` (macula-go's
     * connection.Session.Publish, which also attaches the end-to-end
     * publisher_sig a relayed EVENT needs to survive beyond one hop --
     * see that method's own doc, not reimplemented here). `payload`
     * follows the same JsonValue rules as call()'s payload (no boolean,
     * embedded bytes as "0x"-prefixed hex). Fire-and-forget: Publish's
     * own doc is explicit that no reply is expected on the wire, so the
     * returned Promise resolving only means this Session's own frame was
     * encoded, signed, and sent -- never that any subscriber received it
     * (macula-go's own live test for this, TestLivePubSubRoundTrip,
     * observes a subscriber's own publish arriving back at it rather than
     * asserting it as a hard guarantee, for the same reason).
     *
     * Deliberately NOT guarded by the same-Session exclusivity rule
     * call()/serve()/subscribe()/the DHT methods share (see
     * #requireHandleNotServing's own doc) -- publish() only ever writes,
     * never reads off the shared control stream, so it does not race a
     * concurrent serve()/subscribe() the way those do, and can run safely
     * on the SAME Session a subscribe() of its own is active on -- exactly
     * what a subscriber publishing to (and receiving) its own topic needs.
     *
     * Real network I/O (one signed frame write) -- runs off the main
     * thread on the native side, like every other network-touching method
     * here. */
    publish(topic: string, payload: JsonValue, opts?: PublishOptions): Promise<void>;
    /** Pubsub: sends a signed SUBSCRIBE for `topic`, then delivers every
     * inbound EVENT for it to `handler` -- macula-go's own
     * connection.Session.RunSubscriber (connection/subscriber.go) drives
     * the actual read loop on the Go side, in a background goroutine, NOT
     * reimplemented on top of a hand-rolled poll here (see cabi/pubsub.go's
     * own doc for why RunSubscriber specifically, over the lower-level
     * RecvEvent). Delivery is Go-driven, not JS-driven: unlike serve()'s
     * poll loop, nothing on this side calls into the native layer
     * repeatedly to ask "did anything arrive yet" -- the addon calls INTO
     * this handler asynchronously, via a Napi::ThreadSafeFunction wired to
     * that background goroutine, whenever an EVENT actually shows up.
     *
     * Only one subscribe() (and no active serve()) is allowed per Session
     * at a time -- same reasoning as serve()'s own one-at-a-time rule
     * (#requireHandleNotServing's own doc): the background reader and any
     * other read off this Session's shared control stream would race.
     * Open a second Session for a second topic (or to serve/call
     * concurrently) instead.
     *
     * Resolves with an async stop() function once the initial SUBSCRIBE
     * has been sent and the background reader has started. stop() sends
     * the matching UNSUBSCRIBE and does not resolve until the Go-side
     * reader goroutine has genuinely exited -- calling it and awaiting the
     * result is the actual guarantee that no further `handler` call can
     * happen afterward, not just that one was requested.
     *
     * Real network I/O (the initial SUBSCRIBE send, and stop()'s
     * UNSUBSCRIBE) -- both run off the main thread on the native side. */
    subscribe(topic: string, handler: (evt: PubsubEvent) => void): Promise<() => Promise<void>>;
    /** Content transfer: stores `data` (macula-go's content.Put, on this
     * Session's own fresh dedicated QUIC stream -- Session.
     * OpenDedicatedStream on the Go side, NOT the shared control stream
     * call()/serve()/the DHT methods/subscribe() all read from), chunking
     * automatically above manifest.DefaultChunkSize (256 KiB) and
     * returning the hex-encoded mcid it's now addressable by. `name` is
     * used ONLY on the chunked path (attached to the resulting manifest)
     * -- a single-block put ignores it entirely, matching content.Put's
     * own documented behavior; leave it unset for small blobs.
     *
     * NOT durable object storage -- see content.ts's own module doc: a
     * station may forget this content later, and there is no list/delete
     * operation. Treat this as "hand these bytes to a peer once."
     *
     * Because Put opens its own dedicated stream instead of reading the
     * shared control stream, this is, unlike call()/serve()/the DHT
     * methods/subscribe(), never subject to Session's same-Session
     * exclusivity guard (#requireHandleNotServing) -- it can run
     * concurrently with an active serve()/subscribe() (or another
     * putContent()/getContent()) on the same Session without racing.
     *
     * Real network I/O (one or more signed CALLs on the new stream) --
     * runs off the main thread on the native side, like every other
     * network-touching method here. */
    putContent(data: Uint8Array, name?: string): Promise<{
        mcid: string;
    }>;
    /** Content transfer: fetches and verifies (macula-go's content.Get,
     * on its own fresh dedicated QUIC stream, same reasoning as
     * putContent() -- including content.Get's own client-side hash
     * re-check against `mcid`: a station may only be relaying content it
     * doesn't itself store, so its answer is never trusted blindly) the
     * content addressed by `mcid` (the hex string putContent() returned).
     *
     * Rejects with ContentNotFoundError (content.ts) specifically when
     * the station reports it doesn't know this mcid -- an expected,
     * routine outcome for a one-time transfer mechanism with no
     * durability guarantee, not a transport failure; every other failure
     * (a bad session, a malformed mcid, a real transport error) rejects
     * with a plain Error instead.
     *
     * Same dedicated-stream, no-exclusivity-guard reasoning as
     * putContent() -- safe alongside an active serve()/subscribe() on the
     * same Session. Real network I/O, runs off the main thread. */
    getContent(mcid: string): Promise<Uint8Array>;
}
