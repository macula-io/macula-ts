// Package main is macula-ts's C ABI layer: a thin cgo export wrapping
// macula-go's existing public API, built as a shared library
// (`go build -buildmode=c-shared`) for Node.js FFI to load directly.
// macula-go itself needs zero changes for this -- this file is an
// ordinary consumer of its public API, same as any Go program
// importing the module.
//
// Handles: every Go value that crosses the boundary (identities) is
// wrapped as a `runtime/cgo.Handle` -- an opaque uintptr safe to pass
// through C and back, the standard Go mechanism for exactly this.
// The TypeScript side holds the uintptr, never touches the Go value
// directly, and must call the matching `_free` function when done --
// there is no GC coordination across this boundary. This convention
// (and the error/output-buffer conventions below) is copied directly
// from macula-io/macula-php's cabi/main.go, which already proved it
// against a real station -- not reinvented here.
//
// Errors: any function that can fail takes a `char** err_out`. On
// failure it mallocs a C string into `*err_out` (via C.CString) and
// returns a zero/negative sentinel; the caller must free it with
// macula_free_string. On success `*err_out` is left untouched.
//
// Walking skeleton scope only: identity generation and its accessors.
// No network I/O, no CONNECT/HELLO handshake, no RPC/pubsub/DHT --
// those are separate, later work (see README.md's status section).
package main

/*
#include <stdlib.h>
#include <stdint.h>
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"

	"github.com/macula-io/macula-go/identity"
)

var errInvalidIdentityHandle = errors.New("macula-ts/cabi: invalid identity handle")

func setErr(errOut **C.char, err error) {
	if errOut == nil || err == nil {
		return
	}
	*errOut = C.CString(err.Error())
}

// identityFromHandle resolves a caller-supplied uintptr_t against
// runtime/cgo's handle table, returning ok=false for any handle this
// process never issued (or already freed) instead of propagating a
// panic. This matters specifically at this boundary: cgo.Handle.Value
// panics -- it does not return an error -- on an unregistered handle
// (verified directly: a garbage uintptr_t from the TypeScript side
// took the whole process down with "misuse of an invalid Handle"
// before this guard existed). Every exported function that takes an
// identityHandle must resolve it through this helper, never through
// cgo.Handle(h).Value() directly.
func identityFromHandle(h C.uintptr_t) (id identity.KeyPair, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	id, ok = cgo.Handle(h).Value().(identity.KeyPair)
	return
}

// deleteHandle is identityFromHandle's counterpart for freeing: Delete
// panics on an invalid/already-freed handle the same way Value does,
// so macula_identity_free must not call cgo.Handle(h).Delete()
// directly either.
func deleteHandle(h C.uintptr_t) {
	defer func() { recover() }()
	cgo.Handle(h).Delete()
}

// bytes32FromC reads a fixed 32-byte C buffer into a Go []byte.
func bytes32FromC(src *C.uchar) []byte {
	return append([]byte(nil), unsafe.Slice((*byte)(unsafe.Pointer(src)), 32)...)
}

//export macula_free_string
func macula_free_string(s *C.char) {
	C.free(unsafe.Pointer(s))
}

// macula_identity_generate mints a fresh, S/Kademlia puzzle-hardened
// Ed25519 identity via identity.Generate() -- the real, non-trivial
// operation this whole walking skeleton exists to prove reaches
// across the FFI boundary correctly (see README.md and
// src/identity.test.ts, which assert the puzzle property on the
// returned NodeID, not just that a call returns).
//
//export macula_identity_generate
func macula_identity_generate(errOut **C.char) C.uintptr_t {
	id, err := identity.Generate()
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return C.uintptr_t(cgo.NewHandle(id))
}

// macula_identity_from_seed_bytes reconstructs an identity from a
// 32-byte Ed25519 seed (no re-grinding -- see identity.FromSeed's own
// doc: a valid seed's derived key already satisfies whatever puzzle
// difficulty it was originally minted for).
//
//export macula_identity_from_seed_bytes
func macula_identity_from_seed_bytes(seed32 *C.uchar, errOut **C.char) C.uintptr_t {
	id, err := identity.FromSeed(bytes32FromC(seed32))
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return C.uintptr_t(cgo.NewHandle(id))
}

//export macula_identity_node_id
func macula_identity_node_id(identityHandle C.uintptr_t, out32 *C.uchar) C.int {
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		return -1
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(out32)), 32)
	copy(dst, id.NodeID())
	return 0
}

//export macula_identity_private_bytes
func macula_identity_private_bytes(identityHandle C.uintptr_t, out32 *C.uchar) C.int {
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		return -1
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(out32)), 32)
	copy(dst, id.Private.Seed())
	return 0
}

//export macula_identity_free
func macula_identity_free(identityHandle C.uintptr_t) {
	deleteHandle(identityHandle)
}

func main() {} // required by -buildmode=c-shared, never actually run
