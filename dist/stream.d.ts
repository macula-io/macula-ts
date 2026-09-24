import { type Handle } from "./binding.js";
import { type BytesOutput, type JsonValue } from "./wire.js";
/** The three stream modes: the provider sends (server), the caller sends and
 * the provider replies (client), or both send (bidi). */
export declare enum StreamMode {
    Server = 0,
    Client = 1,
    Bidi = 2
}
/** A frame the peer sent: a chunk (raw bytes as hex or tagged, or a value),
 * the end of its sending ("send") or of the stream ("both"), or the
 * provider's reply. */
export type StreamEvent = {
    readonly kind: "data";
    readonly encoding: "raw" | "msgpack";
    readonly body: JsonValue;
} | {
    readonly kind: "end";
    readonly role: "send" | "both";
} | {
    readonly kind: "reply";
    readonly payload: JsonValue;
};
/** A stream's open: who opened it, where, and its payload. */
export interface StreamRequest {
    readonly caller: string;
    readonly realm: string;
    readonly procedure: string;
    readonly payload: JsonValue;
    readonly deadlineMs: number;
}
export declare class Stream {
    private readonly handle;
    private readonly bytes;
    private freed;
    /** @internal */
    constructor(handle: Handle, bytes: BytesOutput | undefined);
    /** The stream's open. */
    request(): StreamRequest;
    /** Sends a raw chunk. */
    send(chunk: Uint8Array): Promise<void>;
    /** Sends a structured chunk. */
    sendValue(value: JsonValue): Promise<void>;
    /** Ends this side's sending; the peer may still send. */
    closeSend(): Promise<void>;
    /** Ends the stream on both sides. */
    close(): Promise<void>;
    /** The provider's terminal value; ends the stream. */
    reply(payload: JsonValue): Promise<void>;
    /** Ends the stream with a STREAM_ERROR the peer sees. */
    abort(code: string, message?: string): Promise<void>;
    /** The peer's next frame, or null once the stream has ended normally. A
     * stream error is thrown as a StreamError; `timeoutMs` (0 for none) bounds
     * the wait with an Error("timeout"). */
    recv(options?: {
        timeoutMs?: number;
    }): Promise<StreamEvent | null>;
    /** Every frame until the stream ends. */
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
    /** Releases the stream, aborting it first when it has not ended. */
    free(): Promise<void>;
    private live;
}
