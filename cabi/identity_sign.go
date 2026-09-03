// identity_sign.go exposes identity.KeyPair.Sign -- a generic Ed25519
// signing primitive over identityHandle's own private key. data crosses
// this boundary as an opaque byte buffer and the 64-byte Ed25519
// signature (ed25519.Sign's raw output, unmodified) is written back
// verbatim into out64. Deliberately no application-specific message
// format is baked in anywhere in this file: whatever byte-layout
// convention a caller needs (e.g. an ownership-proof format) is that
// caller's own concern, built from plain bytes on the TypeScript side
// and passed in here as-is -- see src/identity.ts's sign() doc.
//
// No network I/O -- KeyPair.Sign is a direct ed25519.Sign wrapper, pure
// local computation -- so this exports synchronously, called directly
// (not via Napi::AsyncWorker) from addon/binding.cc, the same
// convention macula_identity_node_id and macula_ucan_mint/_decode use.
package main

/*
#include <stdint.h>
*/
import "C"

import (
	"unsafe"
)

// macula_identity_sign signs data with identityHandle's private key
// (identity.KeyPair.Sign) and writes the resulting 64-byte Ed25519
// signature into out64. dataLen==0 is handled explicitly rather than
// trusting C.GoBytes with a possibly-nil data pointer at length 0,
// matching content.go's macula_content_put. Returns 0 on success, -1
// for an invalid/already-freed identity handle -- resolved through
// identityFromHandle's own recover()-guarded lookup, the same guard
// every other identityHandle-taking export in this cabi uses; never
// cgo.Handle(h).Value() directly (see main.go's own doc on why:
// Value() panics, it does not return an error, on a handle this
// process never issued or already freed).
//
//export macula_identity_sign
func macula_identity_sign(identityHandle C.uintptr_t, data *C.uchar, dataLen C.int, out64 *C.uchar) C.int {
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		return -1
	}

	var dataBytes []byte
	if dataLen > 0 {
		dataBytes = C.GoBytes(unsafe.Pointer(data), dataLen)
	}

	sig := id.Sign(dataBytes)
	dst := unsafe.Slice((*byte)(unsafe.Pointer(out64)), 64)
	copy(dst, sig)
	return 0
}
