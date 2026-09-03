// serve.go is the provider role's half of unary RPC: advertise a
// procedure (connection.Session.Advertise/Unadvertise) and answer
// inbound CALLs against it (connection.Session.ServeOneCall) -- see
// rpc.go for the caller role's half.
//
// ServeOneCall bundles "wait for a CALL, invoke a handler, send the
// reply" into one synchronous Go call with an embedded callback
// (connection.CallHandler). TypeScript has no equivalent of handing a
// Go closure across the FFI boundary, and the handler here needs to run
// arbitrary (possibly async) JS code -- so, exactly like
// macula-io/macula-php's cabi/serve.go (same problem, same fix,
// verified there first), this splits ServeOneCall's one call into
// three: macula_serve_wait_for_call blocks until a matching CALL
// arrives and returns a pendingCall handle; the TypeScript side reads
// its procedure/payload via plain accessors and computes an answer
// however it likes (including awaiting a Promise); then
// macula_pending_call_reply_result/_error resumes the waiting
// goroutine with that answer and blocks again until ServeOneCall has
// actually sent the reply frame.
//
// This is plain Go concurrency (one goroutine + two buffered channels
// per pending call), not anything requiring OS-level coordination --
// no fork(), no shared memory tricks.
package main

/*
#include <stdint.h>
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"runtime/cgo"
	"time"

	"github.com/macula-io/macula-go/cbor"
	"github.com/macula-io/macula-go/connection"
	"github.com/macula-io/macula-go/frame"
)

// pendingCall is the rendezvous point between the background goroutine
// driving Session.ServeOneCall and the later cgo calls the addon makes
// to inspect and reply to it -- see this file's own doc.
type pendingCall struct {
	procedure string
	payload   cbor.Value
	replyCh   chan callReply
	doneCh    chan error
}

type callReply struct {
	isError bool
	value   cbor.Value // RESULT payload, when !isError
	detail  *string    // ERROR detail, when isError
}

// errServeReply carries a handler-side error string back through
// connection.CallHandler's own (cbor.Value, error) contract --
// serve.go's ServeOneCallGated maps any non-nil handler error to BOLT#4
// UnknownError with this string as Detail (see macula-go's
// connection/serve.go buildCallReply), exactly the "a handler error to
// unknown_error" mapping this SDK's own scope calls for.
type errServeReply string

func (e errServeReply) Error() string { return string(e) }

// macula_session_advertise sends a signed ADVERTISE for (realm,
// procedure) -- connection.Session.Advertise. Fire-and-forget on the
// wire, but still a real network write, so it runs off Node's main
// thread like every other export here that touches the network (see
// addon/binding.cc's SessionAdvertiseWorker).
//
//export macula_session_advertise
func macula_session_advertise(sessionHandle C.uintptr_t, identityHandle C.uintptr_t, realm32 *C.uchar, procedure *C.char, errOut **C.char) {
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
	spec := frame.NewAdvertiseSpec(realm32OrZero(realm32), C.GoString(procedure), id.NodeID())
	if err := session.Advertise(spec, id); err != nil {
		setErr(errOut, err)
	}
}

// macula_session_unadvertise is macula_session_advertise's undo --
// connection.Session.Unadvertise.
//
//export macula_session_unadvertise
func macula_session_unadvertise(sessionHandle C.uintptr_t, identityHandle C.uintptr_t, realm32 *C.uchar, procedure *C.char, errOut **C.char) {
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
	spec := frame.NewUnadvertiseSpec(realm32OrZero(realm32), C.GoString(procedure), id.NodeID())
	if err := session.Unadvertise(spec, id); err != nil {
		setErr(errOut, err)
	}
}

// macula_serve_wait_for_call blocks (bounded by timeoutMs) for the next
// inbound CALL matching (realm, procedure) on this session's control
// stream, via connection.Session.ServeOneCall with a lookup that only
// matches that one (realm, procedure) pair -- a CALL for anything else
// arriving on this same session (not expected in steady state; see
// connection.CallLookup's own doc on the narrow unadvertise-race this
// covers) is answered UnknownNextPeer automatically by macula-go itself
// and never surfaces here at all, same as a plain timeout: the caller
// should just poll again.
//
// *noCallOut is set to 1 (and 0 returned) for both of those "keep
// polling, nothing for you this tick" cases -- the src/rpc.ts serve()
// loop treats them identically, matching macula-go's own ServeForever
// (connection/serve_loop.go), which does not distinguish them either.
// *errOut is reserved for an actual transport-level failure (a broken
// session), at which point the caller should stop polling instead.
//
// Real network I/O -- blocks reading frames off the QUIC stream -- so
// this runs off Node's main thread (addon/binding.cc's
// ServeWaitForCallWorker).
//
//export macula_serve_wait_for_call
func macula_serve_wait_for_call(
	sessionHandle C.uintptr_t,
	identityHandle C.uintptr_t,
	realm32 *C.uchar,
	procedure *C.char,
	timeoutMs C.int64_t,
	noCallOut *C.int,
	errOut **C.char,
) C.uintptr_t {
	session, ok := sessionFromHandle(sessionHandle)
	if !ok {
		setErr(errOut, errInvalidSessionHandle)
		return 0
	}
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return 0
	}

	wantRealm := realm32OrZero(realm32)
	wantProcedure := C.GoString(procedure)

	callCh := make(chan frame.CallInfo, 1)
	replyCh := make(chan callReply, 1)
	doneCh := make(chan error, 1)

	lookup := func(realm []byte, proc string) (connection.CallHandler, bool) {
		if proc != wantProcedure || !bytes.Equal(realm, wantRealm) {
			return nil, false
		}
		return connection.CallHandler(func(payload cbor.Value) (cbor.Value, error) {
			callCh <- frame.CallInfo{Procedure: proc, Realm: append([]byte(nil), realm...), Payload: payload}
			reply := <-replyCh
			if reply.isError {
				detail := ""
				if reply.detail != nil {
					detail = *reply.detail
				}
				return cbor.Null(), errServeReply(detail)
			}
			return reply.value, nil
		}), true
	}

	go func() {
		doneCh <- session.ServeOneCall(lookup, id, time.Duration(timeoutMs)*time.Millisecond)
	}()

	select {
	case info := <-callCh:
		handle := C.uintptr_t(cgo.NewHandle(&pendingCall{
			procedure: info.Procedure,
			payload:   info.Payload,
			replyCh:   replyCh,
			doneCh:    doneCh,
		}))
		return handle
	case err := <-doneCh:
		if err != nil && !errors.Is(err, connection.ErrServeOneCallTimeout) {
			setErr(errOut, err)
			return 0
		}
		// Either ErrServeOneCallTimeout (nothing arrived this tick), or
		// nil (a CALL arrived but didn't match lookup and macula-go
		// already answered it UnknownNextPeer on our behalf) -- both mean
		// "keep polling", see this function's own doc.
		if noCallOut != nil {
			*noCallOut = 1
		}
		return 0
	}
}

//export macula_pending_call_procedure
func macula_pending_call_procedure(pendingHandle C.uintptr_t, errOut **C.char) *C.char {
	pc, ok := pendingCallFromHandle(pendingHandle)
	if !ok {
		setErr(errOut, errInvalidPendingCallHandle)
		return nil
	}
	return C.CString(pc.procedure)
}

// macula_pending_call_payload_json is a local field read plus a JSON
// marshal -- no network I/O, safe to call synchronously from Node's
// main thread (see addon/binding.cc's PendingCallPayloadJson).
//
//export macula_pending_call_payload_json
func macula_pending_call_payload_json(pendingHandle C.uintptr_t, errOut **C.char) *C.char {
	pc, ok := pendingCallFromHandle(pendingHandle)
	if !ok {
		setErr(errOut, errInvalidPendingCallHandle)
		return nil
	}
	b, err := json.Marshal(cborToJSON(pc.payload))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return C.CString(string(b))
}

// macula_pending_call_reply_result resumes the goroutine blocked inside
// ServeOneCall's handler (see this file's own doc) with a RESULT
// payload, then blocks until ServeOneCall has actually sent the RESULT
// frame -- real network I/O, runs off Node's main thread. Deletes
// pendingHandle either way (success or failure): a pendingCall is
// answered exactly once, by design, same as macula-php's identical
// convention.
//
//export macula_pending_call_reply_result
func macula_pending_call_reply_result(pendingHandle C.uintptr_t, resultJSON *C.char, errOut **C.char) {
	pc, ok := pendingCallFromHandle(pendingHandle)
	if !ok {
		setErr(errOut, errInvalidPendingCallHandle)
		return
	}
	defer deleteHandle(pendingHandle)

	var resultStr string
	if resultJSON != nil {
		resultStr = C.GoString(resultJSON)
	}
	value, err := jsonToCbor(resultStr)
	if err != nil {
		// A malformed reply from the JS handler must still unblock the
		// waiting goroutine (replyCh has exactly one reader, forever, if
		// nothing is ever sent) -- turn it into an ERROR reply instead of
		// silently hanging the provider side.
		detail := err.Error()
		pc.replyCh <- callReply{isError: true, detail: &detail}
	} else {
		pc.replyCh <- callReply{value: value}
	}
	if err := <-pc.doneCh; err != nil {
		setErr(errOut, err)
	}
}

// macula_pending_call_reply_error is macula_pending_call_reply_result's
// counterpart for an ERROR reply -- see errServeReply's doc for how
// detail maps to the wire (BOLT#4 UnknownError). detail may be nil (an
// empty C string is still a valid, if uninformative, reply).
//
//export macula_pending_call_reply_error
func macula_pending_call_reply_error(pendingHandle C.uintptr_t, detail *C.char, errOut **C.char) {
	pc, ok := pendingCallFromHandle(pendingHandle)
	if !ok {
		setErr(errOut, errInvalidPendingCallHandle)
		return
	}
	defer deleteHandle(pendingHandle)

	var d *string
	if detail != nil {
		s := C.GoString(detail)
		d = &s
	}
	pc.replyCh <- callReply{isError: true, detail: d}
	if err := <-pc.doneCh; err != nil {
		setErr(errOut, err)
	}
}
