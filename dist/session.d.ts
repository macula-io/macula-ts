import type { Identity } from "./identity.js";
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
}
