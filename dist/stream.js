// A streaming session, on either side: the caller's from Pool.openStream, or
// a provider's handed to a Pool.serveStream handler. Each session is a QUIC
// stream of its own, released on every path; frames are signed by each side
// and verified before they are handed on.
import { native } from "./binding.js";
import { StreamError, bytesModeFor } from "./wire.js";
/** The three stream modes: the provider sends (server), the caller sends and
 * the provider replies (client), or both send (bidi). */
export var StreamMode;
(function (StreamMode) {
    StreamMode[StreamMode["Server"] = 0] = "Server";
    StreamMode[StreamMode["Client"] = 1] = "Client";
    StreamMode[StreamMode["Bidi"] = 2] = "Bidi";
})(StreamMode || (StreamMode = {}));
export class Stream {
    handle;
    bytes;
    freed = false;
    /** @internal */
    constructor(handle, bytes) {
        this.handle = handle;
        this.bytes = bytes;
    }
    /** The stream's open. */
    request() {
        const r = JSON.parse(native.streamRequest(this.live(), bytesModeFor(this.bytes)));
        return { caller: r.caller, realm: r.realm, procedure: r.procedure, payload: r.payload, deadlineMs: r.deadline_ms };
    }
    /** Sends a raw chunk. */
    async send(chunk) {
        await native.streamSendBytes(this.live(), chunk);
    }
    /** Sends a structured chunk. */
    async sendValue(value) {
        await native.streamSendJson(this.live(), JSON.stringify(value));
    }
    /** Ends this side's sending; the peer may still send. */
    async closeSend() {
        await native.streamCloseSend(this.live());
    }
    /** Ends the stream on both sides. */
    async close() {
        await native.streamClose(this.live());
    }
    /** The provider's terminal value; ends the stream. */
    async reply(payload) {
        await native.streamReply(this.live(), JSON.stringify(payload));
    }
    /** Ends the stream with a STREAM_ERROR the peer sees. */
    async abort(code, message = "") {
        await native.streamAbort(this.live(), code, message);
    }
    /** The peer's next frame, or null once the stream has ended normally. A
     * stream error is thrown as a StreamError; `timeoutMs` (0 for none) bounds
     * the wait with an Error("timeout"). */
    async recv(options = {}) {
        const e = JSON.parse(await native.streamRecv(this.live(), options.timeoutMs ?? 0, bytesModeFor(this.bytes)));
        switch (e.kind) {
            case "eof":
                return null;
            case "error":
                throw new StreamError(e.code, e.message ?? "", e.relay === 1);
            case "data":
                return { kind: "data", encoding: e.encoding, body: e.body };
            case "end":
                return { kind: "end", role: e.role };
            default:
                return { kind: "reply", payload: e.payload };
        }
    }
    /** Every frame until the stream ends. */
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const event = await this.recv();
            if (event === null)
                return;
            yield event;
        }
    }
    /** Releases the stream, aborting it first when it has not ended. */
    async free() {
        if (this.freed)
            return;
        this.freed = true;
        await native.streamFree(this.handle);
    }
    live() {
        if (this.freed)
            throw new Error("macula-ts: this Stream was freed");
        return this.handle;
    }
}
//# sourceMappingURL=stream.js.map