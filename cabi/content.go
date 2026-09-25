package main

/*
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"errors"
	"time"

	"github.com/macula-io/macula-go/manifest"
	"github.com/macula-io/macula-go/pool"
)

// Node-served content (macula 12.6.0, D27), over macula-go's pool: a node
// shares content on its own ~<node_id>/content_v1 and announces it; a fetch
// finds the announcements, dials each sharer and checks everything against
// the content id.

// mcidOf is a 50-byte content id, or false.
func mcidOf(p *C.uchar, n C.size_t) (manifest.Mcid, bool) {
	var mcid manifest.Mcid
	if int(n) != len(mcid) {
		return mcid, false
	}
	copy(mcid[:], goBytes(p, n))
	return mcid, true
}

var errNotAContentID = errors.New("macula-ts/cabi: a content id is 50 bytes")

// macula_pool_share_content keeps data, serves it in realm and announces it,
// and returns its content id (50 bytes, in *outLen).
//
//export macula_pool_share_content
func macula_pool_share_content(h C.uintptr_t, realm32 *C.uchar, data *C.uchar, dataLen C.size_t, name *C.char,
	timeoutMs C.int64_t, outLen *C.size_t, errOut **C.char) *C.uchar {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	realm, _ := id32(realm32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	mcid, err := p.ShareContent(ctx, realm, goBytes(data, dataLen), C.GoString(name))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return cBytes(mcid[:], outLen)
}

// macula_pool_unshare_content stops sharing a content id in realm and
// withdraws its announcement.
//
//export macula_pool_unshare_content
func macula_pool_unshare_content(h C.uintptr_t, realm32 *C.uchar, mcidPtr *C.uchar, mcidLen C.size_t, timeoutMs C.int64_t, errOut **C.char) {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	mcid, ok := mcidOf(mcidPtr, mcidLen)
	if !ok {
		setErr(errOut, errNotAContentID)
		return
	}
	realm, _ := id32(realm32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	setErr(errOut, p.UnshareContent(ctx, realm, mcid))
}

// macula_pool_get_content fetches a content id in realm and returns its bytes
// (in *outLen), within the bounds given (0 for each default). Content nobody
// shares is the error "not_shared"; content every sharer failed to give is
// "unavailable:" followed by each failure.
//
//export macula_pool_get_content
func macula_pool_get_content(h C.uintptr_t, realm32 *C.uchar, mcidPtr *C.uchar, mcidLen C.size_t, maxBytes C.uint64_t,
	maxChunks C.int, parallel C.int, chunkTimeoutMs C.int64_t, timeoutMs C.int64_t, outLen *C.size_t, errOut **C.char) *C.uchar {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	mcid, ok := mcidOf(mcidPtr, mcidLen)
	if !ok {
		setErr(errOut, errNotAContentID)
		return nil
	}
	realm, _ := id32(realm32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	data, err := p.GetContent(ctx, realm, mcid, pool.ContentOptions{MaxBytes: uint64(maxBytes), MaxChunks: int(maxChunks),
		Parallel: int(parallel), ChunkTimeout: time.Duration(chunkTimeoutMs) * time.Millisecond})
	switch {
	case errors.Is(err, pool.ErrContentUnavailable):
		setErr(errOut, errors.New("unavailable:"+err.Error()))
		return nil
	case errors.Is(err, pool.ErrNotShared):
		setErr(errOut, errors.New("not_shared"))
		return nil
	case err != nil:
		setErr(errOut, err)
		return nil
	}
	return cBytes(data, outLen)
}
