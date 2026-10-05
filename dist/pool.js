// A node's pool of station links on the macula 12 mesh, as macula-go's pool
// keeps it: every seed pinned by its node_id, the realms whose keys the node
// trusts, and one identity for every link. Calls and streams reach a provider
// by direct dial: its advertisements from the DHT, trusted only when the
// realm's key authorizes them (or, in a node's own namespace `~<node_id>/`,
// only when that node signed them), and the station it serves from dialed
// pinned.
import { native } from "./binding.js";
import { Stream } from "./stream.js";
import { DEFAULT_CONTENT_TIMEOUT_MS, mcid50 } from "./content.js";
import { DEFAULT_CALL_TIMEOUT_MS, MaculaError, bytesOut, hex, sealReport, id32, } from "./wire.js";
/** A call's or a stream's options, as macula_pool_call_opts takes them. */
function callOptionsJson(provider, confidential, presented, report) {
    const o = {};
    if (provider !== undefined)
        o.provider = hex(id32(provider, "provider"));
    if (confidential !== undefined)
        o.confidential = confidential;
    if (presented.ucan === "")
        throw new TypeError("@macula-io/ts: a UCAN is never empty; leave it out for none");
    if (presented.ucan !== undefined)
        o.ucan = presented.ucan;
    if (presented.proofs !== undefined && presented.proofs.length > 0) {
        if (presented.ucan === undefined)
            throw new TypeError("@macula-io/ts: proofs go with the UCAN they prove");
        o.proofs = presented.proofs;
    }
    // Handed on as given: callReport sends 1, and openStream hands on whatever
    // it was given, so the ABI refuses a report on a stream open rather than it
    // vanishing here. call sends none.
    if (report !== undefined)
        o.report = report;
    return JSON.stringify(o);
}
/** A served procedure's options, as macula_pool_serve_opts takes them. */
function serveOptionsJson(confidential, policy) {
    const o = {};
    if (confidential !== undefined)
        o.confidential = confidential;
    if (policy !== undefined)
        o.policy = policy;
    return JSON.stringify(o);
}
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
    finalDropped = null;
    /** @internal */
    constructor(handle, closed) {
        this.handle = handle;
        this.closed = closed;
    }
    /** Events dropped before onEvent heard them: when onEvent was behind and
     * the inbox (256) was full, which drops the newest, and any the pool itself
     * could not hand on. After stop(), the count at stop; read it before the
     * pool closes if the subscription was not stopped, since closing frees it. */
    dropped() {
        return this.finalDropped ?? native.subscriptionDropped(this.handle);
    }
    /** Ends the subscription on every link. */
    async stop() {
        if (this.finalDropped !== null)
            return;
        this.finalDropped = native.subscriptionDropped(this.handle);
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
            kem_advertise: options.kemAdvertise ?? 0,
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
        // The ABI carries flags as 0 or 1.
        const links = JSON.parse(native.poolStatus(this.live())) ?? [];
        return links.map((l) => ({ station: l.station, host: l.host, port: l.port, direct: l.direct === 1, up: l.up === 1 }));
    }
    /** Calls procedure in realm at a provider (any trusted one unless
     * `provider` names one) by direct dial. The call is sealed to the
     * provider's advertised KEM key whenever its advertisement names one
     * (`confidential` "preferred", the default); "required" never calls a
     * provider that names none. A provider's ERROR is thrown as a
     * ProviderError, a station's relay error as a RelayError, a call that
     * could not be kept confidential as a ConfidentialityError. `ucan` presents
     * a token minted for this node to a gated procedure, with `proofs`, its
     * chain's parents; a gated provider that refuses it answers a ProviderError
     * of code "unauthorized". An open procedure ignores any token. */
    async call(realm, procedure, payload = {}, options = {}) {
        bytesOut(null, options.bytes);
        const result = await native.poolCall(this.live(), id32(realm, "realm"), procedure, JSON.stringify(payload), callOptionsJson(options.provider, options.confidential, options), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
        return bytesOut(JSON.parse(result), options.bytes);
    }
    /** call, with the caller's seal report: whether the exchange behind the
     * result was sealed, to which provider and key (see SealReport). The result
     * is call's; an error is thrown as call throws it, with no report. After a
     * sealed_refused and one reseal, the report names the reseal's key. */
    async callReport(realm, procedure, payload = {}, options = {}) {
        bytesOut(null, options.bytes);
        const reply = JSON.parse(await native.poolCall(this.live(), id32(realm, "realm"), procedure, JSON.stringify(payload), callOptionsJson(options.provider, options.confidential, options, 1), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS));
        return { result: bytesOut(reply.result, options.bytes), report: sealReport(reply) };
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
        bytesOut(null, options.bytes);
        const handle = await native.poolSubscribe(this.live(), id32(realm, "realm"), topic, (d) => {
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
     * neither, and another node's namespace is refused. `confidential`:
     * "preferred" (the default) names the pool's KEM key when it has
     * kemAdvertise, and takes a clear call only while the procedure's last
     * keyless advertisement could still be served, then refuses it
     * (sealed_required), so a caller older than macula 13, macula-go 0.18 or
     * this release cannot call it after that; without kemAdvertise it names
     * no key and serves in the clear. "required" refuses every clear call
     * (sealed_required) and needs kemAdvertise; "off" serves in the clear.
     * `policy` (Ucan.ucanRequired, Ucan.realmMemberRequired) serves only
     * callers whose UCAN chain it accepts; a refused call never reaches the
     * handler. */
    async serve(realm, procedure, handler, options = {}) {
        bytesOut(null, options.bytes);
        const handle = await native.poolServe(this.live(), id32(realm, "realm"), procedure, serveOptionsJson(options.confidential, options.policy), (d) => {
            if (d.kind !== "request")
                return;
            void answer(d, handler, options.bytes);
        });
        return new Served(handle);
    }
    /** Serves procedure in realm as a stream of mode: handler drives each
     * session. The stream is closed when the handler returns without ending
     * it, aborted with code error when it throws, and released either way.
     * `confidential` and `policy` as serve's. */
    async serveStream(realm, procedure, mode, handler, options = {}) {
        bytesOut(null, options.bytes);
        const handle = await native.poolServeStream(this.live(), id32(realm, "realm"), procedure, mode, serveOptionsJson(options.confidential, options.policy), (d) => {
            if (d.kind !== "request")
                return;
            void runStream(new Stream(d.handle, options.bytes), handler);
        });
        return new Served(handle);
    }
    /** Opens a stream of mode on procedure in realm at a provider, by direct
     * dial, sealed as call is (`confidential`). A refusal arrives on its first
     * recv(); a stream that could not be kept confidential is a
     * ConfidentialityError here. `ucan` and `proofs` as call's; a gated
     * provider's refusal arrives on the first recv() as a StreamError of code
     * "unauthorized". */
    async openStream(realm, procedure, mode, payload = {}, options = {}) {
        bytesOut(null, options.bytes);
        const handle = await native.poolOpenStream(this.live(), id32(realm, "realm"), procedure, mode, JSON.stringify(payload), callOptionsJson(options.provider, options.confidential, options, options.report), options.deadlineMs ?? 0, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
        return new Stream(handle, options.bytes);
    }
    /** The verified record under key, or null when there is none. */
    async findRecord(key, options = {}) {
        bytesOut(null, options.bytes);
        try {
            return toRecord(JSON.parse(await native.poolFindRecord(this.live(), id32(key, "key"), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)), options.bytes);
        }
        catch (e) {
            if (e instanceof MaculaError && e.kind === "not_found")
                return null;
            throw e;
        }
    }
    /** Every verified record under key, and how many did not verify. */
    async findRecords(key, options = {}) {
        bytesOut(null, options.bytes);
        return toRecords(JSON.parse(await native.poolFindRecords(this.live(), id32(key, "key"), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)), options.bytes);
    }
    /** Every verified record of type the station holds, and how many did not
     * verify. */
    async findRecordsByType(type, options = {}) {
        bytesOut(null, options.bytes);
        return toRecords(JSON.parse(await native.poolFindRecordsByType(this.live(), type, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)), options.bytes);
    }
    /** Shares data in realm: this node keeps it, serves it on its own
     * `~<node_id>/content_v1` and announces it, renewing the announcement until
     * unshareContent or close. Data of at most 256 KiB is one raw block; larger
     * data a manifest over 256 KiB chunks, named name. Resolves to the content
     * id as hex. Serving needs stations that admit a node's own namespace. */
    async shareContent(realm, data, name = "", options = {}) {
        return hex(await native.poolShareContent(this.live(), id32(realm, "realm"), data, name, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS));
    }
    /** Stops sharing mcid in realm and withdraws its announcement. */
    async unshareContent(realm, mcid, options = {}) {
        await native.poolUnshareContent(this.live(), id32(realm, "realm"), mcid50(mcid), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    }
    /** Fetches the content mcid names in realm from a node that shares it,
     * checked against mcid; no realm key is needed. Content nobody announces is
     * a NotSharedError, content every sharer failed to give a
     * ContentUnavailableError. */
    async getContent(realm, mcid, options = {}) {
        const asked = mcid50(mcid);
        const bounds = {};
        if (options.maxBytes)
            bounds.max_bytes = options.maxBytes;
        if (options.maxChunks)
            bounds.max_chunks = options.maxChunks;
        if (options.parallel)
            bounds.parallel = options.parallel;
        if (options.chunkTimeoutMs)
            bounds.chunk_timeout_ms = options.chunkTimeoutMs;
        return await native.poolGetContent(this.live(), id32(realm, "realm"), asked, Object.keys(bounds).length === 0 ? "" : JSON.stringify(bounds), options.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS);
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
async function answer(d, handler, bytes) {
    const r = JSON.parse(d.json);
    const request = { caller: r.caller, realm: r.realm, procedure: r.procedure,
        payload: bytesOut(r.payload, bytes), deadlineMs: r.deadline_ms, sealed: r.sealed };
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
// A record's payload follows the caller's bytes option; its wire bytes are
// always tagged.
function toRecord(r, bytes) {
    return { type: r.type, keyId: r.key_id, createdAt: r.created_at, expiresAt: r.expires_at,
        payload: bytesOut(r.payload, bytes), wire: r.wire };
}
function toRecords(out, bytes) {
    return { records: (out.records ?? []).map((r) => toRecord(r, bytes)), dropped: out.dropped ?? 0 };
}
//# sourceMappingURL=pool.js.map