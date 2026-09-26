// Package main is macula-ts's C ABI over macula-go's macula 12 API: node keys,
// a pool of station links, calls and streams by direct dial, serving,
// publish/subscribe and the DHT. It is built as a C archive
// (-buildmode=c-archive) and linked into the N-API addon (addon/binding.cc).
//
// Handles: every Go value that crosses the boundary (a key, a pool, a
// subscription, a served procedure, a pending call, a stream) is a
// runtime/cgo.Handle, an opaque uintptr the TypeScript side holds and gives
// back, and frees with the matching _free or _stop when done. A handle this
// process never issued, or already freed, is refused as invalid rather than
// panicking (cgo.Handle.Value panics on one).
//
// Errors: a function that can fail takes a char** err_out. On failure it
// mallocs a C string into *err_out and returns a zero value; the caller frees
// it with macula_free_string. On success *err_out is untouched.
//
// Payloads cross as JSON text, converted to and from cbor.Value by
// wirevalue.go: no booleans, and bytes as {"$bytes": "<base64>"} going in and
// either "0x..." hex or the tagged form coming out, as the caller asks.
//
// Every function that does network I/O blocks the calling thread; the addon
// runs each on a worker thread (Napi::AsyncWorker), never on the event loop.
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
	"github.com/macula-io/macula-go/profile"
)

var errInvalidHandle = errors.New("macula-ts/cabi: invalid handle")

func setErr(errOut **C.char, err error) {
	if errOut == nil || err == nil {
		return
	}
	*errOut = C.CString(err.Error())
}

// valueOf resolves a handle to a value of type T, or ok false for a handle
// this process never issued, one already freed, or one of another type.
func valueOf[T any](h C.uintptr_t) (v T, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	if h == 0 {
		return v, false
	}
	v, ok = cgo.Handle(h).Value().(T)
	return v, ok
}

func newHandle(v any) C.uintptr_t { return C.uintptr_t(cgo.NewHandle(v)) }

// release frees a handle, ignoring one already freed or never issued.
func release(h C.uintptr_t) {
	defer func() { _ = recover() }()
	if h != 0 {
		cgo.Handle(h).Delete()
	}
}

func goBytes(p *C.uchar, n C.size_t) []byte {
	if p == nil || n == 0 {
		return nil
	}
	return C.GoBytes(unsafe.Pointer(p), C.int(n))
}

func id32(p *C.uchar) ([32]byte, bool) {
	var out [32]byte
	if p == nil {
		return out, false
	}
	copy(out[:], C.GoBytes(unsafe.Pointer(p), 32))
	return out, true
}

// cBytes mallocs a copy of b for the caller, who frees it with
// macula_free_bytes, and stores its length in *outLen.
func cBytes(b []byte, outLen *C.size_t) *C.uchar {
	*outLen = C.size_t(len(b))
	if len(b) == 0 {
		return nil
	}
	return (*C.uchar)(C.CBytes(b))
}

//export macula_free_string
func macula_free_string(s *C.char) { C.free(unsafe.Pointer(s)) }

//export macula_free_bytes
func macula_free_bytes(b *C.uchar) { C.free(unsafe.Pointer(b)) }

func parseProfile(name *C.char) (profile.Profile, error) {
	if name == nil {
		return profile.PQHybrid, nil
	}
	return profile.Parse(C.GoString(name))
}

// macula_key_generate makes a node identity key in profile ("pq_hybrid" or
// "pq_pure", pq_hybrid when NULL) whose node_id solves the admission puzzle.
// It takes a second or so: call it off the event loop.
//
//export macula_key_generate
func macula_key_generate(profileName *C.char, errOut **C.char) C.uintptr_t {
	p, err := parseProfile(profileName)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	key, err := identity.GenerateIdentityKey(p, identity.PuzzleDifficulty)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return newHandle(key)
}

// macula_key_load reads the identity key file at path in profile. A file the
// user's group or others can read, or that holds a key of another purpose or
// profile, is refused.
//
//export macula_key_load
func macula_key_load(path, profileName *C.char, errOut **C.char) C.uintptr_t {
	p, err := parseProfile(profileName)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	key, err := identity.LoadKey(C.GoString(path), identity.PurposeIdentity, p)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return newHandle(key)
}

// macula_key_save writes the key to path, readable by its owner only.
//
//export macula_key_save
func macula_key_save(h C.uintptr_t, path *C.char, errOut **C.char) {
	key, ok := valueOf[*identity.NodeKey](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	setErr(errOut, key.Save(C.GoString(path)))
}

// macula_key_node_id writes the key's 32-byte node_id to out32.
//
//export macula_key_node_id
func macula_key_node_id(h C.uintptr_t, out32 *C.uchar, errOut **C.char) {
	key, ok := valueOf[*identity.NodeKey](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	id, err := key.NodeID()
	if err != nil {
		setErr(errOut, err)
		return
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(out32)), 32), id[:])
}

// macula_key_public_key is the key as carried on the wire.
//
//export macula_key_public_key
func macula_key_public_key(h C.uintptr_t, outLen *C.size_t, errOut **C.char) *C.uchar {
	key, ok := valueOf[*identity.NodeKey](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	return cBytes(key.PublicKey(), outLen)
}

// macula_key_profile is the key's profile name, freed with
// macula_free_string.
//
//export macula_key_profile
func macula_key_profile(h C.uintptr_t, errOut **C.char) *C.char {
	key, ok := valueOf[*identity.NodeKey](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	return C.CString(string(key.Profile()))
}

// macula_key_sign signs data with the key, as it is given.
//
//export macula_key_sign
func macula_key_sign(h C.uintptr_t, data *C.uchar, dataLen C.size_t, outLen *C.size_t, errOut **C.char) *C.uchar {
	key, ok := valueOf[*identity.NodeKey](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	signature, err := key.Sign(goBytes(data, dataLen))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return cBytes(signature, outLen)
}

// macula_verify reports whether signature is valid over data for a public key
// as carried, under profile ("pq_hybrid" or "pq_pure", pq_hybrid when NULL):
// 1 when it is, 0 when it is not or anything is malformed. A profile it does
// not know is an error.
//
//export macula_verify
func macula_verify(data *C.uchar, dataLen C.size_t, signature *C.uchar, signatureLen C.size_t,
	publicKey *C.uchar, publicKeyLen C.size_t, profileName *C.char, errOut **C.char) C.int {
	p, err := parseProfile(profileName)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	if identity.Verify(goBytes(data, dataLen), goBytes(signature, signatureLen), goBytes(publicKey, publicKeyLen), p) {
		return 1
	}
	return 0
}

// macula_key_free frees the key's handle.
//
//export macula_key_free
func macula_key_free(h C.uintptr_t) { release(h) }

func main() {}
