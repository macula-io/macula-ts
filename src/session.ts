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
import { ContentNotFoundError } from "./content.js";
import { DHT_DEFAULT_TTL_MS, DhtRecordType, type DhtRecord } from "./dht.js";
import { Identity } from "./identity.js";
import type { PublishOptions, PubsubEvent, SubscribeOptions } from "./pubsub.js";
import { DEFAULT_CALL_TIMEOUT_MS, MaculaCallError, SERVE_POLL_MS, type CallEnvelope, type JsonValue } from "./rpc.js";
import { Ucan } from "./ucan.js";

/** Options for Session.call()/callWithUcan(). */
export interface CallOptions {
  /** How long to wait for a RESULT/ERROR before giving up, in
   * milliseconds. Also becomes the wire's own `deadline_ms` (now +
   * this) -- see rpc.ts's DEFAULT_CALL_TIMEOUT_MS for why both share
   * one number. */
  deadlineMs?: number;
  /** The realm this CALL is scoped to, as a 64-character lowercase (or
   * uppercase, case-insensitive) hex string -- 32 bytes, the same
   * hex-string convention DhtRecord's own key/version/signature fields
   * already use (dht.ts), not native.*'s raw-byte Uint8Array (this
   * class converts internally -- see realmBytesFromHex below). Omitted
   * means the all-zero realm, the same default every mesh operation in
   * this SDK used exclusively before this option existed, and what
   * macula-go's own realm32OrZero (cabi/main.go) falls back to when no
   * realm pointer is given.
   *
   * Must match whatever realm the target procedure is actually served
   * under, or this CALL comes back `unknown_next_peer` even for a
   * procedure genuinely advertised elsewhere -- realm is an exact-match
   * routing key, not a hierarchy or a default-realm fallback. This
   * class's own `serve()` always advertises under the all-zero realm
   * (a separate, later gap -- see README.md's "What's explicitly not
   * yet implemented"); calling with a non-zero realm only reaches a
   * provider serving under that same realm through some other means. */
  realm?: string;
}

const REALM_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Decodes CallOptions.realm/PublishOptions.realm/SubscribeOptions.realm's
 * public hex-string convention into the 32-byte Uint8Array native.*
 * already accepts for its own `realm` parameter on sessionCall/
 * sessionCallWithUcan/sessionPublish/sessionSubscribeStart -- cabi/rpc.go,
 * cabi/pubsub.go, and addon/binding.cc were, on inspection, already fully
 * wired for an optional realm all the way through (ReadOptionalRealm in
 * binding.cc, realm32OrZero in cabi/main.go); this class's own methods
 * were the only place still hardcoding `undefined`. Kept as a hex string
 * at the PUBLIC surface specifically to match DhtRecord's existing
 * convention, while reusing that already-working raw-byte plumbing
 * beneath it unchanged, rather than re-threading the FFI boundary itself
 * as a second, redundant string convention alongside it.
 * `undefined` in, `undefined` out -- the all-zero-realm default. */
function realmBytesFromHex(realm: string | undefined): Uint8Array | undefined {
  if (realm === undefined) return undefined;
  if (!REALM_HEX_PATTERN.test(realm)) {
    throw new Error(`macula-ts: realm must be exactly 64 hex characters (32 bytes), got ${JSON.stringify(realm)}`);
  }
  return new Uint8Array(Buffer.from(realm, "hex"));
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

  // Serializes every operation that reads this Session's shared
  // control stream: call()/callWithUcan()/the DHT methods, plus
  // serve()'s advertise + each poll tick + unadvertise, plus
  // subscribe()'s start + stop. macula-go's connection/frame_stream.go
  // RecvFrame mutates a shared buffer with no mutex of its own, so two
  // reads racing it corrupt the stream -- verified live: `Promise.all`
  // of 4 concurrent call()s on one Session left EVERY later read on
  // that same Session permanently failing "claimed frame length ...
  // exceeds the 16777215-byte cap" (a torn buffer), not just that one
  // batch. The `#activeServe`/`#activeSubscription` checks above only
  // ever protected call()-family operations from an ACTIVE serve()/
  // subscribe() -- they did nothing to stop two ordinary call()s (or a
  // call() racing a DHT method) from racing each other, since neither
  // flag is set in that case. This queue is what actually closes that
  // gap: every control-stream-reading native call funnels through
  // #enqueue, so only one is ever in flight at a time, regardless of
  // which method it came from. publish()/putContent()/getContent() do
  // NOT go through this -- see their own docs for why (a pure write,
  // and each own dedicated QUIC stream, respectively -- neither reads
  // this shared stream at all).
  #queue: Promise<void> = Promise.resolve();

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn);
    // The chain itself must never become a rejected promise -- that
    // would wedge every future caller behind a permanently-broken
    // link. Each waiter still gets ITS OWN real result/rejection via
    // the `result` returned below; only the internal sequencing link
    // swallows the outcome.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

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
      // Swallowed, not awaited-and-propagated: a subscription whose
      // connection already died (or whose stop() otherwise fails) must
      // never prevent this Session from actually closing -- verified
      // live that letting that rejection abort close() left the
      // Session's handle un-nulled (leaked) and unclosable on every
      // subsequent attempt. Whatever happened here is either already
      // reported (subscribe()'s own onClosed, if that's why this
      // failed) or genuinely not this method's problem to surface --
      // close() closing the underlying session either way is the
      // actual guarantee this method makes.
      try {
        await this.#activeSubscription.stop();
      } catch (err) {
        console.error(`macula-ts: session.close() couldn't cleanly stop an active subscription first (closing anyway):`, err);
      }
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
    const realm = realmBytesFromHex(opts.realm);
    const envelopeJson = await this.#enqueue(() =>
      native.sessionCall(handle, this.#identity.handleForFfi(), procedure, realm, payloadJson, timeoutMs),
    );
    const envelope = JSON.parse(envelopeJson) as CallEnvelope;
    if (envelope.ok) return envelope.payload;
    throw new MaculaCallError(envelope.bolt4);
  }

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
  async callWithUcan(procedure: string, payload: JsonValue, ucanToken: string | Ucan, opts: CallOptions = {}): Promise<JsonValue> {
    const handle = this.#requireHandleNotServing("callWithUcan");
    const timeoutMs = opts.deadlineMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const payloadJson = JSON.stringify(payload ?? null);
    const realm = realmBytesFromHex(opts.realm);
    const token = typeof ucanToken === "string" ? ucanToken : ucanToken.token;
    const envelopeJson = await this.#enqueue(() =>
      native.sessionCallWithUcan(
        handle,
        this.#identity.handleForFfi(),
        procedure,
        realm,
        payloadJson,
        timeoutMs,
        token,
      ),
    );
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

    // Marked BEFORE the advertise await below, not after -- closing the
    // exact race window this repo's own live testing found: a
    // concurrent call()/serve()/subscribe() checks #activeServe
    // synchronously, so it must already be non-null by the time this
    // function's first await yields control, not only once advertise
    // has finished. The placeholder stop() is only reachable if
    // something races this same synchronous tick (impossible in
    // practice, single-threaded JS) or misuses the handle before
    // startup finishes; rolled back to null below if advertise itself
    // fails, so a failed serve() attempt doesn't leave the Session
    // permanently (and incorrectly) marked as serving.
    const placeholderStop = async (): Promise<void> => {
      throw new Error(`macula-ts: session.serve("${procedure}") has not finished starting yet`);
    };
    this.#activeServe = { procedure, stop: placeholderStop };

    try {
      await this.#enqueue(() => native.sessionAdvertise(handle, identityHandle, undefined, procedure));
    } catch (err) {
      this.#activeServe = null;
      throw err;
    }

    let stopped = false;
    const loopDone = (async () => {
      while (!stopped) {
        let pendingHandle: Handle | null;
        try {
          pendingHandle = await this.#enqueue(() =>
            native.serveWaitForCall(handle, identityHandle, undefined, procedure, SERVE_POLL_MS),
          );
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
        await this.#enqueue(() => native.sessionUnadvertise(handle, identityHandle, undefined, procedure));
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
    const json = await this.#enqueue(() => native.dhtFindRecordsByType(handle, this.#identity.handleForFfi(), recordType));
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
    const json = await this.#enqueue(() => native.dhtFindRecords(handle, this.#identity.handleForFfi(), key));
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
    const json = await this.#enqueue(() => native.dhtFindRecord(handle, this.#identity.handleForFfi(), key));
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
   * `call()`'s own default (see CallOptions.realm's own doc: `call()`/
   * `callWithUcan()`/`publish()`/`subscribe()` now all take an optional
   * realm; `serve()`/`advertise` remain all-zero-realm-only for this
   * slice, unchanged). This method
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
    const json = await this.#enqueue(() =>
      native.dhtPutProcedureAdvertisement(
        handle,
        this.#identity.handleForFfi(),
        opts.realm,
        procedure,
        servingStation,
        opts.ttlMs ?? DHT_DEFAULT_TTL_MS,
      ),
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
    const json = await this.#enqueue(() =>
      native.dhtPutContentAnnouncement(handle, this.#identity.handleForFfi(), mcid, endpoint, ttlMs),
    );
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
   * `opts.realm` (see CallOptions.realm's own doc for the hex-string
   * format and exact-match semantics) scopes which realm this EVENT is
   * published under -- omitted means the all-zero realm, this SDK's
   * sole default before this option existed. A subscribe() only
   * receives this event if its own realm matches exactly.
   *
   * Real network I/O (one signed frame write) -- runs off the main
   * thread on the native side, like every other network-touching method
   * here. */
  async publish(topic: string, payload: JsonValue, opts: PublishOptions = {}): Promise<void> {
    const handle = this.#requireHandle();
    const payloadJson = JSON.stringify(payload ?? null);
    const realm = realmBytesFromHex(opts.realm);
    await native.sessionPublish(handle, this.#identity.handleForFfi(), realm, topic, payloadJson, opts.ttlMs ?? 0);
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
   * UNSUBSCRIBE) -- both run off the main thread on the native side.
   *
   * `opts.realm` (see CallOptions.realm's own doc for the hex-string
   * format and exact-match semantics) scopes which realm this SUBSCRIBE
   * listens on -- omitted means the all-zero realm, this SDK's sole
   * default before this option existed. Only an EVENT published under
   * the SAME realm is ever delivered to `handler`.
   *
   * If the underlying connection dies (or any other transport error
   * ends the background reader) rather than the returned stop() being
   * called, this subscription tears itself down automatically -- the
   * native handle is released and this Session is left closable and
   * reusable for a fresh subscribe()/serve()/call() -- and, if
   * provided, `opts.onClosed` is called once with the error. Verified
   * live that, without this, such a subscription went silent forever
   * (no further events, no error) and left this Session's handle
   * permanently open even after close(). */
  async subscribe(topic: string, handler: (evt: PubsubEvent) => void, opts: SubscribeOptions = {}): Promise<() => Promise<void>> {
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
    const realm = realmBytesFromHex(opts.realm);

    // Marked BEFORE the subscribe-start await below, not after -- same
    // race-window fix as serve()'s own placeholder above, and for the
    // identical reason (this repo's own live testing found the same
    // class of race on both). Rolled back to null if starting the
    // subscription itself fails.
    const placeholderStop = async (): Promise<void> => {
      throw new Error(`macula-ts: session.subscribe("${topic}") has not finished starting yet`);
    };
    this.#activeSubscription = { topic, stop: placeholderStop };

    // subscriptionHandle is assigned once (right after sessionSubscribeStart
    // resolves, below) and only ever READ from here on -- realStop
    // cannot run before that assignment, since nothing can call stop()
    // (directly or via onClosed) before this function itself returns it.
    let subscriptionHandle!: Handle;
    let stopPromise: Promise<void> | null = null;

    const realStop = async (): Promise<void> => {
      this.#activeSubscription = null;
      await this.#enqueue(() => native.sessionSubscribeStop(subscriptionHandle));
    };
    // Memoized so it is safe to call more than once, from more than one
    // place -- the caller's own returned stop(), AND onClosed's own
    // internal call below when the reader exits on its own -- without
    // either double-invoking the native stop (which would either be a
    // wasted call or, worse, race a second subscribe() that had since
    // reused this Session). Whichever caller gets here first actually
    // runs realStop(); everyone else gets that same settled outcome.
    const stop = (): Promise<void> => {
      if (stopPromise === null) stopPromise = realStop();
      return stopPromise;
    };

    const onClosed = (error: Error): void => {
      console.error(`macula-ts: session.subscribe("${topic}") ended unexpectedly, tearing it down:`, error);
      // This internal call's own rejection (the underlying transport
      // error realStop's native call surfaces once more, tearing down
      // an already-dead subscription) is not new information -- error
      // is already being reported via onClosed itself, right below.
      // A caller's OWN explicit call to the returned stop() afterward
      // still resolves/rejects for real, from the same memoized promise.
      stop().catch(() => {});
      opts.onClosed?.(error);
    };

    try {
      subscriptionHandle = await this.#enqueue(() =>
        native.sessionSubscribeStart(handle, identityHandle, realm, topic, (msg) => {
          if (msg.kind === "closed") {
            onClosed(new Error(msg.error ?? "subscription closed"));
            return;
          }
          handler({ payload: JSON.parse(msg.payloadJson) as JsonValue, publisher: msg.publisher, seq: msg.seq });
        }),
      );
    } catch (err) {
      this.#activeSubscription = null;
      throw err;
    }

    this.#activeSubscription = { topic, stop };
    return stop;
  }

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
  async putContent(data: Uint8Array, name = ""): Promise<{ mcid: string }> {
    const handle = this.#requireHandle();
    const mcid = await native.contentPut(handle, this.#identity.handleForFfi(), data, name);
    return { mcid };
  }

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
  async getContent(mcid: string): Promise<Uint8Array> {
    const handle = this.#requireHandle();
    const data = await native.contentGet(handle, this.#identity.handleForFfi(), mcid);
    if (data === null) throw new ContentNotFoundError(mcid);
    return data;
  }
}

function requireKey32(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(`macula-ts: DHT key must be exactly 32 bytes, got ${key.length}`);
  }
}
