// A streaming session, on either side: the caller's from Pool.openStream, or
// a provider's handed to a Pool.serveStream handler. Each session is a QUIC
// stream of its own, released on every path; frames are signed by each side
// and verified before they are handed on.
import { native, type Handle } from "./binding.js";
import { StreamError, bytesOut, type BytesOutput, type JsonValue } from "./wire.js";

/** The three stream modes: the provider sends (server), the caller sends and
 * the provider replies (client), or both send (bidi). */
export enum StreamMode {
  Server = 0,
  Client = 1,
  Bidi = 2,
}

/** A frame the peer sent: a chunk (raw bytes as hex or tagged, or a value),
 * the end of its sending ("send") or of the stream ("both"), or the
 * provider's reply. */
export type StreamEvent =
  | { readonly kind: "data"; readonly encoding: "raw" | "msgpack"; readonly body: JsonValue }
  | { readonly kind: "end"; readonly role: "send" | "both" }
  | { readonly kind: "reply"; readonly payload: JsonValue };

/** A stream's open: who opened it, where, and its payload. */
export interface StreamRequest {
  readonly caller: string;
  readonly realm: string;
  readonly procedure: string;
  readonly payload: JsonValue;
  readonly deadlineMs: number;
}

export class Stream {
  private freed = false;

  /** @internal */
  constructor(private readonly handle: Handle, private readonly bytes: BytesOutput | undefined) {}

  /** The stream's open. */
  request(): StreamRequest {
    const r = JSON.parse(native.streamRequest(this.live()));
    return { caller: r.caller, realm: r.realm, procedure: r.procedure, payload: bytesOut(r.payload, this.bytes),
      deadlineMs: r.deadline_ms };
  }

  /** Sends a raw chunk. */
  async send(chunk: Uint8Array): Promise<void> {
    await native.streamSendBytes(this.live(), chunk);
  }

  /** Sends a structured chunk. */
  async sendValue(value: JsonValue): Promise<void> {
    await native.streamSendJson(this.live(), JSON.stringify(value));
  }

  /** Ends this side's sending; the peer may still send. */
  async closeSend(): Promise<void> {
    await native.streamCloseSend(this.live());
  }

  /** Ends the stream on both sides. */
  async close(): Promise<void> {
    await native.streamClose(this.live());
  }

  /** The provider's terminal value; ends the stream. */
  async reply(payload: JsonValue): Promise<void> {
    await native.streamReply(this.live(), JSON.stringify(payload));
  }

  /** Ends the stream with a STREAM_ERROR the peer sees. */
  async abort(code: string, message = ""): Promise<void> {
    await native.streamAbort(this.live(), code, message);
  }

  /** The peer's next frame, or null once the stream has ended normally. A
   * stream error is thrown as a StreamError; `timeoutMs` (0 for none) bounds
   * the wait with a MaculaError of kind "timeout". */
  async recv(options: { timeoutMs?: number } = {}): Promise<StreamEvent | null> {
    const e = JSON.parse(await native.streamRecv(this.live(), options.timeoutMs ?? 0));
    switch (e.kind) {
      case "eof":
        return null;
      case "error":
        throw new StreamError(e.code, e.message ?? "", e.relay === 1);
      case "data":
        return { kind: "data", encoding: e.encoding, body: bytesOut(e.body, this.bytes) };
      case "end":
        return { kind: "end", role: e.role };
      default:
        return { kind: "reply", payload: bytesOut(e.payload, this.bytes) };
    }
  }

  /** Every frame until the stream ends. */
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (;;) {
      const event = await this.recv();
      if (event === null) return;
      yield event;
    }
  }

  /** Releases the stream, aborting it first when it has not ended. */
  async free(): Promise<void> {
    if (this.freed) return;
    this.freed = true;
    await native.streamFree(this.handle);
  }

  private live(): Handle {
    if (this.freed) throw new Error("macula-ts: this Stream was freed");
    return this.handle;
  }
}
