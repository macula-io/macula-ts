// pubsub.go exposes macula-go's pubsub primitives (connection.Session.
// Publish/Subscribe/Unsubscribe, frame.EventInfo -- see
// connection/connection.go, connection/subscriber.go, frame/pubsub.go):
// macula_session_publish (fire-and-forget, same shape as
// macula_session_advertise in serve.go) and a subscribe/stop pair
// modeled on serve.go's own pendingCall split, one level up -- a whole
// running background loop instead of one in-flight call.
//
// This file is the first place in this SDK where the Go side needs to
// call INTO the addon asynchronously, on its own schedule, rather than
// only ever answering a JS-initiated request: events arrive whenever a
// publisher publishes, not in response to anything this session did.
// macula_session_subscribe_start takes a C function pointer (cb) plus an
// opaque user_data the addon owns (its own Napi::ThreadSafeFunction
// wrapper) and calls it, from the background reader goroutine's own OS
// thread, once per delivered EVENT -- see callEventCallback below for
// why a trampoline is needed at all (Go cannot invoke a C function
// pointer value directly; this is a cgo limitation, not a design
// choice).
package main

/*
#include <stdint.h>
#include <stdlib.h>

// macula_event_callback is provided by addon/binding.cc: OnMaculaEvent
// there, which does nothing but hand the event off to a
// Napi::ThreadSafeFunction::NonBlockingCall -- the only thing safe to do
// with a Napi::Env/V8 handle from a foreign OS thread (see that file's
// own doc). Declared here (not just in the generated libmacula.h) so
// this file's Go code can name the type.
typedef void (*macula_event_callback)(void* user_data, const char* topic,
    const unsigned char* publisher32, unsigned long long seq, const char* payload_json);

// callEventCallback is the required C-side trampoline: cgo can call a
// plain C function from Go, but there is no way to invoke an arbitrary
// C function POINTER VALUE from Go directly -- the call has to go
// through an actual C function that does the indirection. This is that
// function, and nothing else.
static inline void callEventCallback(macula_event_callback cb, void* user_data,
    const char* topic, const unsigned char* publisher32, unsigned long long seq,
    const char* payload_json) {
  cb(user_data, topic, publisher32, seq, payload_json);
}
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"runtime/cgo"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/macula-io/macula-go/frame"
)

var errInvalidSubscriptionHandle = errors.New("macula-ts/cabi: invalid subscription handle")

// publishSeqCounter mints frame.PublishSpec's own Seq field -- a
// process-wide monotonic counter, since src/session.ts's publish() has
// no seq parameter of its own (this SDK doesn't expose per-topic
// ordering/dedup semantics yet). Matches the convention macula-go's own
// telemetry facts use for the identical purpose (connection/publisher.go's
// unexported factSeq()/factSeqCounter) -- not reused directly since
// that one is unexported, but the same shape.
var publishSeqCounter uint64

func nextPublishSeq() uint64 { return atomic.AddUint64(&publishSeqCounter, 1) }

// macula_session_publish sends a signed PUBLISH for (realm, topic) --
// connection.Session.Publish, which also attaches the end-to-end
// publisher_sig a relayed EVENT needs to verify beyond one hop (see
// Session.Publish's own doc) -- not reimplemented here. Fire-and-forget:
// Publish's own doc is explicit that no reply is expected on the wire,
// so *errOut here only ever reflects a LOCAL failure (bad payload,
// encode/sign/send failure) -- never anything about whether any
// subscriber actually received it.
//
// ttlMs<=0 means no TTL (PublishSpec.TTLMs left nil) -- unlike the DHT
// puts (cabi/dht.go), Publish has no macula-go-side default TTL to fall
// back to; "not specified" should mean exactly that, not an error or an
// invented default.
//
// Real network I/O (one signed frame write) -- like every other export
// here that touches the network, must run off Node's main thread (see
// addon/binding.cc's SessionPublishWorker).
//
//export macula_session_publish
func macula_session_publish(
	sessionHandle, identityHandle C.uintptr_t,
	realm32 *C.uchar,
	topic *C.char,
	payloadJSON *C.char,
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

	var payloadStr string
	if payloadJSON != nil {
		payloadStr = C.GoString(payloadJSON)
	}
	payload, err := jsonToCbor(payloadStr)
	if err != nil {
		setErr(errOut, err)
		return
	}

	spec := frame.NewPublishSpec(C.GoString(topic), realm32OrZero(realm32), id.NodeID(), nextPublishSeq(), payload, time.Now().UnixMilli())
	if ttlMs > 0 {
		ttl := uint64(ttlMs)
		spec.TTLMs = &ttl
	}
	if err := session.Publish(spec, id); err != nil {
		setErr(errOut, err)
	}
}

// subscription is the rendezvous point between the background reader
// goroutine macula_session_subscribe_start starts and the later
// macula_session_subscribe_stop call that tears it down -- same shape as
// serve.go's pendingCall, one level up (a whole running loop, not one
// in-flight call).
type subscription struct {
	cancel context.CancelFunc
	doneCh chan error // the reader goroutine's own RunSubscriber return value
}

func subscriptionFromHandle(h C.uintptr_t) (sub *subscription, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	sub, ok = cgo.Handle(h).Value().(*subscription)
	return
}

// deliverEvent converts one frame.EventInfo to this boundary's JSON
// payload convention (cborToJSON, same as an RPC reply -- wirevalue.go)
// and calls cb via the callEventCallback trampoline. Runs on the
// background reader goroutine's own OS thread, synchronously with
// respect to that goroutine (it returns only once cb itself has
// returned) but asynchronously with respect to Node's main thread --
// exactly the handoff Napi::ThreadSafeFunction exists for; cb's own
// implementation (OnMaculaEvent, addon/binding.cc) does nothing blocking,
// it just queues a NonBlockingCall and returns, so this does not stall
// event delivery waiting for JS to actually process anything.
func deliverEvent(evt frame.EventInfo, cb C.macula_event_callback, userData unsafe.Pointer) {
	payloadJSON, err := json.Marshal(cborToJSON(evt.Payload))
	if err != nil {
		// A payload this SDK's own JSON conversion can't represent -- drop
		// this one event rather than killing the whole subscription over
		// it (matches connection.RunSubscriber's own posture toward a
		// frame it can't use: skip, keep listening -- see its own doc).
		return
	}
	cTopic := C.CString(evt.Topic)
	defer C.free(unsafe.Pointer(cTopic))
	cPayload := C.CString(string(payloadJSON))
	defer C.free(unsafe.Pointer(cPayload))
	var pub32 [32]byte
	copy(pub32[:], evt.Publisher)
	C.callEventCallback(cb, userData, cTopic, (*C.uchar)(unsafe.Pointer(&pub32[0])), C.ulonglong(evt.Seq), cPayload)
}

// macula_session_subscribe_start sends a signed SUBSCRIBE for (realm,
// topic) SYNCHRONOUSLY first -- connection.Session.Subscribe, completed
// before this function returns -- then starts a background goroutine
// running macula-go's OWN Session.RunSubscriber (connection/subscriber.go)
// for the actual event loop.
//
// The synchronous send matters, not just as a nicety: RunSubscriber
// would happily send its own SUBSCRIBE internally, inside the goroutine
// it starts, but "start a goroutine" and "that goroutine has actually
// reached its first line" are not the same moment -- Go's scheduler
// gives no guarantee the SUBSCRIBE would be on the wire before this
// function returns and the JS side's subscribe() Promise resolves. A
// caller that immediately publish()es to the topic it just subscribed
// to (this SDK's own live pubsub round-trip test does exactly this, the
// self-delivery pattern this project's task description calls for)
// would then race its own PUBLISH against a SUBSCRIBE that has not
// necessarily reached the station yet. Confirmed live, not just reasoned
// about: without the synchronous send below, that exact round-trip test
// intermittently failed ("no event arrived") on an otherwise-correct
// implementation. Sending here first, before starting the goroutine at
// all, matches the ordering macula-go's OWN TestLivePubSubRoundTrip
// relies on (subscribe then immediately publish, no sleep, in one
// sequential goroutine) -- reusing a proven-reliable ordering instead of
// introducing a new race this SDK is the first to hit.
//
// RunSubscriber sends its own (harmless, idempotent -- SUBSCRIBE is a
// registration, not a counter) second SUBSCRIBE when its goroutine
// starts; the loop itself is still deliberately RunSubscriber's, not
// hand-rolled here on top of the lower-level Session.RecvEvent, even
// though RecvEvent is exported and would work for the happy path:
// RunSubscriber already gets a real, previously-live-found bug right
// (its own doc: a single non-EVENT frame arriving on this shared control
// stream must be skipped, not treated as fatal -- RecvEvent's own
// contract, by contrast, treats ANY non-EVENT frame as a hard error)
// that a hand-rolled loop here would be at genuine risk of getting wrong
// again on a real, busy, shared station.
//
// This is the one new shape in this SDK: every other export so far is a
// single request answered by a single response (or a bounded poll for
// one, like macula_serve_wait_for_call). An event subscription has no
// such bound -- events arrive on their own schedule for as long as it
// stays open -- so unlike that JS-driven poll loop, delivery here is
// Go-driven: cb is called from the goroutine's own thread whenever
// RunSubscriber's handler fires, for as long as the subscription stays
// open. See macula_session_subscribe_stop for how the goroutine is
// actually torn down again -- it does not run forever unbounded.
//
// Real network I/O (this function's own SUBSCRIBE send) plus starting a
// long-running goroutine -- the synchronous part must run off Node's
// main thread like every other network-touching export here (see
// addon/binding.cc's SessionSubscribeStartWorker); the goroutine itself
// needs no such treatment, since nothing on the JS main thread ever
// blocks waiting on it directly -- it calls back in via cb instead.
//
//export macula_session_subscribe_start
func macula_session_subscribe_start(
	sessionHandle, identityHandle C.uintptr_t,
	realm32 *C.uchar,
	topic *C.char,
	cb C.macula_event_callback,
	userData unsafe.Pointer,
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

	spec := frame.NewSubscribeSpec(C.GoString(topic), realm32OrZero(realm32), id.NodeID())
	if err := session.Subscribe(spec, id); err != nil {
		setErr(errOut, err)
		return 0
	}

	ctx, cancel := context.WithCancel(context.Background())
	sub := &subscription{cancel: cancel, doneCh: make(chan error, 1)}

	go func() {
		sub.doneCh <- session.RunSubscriber(ctx, spec, id, func(evt frame.EventInfo) error {
			deliverEvent(evt, cb, userData)
			return nil
		})
	}()

	return C.uintptr_t(cgo.NewHandle(sub))
}

// macula_session_subscribe_stop cancels the background reader goroutine
// (whose own deferred Unsubscribe then actually runs -- a real network
// write, connection.Session.Unsubscribe) and BLOCKS until that goroutine
// has genuinely exited, so a caller can rely on "no further cb call can
// arrive after this returns", not merely "a stop was requested" -- this
// is the actual mechanism behind the requirement that a subscription's
// background goroutine never runs forever with no way to stop it.
// ctx.Canceled (RunSubscriber's own return value on a clean stop) is not
// treated as a failure; any other error is a genuine transport-level
// problem, surfaced via *errOut same as everywhere else in this cabi.
//
// Bounded by RunSubscriber's own poll interval (2s, unexported in
// macula-go -- see connection/subscriber.go's subscriberPollInterval)
// plus whatever's left of an in-flight RecvFrame wait -- real,
// if bounded, blocking work, so like macula_session_subscribe_start this
// must run off Node's main thread (addon/binding.cc's
// SessionSubscribeStopWorker).
//
//export macula_session_subscribe_stop
func macula_session_subscribe_stop(subscriptionHandle C.uintptr_t, errOut **C.char) {
	sub, ok := subscriptionFromHandle(subscriptionHandle)
	if !ok {
		setErr(errOut, errInvalidSubscriptionHandle)
		return
	}
	defer deleteHandle(subscriptionHandle)
	sub.cancel()
	if err := <-sub.doneCh; err != nil && !errors.Is(err, context.Canceled) {
		setErr(errOut, err)
	}
}
