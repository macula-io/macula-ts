// Loads the compiled N-API addon (addon/binding.cc) and re-exports its
// typed functions. Unlike the koffi-era version of this file, there is
// no runtime signature declaration here -- the addon's C++ glue already
// knows its own shapes, throws real JS errors on failure (no more
// manual errOut-array/checkErr dance), and is a single self-contained
// .node file (cabi/'s Go code is statically linked in via
// -buildmode=c-archive, not loaded separately at runtime).
//
// node-gyp-build picks, at require time, whichever of these exists:
// build/Release/*.node (a local dev build via `npm run build:addon:dev`)
// or prebuilds/<platform>-<arch>/*.node (baked in by `npm run
// build:prebuilds` / prebuildify, and published as part of the npm
// package) -- this is the whole point: a consumer installing this
// package from npm never runs a compiler or fetches anything, because
// the matching prebuild is already sitting in the downloaded tarball.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const addon = require("node-gyp-build")(repoRoot) as {
  identityGenerate(): bigint;
  identityFromSeedBytes(seed32: Uint8Array): bigint;
  identityNodeId(handle: Handle): Uint8Array;
  identityPrivateBytes(handle: Handle): Uint8Array;
  identityFree(handle: Handle): void;
  // sessionConnect/sessionClose are backed by Napi::AsyncWorker on the
  // C++ side (see addon/binding.cc) specifically because they're real
  // network I/O -- a synchronous FFI call here would block the whole
  // Node event loop for the duration of a QUIC dial + handshake (up to
  // ~30s) or a close's drain sleep. They genuinely return Promises,
  // not a sync call wrapped in Promise.resolve().
  sessionConnect(host: string, port: number, identityHandle: Handle): Promise<bigint>;
  sessionRemoteAddr(handle: Handle): string;
  sessionStationNodeId(handle: Handle): Uint8Array;
  sessionClose(handle: Handle, identityHandle: Handle, reason: string): Promise<void>;
  // Unary RPC. All six are real network I/O (see addon/binding.cc's
  // own comments on each worker) except pendingCallProcedure/
  // pendingCallPayloadJson, which only read fields already sitting in
  // a pendingCall handle -- no wire activity, so those two stay
  // synchronous like identityNodeId/sessionRemoteAddr above.
  sessionCall(
    sessionHandle: Handle,
    identityHandle: Handle,
    procedure: string,
    realm: Uint8Array | undefined,
    payloadJson: string,
    timeoutMs: number,
  ): Promise<string>;
  sessionAdvertise(sessionHandle: Handle, identityHandle: Handle, realm: Uint8Array | undefined, procedure: string): Promise<void>;
  sessionUnadvertise(sessionHandle: Handle, identityHandle: Handle, realm: Uint8Array | undefined, procedure: string): Promise<void>;
  // Resolves with a pendingCall Handle once a matching CALL arrives, or
  // `null` if nothing did within timeoutMs (or a foreign CALL got
  // auto-refused on our behalf -- see cabi/serve.go's own doc) -- the
  // caller's cue to just call this again.
  serveWaitForCall(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    procedure: string,
    timeoutMs: number,
  ): Promise<Handle | null>;
  pendingCallProcedure(pendingHandle: Handle): string;
  pendingCallPayloadJson(pendingHandle: Handle): string;
  pendingCallReplyResult(pendingHandle: Handle, resultJson: string): Promise<void>;
  pendingCallReplyError(pendingHandle: Handle, detail: string): Promise<void>;
  // DHT records (cabi/dht.go). All five are real network I/O (a signed
  // CALL under the hood, same as sessionCall) -- backed by
  // Napi::AsyncWorker on the C++ side, same reasoning as sessionCall.
  // Each resolves with JSON text (a DhtRecord or DhtRecord[], per
  // dht.ts), except dhtFindRecord, which resolves `null` for
  // macula-go's dht.ErrNotFound specifically (an expected, common
  // outcome, not an error) rather than rejecting. dhtPutProcedureAdvertisement/
  // _ContentAnnouncement wrap macula-go's REAL constructors -- see
  // cabi/dht.go's own doc for why there is no single generic "put any
  // record type with an arbitrary JSON payload" function.
  dhtFindRecordsByType(sessionHandle: Handle, identityHandle: Handle, recordType: number): Promise<string>;
  dhtFindRecords(sessionHandle: Handle, identityHandle: Handle, key32: Uint8Array): Promise<string>;
  dhtFindRecord(sessionHandle: Handle, identityHandle: Handle, key32: Uint8Array): Promise<string | null>;
  dhtPutProcedureAdvertisement(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    procedure: string,
    servingStation32: Uint8Array,
    ttlMs: number,
  ): Promise<string>;
  dhtPutContentAnnouncement(
    sessionHandle: Handle,
    identityHandle: Handle,
    mcid34: Uint8Array,
    endpoint: string,
    ttlMs: number,
  ): Promise<string>;
  // Pubsub (cabi/pubsub.go). sessionPublish is real network I/O (one
  // signed frame write), same worker shape as sessionAdvertise.
  // sessionSubscribeStart/_Stop are this addon's first request/response
  // pair that ALSO carries a third, ongoing channel: onEvent is called
  // by the addon (via a Napi::ThreadSafeFunction wired to the Go-side
  // background reader goroutine, see addon/binding.cc) once per
  // delivered EVENT, for as long as the subscription stays open --
  // asynchronously, on its own schedule, not just once when the
  // returned Promise resolves. sessionSubscribeStart's Promise resolves
  // once the initial SUBSCRIBE has been sent and the reader goroutine
  // started; sessionSubscribeStop's Promise resolves only once that
  // goroutine has actually exited (UNSUBSCRIBE sent, no further onEvent
  // call possible) -- not merely once a stop was requested.
  sessionPublish(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    topic: string,
    payloadJson: string,
    ttlMs: number,
  ): Promise<void>;
  sessionSubscribeStart(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    topic: string,
    onEvent: (evt: { topic: string; publisher: Uint8Array; seq: number; payloadJson: string }) => void,
  ): Promise<bigint>;
  sessionSubscribeStop(subscriptionHandle: Handle): Promise<void>;
};

// The addon always returns BigInt (see addon/binding.cc's comment on
// why: a JS `number` loses precision above 2^53 and nothing guarantees
// a cgo.Handle value stays under that forever), but accepts either
// shape back for convenience.
export type Handle = number | bigint;

export const native = {
  identityGenerate(): bigint {
    return addon.identityGenerate();
  },
  identityFromSeedBytes(seed32: Uint8Array): bigint {
    if (seed32.length !== 32) {
      throw new Error(`macula-ts: seed must be exactly 32 bytes, got ${seed32.length}`);
    }
    return addon.identityFromSeedBytes(seed32);
  },
  identityNodeId(handle: Handle): Uint8Array {
    return addon.identityNodeId(handle);
  },
  identityPrivateBytes(handle: Handle): Uint8Array {
    return addon.identityPrivateBytes(handle);
  },
  identityFree(handle: Handle): void {
    addon.identityFree(handle);
  },
  sessionConnect(host: string, port: number, identityHandle: Handle): Promise<bigint> {
    return addon.sessionConnect(host, port, identityHandle);
  },
  sessionRemoteAddr(handle: Handle): string {
    return addon.sessionRemoteAddr(handle);
  },
  sessionStationNodeId(handle: Handle): Uint8Array {
    return addon.sessionStationNodeId(handle);
  },
  sessionClose(handle: Handle, identityHandle: Handle, reason: string): Promise<void> {
    return addon.sessionClose(handle, identityHandle, reason);
  },
  sessionCall(
    sessionHandle: Handle,
    identityHandle: Handle,
    procedure: string,
    realm: Uint8Array | undefined,
    payloadJson: string,
    timeoutMs: number,
  ): Promise<string> {
    return addon.sessionCall(sessionHandle, identityHandle, procedure, realm, payloadJson, timeoutMs);
  },
  sessionAdvertise(sessionHandle: Handle, identityHandle: Handle, realm: Uint8Array | undefined, procedure: string): Promise<void> {
    return addon.sessionAdvertise(sessionHandle, identityHandle, realm, procedure);
  },
  sessionUnadvertise(sessionHandle: Handle, identityHandle: Handle, realm: Uint8Array | undefined, procedure: string): Promise<void> {
    return addon.sessionUnadvertise(sessionHandle, identityHandle, realm, procedure);
  },
  serveWaitForCall(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    procedure: string,
    timeoutMs: number,
  ): Promise<Handle | null> {
    return addon.serveWaitForCall(sessionHandle, identityHandle, realm, procedure, timeoutMs);
  },
  pendingCallProcedure(pendingHandle: Handle): string {
    return addon.pendingCallProcedure(pendingHandle);
  },
  pendingCallPayloadJson(pendingHandle: Handle): string {
    return addon.pendingCallPayloadJson(pendingHandle);
  },
  pendingCallReplyResult(pendingHandle: Handle, resultJson: string): Promise<void> {
    return addon.pendingCallReplyResult(pendingHandle, resultJson);
  },
  pendingCallReplyError(pendingHandle: Handle, detail: string): Promise<void> {
    return addon.pendingCallReplyError(pendingHandle, detail);
  },
  dhtFindRecordsByType(sessionHandle: Handle, identityHandle: Handle, recordType: number): Promise<string> {
    return addon.dhtFindRecordsByType(sessionHandle, identityHandle, recordType);
  },
  dhtFindRecords(sessionHandle: Handle, identityHandle: Handle, key32: Uint8Array): Promise<string> {
    return addon.dhtFindRecords(sessionHandle, identityHandle, key32);
  },
  dhtFindRecord(sessionHandle: Handle, identityHandle: Handle, key32: Uint8Array): Promise<string | null> {
    return addon.dhtFindRecord(sessionHandle, identityHandle, key32);
  },
  dhtPutProcedureAdvertisement(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    procedure: string,
    servingStation32: Uint8Array,
    ttlMs: number,
  ): Promise<string> {
    return addon.dhtPutProcedureAdvertisement(sessionHandle, identityHandle, realm, procedure, servingStation32, ttlMs);
  },
  dhtPutContentAnnouncement(
    sessionHandle: Handle,
    identityHandle: Handle,
    mcid34: Uint8Array,
    endpoint: string,
    ttlMs: number,
  ): Promise<string> {
    return addon.dhtPutContentAnnouncement(sessionHandle, identityHandle, mcid34, endpoint, ttlMs);
  },
  sessionPublish(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    topic: string,
    payloadJson: string,
    ttlMs: number,
  ): Promise<void> {
    return addon.sessionPublish(sessionHandle, identityHandle, realm, topic, payloadJson, ttlMs);
  },
  sessionSubscribeStart(
    sessionHandle: Handle,
    identityHandle: Handle,
    realm: Uint8Array | undefined,
    topic: string,
    onEvent: (evt: { topic: string; publisher: Uint8Array; seq: number; payloadJson: string }) => void,
  ): Promise<bigint> {
    return addon.sessionSubscribeStart(sessionHandle, identityHandle, realm, topic, onEvent);
  },
  sessionSubscribeStop(subscriptionHandle: Handle): Promise<void> {
    return addon.sessionSubscribeStop(subscriptionHandle);
  },
};
