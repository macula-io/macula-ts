// directdial.go exposes macula-go's directdial package: caller-side
// resolve+one-hop-call (Resolve, Call, CallWithUCAN) and provider-side
// advertise-direct (AdvertiseDirect) -- see directdial/directdial.go's
// own doc for the trust model this reproduces: every candidate
// procedure_advertisement must carry a valid signature before its
// serving_station is trusted at all, the resolved station_endpoint must
// be signed by the station itself, and after the one-hop dial (which
// trusts neither the TLS certificate -- transport.Insecure{} -- nor
// nothing) the freshly connected session's own HELLO-proven identity is
// checked against the exact pubkey the signed DHT chain resolved. Also
// why AdvertiseDirect publishes BOTH a plain ADVERTISE and a signed
// procedure_advertisement DHT record: skipping the plain ADVERTISE lets
// resolve+dial complete cleanly against a station with nothing
// registered to route the CALL to -- a real bug macula-go fixed live
// 2026-08-30, found by verifying an actual RESULT came back through
// direct-dial rather than accepting a clean unknown_next_peer as
// sufficient proof.
//
// Composes directly with the existing Session/RPC/DHT work: every
// function here takes the SAME *connection.Session macula_session_connect
// already hands back. Resolve/Call/CallWithUCAN use it only to query the
// DHT (matching dht.go's FindRecord et al.); AdvertiseDirect sends the
// plain ADVERTISE and the DHT PutRecord on it directly. Both are reads/
// writes of this session's shared control stream, so src/session.ts
// applies the same call()-vs-active-serve() exclusivity guard to these as
// it does to call()/the DHT methods -- see AdvertiseDirect's own doc on
// why: it must not run on a session whose receive loop belongs to a
// ServeForever/ServeOneCall loop, or its own PutRecord CALL's reply is
// consumed by that loop instead and the put times out. A long-lived
// provider that wants to keep re-advertising on an interval while also
// serving therefore needs a SEPARATE session (and identity -- this fleet
// enforces one connection per identity, kicking whichever connects
// second) for that, not its own serving session; src/directdial.ts's
// keepAdvertisedDirect() takes whichever Session it's given and leaves
// that choice to the caller, exactly like macula-go's own
// KeepAdvertisedDirect free function does.
//
// Call/CallWithUCAN's actual one-hop dial to the resolved station is
// entirely internal to macula-go's directdial package -- a SEPARATE,
// short-lived connection.Session this file never surfaces as a handle:
// opened, application-layer-pinned against the resolved pubkey, used for
// exactly one CALL, and closed again, all inside the one macula-go call
// each of these wraps.
package main

/*
#include <stdint.h>
*/
import "C"

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/macula-io/macula-go/dht"
	"github.com/macula-io/macula-go/directdial"
)

// resolveResultJSON is the JSON shape macula_directdial_resolve returns
// on success -- kept in sync BY HAND with src/directdial.ts's
// DirectDialTarget, the same hand-synced-JSON convention every other FFI
// JSON shape in this cabi uses (callEnvelope in rpc.go, dhtRecordJSON in
// dht.go, ...). Station crosses as lowercase hex, matching dht.go's own
// convention for a raw identifier with no native JSON shape (NOT
// wirevalue.go's "0x"-prefixed convention for bytes found inside a
// payload -- this is a top-level field, not one).
type resolveResultJSON struct {
	Station string `json:"station"`
	Host    string `json:"host"`
	Port    uint16 `json:"port"`
}

// macula_directdial_resolve finds procedure's currently-advertised
// serving station and its dialable host/port (directdial.Resolve),
// retrying past DHT propagation lag internally -- up to 50 attempts x
// 100ms, macula-go's own fixed resolveRetries/resolveRetryDelay, not
// duplicated or made configurable here. realm32 nil means the all-zero
// realm (realm32OrZero, main.go), matching every other realm-taking
// export in this cabi. A procedure nobody ever called AdvertiseDirect for
// fails cleanly here (ErrProcedureNotAdvertised, wrapped into *errOut)
// after that bounded ~5s retry window -- never a hang.
//
// Real network I/O (one or more signed CALLs under the hood) -- must run
// off Node's main thread, like macula_dht_find_record.
//
//export macula_directdial_resolve
func macula_directdial_resolve(sessionHandle, identityHandle C.uintptr_t, realm32 *C.uchar, procedure *C.char, errOut **C.char) *C.char {
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
	station, host, port, err := directdial.Resolve(session, id, realm32OrZero(realm32), C.GoString(procedure))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	b, err := json.Marshal(resolveResultJSON{Station: hex.EncodeToString(station), Host: host, Port: port})
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode direct-dial resolve result as JSON: %w", err))
		return nil
	}
	return C.CString(string(b))
}

// macula_directdial_call resolves procedure's provider via direct-dial
// (through this session, used only to query the DHT) and calls it there
// in one hop, in a separate connection macula-go opens/pins/closes
// internally (directdial.Call) -- see this file's own doc. Returns the
// SAME callEnvelope JSON shape macula_session_call does (rpc.go) --
// ok:true with the RESULT payload, or ok:false with the structured
// BOLT#4 error -- reusing rpc.go's own callResponseToEnvelope rather
// than duplicating that mapping a second time. *errOut is reserved for a
// genuine resolve/dial/trust failure (procedure never advertised, no
// live station_endpoint, a resolved-but-different peer identity) or any
// other failure that never got a wire-level answer at all -- exactly
// macula_session_call's own errOut/envelope split, extended to also
// cover the resolve+dial stage this adds in front of the call itself.
//
// Real network I/O (DHT lookups, a fresh QUIC dial, then the CALL
// itself) -- must run off Node's main thread, like macula_session_call.
//
//export macula_directdial_call
func macula_directdial_call(
	sessionHandle C.uintptr_t,
	identityHandle C.uintptr_t,
	procedure *C.char,
	realm32 *C.uchar,
	payloadJSON *C.char,
	timeoutMs C.int64_t,
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

	var payloadStr string
	if payloadJSON != nil {
		payloadStr = C.GoString(payloadJSON)
	}
	payload, err := jsonToCbor(payloadStr)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	resp, err := directdial.Call(context.Background(), session, id, realm32OrZero(realm32), C.GoString(procedure), payload, timeout)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	envelopeJSON, err := json.Marshal(callResponseToEnvelope(resp))
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode direct-dial call response as JSON: %w", err))
		return nil
	}
	return C.CString(string(envelopeJSON))
}

// macula_directdial_call_with_ucan is macula_directdial_call, attaching
// ucanToken to the outgoing CALL (directdial.CallWithUCAN) -- for
// reaching a direct-dial-advertised procedure a provider has gated
// behind a ucan.Policy.Required policy. Every hecate-om capability is
// advertised via AdvertiseDirect specifically so it's reachable ONLY
// this way -- plain macula_directdial_call cannot resolve or attach a
// token to it. Same errOut/envelope split and threading requirement as
// macula_directdial_call.
//
//export macula_directdial_call_with_ucan
func macula_directdial_call_with_ucan(
	sessionHandle C.uintptr_t,
	identityHandle C.uintptr_t,
	procedure *C.char,
	realm32 *C.uchar,
	payloadJSON *C.char,
	timeoutMs C.int64_t,
	ucanToken *C.char,
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

	var payloadStr string
	if payloadJSON != nil {
		payloadStr = C.GoString(payloadJSON)
	}
	payload, err := jsonToCbor(payloadStr)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	var tokenStr string
	if ucanToken != nil {
		tokenStr = C.GoString(ucanToken)
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	resp, err := directdial.CallWithUCAN(
		context.Background(), session, id, realm32OrZero(realm32), C.GoString(procedure), payload, timeout, []byte(tokenStr),
	)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	envelopeJSON, err := json.Marshal(callResponseToEnvelope(resp))
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode direct-dial call-with-UCAN response as JSON: %w", err))
		return nil
	}
	return C.CString(string(envelopeJSON))
}

// macula_directdial_advertise publishes procedure as direct-dial-reachable
// at this session's own currently-connected station -- a plain ADVERTISE
// (so an inbound CALL routed here via the DHT-resolved path still has
// something to route to, see this file's own doc) plus a signed
// procedure_advertisement DHT record naming this session's station
// (directdial.AdvertiseDirect). ttlMs<=0 means dht.DefaultTTL (48h),
// matching macula_dht_put_content_announcement's own convention.
//
// Must NOT be called on a session that is also actively ServeOneCall-ing
// -- session.ts enforces this the same way it does for the DHT methods
// (see this file's own doc). Real network I/O (a fire-and-forget
// ADVERTISE write plus a signed PutRecord CALL) -- must run off Node's
// main thread, like macula_session_advertise.
//
//export macula_directdial_advertise
func macula_directdial_advertise(
	sessionHandle C.uintptr_t,
	identityHandle C.uintptr_t,
	realm32 *C.uchar,
	procedure *C.char,
	ttlMs C.int64_t,
	errOut **C.char,
) {
	session, ok := sessionFromHandle(sessionHandle)
	if !ok {
		setErr(errOut, errInvalidSessionHandle)
		return
	}
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return
	}
	ttl := time.Duration(ttlMs) * time.Millisecond
	if ttl <= 0 {
		ttl = dht.DefaultTTL
	}
	if err := directdial.AdvertiseDirect(session, id, realm32OrZero(realm32), C.GoString(procedure), ttl); err != nil {
		setErr(errOut, err)
	}
}
