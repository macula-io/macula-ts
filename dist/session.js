// A handshaked connection to a real macula-station: transport +
// CONNECT/HELLO, reached through cabi's FFI boundary exactly like
// Identity generation was -- connection.Connect on the Go side already
// does the real QUIC dial, the CBOR frame encoding, and the Ed25519
// sign/verify of the handshake; this file does not reimplement any of
// that, it exposes it.
//
// Scope of this slice: connect + close only. No RPC (call/serve), no
// pubsub, no DHT, no content transfer, no streaming, no UCAN -- those
// build on top of a working Session and are separate work.
import { native } from "./binding.js";
export class Session {
    #handle;
    constructor(handle) {
        this.#handle = handle;
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
    static async connect(host, port, identity) {
        const handle = await native.sessionConnect(host, port, identity.handleForFfi());
        return new Session(handle);
    }
    #requireHandle() {
        if (this.#handle === null) {
            throw new Error("macula-ts: Session used after close()");
        }
        return this.#handle;
    }
    /** The address this session's underlying QUIC connection is with. */
    get remoteAddr() {
        return native.sessionRemoteAddr(this.#requireHandle());
    }
    /** The station's HELLO-verified 32-byte NodeID (Ed25519 public key)
     * -- proof, beyond "connect() didn't throw", that this is a real,
     * application-layer-verified session and not just a QUIC/TLS
     * handshake: frame.Verify already checked this NodeID's signature
     * over the HELLO frame inside connect(), this just surfaces it. */
    get stationNodeId() {
        return native.sessionStationNodeId(this.#requireHandle());
    }
    /** Sends a signed GOODBYE and closes the connection. Safe to call
     * more than once -- a second call is a no-op, matching Identity's
     * dispose() convention. `identity` must be the same (non-disposed)
     * identity used to open this session; Close needs it to sign
     * GOODBYE. Like connect(), this is real network I/O (a drain sleep
     * plus a write) and runs off the main thread on the native side. */
    async close(identity, reason = "") {
        if (this.#handle === null)
            return;
        const handle = this.#handle;
        this.#handle = null;
        await native.sessionClose(handle, identity.handleForFfi(), reason);
    }
}
//# sourceMappingURL=session.js.map