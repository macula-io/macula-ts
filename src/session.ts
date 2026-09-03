// A handshaked connection to a real macula-station: transport +
// CONNECT/HELLO, reached through cabi's FFI boundary exactly like
// Identity generation was -- connection.Connect on the Go side already
// does the real QUIC dial, the CBOR frame encoding, and the Ed25519
// sign/verify of the handshake; this file does not reimplement any of
// that, it exposes it.
//
// Scope of this slice: connect/close plus unary RPC, both roles (call
// as caller, serve as provider -- see rpc.ts for the shared payload/
// error shapes). No pubsub, no DHT, no content transfer, no streaming,
// no UCAN -- those build on top of a working Session and are separate
// work.
import { native, type Handle } from "./binding.js";
import { DHT_DEFAULT_TTL_MS, DhtRecordType, type DhtRecord } from "./dht.js";
import { Identity } from "./identity.js";
import type { PublishOptions, PubsubEvent } from "./pubsub.js";
import { DEFAULT_CALL_TIMEOUT_MS, MaculaCallError, SERVE_POLL_MS, type CallEnvelope, type JsonValue } from "./rpc.js";

/** Options for Session.call(). */
export interface CallOptions {
  /** How long to wait for a RESULT/ERROR before giving up, in
   * milliseconds. Also becomes the wire's own `deadline_ms` (now +
   * this) -- see rpc.ts's DEFAULT_CALL_TIMEOUT_MS for why both share
   * one number. */
  deadlineMs?: number;
}

/** One Session.serve() registration -- tracked so a second concurrent
 * serve() on the same Session fails fast instead of racing (see
 * serve()'s own doc for why mixing two server loops, or a server loop
 * and call(), on one Session is unsafe at the protocol level, not just
 * an API nicety). */
interface ActiveServe {
  procedure: string;
  stop: () => Promise<void>;
}

/** One Session.subscribe() registration -- tracked the same way
 * ActiveServe is, and for the identical reason: subscribe()'s
 * background reader goroutine reads frames off this Session's shared
 * control stream on its own schedule, exactly like serve()'s poll loop
 * does, so a second concurrent subscribe() (or a subscribe() alongside
 * serve()/call()/a DHT method) on the same Session races the same way
 * mixing serve() and call() does -- see #requireHandleNotServing's own
 * doc, which this shares. */
interface ActiveSubscription {
  topic: string;
  stop: () => Promise<void>;
}

export class Session {
  #handle: Handle | null;
  // Retained since connect() purely so call()/serve() (added this
  // slice) don't force every caller to re-pass the identity they just
  // used to open the session -- connection.Session itself has no such
  // field (every Go-side signing call takes identity.KeyPair
  // explicitly, see connection.go), so this is a convenience this
  // wrapper adds, not something mirrored from macula-go. close()
  // deliberately still takes identity as an explicit parameter (see
  // its own doc below) -- that contract predates this field and is
  // unchanged, per this repo's own "extend, don't replace" rule.
  #identity: Identity;
  #activeServe: ActiveServe | null = null;
  #activeSubscription: ActiveSubscription | null = null;

  private constructor(handle: Handle, identity: Identity) {
    this.#handle = handle;
    this.#identity = identity;
  }

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
  static async connect(host: string, port: number, identity: Identity): Promise<Session> {
    const handle = await native.sessionConnect(host, port, identity.handleForFfi());
    return new Session(handle, identity);
  }

  #requireHandle(): Handle {
    if (this.#handle === null) {
      throw new Error("macula-ts: Session used after close()");
    }
    return this.#handle;
  }

  /** call()'s own handle-plus-exclusivity guard, factored out since the
   * DHT methods below (findRecord/findRecords/findRecordsByType/
   * putRecord) all end up on this Session's same shared control stream
   * too -- macula-go's dht.FindRecord et al. are themselves just a
   * connection.Session.Call under the hood (see cabi/dht.go), so mixing
   * one of these with an active serve() OR subscribe() on this Session
   * races exactly the way call() itself would: serve()'s poll loop and
   * subscribe()'s background reader both read frames off this same
   * stream on their own schedule, same as call()'s own blocking read
   * does. publish() is deliberately NOT guarded by this: it only ever
   * WRITES a fire-and-forget frame (connection.Session.Publish), never
   * reads, so it does not race a concurrent reader the way call()/
   * serve()/subscribe()/the DHT methods do -- and the live pubsub round
   * trip this SDK's own test performs (subscribe(), then publish() on
   * the SAME Session while that subscription is active) depends on
   * publish() staying unguarded here. */
  #requireHandleNotServing(caller: string): Handle {
    const handle = this.#requireHandle();
    if (this.#activeServe !== null) {
      throw new Error(
        `macula-ts: Session.${caller}() while serve("${this.#activeServe.procedure}") is active on the same ` +
          `Session races on the shared control stream -- open a second Session for the other role.`,
      );
    }
    if (this.#activeSubscription !== null) {
      throw new Error(
        `macula-ts: Session.${caller}() while subscribe("${this.#activeSubscription.topic}") is active on the ` +
          `same Session races on the shared control stream -- open a second Session for the other role.`,
      );
    }
    return handle;
  }

  /** The address this session's underlying QUIC connection is with. */
  get remoteAddr(): string {
    return native.sessionRemoteAddr(this.#requireHandle());
  }

  /** The station's HELLO-verified 32-byte NodeID (Ed25519 public key)
   * -- proof, beyond "connect() didn't throw", that this is a real,
   * application-layer-verified session and not just a QUIC/TLS
   * handshake: frame.Verify already checked this NodeID's signature
   * over the HELLO frame inside connect(), this just surfaces it. */
  get stationNodeId(): Uint8Array {
    return native.sessionStationNodeId(this.#requireHandle());
  }

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
  async close(identity: Identity, reason = ""): Promise<void> {
    if (this.#handle === null) return;
    if (this.#activeSubscription !== null) {
      await this.#activeSubscription.stop();
    }
    const handle = this.#handle;
    this.#handle = null;
    await native.sessionClose(handle, identity.handleForFfi(), reason);
  }

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
  async call(procedure: string, payload: JsonValue, opts: CallOptions = {}): Promise<JsonValue> {
    const handle = this.#requireHandleNotServing("call");
    const timeoutMs = opts.deadlineMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const payloadJson = JSON.stringify(payload ?? null);
    const envelopeJson = await native.sessionCall(handle, this.#identity.handleForFfi(), procedure, undefined, payloadJson, timeoutMs);
    const envelope = JSON.parse(envelopeJson) as CallEnvelope;
    if (envelope.ok) return envelope.payload;
    throw new MaculaCallError(envelope.bolt4);
  }

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
  async serve(procedure: string, handler: (payload: JsonValue) => JsonValue | Promise<JsonValue>): Promise<() => Promise<void>> {
    if (this.#activeServe !== null) {
      throw new Error(
        `macula-ts: Session is already serving "${this.#activeServe.procedure}" -- macula-go's ServeOneCall reads ` +
          `one frame at a time off the shared control stream, so a second concurrent serve() (or a serve() ` +
          `alongside call()) on the same Session races; open a second Session instead.`,
      );
    }
    if (this.#activeSubscription !== null) {
      throw new Error(
        `macula-ts: Session.serve() while subscribe("${this.#activeSubscription.topic}") is active on the same ` +
          `Session races on the shared control stream -- open a second Session for the other role.`,
      );
    }
    const handle = this.#requireHandle();
    const identityHandle = this.#identity.handleForFfi();

    await native.sessionAdvertise(handle, identityHandle, undefined, procedure);

    let stopped = false;
    const loopDone = (async () => {
      while (!stopped) {
        let pendingHandle: Handle | null;
        try {
          pendingHandle = await native.serveWaitForCall(handle, identityHandle, undefined, procedure, SERVE_POLL_MS);
        } catch (err) {
          if (!stopped) {
            console.error(`macula-ts: session.serve("${procedure}") poll failed, stopping this server loop:`, err);
          }
          return;
        }
        if (pendingHandle === null) continue; // nothing arrived this tick -- poll again

        const payload = JSON.parse(native.pendingCallPayloadJson(pendingHandle)) as JsonValue;
        try {
          const reply = await handler(payload);
          await native.pendingCallReplyResult(pendingHandle, JSON.stringify(reply ?? null));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          try {
            await native.pendingCallReplyError(pendingHandle, detail);
          } catch (replyErr) {
            console.error(`macula-ts: session.serve("${procedure}") failed to send a reply:`, replyErr);
          }
        }
      }
    })();

    const stop = async (): Promise<void> => {
      stopped = true;
      await loopDone;
      this.#activeServe = null;
      if (this.#handle !== null) {
        await native.sessionUnadvertise(handle, identityHandle, undefined, procedure);
      }
    };
    this.#activeServe = { procedure, stop };
    return stop;
  }

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
  async findRecordsByType(recordType: DhtRecordType | number): Promise<DhtRecord[]> {
    const handle = this.#requireHandleNotServing("findRecordsByType");
    const json = await native.dhtFindRecordsByType(handle, this.#identity.handleForFfi(), recordType);
    return JSON.parse(json) as DhtRecord[];
  }

  /** DHT: returns every record stored at `key` -- the full
   * signer-deduped multiset at that storage key (macula-go's
   * dht.FindRecords), e.g. every procedure_advertisement for one
   * procedure, not just the first one found. `key` must be exactly 32
   * bytes -- see dht/record.go's ProcedureKey/StationEndpointKey/
   * ContentKey (macula-go) for how those are derived from the thing
   * being looked up. Same I/O and exclusivity notes as
   * findRecordsByType(). */
  async findRecords(key: Uint8Array): Promise<DhtRecord[]> {
    const handle = this.#requireHandleNotServing("findRecords");
    requireKey32(key);
    const json = await native.dhtFindRecords(handle, this.#identity.handleForFfi(), key);
    return JSON.parse(json) as DhtRecord[];
  }

  /** DHT: returns ONE record by storage key (macula-go's
   * dht.FindRecord). Resolves `null` when none exists -- mirrors
   * macula-go's own dht.ErrNotFound, translated to a value instead of a
   * thrown error since "not found" is an expected, routine outcome
   * here, not exceptional. Same I/O and exclusivity notes as
   * findRecordsByType(). */
  async findRecord(key: Uint8Array): Promise<DhtRecord | null> {
    const handle = this.#requireHandleNotServing("findRecord");
    requireKey32(key);
    const json = await native.dhtFindRecord(handle, this.#identity.handleForFfi(), key);
    return json === null ? null : (JSON.parse(json) as DhtRecord);
  }

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
  async putProcedureAdvertisement(
    procedure: string,
    servingStation: Uint8Array,
    opts: { realm?: Uint8Array; ttlMs?: number } = {},
  ): Promise<DhtRecord> {
    const handle = this.#requireHandleNotServing("putProcedureAdvertisement");
    requireKey32(servingStation);
    if (opts.realm !== undefined) requireKey32(opts.realm);
    const json = await native.dhtPutProcedureAdvertisement(
      handle,
      this.#identity.handleForFfi(),
      opts.realm,
      procedure,
      servingStation,
      opts.ttlMs ?? DHT_DEFAULT_TTL_MS,
    );
    return JSON.parse(json) as DhtRecord;
  }

  /** DHT: builds (macula-go's dht.NewContentAnnouncement), signs, and
   * stores a content_announcement naming this Session's own Identity as
   * `mcid`'s (34 bytes) announcer, reachable at `endpoint` (a dialable
   * seed URL, e.g. "https://host:4433" -- NOT a station_endpoint's
   * split host/port). Same reasoning as putProcedureAdvertisement()'s
   * own doc for wrapping macula-go's real constructor instead of a
   * generic JSON-payload builder (announcer_node/mcid are the same kind
   * of raw-byte field). `ttlMs` defaults to DHT_DEFAULT_TTL_MS (48h).
   * Same I/O and exclusivity notes as findRecordsByType(). */
  async putContentAnnouncement(mcid: Uint8Array, endpoint: string, ttlMs = DHT_DEFAULT_TTL_MS): Promise<DhtRecord> {
    const handle = this.#requireHandleNotServing("putContentAnnouncement");
    if (mcid.length !== 34) {
      throw new Error(`macula-ts: content_announcement mcid must be exactly 34 bytes, got ${mcid.length}`);
    }
    const json = await native.dhtPutContentAnnouncement(handle, this.#identity.handleForFfi(), mcid, endpoint, ttlMs);
    return JSON.parse(json) as DhtRecord;
  }

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
  async publish(topic: string, payload: JsonValue, opts: PublishOptions = {}): Promise<void> {
    const handle = this.#requireHandle();
    const payloadJson = JSON.stringify(payload ?? null);
    await native.sessionPublish(handle, this.#identity.handleForFfi(), undefined, topic, payloadJson, opts.ttlMs ?? 0);
  }

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
  async subscribe(topic: string, handler: (evt: PubsubEvent) => void): Promise<() => Promise<void>> {
    if (this.#activeServe !== null) {
      throw new Error(
        `macula-ts: Session.subscribe() while serve("${this.#activeServe.procedure}") is active on the same ` +
          `Session races on the shared control stream -- open a second Session for the other role.`,
      );
    }
    if (this.#activeSubscription !== null) {
      throw new Error(
        `macula-ts: Session is already subscribed to "${this.#activeSubscription.topic}" -- macula-go's ` +
          `RunSubscriber reads one frame at a time off the shared control stream, so a second concurrent ` +
          `subscribe() on the same Session races; open a second Session instead.`,
      );
    }
    const handle = this.#requireHandle();
    const identityHandle = this.#identity.handleForFfi();

    const subscriptionHandle = await native.sessionSubscribeStart(handle, identityHandle, undefined, topic, (evt) => {
      handler({ payload: JSON.parse(evt.payloadJson) as JsonValue, publisher: evt.publisher, seq: evt.seq });
    });

    const stop = async (): Promise<void> => {
      // Cleared only AFTER the native call resolves, not before -- that
      // call is what blocks until the Go-side reader goroutine has
      // actually exited (see native.sessionSubscribeStop's own doc), so
      // clearing this any earlier would let a concurrent call()/serve()/
      // another subscribe() start racing the still-shutting-down reader.
      await native.sessionSubscribeStop(subscriptionHandle);
      this.#activeSubscription = null;
    };
    this.#activeSubscription = { topic, stop };
    return stop;
  }
}

function requireKey32(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(`macula-ts: DHT key must be exactly 32 bytes, got ${key.length}`);
  }
}
