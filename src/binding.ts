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
};
