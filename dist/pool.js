// A node's pool of station links on the macula 12 mesh, as macula-go's pool
// keeps it: every seed pinned by its node_id, the realms whose keys the node
// trusts, and one identity for every link. Calls and streams reach a provider
// by direct dial: its advertisements from the DHT, trusted only when the
// realm's key authorizes them (or, in a node's own namespace `~<node_id>/`,
// only when that node signed them), and the station it serves from dialed
// pinned.
import { native } from "./binding.js";
import { Stream } from "./stream.js";
import { DEFAULT_CALL_TIMEOUT_MS, bytesModeFor, callError, hex, id32, } from "./wire.js";
/** macula 12's record types. */
export var RecordType;
(function (RecordType) {
    RecordType[RecordType["NodeRecord"] = 1] = "NodeRecord";
    RecordType[RecordType["ProcedureAdvertisement"] = 6] = "ProcedureAdvertisement";
    RecordType[RecordType["Tombstone"] = 12] = "Tombstone";
    RecordType[RecordType["ContentAnnouncement"] = 17] = "ContentAnnouncement";
    RecordType[RecordType["StationEndpoint"] = 18] = "StationEndpoint";
    RecordType[RecordType["OrgDirectory"] = 21] = "OrgDirectory";
    RecordType[RecordType["ProcedureDelegation"] = 22] = "ProcedureDelegation";
})(RecordType || (RecordType = {}));
/** A subscription, until stop() or the pool closes. */
export class Subscription {
    handle;
    closed;
    /** @internal */
    constructor(handle, closed) {
        this.handle = handle;
        this.closed = closed;
    }
    /** Ends the subscription on every link. */
    async stop() {
        await native.subscriptionStop(this.handle);
    }
}
/** A served procedure, until stop(). */
export class Served {
    handle;
    stopped = false;
    /** @internal */
    constructor(handle) {
        this.handle = handle;
    }
    /** Withdraws the procedure on every link. */
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        await native.servedStop(this.handle);
    }
}
export class Pool {
    handle;
    closed = false;
    constructor(handle) {
        this.handle = handle;
    }
    /** Links the key's node to every seed, and resolves once one link is up. */
    static async connect(key, seeds, options = {}) {
        const seedJson = seeds.map((s) => ({ host: s.host, port: s.port, node_id: hex(id32(s.nodeId, "a seed's nodeId")) }));
        const realmTrust = {};
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
    nodeId() {
        return hex(native.poolNodeId(this.live()));
    }
    /** name in this node's own namespace, `~<node_id>/<name>`: a procedure it
     * serves with no org and no realm key, authorized by its advertisement's
     * signature alone, and that any node calls with no realm key pinned. */
    ownProcedure(name) {
        return `~${this.nodeId()}/${name}`;
    }
    /** Every link the pool holds. */
    status() {
        return JSON.parse(native.poolStatus(this.live())) ?? [];
    }
    /** Calls procedure in realm at a provider (any trusted one unless
     * `provider` names one) by direct dial. A provider's ERROR is thrown as a
     * ProviderError, a station's relay error as a RelayError. */
    async call(realm, procedure, payload = {}, options = {}) {
        try {
            const result = await native.poolCall(this.live(), id32(realm, "realm"), procedure, JSON.stringify(payload), options.provider === undefined ? null : id32(options.provider, "provider"), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, bytesModeFor(options.bytes));
            return JSON.parse(result);
        }
        catch (e) {
            throw callError(e);
        }
    }
    /** The procedure's trusted providers, freshest first. */
    async providers(realm, procedure, options = {}) {
        return JSON.parse(await native.poolProviders(this.live(), id32(realm, "realm"), procedure, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)) ?? [];
    }
    /** Publishes payload on topic in realm. Topics name a kind of fact; ids go
     * in the payload. */
    async publish(realm, topic, payload, options = {}) {
        await native.poolPublish(this.live(), id32(realm, "realm"), topic, JSON.stringify(payload), options.ttlMs ?? 0);
    }
    /** Subscribes to topic in realm: onEvent hears each verified event once,
     * however many links deliver it. `closed` resolves when the subscription
     * ends, with why or null. */
    async subscribe(realm, topic, onEvent, options = {}) {
        let settle = () => { };
        const closed = new Promise((resolve) => (settle = resolve));
        const handle = await native.poolSubscribe(this.live(), id32(realm, "realm"), topic, bytesModeFor(options.bytes), (d) => {
            if (d.kind === "closed") {
                settle(d.json === "" ? null : d.json);
                return;
            }
            const e = JSON.parse(d.json);
            onEvent({ publisher: e.publisher, realm: e.realm, topic: e.topic, seq: e.seq, publishedAt: e.published_at,
                payload: e.payload, deliveredVia: e.delivered_via });
        });
        return new Subscription(handle, closed);
    }
    /** Serves procedure in realm: handler answers each call, and its thrown
     * error goes back as a handler_error with its message. An org procedure
     * needs the realm's key pinned and the org's delegation to this node in the
     * DHT; a procedure in this node's own namespace (ownProcedure) needs
     * neither, and another node's namespace is refused. */
    async serve(realm, procedure, handler, options = {}) {
        const handle = await native.poolServe(this.live(), id32(realm, "realm"), procedure, bytesModeFor(options.bytes), (d) => {
            if (d.kind !== "request")
                return;
            void answer(d, handler);
        });
        return new Served(handle);
    }
    /** Serves procedure in realm as a stream of mode: handler drives each
     * session. The stream is closed when the handler returns without ending
     * it, aborted with code error when it throws, and released either way. */
    async serveStream(realm, procedure, mode, handler, options = {}) {
        const handle = await native.poolServeStream(this.live(), id32(realm, "realm"), procedure, mode, bytesModeFor(options.bytes), (d) => {
            if (d.kind !== "request")
                return;
            void runStream(new Stream(d.handle, options.bytes), handler);
        });
        return new Served(handle);
    }
    /** Opens a stream of mode on procedure in realm at a provider, by direct
     * dial. A refusal arrives on its first recv(). */
    async openStream(realm, procedure, mode, payload = {}, options = {}) {
        try {
            const handle = await native.poolOpenStream(this.live(), id32(realm, "realm"), procedure, mode, JSON.stringify(payload), options.provider === undefined ? null : id32(options.provider, "provider"), options.deadlineMs ?? 0, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
            return new Stream(handle, options.bytes);
        }
        catch (e) {
            throw callError(e);
        }
    }
    /** The verified record under key, or null when there is none. */
    async findRecord(key, options = {}) {
        try {
            return toRecord(JSON.parse(await native.poolFindRecord(this.live(), id32(key, "key"), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, bytesModeFor(options.bytes))));
        }
        catch (e) {
            if (e instanceof Error && e.message === "not_found")
                return null;
            throw e;
        }
    }
    /** Every verified record under key, and how many did not verify. */
    async findRecords(key, options = {}) {
        return toRecords(JSON.parse(await native.poolFindRecords(this.live(), id32(key, "key"), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, bytesModeFor(options.bytes))));
    }
    /** Every verified record of type the station holds, and how many did not
     * verify. */
    async findRecordsByType(type, options = {}) {
        return toRecords(JSON.parse(await native.poolFindRecordsByType(this.live(), type, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, bytesModeFor(options.bytes))));
    }
    /** Puts a signed record's wire bytes in the DHT. */
    async putRecord(wire, options = {}) {
        await native.poolPutRecord(this.live(), wire, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    }
    /** Closes every link and subscription. */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await native.poolClose(this.handle);
    }
    live() {
        if (this.closed)
            throw new Error("macula-ts: this Pool is closed");
        return this.handle;
    }
}
/** Answers one served call with the handler's result or its error, once. */
async function answer(d, handler) {
    const r = JSON.parse(d.json);
    const request = { caller: r.caller, realm: r.realm, procedure: r.procedure, payload: r.payload,
        deadlineMs: r.deadline_ms };
    try {
        native.pendingReply(d.handle, JSON.stringify(await handler(request)));
    }
    catch (e) {
        try {
            native.pendingError(d.handle, e instanceof Error ? e.message : String(e));
        }
        catch {
            // Answered already, or its deadline passed: nothing is waiting.
        }
    }
}
/** Runs a stream handler, ends the stream as it leaves it, and releases it. */
async function runStream(stream, handler) {
    try {
        await handler(stream, stream.request());
        await stream.close().catch(() => { });
    }
    catch (e) {
        await stream.abort("error", e instanceof Error ? e.message : String(e)).catch(() => { });
    }
    finally {
        await stream.free();
    }
}
function toRecord(r) {
    return { type: r.type, keyId: r.key_id, createdAt: r.created_at, expiresAt: r.expires_at, payload: r.payload,
        wire: r.wire };
}
function toRecords(out) {
    return { records: (out.records ?? []).map(toRecord), dropped: out.dropped ?? 0 };
}
//# sourceMappingURL=pool.js.map