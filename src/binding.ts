// Loads cabi/'s compiled C-shared library and declares the exact C
// function signatures it exports (see cabi/main.go and the generated
// build/libmacula.h). This is the only file that touches koffi
// directly -- everything else in src/ talks to the typed wrappers
// this module exports, never to raw pointers.
//
// Memory-ownership convention (matches macula-io/macula-php's cabi,
// which proved this against a real station first): opaque Go values
// (identities) cross as a `uintptr_t` handle from runtime/cgo.Handle
// -- hold it, pass it back for every operation, and call the matching
// `_free` function exactly once when done. Fixed-length fields (a
// 32-byte NodeID or seed) are written directly into a caller-supplied
// output buffer of that exact size. A `char** errOut` out-parameter
// carries a heap-allocated error string on failure; koffi copies the
// string out for us on this shape, so there is nothing to free on the
// TS side for the error case (only cabi/main.go's C.CString calls
// leak-if-unfreed -- errOut here is consumed and never freed, which
// is fine: it's a rare error path, not a hot loop; a future revision
// could add an explicit macula_free_string(errOut) call if that ever
// matters).
//
// Every call shape below (the double-pointer errOut, the single
// uint8_t* out-buffer, the plain uintptr_t handle argument) was
// verified empirically against the real compiled library before this
// file was written, not assumed from documentation alone.
import koffi from "koffi";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// Only a Linux build is produced by `npm run build:native` today (see
// README.md's "Status" section) -- this walking skeleton deliberately
// does not attempt a cross-platform prebuilt matrix yet.
function libraryPath(): string {
  const candidates = [
    join(here, "..", "build", "libmacula.so"),
    join(here, "..", "build", "libmacula.dylib"),
    join(here, "..", "build", "libmacula.dll"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `macula-ts: no compiled cabi/ library found under build/. Run "npm run build:native" first. Looked for: ${candidates.join(", ")}`,
    );
  }
  return found;
}

const lib = koffi.load(libraryPath());
const charPtr = koffi.pointer("char");

// Opaque handle to a Go-side value (currently: only an identity
// KeyPair). koffi returns a plain JS `number` for handle values that
// fit safely (cgo.Handle issues small sequential integers in
// practice), but accept bigint too since that is what koffi falls
// back to for values outside Number.MAX_SAFE_INTEGER -- never assume
// which one you'll get back.
export type Handle = number | bigint;

const nativeGenerate = lib.func("macula_identity_generate", "uintptr_t", [
  koffi.out(koffi.pointer(charPtr, 2)),
]);
const nativeFromSeedBytes = lib.func(
  "macula_identity_from_seed_bytes",
  "uintptr_t",
  ["uint8_t*", koffi.out(koffi.pointer(charPtr, 2))],
);
const nativeNodeId = lib.func("macula_identity_node_id", "int", [
  "uintptr_t",
  koffi.out(koffi.pointer("uint8_t", 1)),
]);
const nativePrivateBytes = lib.func("macula_identity_private_bytes", "int", [
  "uintptr_t",
  koffi.out(koffi.pointer("uint8_t", 1)),
]);
const nativeFree = lib.func("macula_identity_free", "void", ["uintptr_t"]);

function checkErr(errOut: [string | null]): void {
  if (errOut[0] !== null) {
    throw new Error(`macula-ts (native): ${errOut[0]}`);
  }
}

export const native = {
  identityGenerate(): Handle {
    const errOut: [string | null] = [null];
    const handle = nativeGenerate(errOut) as Handle;
    checkErr(errOut);
    return handle;
  },
  identityFromSeedBytes(seed32: Uint8Array): Handle {
    if (seed32.length !== 32) {
      throw new Error(`macula-ts: seed must be exactly 32 bytes, got ${seed32.length}`);
    }
    const errOut: [string | null] = [null];
    const handle = nativeFromSeedBytes(Buffer.from(seed32), errOut) as Handle;
    checkErr(errOut);
    return handle;
  },
  identityNodeId(handle: Handle): Uint8Array {
    const out = Buffer.alloc(32);
    const rc = nativeNodeId(handle, out) as number;
    if (rc !== 0) {
      throw new Error(`macula-ts: identityNodeId failed on an invalid/freed handle (rc=${rc})`);
    }
    return out;
  },
  identityPrivateBytes(handle: Handle): Uint8Array {
    const out = Buffer.alloc(32);
    const rc = nativePrivateBytes(handle, out) as number;
    if (rc !== 0) {
      throw new Error(`macula-ts: identityPrivateBytes failed on an invalid/freed handle (rc=${rc})`);
    }
    return out;
  },
  identityFree(handle: Handle): void {
    nativeFree(handle);
  },
};
