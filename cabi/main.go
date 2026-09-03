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
// Scope so far: identity generation/accessors, transport + handshake
// (Session connect/close), unary RPC (both roles: Session.Call as
// caller, Session.Advertise + Session.ServeOneCall as provider -- see
// rpc.go and serve.go), DHT record client operations (dht.go:
// FindRecord/FindRecords/FindRecordsByType, plus PutRecord via two
// type-specific builders), pubsub (pubsub.go: Publish, and a
// Subscribe/Unsubscribe pair backed by a background reader goroutine),
// content transfer (content.go: Put/Get, each on its own dedicated QUIC
// stream), and UCAN mint/inspect/attach-to-call (ucan.go). No streaming
// RPC or direct-dial yet -- those are separate, later work (see
// README.md's status section).
//
// RPC payloads cross this boundary as JSON text, not a bespoke
// kind/value accessor scheme (contrast macula-php's cabi, which has no
// JSON on the PHP side and so uses one) -- converted to/from
// macula-go's cbor.Value by wirevalue.go, ported from macula-cli's
// internal/wirevalue package (already proven against the same no-bool,
// bytes-as-hex-string rules this boundary needs).
package main

/*
#include <stdlib.h>
#include <stdint.h>
*/
import "C"

import (
	"context"
	"errors"
	"runtime/cgo"
	"unsafe"

	"github.com/macula-io/macula-go/connection"
	"github.com/macula-io/macula-go/identity"
	"github.com/macula-io/macula-go/transport"
)

var (
	errInvalidIdentityHandle    = errors.New("macula-ts/cabi: invalid identity handle")
	errInvalidSessionHandle     = errors.New("macula-ts/cabi: invalid session handle")
	errInvalidPendingCallHandle = errors.New("macula-ts/cabi: invalid pending-call handle")
)

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

// sessionFromHandle is identityFromHandle's counterpart for
// *connection.Session -- same guard, same reason: cgo.Handle.Value
// panics on a handle this process never issued (or already freed)
// instead of returning an error.
func sessionFromHandle(h C.uintptr_t) (s *connection.Session, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	s, ok = cgo.Handle(h).Value().(*connection.Session)
	return
}

// bytes32FromC reads a fixed 32-byte C buffer into a Go []byte.
func bytes32FromC(src *C.uchar) []byte {
	return append([]byte(nil), unsafe.Slice((*byte)(unsafe.Pointer(src)), 32)...)
}

// realm32OrZero is bytes32FromC's nil-tolerant counterpart for realm
// fields specifically: rpc.go and serve.go's exports all take realm32
// as an optional 32-byte buffer, with a nil pointer meaning "use the
// all-zero realm" -- the same default macula-go's own quickstart
// example (examples/quickstart/main.go) and this project's live tests
// use, not invented here.
func realm32OrZero(src *C.uchar) []byte {
	if src == nil {
		return make([]byte, 32)
	}
	return bytes32FromC(src)
}

// pendingCallFromHandle is identityFromHandle's counterpart for
// *pendingCall (see serve.go) -- same guard, same reason.
func pendingCallFromHandle(h C.uintptr_t) (pc *pendingCall, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	pc, ok = cgo.Handle(h).Value().(*pendingCall)
	return
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

// macula_session_connect dials host:port and completes the full
// CONNECT/HELLO handshake via connection.Connect, using WebPKI trust
// (standard CA-bundle validation -- what the real production fleet
// presents; Pinned/Insecure trust modes are not exposed yet, future
// work). This is a real network round trip and can take up to
// connection.HandshakeTimeout (30s, enforced internally by macula-go,
// not duplicated here) -- like every export in this file, it has no
// async awareness of its own; running it off the Node main thread is
// addon/binding.cc's job (see ConnectWorker there), not cabi's.
//
//export macula_session_connect
func macula_session_connect(host *C.char, port C.uint16_t, identityHandle C.uintptr_t, errOut **C.char) C.uintptr_t {
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return 0
	}
	session, err := connection.Connect(context.Background(), C.GoString(host), uint16(port), transport.WebPKI{}, id)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return C.uintptr_t(cgo.NewHandle(session))
}

// macula_session_remote_addr returns the session's remote address as a
// newly-allocated C string; the caller must free it via
// macula_free_string.
//
//export macula_session_remote_addr
func macula_session_remote_addr(sessionHandle C.uintptr_t, errOut **C.char) *C.char {
	s, ok := sessionFromHandle(sessionHandle)
	if !ok {
		setErr(errOut, errInvalidSessionHandle)
		return nil
	}
	return C.CString(s.RemoteAddr())
}

// macula_session_station_node_id copies the station's HELLO-verified
// 32-byte NodeID (Ed25519 public key) into out32 -- proof, beyond "no
// error was thrown", that this is a real, application-layer-verified
// session: frame.Verify already checked this NodeID's signature over
// the HELLO frame inside connection.Connect: this just surfaces it.
//
//export macula_session_station_node_id
func macula_session_station_node_id(sessionHandle C.uintptr_t, out32 *C.uchar) C.int {
	s, ok := sessionFromHandle(sessionHandle)
	if !ok {
		return -1
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(out32)), 32)
	copy(dst, s.Station.NodeID)
	return 0
}

// macula_session_close sends a signed GOODBYE and closes the
// underlying QUIC connection (connection.Session.Close), then frees
// the session handle -- a session is not meant to be reused after
// this, closed or not. Requires identityHandle to still be a valid,
// non-freed identity (Close signs GOODBYE with it): callers must not
// dispose an Identity before closing every Session opened with it.
// Close has an internal 250ms drain sleep plus a network write, so
// like Connect this must run off the Node main thread (see
// addon/binding.cc's CloseWorker).
//
//export macula_session_close
func macula_session_close(sessionHandle C.uintptr_t, identityHandle C.uintptr_t, reason *C.char, errOut **C.char) C.int {
	s, ok := sessionFromHandle(sessionHandle)
	if !ok {
		setErr(errOut, errInvalidSessionHandle)
		return -1
	}
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return -1
	}
	err := s.Close(C.GoString(reason), nil, id)
	deleteHandle(sessionHandle) // the Go-side connection is gone either way
	if err != nil {
		setErr(errOut, err)
		return -1
	}
	return 0
}

func main() {} // required by -buildmode=c-shared, never actually run
