// rpc.go is the caller role's half of unary RPC: macula_session_call
// wraps connection.Session.Call exactly (the real CALL/RESULT-or-ERROR
// round trip, CBOR framing and Ed25519 signing all handled by
// macula-go, not reimplemented here) -- see serve.go for the provider
// role's half.
package main

/*
#include <stdint.h>
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/macula-io/macula-go/bolt4"
	"github.com/macula-io/macula-go/frame"
)

// callEnvelope is the single JSON string macula_session_call returns on
// success (as opposed to *errOut, reserved for a genuine transport-
// level failure -- see this function's own doc). Marshaled by
// encoding/json, unmarshaled by src/rpc.ts's CallEnvelope type on the
// TypeScript side -- the two must be kept in sync by hand, there is no
// shared schema.
// Payload has no `omitempty` deliberately: a RESULT can legitimately
// carry a JSON null payload (cborToJSON(cbor.Null()) == nil), and
// omitempty on an `any` field drops the key entirely for a nil
// interface value -- which would make src/rpc.ts's CallEnvelope see
// `payload` as absent (undefined) instead of present-and-null on a
// genuinely null RESULT. Bolt4 keeps omitempty: a nil *callEnvelopeError
// pointer (the ok:true case) SHOULD vanish from the JSON entirely.
type callEnvelope struct {
	OK      bool               `json:"ok"`
	Payload any                `json:"payload"`
	Bolt4   *callEnvelopeError `json:"bolt4,omitempty"`
}

type callEnvelopeError struct {
	Code      uint8   `json:"code"`
	Name      string  `json:"name"`
	Retryable bool    `json:"retryable"`
	Detail    *string `json:"detail"`
}

func callResponseToEnvelope(resp frame.CallResponse) callEnvelope {
	if resp.IsError {
		return callEnvelope{OK: false, Bolt4: &callEnvelopeError{
			Code: resp.Code,
			Name: resp.Name,
			// bolt4.Code.IsRetryable() is the numeric code's own policy
			// verdict (bolt4/bolt4.go's nonRetryable table) -- computed
			// here, not left for the TypeScript side to reimplement from
			// a bare code number.
			Retryable: bolt4.Code(resp.Code).IsRetryable(),
			Detail:    resp.Detail,
		}}
	}
	return callEnvelope{OK: true, Payload: cborToJSON(resp.Payload)}
}

// macula_session_call sends a signed CALL for procedure and waits for
// the matching RESULT or ERROR (connection.Session.Call), bounded by
// timeoutMs both locally (how long this call blocks) and on the wire
// (deadline_ms, computed as now+timeoutMs -- matching macula-go's own
// examples/quickstart/main.go, which derives both from one duration).
//
// realm32 nil means the all-zero realm (realm32OrZero, main.go).
// payloadJSON is converted to a cbor.Value via jsonToCbor
// (wirevalue.go); a malformed payload (e.g. containing a JSON boolean,
// which has no CBOR representation on this wire) is a *errOut failure,
// same as an invalid handle -- neither ever reaches the network.
//
// The return value distinguishes two different kinds of "failure" that
// a naive single errOut convention would collapse together: *errOut is
// reserved for this call never getting a wire-level answer at all (bad
// input, a broken session, a local timeout with no response); a BOLT#4
// ERROR frame -- a real, structured answer from a provider or a relay
// -- is not a Go error at all (frame.CallResponse.IsError, not err !=
// nil) and comes back as ok:false in the JSON envelope instead, for
// src/rpc.ts's MaculaCallError to carry as a typed code/name/retryable
// triple rather than a generic thrown string.
//
// This is real network I/O -- a signed frame out and a wait for the
// matching reply, up to timeoutMs -- so it must run off Node's main
// thread; see addon/binding.cc's SessionCallWorker.
//
//export macula_session_call
func macula_session_call(
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
	deadlineMs := time.Now().Add(timeout).UnixMilli()

	resp, err := session.Call(C.GoString(procedure), realm32OrZero(realm32), payload, deadlineMs, id, timeout)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	envelopeJSON, err := json.Marshal(callResponseToEnvelope(resp))
	if err != nil {
		// Only reachable if the payload contains a non-finite float
		// (NaN/+-Inf) -- encoding/json refuses to marshal those, and
		// unlike every other error in this function that's a property
		// of what the PEER sent back, not of macula-ts's own input.
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode call response as JSON: %w", err))
		return nil
	}
	return C.CString(string(envelopeJSON))
}
