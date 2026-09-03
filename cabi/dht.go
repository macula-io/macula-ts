// dht.go exposes macula-go's dht package: FindRecord/FindRecords/
// FindRecordsByType (thin CALL wrappers to the mesh's own reserved
// `_dht.*` procedures under the DHT's own all-zero realm -- macula-go's
// dht package threads that realm internally, these wrappers never
// construct or pass one themselves), plus PutRecord via two
// type-specific builders (put_procedure_advertisement,
// put_content_announcement -- see their own doc for why this is NOT one
// generic put taking an arbitrary JSON payload). Composes directly with
// the existing Session/RPC work: dht.FindRecordsByType et al. take the
// SAME *connection.Session macula_session_connect already hands back --
// no new transport-level plumbing needed here, and (like
// macula_session_call) these all end up on the same shared control
// stream a CALL uses, so src/session.ts applies the same
// call()-vs-active-serve() exclusivity guard to these as it does to
// call() itself.
//
// Records cross this boundary as JSON, the same convention RPC payloads
// use (see wirevalue.go) -- dhtRecordJSON below, kept in sync by hand
// with src/dht.ts's DhtRecord type. A record's Payload field (itself a
// cbor.Value map) reuses cborToJSON/jsonToCbor exactly like a CALL
// payload does; Key/Version/Signature (all raw bytes with no native
// JSON shape) cross as lowercase hex strings -- deliberately NOT
// wirevalue.go's own "0x"-prefixed convention, so as not to imply they
// went through jsonToCbor's byte-producing path (which does not exist --
// see that file's own doc on why bytes are one-directional there).
// src/dht.ts documents this deliberate asymmetry on its own side.
package main

/*
#include <stdint.h>
*/
import "C"

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unsafe"

	"github.com/macula-io/macula-go/connection"
	"github.com/macula-io/macula-go/dht"
	"github.com/macula-io/macula-go/identity"
)

type dhtRecordJSON struct {
	Type      uint8  `json:"type"`
	Key       string `json:"key"`
	Version   string `json:"version"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Payload   any    `json:"payload"`
	Signature string `json:"signature"`
}

func dhtRecordToJSON(r dht.Record) dhtRecordJSON {
	return dhtRecordJSON{
		Type:      r.Type,
		Key:       hex.EncodeToString(r.Key),
		Version:   hex.EncodeToString(r.Version),
		CreatedAt: r.CreatedAt,
		ExpiresAt: r.ExpiresAt,
		Payload:   cborToJSON(r.Payload),
		Signature: hex.EncodeToString(r.Signature),
	}
}

// marshalRecords JSON-encodes a []dht.Record as a JSON array, the shape
// macula_dht_find_records/_by_type both return on success -- factored
// out since both do exactly this and nothing else once they have their
// records.
func marshalRecords(records []dht.Record, errOut **C.char) *C.char {
	out := make([]dhtRecordJSON, len(records))
	for i, r := range records {
		out[i] = dhtRecordToJSON(r)
	}
	b, err := json.Marshal(out)
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode DHT records as JSON: %w", err))
		return nil
	}
	return C.CString(string(b))
}

// key32FromC reads a MANDATORY 32-byte C buffer as a [32]byte -- a DHT
// storage key, unlike realm32 (main.go's realm32OrZero), has no
// meaningful "nil means use a default" reading, so this has no
// nil-tolerant counterpart the way realm32OrZero is one for
// bytes32FromC.
func key32FromC(src *C.uchar) [32]byte {
	var out [32]byte
	copy(out[:], bytes32FromC(src))
	return out
}

// macula_dht_find_records_by_type returns every record of recordType
// currently visible from the station this session is connected to
// (dht.FindRecordsByType) -- coverage depends on that station's own
// view of the DHT, not a global guarantee. Real network I/O (a signed
// CALL under the hood) -- must run off Node's main thread, like
// macula_session_call (see addon/binding.cc's DhtFindRecordsByTypeWorker).
//
//export macula_dht_find_records_by_type
func macula_dht_find_records_by_type(sessionHandle, identityHandle C.uintptr_t, recordType C.uint8_t, errOut **C.char) *C.char {
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
	records, err := dht.FindRecordsByType(session, id, uint8(recordType))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return marshalRecords(records, errOut)
}

// macula_dht_find_records returns every record stored at key32 --
// the full signer-deduped multiset (dht.FindRecords), e.g. every
// procedure_advertisement for one procedure, not just one. Real network
// I/O, same threading requirement as above.
//
//export macula_dht_find_records
func macula_dht_find_records(sessionHandle, identityHandle C.uintptr_t, key32 *C.uchar, errOut **C.char) *C.char {
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
	records, err := dht.FindRecords(session, id, key32FromC(key32))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return marshalRecords(records, errOut)
}

// macula_dht_find_record fetches ONE record by key32 (dht.FindRecord).
// *notFoundOut is set to 1 (and nil returned, *errOut left untouched)
// specifically for dht.ErrNotFound -- an expected, common outcome here,
// distinguished from a real transport-level failure the same way
// macula_serve_wait_for_call's *noCallOut distinguishes "nothing this
// tick" from an actual error (serve.go). Real network I/O, same
// threading requirement as above.
//
//export macula_dht_find_record
func macula_dht_find_record(sessionHandle, identityHandle C.uintptr_t, key32 *C.uchar, notFoundOut *C.int, errOut **C.char) *C.char {
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
	rec, err := dht.FindRecord(session, id, key32FromC(key32))
	if err != nil {
		if errors.Is(err, dht.ErrNotFound) {
			if notFoundOut != nil {
				*notFoundOut = 1
			}
			return nil
		}
		setErr(errOut, err)
		return nil
	}
	b, err := json.Marshal(dhtRecordToJSON(rec))
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode DHT record as JSON: %w", err))
		return nil
	}
	return C.CString(string(b))
}

// bytesNFromC reads a mandatory N-byte C buffer into a Go []byte --
// bytes32FromC generalized to a caller-supplied length, needed here for
// content_announcement's 34-byte MCID (bytes32FromC's own 32 is a
// different, unrelated width).
func bytesNFromC(src *C.uchar, n int) []byte {
	return append([]byte(nil), unsafe.Slice((*byte)(unsafe.Pointer(src)), n)...)
}

func signAndPutRecord(session *connection.Session, id identity.KeyPair, rec dht.Record, errOut **C.char) *C.char {
	rec = dht.Sign(rec, id)
	if err := dht.PutRecord(session, id, rec); err != nil {
		setErr(errOut, err)
		return nil
	}
	b, err := json.Marshal(dhtRecordToJSON(rec))
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode DHT record as JSON: %w", err))
		return nil
	}
	return C.CString(string(b))
}

// macula_dht_put_procedure_advertisement builds the realm-qualified
// discovery URI (dht.DiscoveryURI), then builds (dht.
// NewProcedureAdvertisement), signs (dht.Sign), and stores (dht.
// PutRecord) a procedure_advertisement naming this identity as that
// procedure's advertiser and servingStation32 as the station that
// serves it.
//
// realm32 is threaded through and pre-pended via dht.DiscoveryURI
// rather than left for the caller to hex-encode and concatenate
// themselves: NewProcedureAdvertisement's own doc is explicit that
// "the advertiser and the resolver must derive the identical URI or
// the DHT storage key (dht.ProcedureKey) will not agree" -- doing this
// here, once, with macula-go's own DiscoveryURI, is the only way to
// guarantee that agreement; a caller-supplied pre-qualified string
// invites exactly the class of bug this function exists to make
// impossible (verified directly: an earlier draft of this SDK's own
// live test passed a bare, unqualified procedure name here and its
// following find_record came back not-found -- a real bug in test code
// this signature now makes unwritable). nil realm32 means the all-zero
// realm, same convention as realm32OrZero (main.go), though DHT
// discovery URIs are not actually DHT-realm records themselves --
// realm32 here is the REALM THE PROCEDURE ITSELF IS SERVED UNDER (the
// same realm session.call()/serve() would use for that procedure), not
// the DHT's own reserved realm dht.FindRecordsByType et al. operate
// under internally.
//
// Deliberately calls macula-go's REAL constructor rather than
// hand-building the envelope generically from a JSON payload the way
// rpc.go's macula_session_call builds a CALL's payload: two of this
// record type's three payload fields (advertiser_node, serving_station)
// are raw 32-byte pubkeys that must round-trip as CBOR BYTE strings
// (major type 2) for a real resolver's bytesField() reads to succeed --
// and wirevalue.go's jsonToCbor, by its own doc, has no path that
// produces cbor.Bytes going IN (only cborToJSON produces the
// "0x"-prefixed hex convention going OUT). A generic JSON-payload path
// here would silently write those fields as CBOR TEXT strings instead,
// producing a record that stores and signs successfully but that no
// real reader could parse. ttlMs<=0 means "use dht.DefaultTTL" (48h) --
// NewProcedureAdvertisement's own ttl<=0 handling, not duplicated here.
//
// Real network I/O (dht.PutRecord is a signed CALL under the hood) --
// must run off Node's main thread, like macula_session_call.
//
//export macula_dht_put_procedure_advertisement
func macula_dht_put_procedure_advertisement(
	sessionHandle, identityHandle C.uintptr_t,
	realm32 *C.uchar,
	procedure *C.char,
	servingStation32 *C.uchar,
	ttlMs C.int64_t,
	errOut **C.char,
) *C.char {
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
	uri := dht.DiscoveryURI(realm32OrZero(realm32), C.GoString(procedure))
	rec, err := dht.NewProcedureAdvertisement(
		id.NodeID(),
		uri,
		bytes32FromC(servingStation32),
		time.Duration(ttlMs)*time.Millisecond,
	)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return signAndPutRecord(session, id, rec, errOut)
}

// macula_dht_put_content_announcement builds (dht.NewContentAnnouncement),
// signs, and stores a content_announcement naming this identity as
// mcid34's announcer, reachable at endpoint. Same reasoning as
// macula_dht_put_procedure_advertisement's own doc for why this wraps
// macula-go's real constructor rather than a generic JSON payload path
// -- announcer_node and mcid are both raw-byte fields with the same
// jsonToCbor limitation. ttlMs<=0 is mapped to dht.DefaultTTL here
// (unlike NewProcedureAdvertisement, NewContentAnnouncement itself has
// no such default -- an unspecified TTL should not silently mean
// "already expired").
//
//export macula_dht_put_content_announcement
func macula_dht_put_content_announcement(
	sessionHandle, identityHandle C.uintptr_t,
	mcid34 *C.uchar,
	endpoint *C.char,
	ttlMs C.int64_t,
	errOut **C.char,
) *C.char {
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
	ttl := time.Duration(ttlMs) * time.Millisecond
	if ttl <= 0 {
		ttl = dht.DefaultTTL
	}
	rec, err := dht.NewContentAnnouncement(id.NodeID(), bytesNFromC(mcid34, 34), C.GoString(endpoint), ttl)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return signAndPutRecord(session, id, rec, errOut)
}
