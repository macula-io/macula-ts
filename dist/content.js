// Content transfer -- macula-go's content package (Put/Get), thin
// CALL/RESULT wrappers to reserved `_content.*` procedures sent on
// their OWN dedicated QUIC stream (Session.OpenDedicatedStream on the
// Go side), NOT the shared control stream call()/serve()/the DHT
// methods/subscribe() all read from -- see cabi/content.go's own doc
// for why Session.putContent()/getContent() (session.ts) are, unlike
// those, never subject to Session's same-Session exclusivity guard, and
// why two concurrent putContent()/getContent() calls on one Session
// don't race each other either (each gets its own fresh dedicated
// stream).
//
// IMPORTANT: this is a one-time TRANSFER mechanism, not durable object
// storage. A station may forget content after serving it, there is no
// "list what's stored here" operation, and there is no "delete"
// operation -- putContent()/getContent() hand a blob to a peer once,
// they do not give you a key-value store. Do not build anything on this
// SDK that assumes content survives indefinitely, or that a station is
// obligated to keep serving something it once accepted.
//
// mcid crosses the FFI boundary as a lowercase hex string (68 hex
// chars = 34 bytes: <<Version:8, Codec:8, Hash:32/binary>>, macula-go's
// manifest.Mcid) -- the same "raw byte identifier -> hex string"
// convention DhtRecord's key/version/signature already use (dht.ts),
// deliberately NOT rpc.ts's own "0x"-prefixed convention for bytes
// embedded *inside* a JSON payload -- an mcid stands on its own here,
// it isn't a payload field.
/** Thrown by Session.getContent() when the station reports the content
 * isn't known to it (macula-go's content.ErrNotFound) -- an expected,
 * routine outcome for a transfer mechanism with no durability
 * guarantee, not a transport failure. Unlike DhtRecord's findRecord()
 * (which resolves `null` for its own equivalent "not found" case),
 * getContent() throws instead: its whole contract is "hand back the
 * bytes or fail", and there is no sensible non-throwing value to return
 * in place of the `Uint8Array` a caller asked for. */
export class ContentNotFoundError extends Error {
    /** The mcid that produced this error, hex-encoded (the same string
     * that was passed to getContent()). */
    mcid;
    constructor(mcid) {
        super(`macula-ts: no content found for mcid ${mcid}`);
        this.name = "ContentNotFoundError";
        this.mcid = mcid;
    }
}
//# sourceMappingURL=content.js.map