// Loads the compiled N-API addon (addon/binding.cc) and types its functions.
// macula-go's shared C ABI (cabi/, built as a c-archive from the release in
// native/MACULA_GO) is linked into the addon statically, so it is one
// self-contained .node file. node-gyp-build picks, at require time, a local
// build (build/Release/*.node) or the published prebuild for this platform
// (prebuilds/<platform>-<arch>/*.node), so a consumer installing from npm
// never runs a compiler.
//
// Every function is wrapped once here: an error the ABI reports (JSON with a
// fixed kind) reaches the rest of the package as the class its kind names
// (wire.ts nativeError).
//
// Internal to the package: the public API is key.ts, pool.ts and stream.ts.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nativeError } from "./wire.js";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** An opaque Go value's handle (runtime/cgo.Handle), as the addon returns it. */
export type Handle = bigint;

/** What a listener (a subscription, a served procedure, a served stream
 * procedure) is handed, on the event loop: an event, a request with the
 * pending call's or stream's handle, or, last, the closing notice, whose json
 * is empty when the listener ended as asked and the error's JSON otherwise. */
export interface Delivery {
  readonly kind: "event" | "closed" | "request";
  readonly json: string;
  readonly handle: Handle;
}

export type Listener = (delivery: Delivery) => void;

interface Native {
  abiVersion: number;
  keyGenerate(profile: string): Promise<Handle>;
  keyLoad(path: string, profile: string): Promise<Handle>;
  keySave(key: Handle, path: string): Promise<void>;
  keyNodeId(key: Handle): Uint8Array;
  keyPublicKey(key: Handle): Uint8Array;
  keyProfile(key: Handle): string;
  keySign(key: Handle, data: Uint8Array): Promise<Uint8Array>;
  keyDeviceRequestProof(key: Handle, realm: Uint8Array, procedure: string, requestJson: string, rule: number): Promise<string>;
  deviceRequestMessage(publicKey: Uint8Array, realm: Uint8Array, procedure: string, timestampMs: number, nonce: Uint8Array,
    requestJson: string, rule: number): Uint8Array;
  keyFree(key: Handle): void;
  verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array, profile: string): boolean;

  poolConnect(key: Handle, seedsJson: string, optionsJson: string): Promise<Handle>;
  poolClose(pool: Handle): Promise<void>;
  poolNodeId(pool: Handle): Uint8Array;
  poolStatus(pool: Handle): string;
  poolCall(pool: Handle, realm: Uint8Array, procedure: string, payloadJson: string, provider: Uint8Array | null,
    timeoutMs: number): Promise<string>;
  poolProviders(pool: Handle, realm: Uint8Array, procedure: string, timeoutMs: number): Promise<string>;
  poolPublish(pool: Handle, realm: Uint8Array, topic: string, payloadJson: string, ttlMs: number): Promise<void>;
  poolSubscribe(pool: Handle, realm: Uint8Array, topic: string, listener: Listener): Promise<Handle>;
  subscriptionStop(subscription: Handle): Promise<void>;
  subscriptionDropped(subscription: Handle): number;
  poolFindRecord(pool: Handle, key: Uint8Array, timeoutMs: number): Promise<string>;
  poolFindRecords(pool: Handle, key: Uint8Array, timeoutMs: number): Promise<string>;
  poolFindRecordsByType(pool: Handle, type: number, timeoutMs: number): Promise<string>;
  poolPutRecord(pool: Handle, wire: Uint8Array, timeoutMs: number): Promise<void>;
  poolShareContent(pool: Handle, realm: Uint8Array, data: Uint8Array, name: string, timeoutMs: number): Promise<Uint8Array>;
  poolUnshareContent(pool: Handle, realm: Uint8Array, mcid: Uint8Array, timeoutMs: number): Promise<void>;
  poolGetContent(pool: Handle, realm: Uint8Array, mcid: Uint8Array, optionsJson: string, timeoutMs: number): Promise<Uint8Array>;

  poolServe(pool: Handle, realm: Uint8Array, procedure: string, listener: Listener): Promise<Handle>;
  poolServeStream(pool: Handle, realm: Uint8Array, procedure: string, mode: number, listener: Listener): Promise<Handle>;
  pendingReply(pending: Handle, resultJson: string): void;
  pendingError(pending: Handle, message: string): void;
  servedStop(served: Handle): Promise<void>;

  poolOpenStream(pool: Handle, realm: Uint8Array, procedure: string, mode: number, payloadJson: string,
    provider: Uint8Array | null, deadlineMs: number, timeoutMs: number): Promise<Handle>;
  streamSendBytes(stream: Handle, data: Uint8Array): Promise<void>;
  streamSendJson(stream: Handle, valueJson: string): Promise<void>;
  streamCloseSend(stream: Handle): Promise<void>;
  streamClose(stream: Handle): Promise<void>;
  streamReply(stream: Handle, payloadJson: string): Promise<void>;
  streamAbort(stream: Handle, code: string, message: string): Promise<void>;
  streamRecv(stream: Handle, timeoutMs: number): Promise<string>;
  streamRequest(stream: Handle): string;
  streamFree(stream: Handle): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const addon = require("node-gyp-build")(repoRoot) as Native;

/** fn with the ABI's errors as their classes: a rejection or a throw. */
function typed<F extends (...args: never[]) => unknown>(fn: F): F {
  return ((...args: Parameters<F>) => {
    let out: unknown;
    try {
      out = fn(...args);
    } catch (e) {
      throw nativeError(e);
    }
    return out instanceof Promise ? out.catch((e: unknown) => { throw nativeError(e); }) : out;
  }) as F;
}

export const native = Object.fromEntries(
  Object.entries(addon).map(([name, value]) => [name, typeof value === "function" ? typed(value) : value]),
) as unknown as Native;
