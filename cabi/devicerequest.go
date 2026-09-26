package main

/*
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"errors"

	"github.com/macula-io/macula-go/cbor"
	"github.com/macula-io/macula-go/devicerequest"
	"github.com/macula-io/macula-go/identity"
)

// A device request proof (realm proof v2, macula-realm#29), over macula-go's
// devicerequest: the device's key signs exactly the request it makes of a
// realm. rule 0 is an HTTP body, under the realm's JSON rule; rule 1 a mesh
// payload, which is signed as this library puts it on the wire (jsonToCbor),
// so the signed request is the request a call sends.

var errRequestRule = errors.New("macula-ts/cabi: a request rule is 0 (HTTP) or 1 (mesh)")

func signedRequest(requestJSON string, rule C.int) (cbor.Value, error) {
	switch rule {
	case 0:
		return devicerequest.JSONRequest([]byte(requestJSON))
	case 1:
		payload, err := jsonToCbor(requestJSON)
		if err != nil {
			return cbor.Value{}, err
		}
		entries, ok := payload.AsMap()
		if !ok {
			return cbor.Value{}, devicerequest.ErrNotAJSONObject
		}
		kept := make([]cbor.MapEntry, 0, len(entries))
		for _, e := range entries {
			if key, _ := e.Key.AsText(); key != "proof" {
				kept = append(kept, e)
			}
		}
		return cbor.Map(kept), nil
	}
	return cbor.Value{}, errRequestRule
}

// macula_key_device_request_proof is key's v2 proof for request_json (its
// "proof" left out) for procedure in realm, now and with a fresh nonce, as
// JSON {v, timestamp, nonce, signature}.
//
//export macula_key_device_request_proof
func macula_key_device_request_proof(h C.uintptr_t, realm32 *C.uchar, procedure, requestJSON *C.char, rule C.int,
	errOut **C.char) *C.char {
	key, ok := valueOf[*identity.NodeKey](h)
	if !ok {
		setErr(errOut, errInvalidHandle)
		return nil
	}
	realm, _ := id32(realm32)
	request, err := signedRequest(C.GoString(requestJSON), rule)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	proof, err := devicerequest.Sign(key, realm, C.GoString(procedure), request)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	text, _ := json.Marshal(proof)
	return C.CString(string(text))
}

// macula_device_request_message is the exact bytes a v2 proof signs, for a
// given timestamp and 16-byte nonce: what the realm's vector checks.
//
//export macula_device_request_message
func macula_device_request_message(publicKey *C.uchar, publicKeyLen C.size_t, realm32 *C.uchar, procedure *C.char,
	timestampMs C.int64_t, nonce16 *C.uchar, requestJSON *C.char, rule C.int, outLen *C.size_t, errOut **C.char) *C.uchar {
	realm, _ := id32(realm32)
	var nonce [devicerequest.NonceSize]byte
	copy(nonce[:], goBytes(nonce16, devicerequest.NonceSize))
	request, err := signedRequest(C.GoString(requestJSON), rule)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	message := devicerequest.Message(goBytes(publicKey, publicKeyLen), realm, C.GoString(procedure), uint64(timestampMs),
		nonce, request)
	return cBytes(message, outLen)
}
