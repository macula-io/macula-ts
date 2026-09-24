package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef void (*macula_event_callback)(void* user_data, const char* event_json);
static inline void callEventCallback(macula_event_callback cb, void* user_data, const char* event_json) {
  cb(user_data, event_json);
}
typedef void (*macula_closed_callback)(void* user_data, const char* err_message);
static inline void callClosedCallback(macula_closed_callback cb, void* user_data, const char* err_message) {
  cb(user_data, err_message);
}
*/
import "C"

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unsafe"

	"github.com/macula-io/macula-go/cbor"
	"github.com/macula-io/macula-go/identity"
	"github.com/macula-io/macula-go/pool"
	"github.com/macula-io/macula-go/record"
	"github.com/macula-io/macula-go/stationlink"
)

// connectSeed is one seed as the TypeScript side gives it.
type connectSeed struct {
	Host   string `json:"host"`
	Port   uint16 `json:"port"`
	NodeID string `json:"node_id"`
}

// connectOptions are the pool options the TypeScript side gives. Realm keys
// are hex, keyed by the realm id in hex.
type connectOptions struct {
	RealmTrust        map[string]string `json:"realm_trust"`
	ReplicationFactor int               `json:"replication_factor"`
	MaxDirectLinks    int               `json:"max_direct_links"`
	RespawnDelayMs    int64             `json:"respawn_delay_ms"`
	TimeoutMs         int64             `json:"timeout_ms"`
}

func hexID(name, text string) ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(text)
	if err != nil || len(raw) != 32 {
		return out, fmt.Errorf("macula-ts/cabi: %s must be 64 hex characters", name)
	}
	copy(out[:], raw)
	return out, nil
}

// macula_pool_connect connects a pool of the key's node to seeds (a JSON list
// of {host, port, node_id}) with options (JSON, see connectOptions), and
// returns once one link is up, or fails within timeout_ms (30 s by default).
//
//export macula_pool_connect
func macula_pool_connect(keyHandle C.uintptr_t, seedsJSON, optsJSON *C.char, errOut **C.char) C.uintptr_t {
	key, ok := valueOf[*identity.NodeKey](keyHandle)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return 0
	}
	var seeds []connectSeed
	if err := json.Unmarshal([]byte(C.GoString(seedsJSON)), &seeds); err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: seeds: %w", err))
		return 0
	}
	var opts connectOptions
	if optsJSON != nil && C.GoString(optsJSON) != "" {
		if err := json.Unmarshal([]byte(C.GoString(optsJSON)), &opts); err != nil {
			setErr(errOut, fmt.Errorf("macula-ts/cabi: options: %w", err))
			return 0
		}
	}
	poolSeeds := make([]pool.Seed, len(seeds))
	for i, s := range seeds {
		id, err := hexID("a seed's node_id", s.NodeID)
		if err != nil {
			setErr(errOut, err)
			return 0
		}
		poolSeeds[i] = pool.Seed{Host: s.Host, Port: s.Port, NodeID: id}
	}
	trust := map[[32]byte][]byte{}
	for realmHex, keyHex := range opts.RealmTrust {
		realm, err := hexID("a realm id", realmHex)
		if err != nil {
			setErr(errOut, err)
			return 0
		}
		realmKey, err := hex.DecodeString(keyHex)
		if err != nil {
			setErr(errOut, fmt.Errorf("macula-ts/cabi: realm key: %w", err))
			return 0
		}
		trust[realm] = realmKey
	}
	timeout := 30 * time.Second
	if opts.TimeoutMs > 0 {
		timeout = time.Duration(opts.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	p, err := pool.Connect(ctx, poolSeeds, pool.Opts{IdentityKey: key, RealmTrust: trust,
		ReplicationFactor: opts.ReplicationFactor, MaxDirectLinks: opts.MaxDirectLinks,
		RespawnDelay: time.Duration(opts.RespawnDelayMs) * time.Millisecond})
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	return newHandle(p)
}

// macula_pool_close closes every link and subscription, and frees the handle.
//
//export macula_pool_close
func macula_pool_close(h C.uintptr_t) {
	if p, ok := valueOf[*pool.Pool](h); ok {
		_ = p.Close()
	}
	release(h)
}

// macula_pool_node_id writes the pool's node_id to out32.
//
//export macula_pool_node_id
func macula_pool_node_id(h C.uintptr_t, out32 *C.uchar, errOut **C.char) {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	id := p.NodeID()
	copy(unsafe.Slice((*byte)(unsafe.Pointer(out32)), 32), id[:])
}

// macula_pool_status is the pool's links as JSON: [{station, host, port,
// direct, up}].
//
//export macula_pool_status
func macula_pool_status(h C.uintptr_t, errOut **C.char) *C.char {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	type link struct {
		Station string `json:"station"`
		Host    string `json:"host"`
		Port    uint16 `json:"port"`
		Direct  bool   `json:"direct"`
		Up      bool   `json:"up"`
	}
	var links []link
	for _, s := range p.Status() {
		links = append(links, link{Station: hex.EncodeToString(s.Station[:]), Host: s.Host, Port: s.Port, Direct: s.Direct, Up: s.Up})
	}
	out, _ := json.Marshal(links)
	return C.CString(string(out))
}

func withTimeout(timeoutMs C.int64_t) (context.Context, context.CancelFunc) {
	if timeoutMs <= 0 {
		return context.WithCancel(context.Background())
	}
	return context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
}

func encodeJSON(v cbor.Value, mode C.int, errOut **C.char) *C.char {
	m, err := parseBytesOutput(int(mode))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	out, err := json.Marshal(cborToJSON(v, m))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return C.CString(string(out))
}

// callError renders a call's failure so the TypeScript side can tell its
// kinds apart: "provider_error:<code>:<detail>", "relay_error:<code>", or the
// error's text.
func callError(err error) error {
	var provider *stationlink.ProviderError
	var relay *stationlink.RelayError
	switch {
	case errors.As(err, &provider):
		detail := ""
		if provider.Detail != nil {
			detail = *provider.Detail
		}
		return fmt.Errorf("provider_error:%s:%s", provider.Code, detail)
	case errors.As(err, &relay):
		return fmt.Errorf("relay_error:%s", relay.Code)
	}
	return err
}

// macula_pool_call calls procedure in realm at a provider, any trusted one when
// provider32 is NULL, by direct dial, and returns its result as JSON.
//
//export macula_pool_call
func macula_pool_call(h C.uintptr_t, realm32 *C.uchar, procedure, payloadJSON *C.char, provider32 *C.uchar,
	timeoutMs C.int64_t, bytesMode C.int, errOut **C.char) *C.char {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	realm, _ := id32(realm32)
	provider, _ := id32(provider32)
	payload, err := jsonToCbor(C.GoString(payloadJSON))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	result, err := p.Call(context.Background(), pool.Call{Realm: realm, Procedure: C.GoString(procedure),
		Provider: provider, Payload: payload, Timeout: time.Duration(timeoutMs) * time.Millisecond})
	if err != nil {
		setErr(errOut, callError(err))
		return nil
	}
	return encodeJSON(result, bytesMode, errOut)
}

// macula_pool_providers is JSON of the procedure's trusted providers:
// [{node, station}], freshest first.
//
//export macula_pool_providers
func macula_pool_providers(h C.uintptr_t, realm32 *C.uchar, procedure *C.char, timeoutMs C.int64_t, errOut **C.char) *C.char {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	realm, _ := id32(realm32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	providers, err := p.Providers(ctx, realm, C.GoString(procedure))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	type entry struct {
		Node    string `json:"node"`
		Station string `json:"station"`
	}
	out := make([]entry, len(providers))
	for i, pr := range providers {
		out[i] = entry{Node: hex.EncodeToString(pr.Node[:]), Station: hex.EncodeToString(pr.Station[:])}
	}
	text, _ := json.Marshal(out)
	return C.CString(string(text))
}

// macula_pool_publish publishes payload on topic in realm, living ttl_ms (the
// default, 10 minutes, when 0).
//
//export macula_pool_publish
func macula_pool_publish(h C.uintptr_t, realm32 *C.uchar, topic, payloadJSON *C.char, ttlMs C.int64_t, errOut **C.char) {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	realm, _ := id32(realm32)
	payload, err := jsonToCbor(C.GoString(payloadJSON))
	if err != nil {
		setErr(errOut, err)
		return
	}
	publication := stationlink.Publication{Realm: realm, Topic: C.GoString(topic), Payload: payload}
	if ttlMs > 0 {
		ttl := uint64(ttlMs)
		publication.TTLMs = &ttl
	}
	setErr(errOut, p.Publish(publication))
}

// macula_pool_subscribe subscribes to topic in realm. Each event is handed to
// on_event as JSON {publisher, realm, topic, seq, published_at, payload,
// delivered_via}, on a Go thread; on_closed is called once, with NULL or why,
// when the subscription ends. The returned handle is given back to
// macula_subscription_stop.
//
//export macula_pool_subscribe
func macula_pool_subscribe(h C.uintptr_t, realm32 *C.uchar, topic *C.char, onEvent C.macula_event_callback,
	onClosed C.macula_closed_callback, userData unsafe.Pointer, bytesMode C.int, errOut **C.char) C.uintptr_t {
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
	sub, err := p.Subscribe(realm, C.GoString(topic))
	if err != nil {
		setErr(errOut, err)
		return 0
	}
	go func() {
		for event := range sub.Events() {
			text, err := json.Marshal(map[string]any{
				"publisher": hex.EncodeToString(event.Publisher[:]), "realm": hex.EncodeToString(event.Realm[:]),
				"topic": event.Topic, "seq": event.Seq, "published_at": event.PublishedAt,
				"payload": cborToJSON(event.Payload, mode), "delivered_via": event.DeliveredVia,
			})
			if err != nil {
				continue
			}
			cText := C.CString(string(text))
			C.callEventCallback(onEvent, userData, cText)
			C.free(unsafe.Pointer(cText))
		}
		C.callClosedCallback(onClosed, userData, nil)
	}()
	return newHandle(sub)
}

// macula_subscription_stop ends the subscription and frees its handle.
//
//export macula_subscription_stop
func macula_subscription_stop(h C.uintptr_t) {
	if sub, ok := valueOf[*pool.Subscription](h); ok {
		_ = sub.Unsubscribe()
	}
	release(h)
}

// recordJSON renders a verified record: its type, signer's key id, times,
// payload, and wire bytes (tagged).
func recordJSON(v record.Verified, mode bytesOutput) map[string]any {
	r := v.Record()
	wire, _ := record.Encode(r)
	return map[string]any{
		"type": uint8(r.Type), "key_id": hex.EncodeToString(r.KeyID[:]), "created_at": r.CreatedAt,
		"expires_at": r.ExpiresAt, "payload": cborToJSON(r.Payload, mode), "wire": cborToJSON(cbor.Bytes(wire), bytesTagged),
	}
}

func recordsJSON(found []record.Verified, dropped int, mode bytesOutput) *C.char {
	out := make([]map[string]any, len(found))
	for i, v := range found {
		out[i] = recordJSON(v, mode)
	}
	text, _ := json.Marshal(map[string]any{"records": out, "dropped": dropped})
	return C.CString(string(text))
}

// macula_pool_find_record is the verified record under key32 as JSON (see
// recordJSON), or the error "not_found".
//
//export macula_pool_find_record
func macula_pool_find_record(h C.uintptr_t, key32 *C.uchar, timeoutMs C.int64_t, bytesMode C.int, errOut **C.char) *C.char {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	key, _ := id32(key32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	found, err := p.FindRecord(ctx, key)
	if errors.Is(err, stationlink.ErrRecordNotFound) {
		setErr(errOut, errors.New("not_found"))
		return nil
	}
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	text, _ := json.Marshal(recordJSON(found, mode))
	return C.CString(string(text))
}

// macula_pool_find_records is every verified record under key32, and how many
// did not verify, as JSON {records, dropped}.
//
//export macula_pool_find_records
func macula_pool_find_records(h C.uintptr_t, key32 *C.uchar, timeoutMs C.int64_t, bytesMode C.int, errOut **C.char) *C.char {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	key, _ := id32(key32)
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	found, dropped, err := p.FindRecords(ctx, key)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return recordsJSON(found, dropped, mode)
}

// macula_pool_find_records_by_type is every verified record of the type the
// station holds, as JSON {records, dropped}.
//
//export macula_pool_find_records_by_type
func macula_pool_find_records_by_type(h C.uintptr_t, recordType C.int, timeoutMs C.int64_t, bytesMode C.int, errOut **C.char) *C.char {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	mode, err := parseBytesOutput(int(bytesMode))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	if recordType < 1 || recordType > 255 {
		setErr(errOut, errors.New("macula-ts/cabi: a record type is 1 to 255"))
		return nil
	}
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	found, dropped, err := p.FindRecordsByType(ctx, record.Type(recordType))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return recordsJSON(found, dropped, mode)
}

// macula_pool_put_record puts a signed record's wire bytes in the DHT.
//
//export macula_pool_put_record
func macula_pool_put_record(h C.uintptr_t, wire *C.uchar, wireLen C.size_t, timeoutMs C.int64_t, errOut **C.char) {
	p, ok := valueOf[*pool.Pool](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return
	}
	ctx, cancel := withTimeout(timeoutMs)
	defer cancel()
	setErr(errOut, p.PutRecord(ctx, goBytes(wire, wireLen)))
}
