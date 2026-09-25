import { type Handle } from "./binding.js";
import { NodeKey } from "./key.js";
import { Stream, StreamMode, type StreamRequest } from "./stream.js";
import { type BytesOutput, type Id, type JsonValue } from "./wire.js";
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
    readonly realmTrust?: ReadonlyArray<{
        readonly realm: Id;
        readonly key: string | Uint8Array;
    }>;
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
export declare enum RecordType {
    NodeRecord = 1,
    ProcedureAdvertisement = 6,
    Tombstone = 12,
    ContentAnnouncement = 17,
    StationEndpoint = 18,
    OrgDirectory = 21,
    ProcedureDelegation = 22
}
/** A subscription, until stop() or the pool closes. */
export declare class Subscription {
    private readonly handle;
    readonly closed: Promise<string | null>;
    /** @internal */
    constructor(handle: Handle, closed: Promise<string | null>);
    /** Ends the subscription on every link. */
    stop(): Promise<void>;
}
/** A served procedure, until stop(). */
export declare class Served {
    private readonly handle;
    private stopped;
    /** @internal */
    constructor(handle: Handle);
    /** Withdraws the procedure on every link. */
    stop(): Promise<void>;
}
export declare class Pool {
    private readonly handle;
    private closed;
    private constructor();
    /** Links the key's node to every seed, and resolves once one link is up. */
    static connect(key: NodeKey, seeds: readonly Seed[], options?: PoolOptions): Promise<Pool>;
    /** The node_id the pool links as. */
    nodeId(): string;
    /** name in this node's own namespace, `~<node_id>/<name>`: a procedure it
     * serves with no org and no realm key, authorized by its advertisement's
     * signature alone, and that any node calls with no realm key pinned. */
    ownProcedure(name: string): string;
    /** Every link the pool holds. */
    status(): LinkStatus[];
    /** Calls procedure in realm at a provider (any trusted one unless
     * `provider` names one) by direct dial. A provider's ERROR is thrown as a
     * ProviderError, a station's relay error as a RelayError. */
    call(realm: Id, procedure: string, payload?: JsonValue, options?: {
        provider?: Id;
        timeoutMs?: number;
        bytes?: BytesOutput;
    }): Promise<JsonValue>;
    /** The procedure's trusted providers, freshest first. */
    providers(realm: Id, procedure: string, options?: {
        timeoutMs?: number;
    }): Promise<Provider[]>;
    /** Publishes payload on topic in realm. Topics name a kind of fact; ids go
     * in the payload. */
    publish(realm: Id, topic: string, payload: JsonValue, options?: {
        ttlMs?: number;
    }): Promise<void>;
    /** Subscribes to topic in realm: onEvent hears each verified event once,
     * however many links deliver it. `closed` resolves when the subscription
     * ends, with why or null. */
    subscribe(realm: Id, topic: string, onEvent: (event: Event) => void, options?: {
        bytes?: BytesOutput;
    }): Promise<Subscription>;
    /** Serves procedure in realm: handler answers each call, and its thrown
     * error goes back as a handler_error with its message. An org procedure
     * needs the realm's key pinned and the org's delegation to this node in the
     * DHT; a procedure in this node's own namespace (ownProcedure) needs
     * neither, and another node's namespace is refused. */
    serve(realm: Id, procedure: string, handler: (request: Request) => JsonValue | Promise<JsonValue>, options?: {
        bytes?: BytesOutput;
    }): Promise<Served>;
    /** Serves procedure in realm as a stream of mode: handler drives each
     * session. The stream is closed when the handler returns without ending
     * it, aborted with code error when it throws, and released either way. */
    serveStream(realm: Id, procedure: string, mode: StreamMode, handler: (stream: Stream, request: StreamRequest) => void | Promise<void>, options?: {
        bytes?: BytesOutput;
    }): Promise<Served>;
    /** Opens a stream of mode on procedure in realm at a provider, by direct
     * dial. A refusal arrives on its first recv(). */
    openStream(realm: Id, procedure: string, mode: StreamMode, payload?: JsonValue, options?: {
        provider?: Id;
        deadlineMs?: number;
        timeoutMs?: number;
        bytes?: BytesOutput;
    }): Promise<Stream>;
    /** The verified record under key, or null when there is none. */
    findRecord(key: Id, options?: {
        timeoutMs?: number;
        bytes?: BytesOutput;
    }): Promise<DhtRecord | null>;
    /** Every verified record under key, and how many did not verify. */
    findRecords(key: Id, options?: {
        timeoutMs?: number;
        bytes?: BytesOutput;
    }): Promise<{
        records: DhtRecord[];
        dropped: number;
    }>;
    /** Every verified record of type the station holds, and how many did not
     * verify. */
    findRecordsByType(type: RecordType | number, options?: {
        timeoutMs?: number;
        bytes?: BytesOutput;
    }): Promise<{
        records: DhtRecord[];
        dropped: number;
    }>;
    /** Puts a signed record's wire bytes in the DHT. */
    putRecord(wire: Uint8Array, options?: {
        timeoutMs?: number;
    }): Promise<void>;
    /** Closes every link and subscription. */
    close(): Promise<void>;
    private live;
}
