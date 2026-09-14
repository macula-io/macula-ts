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

// macula_subscription_closed_callback is called exactly once, when this
// subscription's background reader goroutine (started by
// macula_session_subscribe_start below) exits for a reason OTHER than
// its own requested stop() -- i.e. the underlying session/connection
// died out from under it, or some other transport error ended the read
// loop. err_message is never NULL when this fires (a clean,
// caller-requested stop is context.Canceled and does NOT trigger this
// callback at all -- the stop() caller already knows synchronously that
// it asked for this and tears down through macula_session_subscribe_stop
// instead). Provided by addon/binding.cc: OnMaculaSubscriptionClosed,
// delivered through the SAME ThreadSafeFunction as ordinary events (see
// that file's own doc) so the JS side learns "this subscription is now
// dead" instead of staying silent forever -- verified live that,
// without this, a subscription whose connection died left its handler
// never called again, its ThreadSafeFunction (which deliberately keeps
// Node's event loop alive for a healthy subscription) never released,
// and the process unable to exit on its own.
typedef void (*macula_subscription_closed_callback)(void* user_data, const char* err_message);

static inline void callClosedCallback(macula_subscription_closed_callback cb, void* user_data,
    const char* err_message) {
  cb(user_data, err_message);
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

	"github.com/macula-io/macula-go/connection"
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
	doneCh chan error // why the reader goroutine's event loop ended
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
func deliverEvent(evt frame.EventInfo, cb C.macula_event_callback, userData unsafe.Pointer, mode bytesOutput) {
	payloadJSON, err := json.Marshal(cborToJSON(evt.Payload, mode))
	if err != nil {
		// A payload this SDK's own JSON conversion can't represent -- drop
		// this one event rather than killing the whole subscription over
		// it: skip it and keep listening.
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

// macula_session_subscribe_start subscribes to (realm, topic)
// SYNCHRONOUSLY first -- connection.Session.Subscribe, whose SUBSCRIBE is
// written before this function returns -- then starts a background
// goroutine that hands every event that Subscription receives to cb.
//
// The synchronous subscribe matters, not just as a nicety: "start a
// goroutine" and "that goroutine has actually reached its first line" are
// not the same moment -- Go's scheduler gives no guarantee a SUBSCRIBE sent
// from inside the goroutine would be on the wire before this function
// returns and the JS side's subscribe() Promise resolves. A caller that
// immediately publish()es to the topic it just subscribed to (this SDK's
// own live pubsub round-trip test does exactly this) would then race its
// own PUBLISH against a SUBSCRIBE that has not necessarily reached the
// station yet. Confirmed live, not just reasoned about: without a
// synchronous subscribe, that exact round-trip test intermittently failed
// ("no event arrived").
//
// The goroutine reads the same Subscription the synchronous call returned,
// so the session holds exactly one subscription for this handle. Since
// macula-go v0.9.0 a session has a single reader that routes each EVENT to
// the Subscriptions it matches, so Subscription.Recv only ever returns
// events for this one: frames of other types never reach this loop.
//
// This is the one new shape in this SDK: every other export so far is a
// single request answered by a single response (or a bounded poll for
// one, like macula_serve_wait_for_call). An event subscription has no
// such bound -- events arrive on their own schedule for as long as it
// stays open -- so unlike that JS-driven poll loop, delivery here is
// Go-driven: cb is called from the goroutine's own thread whenever an
// event arrives, for as long as the subscription stays
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
	closedCb C.macula_subscription_closed_callback,
	userData unsafe.Pointer,
	bytesMode C.int,
	errOut **C.char,
) C.uintptr_t {
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return 0
	}
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
	goSub, err := session.Subscribe(spec, id)
	if err != nil {
		setErr(errOut, err)
		return 0
	}

	ctx, cancel := context.WithCancel(context.Background())
	sub := &subscription{cancel: cancel, doneCh: make(chan error, 1)}
	deliver := func(evt frame.EventInfo) { deliverEvent(evt, cb, userData, mode) }
	go runSubscription(ctx, goSub, sub, deliver, closedCb, userData)

	return C.uintptr_t(cgo.NewHandle(sub))
}

// runSubscription is a subscription's background goroutine: it runs goSub's
// event loop and reports how the loop ended. A clean, caller-requested stop
// is context.Canceled -- the stop() caller already knows synchronously it
// asked for this and tears down via macula_session_subscribe_stop, so no
// signal is needed for that case. Anything else means the loop ended on its
// own (the session ended, the subscription fell behind its queue, etc) with
// nobody else aware of it yet -- this is the ONLY place that will ever find
// out, so it must say so rather than going silent.
func runSubscription(
	ctx context.Context,
	goSub *connection.Subscription,
	sub *subscription,
	deliver func(frame.EventInfo),
	closedCb C.macula_subscription_closed_callback,
	userData unsafe.Pointer,
) {
	err := receiveEvents(ctx, goSub, deliver)
	if !errors.Is(err, context.Canceled) {
		deliverClosed(err, closedCb, userData)
	}
	sub.doneCh <- err
}

// eventPollInterval bounds how long one Subscription.Recv wait blocks
// before the event loop checks whether it was asked to stop.
const eventPollInterval = 2 * time.Second

// receiveEvents hands every event goSub receives to deliver until ctx is
// done (context.Canceled) or the subscription ends (its error), then closes
// goSub, which writes UNSUBSCRIBE once nothing else on the session holds the
// topic.
func receiveEvents(ctx context.Context, goSub *connection.Subscription, deliver func(frame.EventInfo)) error {
	defer func() { _ = goSub.Close() }()
	err := nextEvent(ctx, goSub, deliver)
	for err == nil {
		err = nextEvent(ctx, goSub, deliver)
	}
	return err
}

// nextEvent waits up to eventPollInterval for goSub's next event and hands
// it to deliver. A wait that finds nothing is not an error.
func nextEvent(ctx context.Context, goSub *connection.Subscription, deliver func(frame.EventInfo)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	evt, err := goSub.Recv(eventPollInterval)
	if errors.Is(err, connection.ErrRecvTimeout) {
		return nil
	}
	if err != nil {
		return err
	}
	deliver(evt)
	return nil
}

// deliverClosed calls closedCb via the callClosedCallback trampoline,
// same threading rules as deliverEvent above (runs on the background
// reader goroutine's own OS thread; the addon's own implementation of
// closedCb does nothing blocking, it just queues a NonBlockingCall and
// returns). err is never nil when this is called (see the one call site
// above) -- always rendered as a real message, never silently dropped.
func deliverClosed(err error, cb C.macula_subscription_closed_callback, userData unsafe.Pointer) {
	cErr := C.CString(err.Error())
	defer C.free(unsafe.Pointer(cErr))
	C.callClosedCallback(cb, userData, cErr)
}

// macula_session_subscribe_stop cancels the background reader goroutine
// (whose deferred Subscription.Close then actually runs -- a real network
// write of UNSUBSCRIBE once nothing else on the session holds the topic)
// and BLOCKS until that goroutine
// has genuinely exited, so a caller can rely on "no further cb call can
// arrive after this returns", not merely "a stop was requested" -- this
// is the actual mechanism behind the requirement that a subscription's
// background goroutine never runs forever with no way to stop it.
// context.Canceled (the event loop's return value on a clean stop) is not
// treated as a failure; any other error is a genuine transport-level
// problem, surfaced via *errOut same as everywhere else in this cabi.
//
// Bounded by eventPollInterval (2s) plus whatever's left of an in-flight
// Subscription.Recv wait -- real,
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
