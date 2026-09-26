// A node's pool of station links on the macula 12 mesh, as macula-go's pool
// keeps it: every seed pinned by its node_id, the realms whose keys the node
// trusts, and one identity for every link. Calls and streams reach a provider
// by direct dial: its advertisements from the DHT, trusted only when the
// realm's key authorizes them (or, in a node's own namespace `~<node_id>/`,
// only when that node signed them), and the station it serves from dialed
// pinned.
import { native, type Delivery, type Handle } from "./binding.js";
import { NodeKey } from "./key.js";
import { Stream, StreamMode, type StreamRequest } from "./stream.js";
import { DEFAULT_CONTENT_TIMEOUT_MS, mcid50, type ContentOptions, type Mcid } from "./content.js";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  MaculaError,
  bytesOut,
  hex,
  id32,
  type BytesOutput,
  type Id,
  type JsonValue,
} from "./wire.js";

/** A station to link to, pinned by the node_id it must prove. */
export interface Seed {
  readonly host: string;
  readonly port: number;
  readonly nodeId: Id;
}

export interface PoolOptions {
  /** Each realm's key as carried (hex or bytes), by realm id: an
   * advertisement in a realm is trusted only when its authorization verifies
   * against it, and a procedure is served only in a realm it names. */
  readonly realmTrust?: ReadonlyArray<{ readonly realm: Id; readonly key: string | Uint8Array }>;
  readonly replicationFactor?: number;
  readonly maxDirectLinks?: number;
  readonly respawnDelayMs?: number;
  /** How long connect waits for a first link, 30 s by default. */
  readonly timeoutMs?: number;
}

/** One of the pool's links. */
export interface LinkStatus {
  readonly station: string;
  readonly host: string;
  readonly port: number;
  readonly direct: boolean;
  readonly up: boolean;
}

/** A trusted provider of a procedure and the station it serves from. */
export interface Provider {
  readonly node: string;
  readonly station: string;
}

/** An event a subscription heard, verified. */
export interface Event {
  readonly publisher: string;
  readonly realm: string;
  readonly topic: string;
  readonly seq: number;
  readonly publishedAt: number;
  readonly payload: JsonValue;
  readonly deliveredVia: string;
}

/** A served call's request. */
export interface Request {
  readonly caller: string;
  readonly realm: string;
  readonly procedure: string;
  readonly payload: JsonValue;
  readonly deadlineMs: number;
}

/** A verified DHT record: its type, signer's key id, times, payload, and wire
 * bytes (tagged). */
export interface DhtRecord {
  readonly type: number;
  readonly keyId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly payload: JsonValue;
  readonly wire: JsonValue;
}

/** macula 12's record types. */
export enum RecordType {
  NodeRecord = 0x01,
  ProcedureAdvertisement = 0x06,
  Tombstone = 0x0c,
  ContentAnnouncement = 0x11,
  StationEndpoint = 0x12,
  OrgDirectory = 0x15,
  ProcedureDelegation = 0x16,
}

/** A subscription, until stop() or the pool closes. */
export class Subscription {
  /** @internal */
  constructor(private readonly handle: Handle, readonly closed: Promise<string | null>) {}

  /** Ends the subscription on every link. */
  async stop(): Promise<void> {
    await native.subscriptionStop(this.handle);
  }
}

/** A served procedure, until stop(). */
export class Served {
  private stopped = false;

  /** @internal */
  constructor(private readonly handle: Handle) {}

  /** Withdraws the procedure on every link. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await native.servedStop(this.handle);
  }
}

export class Pool {
  private closed = false;

  private constructor(private readonly handle: Handle) {}

  /** Links the key's node to every seed, and resolves once one link is up. */
  static async connect(key: NodeKey, seeds: readonly Seed[], options: PoolOptions = {}): Promise<Pool> {
    const seedJson = seeds.map((s) => ({ host: s.host, port: s.port, node_id: hex(id32(s.nodeId, "a seed's nodeId")) }));
    const realmTrust: Record<string, string> = {};
    for (const t of options.realmTrust ?? []) {
      realmTrust[hex(id32(t.realm, "a realm id"))] = typeof t.key === "string" ? t.key : hex(t.key);
    }
    const opts = {
      realm_trust: realmTrust,
      replication_factor: options.replicationFactor ?? 0,
      max_direct_links: options.maxDirectLinks ?? 0,
      respawn_delay_ms: options.respawnDelayMs ?? 0,
      timeout_ms: options.timeoutMs ?? 0,
    };
    return new Pool(await native.poolConnect(key.live(), JSON.stringify(seedJson), JSON.stringify(opts)));
  }

  /** The node_id the pool links as. */
  nodeId(): string {
    return hex(native.poolNodeId(this.live()));
  }

  /** name in this node's own namespace, `~<node_id>/<name>`: a procedure it
   * serves with no org and no realm key, authorized by its advertisement's
   * signature alone, and that any node calls with no realm key pinned. */
  ownProcedure(name: string): string {
    return `~${this.nodeId()}/${name}`;
  }

  /** Every link the pool holds. */
  status(): LinkStatus[] {
    return JSON.parse(native.poolStatus(this.live())) ?? [];
  }

  /** Calls procedure in realm at a provider (any trusted one unless
   * `provider` names one) by direct dial. A provider's ERROR is thrown as a
   * ProviderError, a station's relay error as a RelayError. */
  async call(realm: Id, procedure: string, payload: JsonValue = {},
    options: { provider?: Id; timeoutMs?: number; bytes?: BytesOutput } = {}): Promise<JsonValue> {
    bytesOut(null, options.bytes);
    const result = await native.poolCall(this.live(), id32(realm, "realm"), procedure, JSON.stringify(payload),
      options.provider === undefined ? null : id32(options.provider, "provider"),
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    return bytesOut(JSON.parse(result), options.bytes);
  }

  /** The procedure's trusted providers, freshest first. */
  async providers(realm: Id, procedure: string, options: { timeoutMs?: number } = {}): Promise<Provider[]> {
    return JSON.parse(await native.poolProviders(this.live(), id32(realm, "realm"), procedure,
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)) ?? [];
  }

  /** Publishes payload on topic in realm. Topics name a kind of fact; ids go
   * in the payload. */
  async publish(realm: Id, topic: string, payload: JsonValue, options: { ttlMs?: number } = {}): Promise<void> {
    await native.poolPublish(this.live(), id32(realm, "realm"), topic, JSON.stringify(payload), options.ttlMs ?? 0);
  }

  /** Subscribes to topic in realm: onEvent hears each verified event once,
   * however many links deliver it. `closed` resolves when the subscription
   * ends, with why or null. */
  async subscribe(realm: Id, topic: string, onEvent: (event: Event) => void,
    options: { bytes?: BytesOutput } = {}): Promise<Subscription> {
    let settle: (why: string | null) => void = () => {};
    const closed = new Promise<string | null>((resolve) => (settle = resolve));
    bytesOut(null, options.bytes);
    const handle = await native.poolSubscribe(this.live(), id32(realm, "realm"), topic,
      (d: Delivery) => {
        if (d.kind === "closed") {
          settle(d.json === "" ? null : d.json);
          return;
        }
        const e = JSON.parse(d.json);
        onEvent({ publisher: e.publisher, realm: e.realm, topic: e.topic, seq: e.seq, publishedAt: e.published_at,
          payload: bytesOut(e.payload, options.bytes), deliveredVia: e.delivered_via });
      });
    return new Subscription(handle, closed);
  }

  /** Serves procedure in realm: handler answers each call, and its thrown
   * error goes back as a handler_error with its message. An org procedure
   * needs the realm's key pinned and the org's delegation to this node in the
   * DHT; a procedure in this node's own namespace (ownProcedure) needs
   * neither, and another node's namespace is refused. */
  async serve(realm: Id, procedure: string, handler: (request: Request) => JsonValue | Promise<JsonValue>,
    options: { bytes?: BytesOutput } = {}): Promise<Served> {
    bytesOut(null, options.bytes);
    const handle = await native.poolServe(this.live(), id32(realm, "realm"), procedure,
      (d: Delivery) => {
        if (d.kind !== "request") return;
        void answer(d, handler, options.bytes);
      });
    return new Served(handle);
  }

  /** Serves procedure in realm as a stream of mode: handler drives each
   * session. The stream is closed when the handler returns without ending
   * it, aborted with code error when it throws, and released either way. */
  async serveStream(realm: Id, procedure: string, mode: StreamMode,
    handler: (stream: Stream, request: StreamRequest) => void | Promise<void>,
    options: { bytes?: BytesOutput } = {}): Promise<Served> {
    bytesOut(null, options.bytes);
    const handle = await native.poolServeStream(this.live(), id32(realm, "realm"), procedure, mode,
      (d: Delivery) => {
        if (d.kind !== "request") return;
        void runStream(new Stream(d.handle, options.bytes), handler);
      });
    return new Served(handle);
  }

  /** Opens a stream of mode on procedure in realm at a provider, by direct
   * dial. A refusal arrives on its first recv(). */
  async openStream(realm: Id, procedure: string, mode: StreamMode, payload: JsonValue = {},
    options: { provider?: Id; deadlineMs?: number; timeoutMs?: number; bytes?: BytesOutput } = {}): Promise<Stream> {
    bytesOut(null, options.bytes);
    const handle = await native.poolOpenStream(this.live(), id32(realm, "realm"), procedure, mode,
      JSON.stringify(payload), options.provider === undefined ? null : id32(options.provider, "provider"),
      options.deadlineMs ?? 0, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    return new Stream(handle, options.bytes);
  }

  /** The verified record under key, or null when there is none. */
  async findRecord(key: Id, options: { timeoutMs?: number; bytes?: BytesOutput } = {}): Promise<DhtRecord | null> {
    bytesOut(null, options.bytes);
    try {
      return toRecord(JSON.parse(await native.poolFindRecord(this.live(), id32(key, "key"),
        options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)), options.bytes);
    } catch (e) {
      if (e instanceof MaculaError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /** Every verified record under key, and how many did not verify. */
  async findRecords(key: Id, options: { timeoutMs?: number; bytes?: BytesOutput } = {}):
    Promise<{ records: DhtRecord[]; dropped: number }> {
    bytesOut(null, options.bytes);
    return toRecords(JSON.parse(await native.poolFindRecords(this.live(), id32(key, "key"),
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)), options.bytes);
  }

  /** Every verified record of type the station holds, and how many did not
   * verify. */
  async findRecordsByType(type: RecordType | number, options: { timeoutMs?: number; bytes?: BytesOutput } = {}):
    Promise<{ records: DhtRecord[]; dropped: number }> {
    bytesOut(null, options.bytes);
    return toRecords(JSON.parse(await native.poolFindRecordsByType(this.live(), type,
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)), options.bytes);
  }

  /** Shares data in realm: this node keeps it, serves it on its own
   * `~<node_id>/content_v1` and announces it, renewing the announcement until
   * unshareContent or close. Data of at most 256 KiB is one raw block; larger
   * data a manifest over 256 KiB chunks, named name. Resolves to the content
   * id as hex. Serving needs stations that admit a node's own namespace. */
  async shareContent(realm: Id, data: Uint8Array, name = "", options: { timeoutMs?: number } = {}): Promise<string> {
    return hex(await native.poolShareContent(this.live(), id32(realm, "realm"), data, name,
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS));
  }

  /** Stops sharing mcid in realm and withdraws its announcement. */
  async unshareContent(realm: Id, mcid: Mcid, options: { timeoutMs?: number } = {}): Promise<void> {
    await native.poolUnshareContent(this.live(), id32(realm, "realm"), mcid50(mcid), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  /** Fetches the content mcid names in realm from a node that shares it,
   * checked against mcid; no realm key is needed. Content nobody announces is
   * a NotSharedError, content every sharer failed to give a
   * ContentUnavailableError. */
  async getContent(realm: Id, mcid: Mcid, options: ContentOptions = {}): Promise<Uint8Array> {
    const asked = mcid50(mcid);
    const bounds: Record<string, number> = {};
    if (options.maxBytes) bounds.max_bytes = options.maxBytes;
    if (options.maxChunks) bounds.max_chunks = options.maxChunks;
    if (options.parallel) bounds.parallel = options.parallel;
    if (options.chunkTimeoutMs) bounds.chunk_timeout_ms = options.chunkTimeoutMs;
    return await native.poolGetContent(this.live(), id32(realm, "realm"), asked,
      Object.keys(bounds).length === 0 ? "" : JSON.stringify(bounds), options.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS);
  }

  /** Puts a signed record's wire bytes in the DHT. */
  async putRecord(wire: Uint8Array, options: { timeoutMs?: number } = {}): Promise<void> {
    await native.poolPutRecord(this.live(), wire, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  /** Closes every link and subscription. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await native.poolClose(this.handle);
  }

  private live(): Handle {
    if (this.closed) throw new Error("macula-ts: this Pool is closed");
    return this.handle;
  }
}

/** Answers one served call with the handler's result or its error, once. */
async function answer(d: Delivery, handler: (request: Request) => JsonValue | Promise<JsonValue>,
  bytes: BytesOutput | undefined): Promise<void> {
  const r = JSON.parse(d.json);
  const request: Request = { caller: r.caller, realm: r.realm, procedure: r.procedure,
    payload: bytesOut(r.payload, bytes), deadlineMs: r.deadline_ms };
  try {
    native.pendingReply(d.handle, JSON.stringify(await handler(request)));
  } catch (e) {
    try {
      native.pendingError(d.handle, e instanceof Error ? e.message : String(e));
    } catch {
      // Answered already, or its deadline passed: nothing is waiting.
    }
  }
}

/** Runs a stream handler, ends the stream as it leaves it, and releases it. */
async function runStream(stream: Stream, handler: (stream: Stream, request: StreamRequest) => void | Promise<void>):
  Promise<void> {
  try {
    await handler(stream, stream.request());
    await stream.close().catch(() => {});
  } catch (e) {
    await stream.abort("error", e instanceof Error ? e.message : String(e)).catch(() => {});
  } finally {
    await stream.free();
  }
}

// A record's payload follows the caller's bytes option; its wire bytes are
// always tagged.
function toRecord(r: any, bytes: BytesOutput | undefined): DhtRecord {
  return { type: r.type, keyId: r.key_id, createdAt: r.created_at, expiresAt: r.expires_at,
    payload: bytesOut(r.payload, bytes), wire: r.wire };
}

function toRecords(out: any, bytes: BytesOutput | undefined): { records: DhtRecord[]; dropped: number } {
  return { records: (out.records ?? []).map((r: any) => toRecord(r, bytes)), dropped: out.dropped ?? 0 };
}
