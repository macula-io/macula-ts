// content.go exposes macula-go's content package (Put/Get -- ordinary
// CALL/RESULT against four reserved `_content.*` procedures, sent on
// their OWN dedicated QUIC stream via Session.OpenDedicatedStream, NOT
// the shared control stream rpc.go/serve.go/dht.go/pubsub.go all read
// from). See content/content.go's own doc: this is a one-time TRANSFER
// mechanism, not durable object storage -- a station is free to forget
// content after serving it, and there is no list/delete operation.
// src/content.ts and src/session.ts's putContent/getContent docs carry
// the same warning to TypeScript callers.
//
// Because Put/Get each open a FRESH dedicated stream of their own
// (content.Put/Get -> Session.OpenDedicatedStream), neither races a
// concurrent call()/serve()/subscribe()/DHT method on this session's
// shared control stream, and two concurrent Put/Get calls don't race
// each other either -- unlike every other network-touching export in
// this cabi so far, this pair needs no session-side exclusivity
// reasoning at all. src/session.ts's putContent/getContent are
// deliberately NOT routed through #requireHandleNotServing for exactly
// this reason.
//
// mcid crosses this boundary as a lowercase hex string (68 hex chars =
// manifest.Mcid's 34 bytes: <<Version:8, Codec:8, Hash:32/binary>>) --
// the same "raw byte identifier -> hex string" convention dht.go's
// dhtRecordToJSON already uses for a record's key/version/signature,
// not wirevalue.go's "0x"-prefixed convention (that one is specifically
// for bytes found *inside* a CALL/RESULT JSON payload, which an mcid
// standing on its own here isn't).
package main

/*
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"unsafe"

	"github.com/macula-io/macula-go/content"
	"github.com/macula-io/macula-go/manifest"
)

// macula_content_put stores data (content.Put -- chunked automatically
// above manifest.DefaultChunkSize, 256 KiB), returning the hex-encoded
// MCID it's now addressable by. name is attached to the resulting
// manifest ONLY on the chunked path -- a single-block put ignores it
// entirely, matching content.Put's own documented behavior (an empty
// name is fine either way).
//
// dataLen==0 is handled explicitly rather than trusting C.GoBytes with
// a possibly-nil data pointer at length 0 -- addon/binding.cc always
// supplies a real (if zero-length) buffer, but this keeps the export
// itself total rather than relying on that.
//
// Real network I/O -- opens its own dedicated stream and sends one or
// more signed CALLs on it (each internally retried per content.Put's
// own §12.2 policy) -- must run off Node's main thread; see
// addon/binding.cc's ContentPutWorker.
//
//export macula_content_put
func macula_content_put(sessionHandle, identityHandle C.uintptr_t, data *C.uchar, dataLen C.int, name *C.char, errOut **C.char) *C.char {
	session, ok := sessionFromHandle(sessionHandle)
	if !ok {
		setErr(errOut, errInvalidSessionHandle)
		return nil
	}
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return nil
	}

	var dataBytes []byte
	if dataLen > 0 {
		dataBytes = C.GoBytes(unsafe.Pointer(data), dataLen)
	}

	mcid, err := content.Put(context.Background(), session, dataBytes, C.GoString(name), id)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return C.CString(hex.EncodeToString(mcid[:]))
}

// macula_content_get fetches and verifies (content.Get -- including its
// own client-side hash re-check against mcidHex: a station may only be
// relaying content it doesn't itself store, so its answer is never
// trusted without this, see content.go's own doc) the content addressed
// by mcidHex.
//
// *notFoundOut is set to 1 (nil returned, *errOut left untouched)
// specifically for content.ErrNotFound -- an expected, routine outcome
// for a transfer mechanism with no durability guarantee -- distinguished
// from a real transport-level failure the same way macula_dht_find_record's
// own notFoundOut does (dht.go). On success, *outLen is set and the
// return value is a malloc'd buffer (C.CBytes) the caller must free via
// macula_free_bytes -- content is arbitrary binary data, not text, so
// unlike every *C.char-returning export elsewhere in this cabi it
// cannot cross as a NUL-terminated C string.
//
// Real network I/O, same threading requirement as macula_content_put.
//
//export macula_content_get
func macula_content_get(sessionHandle, identityHandle C.uintptr_t, mcidHex *C.char, outLen *C.int, notFoundOut *C.int, errOut **C.char) *C.uchar {
	session, ok := sessionFromHandle(sessionHandle)
	if !ok {
		setErr(errOut, errInvalidSessionHandle)
		return nil
	}
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return nil
	}

	mcidBytes, err := hex.DecodeString(C.GoString(mcidHex))
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: mcid must be a 34-byte lowercase hex string (68 chars): %w", err))
		return nil
	}
	if len(mcidBytes) != 34 {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: mcid must be exactly 34 bytes (68 hex chars), got %d", len(mcidBytes)))
		return nil
	}
	var mcid manifest.Mcid
	copy(mcid[:], mcidBytes)

	data, err := content.Get(context.Background(), session, mcid, id)
	if err != nil {
		if errors.Is(err, content.ErrNotFound) {
			if notFoundOut != nil {
				*notFoundOut = 1
			}
			return nil
		}
		setErr(errOut, err)
		return nil
	}
	if outLen != nil {
		*outLen = C.int(len(data))
	}
	return (*C.uchar)(C.CBytes(data))
}

// macula_free_bytes frees a buffer macula_content_get returned --
// C.CBytes's own counterpart, the same mechanism macula_free_string is
// for a *C.char, just for a *C.uchar instead (content is arbitrary
// binary data, not guaranteed-NUL-terminable text).
//
//export macula_free_bytes
func macula_free_bytes(p *C.uchar) {
	C.free(unsafe.Pointer(p))
}
