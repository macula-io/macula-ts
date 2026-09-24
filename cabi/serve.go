package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef void (*macula_request_callback)(void* user_data, uintptr_t handle, const char* request_json);
static inline void callRequestCallback(macula_request_callback cb, void* user_data, uintptr_t handle,
    const char* request_json) {
  cb(user_data, handle, request_json);
}
*/
import "C"

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
	"unsafe"

	"github.com/macula-io/macula-go/cbor"
	"github.com/macula-io/macula-go/frame"
	"github.com/macula-io/macula-go/pool"
	"github.com/macula-io/macula-go/stationlink"
)

// Serving: a served procedure's CALLs are handed to the TypeScript side as a
// pending-call handle and the request as JSON, on a Go thread; the TypeScript
// side answers with macula_pending_reply or macula_pending_error, once. A call
// not answered by its deadline is answered for it with an error. A streaming
// procedure's sessions are handed over as a stream handle, which the
// TypeScript side drives and ends.

var errAnswered = errors.New("macula-ts/cabi: the call was already answered")

// pendingCall is a served CALL waiting for its answer.
type pendingCall struct {
	once   sync.Once
	answer chan pendingAnswer
}

type pendingAnswer struct {
	payload cbor.Value
	err     error
}

func requestJSON(r stationlink.Request, mode bytesOutput) *C.char {
	text, _ := json.Marshal(map[string]any{
		"caller": hex.EncodeToString(r.Caller[:]), "realm": hex.EncodeToString(r.Realm[:]),
		"procedure": r.Procedure, "payload": cborToJSON(r.Payload, mode), "deadline_ms": r.Deadline.UnixMilli(),
	})
	return C.CString(string(text))
}

// macula_pool_serve serves procedure in realm with on_call: each CALL is handed
// over as a pending-call handle and the request's JSON {caller, realm,
// procedure, payload, deadline_ms}. The returned handle is given back to
// macula_served_stop.
//
//export macula_pool_serve
func macula_pool_serve(h C.uintptr_t, realm32 *C.uchar, procedure *C.char, onCall C.macula_request_callback,
	userData unsafe.Pointer, bytesMode C.int, errOut **C.char) C.uintptr_t {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return 0
	}
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	realm, _ := id32(realm32)
	handler := func(ctx context.Context, r stationlink.Request) (cbor.Value, error) {
		pending := &pendingCall{answer: make(chan pendingAnswer, 1)}
		ph := newHandle(pending)
		defer release(ph)
		request := requestJSON(r, mode)
		C.callRequestCallback(onCall, userData, C.uintptr_t(ph), request)
		C.free(unsafe.Pointer(request))
		select {
		case answer := <-pending.answer:
			return answer.payload, answer.err
		case <-ctx.Done():
			return cbor.Value{}, errors.New("not answered by its deadline")
		}
	}
	served, err := p.Serve(context.Background(), pool.Offer{Realm: realm, Procedure: C.GoString(procedure), Handler: handler})
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return newHandle(served)
}

func answer(h C.uintptr_t, a pendingAnswer, errOut **C.char) {
	pending, ok := valueOf[*pendingCall](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	sent := false
	pending.once.Do(func() {
		pending.answer <- a
		sent = true
	})
	if !sent {
		setErr(errOut, errAnswered)
	}
}

// macula_pending_reply answers a served call with result (JSON).
//
//export macula_pending_reply
func macula_pending_reply(h C.uintptr_t, resultJSON *C.char, errOut **C.char) {
	result, err := jsonToCbor(C.GoString(resultJSON))
	if err != nil {
		setErr(errOut, err)
		return
	}
	answer(h, pendingAnswer{payload: result}, errOut)
}

// macula_pending_error answers a served call with a handler_error carrying
// message.
//
//export macula_pending_error
func macula_pending_error(h C.uintptr_t, message *C.char, errOut **C.char) {
	answer(h, pendingAnswer{err: errors.New(C.GoString(message))}, errOut)
}

// macula_served_stop withdraws the procedure everywhere and frees the handle.
//
//export macula_served_stop
func macula_served_stop(h C.uintptr_t, errOut **C.char) {
	served, ok := valueOf[*pool.Served](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	setErr(errOut, served.Stop())
	release(h)
}

func streamMode(mode C.int) (frame.StreamMode, error) {
	switch frame.StreamMode(mode) {
	case frame.ServerStream, frame.ClientStream, frame.Bidi:
		return frame.StreamMode(mode), nil
	}
	return 0, errors.New("macula-ts/cabi: a stream mode is 0 (server), 1 (client) or 2 (bidi)")
}

// macula_pool_serve_stream serves procedure in realm as a stream of mode: each
// session is handed to on_stream as a stream handle and the request's JSON.
// The session lives until the TypeScript side ends it, or its peer does; the
// stream handle is freed with macula_stream_free.
//
//export macula_pool_serve_stream
func macula_pool_serve_stream(h C.uintptr_t, realm32 *C.uchar, procedure *C.char, mode C.int,
	onStream C.macula_request_callback, userData unsafe.Pointer, bytesMode C.int, errOut **C.char) C.uintptr_t {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return 0
	}
	bytes, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	m, err := streamMode(mode)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	realm, _ := id32(realm32)
	handler := func(_ context.Context, s *stationlink.Stream) error {
		sh := newHandle(s)
		open := s.Request()
		request := requestJSON(stationlink.Request{Caller: open.Caller, Realm: open.Realm, Procedure: open.Procedure,
			Payload: open.Payload, Deadline: time.UnixMilli(int64(open.Deadline))}, bytes)
		C.callRequestCallback(onStream, userData, C.uintptr_t(sh), request)
		C.free(unsafe.Pointer(request))
		<-s.Done()
		return nil
	}
	served, err := p.Serve(context.Background(), pool.Offer{Realm: realm, Procedure: C.GoString(procedure),
		Stream: &stationlink.StreamOffer{Mode: m, Handler: handler}})
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return newHandle(served)
}

// macula_pool_open_stream opens a stream of mode on procedure in realm at a
// provider (any trusted one when provider32 is NULL), with payload as the
// open's, its deadline deadline_ms ahead (30 s when 0).
//
//export macula_pool_open_stream
func macula_pool_open_stream(h C.uintptr_t, realm32 *C.uchar, procedure *C.char, mode C.int, payloadJSON *C.char,
	provider32 *C.uchar, deadlineMs C.int64_t, timeoutMs C.int64_t, errOut **C.char) C.uintptr_t {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return 0
	}
	m, err := streamMode(mode)
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	payload, err := jsonToCbor(C.GoString(payloadJSON))
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	realm, _ := id32(realm32)
	provider, _ := id32(provider32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	s, err := p.OpenStream(ctx, pool.StreamCall{Realm: realm, Procedure: C.GoString(procedure), Provider: provider,
		Mode: m, Payload: payload, Deadline: time.Duration(deadlineMs) * time.Millisecond})
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return newHandle(s)
}

func streamOf(h C.uintptr_t, errOut **C.char) *stationlink.Stream {
	s, ok := valueOf[*stationlink.Stream](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	return s
}

// macula_stream_send_bytes sends a raw chunk.
//
//export macula_stream_send_bytes
func macula_stream_send_bytes(h C.uintptr_t, data *C.uchar, dataLen C.size_t, errOut **C.char) {
	if s := streamOf(h, errOut); s != nil {
		setErr(errOut, s.Send(goBytes(data, dataLen)))
	}
}

// macula_stream_send_json sends a structured chunk.
//
//export macula_stream_send_json
func macula_stream_send_json(h C.uintptr_t, valueJSON *C.char, errOut **C.char) {
	s := streamOf(h, errOut)
	if s == nil {
		return
	}
	v, err := jsonToCbor(C.GoString(valueJSON))
	if err != nil {
		setErr(errOut, err)
		return
	}
	setErr(errOut, s.SendValue(v))
}

// macula_stream_close_send ends this side's sending.
//
//export macula_stream_close_send
func macula_stream_close_send(h C.uintptr_t, errOut **C.char) {
	if s := streamOf(h, errOut); s != nil {
		setErr(errOut, s.CloseSend())
	}
}

// macula_stream_close ends the stream on both sides.
//
//export macula_stream_close
func macula_stream_close(h C.uintptr_t, errOut **C.char) {
	if s := streamOf(h, errOut); s != nil {
		setErr(errOut, s.Close())
	}
}

// macula_stream_reply sends the provider's terminal value (JSON).
//
//export macula_stream_reply
func macula_stream_reply(h C.uintptr_t, payloadJSON *C.char, errOut **C.char) {
	s := streamOf(h, errOut)
	if s == nil {
		return
	}
	v, err := jsonToCbor(C.GoString(payloadJSON))
	if err != nil {
		setErr(errOut, err)
		return
	}
	setErr(errOut, s.Reply(v))
}

// macula_stream_abort ends the stream with a STREAM_ERROR of code and message.
//
//export macula_stream_abort
func macula_stream_abort(h C.uintptr_t, code, message *C.char, errOut **C.char) {
	if s := streamOf(h, errOut); s != nil {
		setErr(errOut, s.Abort(C.GoString(code), C.GoString(message)))
	}
}

// macula_stream_recv waits up to timeout_ms (forever when 0) for the peer's
// next frame and returns it as JSON: {kind: "data", encoding, body}, {kind:
// "end", role}, {kind: "reply", payload}, {kind: "eof"} after a normal end,
// {kind: "error", code, message, relay} for a stream error, or the error
// "timeout".
//
//export macula_stream_recv
func macula_stream_recv(h C.uintptr_t, timeoutMs C.int64_t, bytesMode C.int, errOut **C.char) *C.char {
	s := streamOf(h, errOut)
	if s == nil {
		return nil
	}
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	event, err := s.Recv(ctx)
	var out map[string]any
	var streamErr *stationlink.StreamError
	switch {
	case err == nil:
		out = eventJSON(event, mode)
	case errors.Is(err, io.EOF):
		out = map[string]any{"kind": "eof"}
	case errors.As(err, &streamErr):
		out = map[string]any{"kind": "error", "code": streamErr.Code, "message": streamErr.Message, "relay": boolText(streamErr.Relay)}
	case errors.Is(err, context.DeadlineExceeded):
		setErr(errOut, errors.New("timeout"))
		return nil
	default:
		setErr(errOut, err)
		return nil
	}
	text, _ := json.Marshal(out)
	return C.CString(string(text))
}

// boolText is a flag as the JSON crossing this boundary carries it: 1 or 0,
// never a boolean.
func boolText(b bool) int {
	if b {
		return 1
	}
	return 0
}

func eventJSON(e stationlink.StreamEvent, mode bytesOutput) map[string]any {
	switch e.Kind {
	case stationlink.StreamEnd:
		return map[string]any{"kind": "end", "role": e.Role.Name()}
	case stationlink.StreamReply:
		return map[string]any{"kind": "reply", "payload": cborToJSON(e.Payload, mode)}
	}
	return map[string]any{"kind": "data", "encoding": e.Encoding.Name(), "body": cborToJSON(e.Body, mode)}
}

// macula_stream_request is the stream's open as JSON {caller, realm,
// procedure, payload, deadline_ms}.
//
//export macula_stream_request
func macula_stream_request(h C.uintptr_t, bytesMode C.int, errOut **C.char) *C.char {
	s := streamOf(h, errOut)
	if s == nil {
		return nil
	}
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	open := s.Request()
	return requestJSON(stationlink.Request{Caller: open.Caller, Realm: open.Realm, Procedure: open.Procedure,
		Payload: open.Payload, Deadline: time.UnixMilli(int64(open.Deadline))}, mode)
}

// macula_stream_free frees the stream's handle, aborting the stream first when
// it has not ended.
//
//export macula_stream_free
func macula_stream_free(h C.uintptr_t) {
	if s, ok := valueOf[*stationlink.Stream](h); ok {
		select {
		case <-s.Done():
		default:
			_ = s.Abort("cancelled", "the stream was released")
		}
	}
	release(h)
}
