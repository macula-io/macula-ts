// ucan.go exposes macula-go's ucan package: minting a UCAN token
// (ucan.Create) and decoding one's claims without verifying them
// (ucan.Decode) -- both pure local operations, no network I/O, so both
// export synchronously (see addon/binding.cc: UcanMint/UcanDecode are
// plain functions, not Napi::AsyncWorker-backed, matching
// macula_identity_generate's own convention). Also
// macula_session_call_with_ucan -- rpc.go's macula_session_call with one
// added ucanToken parameter -- real network I/O, so THAT one runs off
// Node's main thread (see addon/binding.cc's SessionCallWithUcanWorker).
//
// A UCAN token's payload (`fct`, the `facts` map) crosses this boundary
// as arbitrary JSON via Go's encoding/json -- unlike an RPC payload
// (wirevalue.go's jsonToCbor/cborToJSON), a UCAN token is never CBOR: it
// is macula's JWT-shaped format (header.payload.signature, all
// base64url-encoded JSON), so a JSON boolean inside `facts` is perfectly
// valid here and is NOT rejected the way one would be in an RPC payload
// -- see ucan/ucan.go's own module doc for why this format exists at
// all (no existing library implements UCAN 0.10.0's JWT shape). The
// token itself crosses as plain ASCII text (base64url + "."), so unlike
// content.go's raw binary blobs it needs no byte-buffer/length pair,
// just a C string.
//
// This package's ucan.Policy (gating a served procedure behind a
// required issuer) is deliberately NOT exposed here -- out of scope for
// this slice, which covers minting/inspecting a token and attaching one
// to an outgoing CALL, not enforcing one on the provider side. See
// README.md's "What's explicitly not yet implemented" section.
package main

/*
#include <stdint.h>
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/macula-io/macula-go/ucan"
)

// ucanPayloadJSON is the JSON shape macula_ucan_decode returns -- kept
// in sync BY HAND with src/ucan.ts's UcanPayloadJson type, the same
// convention rpc.go's callEnvelope and dht.go's dhtRecordJSON already
// use for their own FFI-boundary JSON shapes. ucan.Capability's own
// `with`/`can` json tags (ucan/ucan.go) are reused directly -- no
// separate wire type needed for that piece. ExpiresAt/NotBefore
// deliberately have NO omitempty: a nil *int64 must marshal as JSON
// `null` (an explicit, present "no claim" the TS side can rely on being
// there), not vanish from the object entirely -- the same reasoning
// rpc.go's callEnvelope.Payload doc gives for its own omitempty choice.
type ucanPayloadJSON struct {
	Issuer       string                 `json:"issuer"`
	Audience     string                 `json:"audience"`
	Capabilities []ucan.Capability      `json:"capabilities"`
	ExpiresAt    *int64                 `json:"expiresAt"`
	NotBefore    *int64                 `json:"notBefore"`
	Nonce        string                 `json:"nonce"`
	Facts        map[string]interface{} `json:"facts"`
	Proofs       []string               `json:"proofs"`
}

func ucanPayloadToJSON(p ucan.Payload) ucanPayloadJSON {
	caps := p.Capabilities
	if caps == nil {
		caps = []ucan.Capability{}
	}
	proofs := p.Proofs
	if proofs == nil {
		proofs = []string{}
	}
	return ucanPayloadJSON{
		Issuer: p.Issuer, Audience: p.Audience, Capabilities: caps,
		ExpiresAt: p.ExpiresAt, NotBefore: p.NotBefore, Nonce: p.Nonce,
		Facts: p.Facts, Proofs: proofs,
	}
}

// macula_ucan_mint mints a new UCAN token (ucan.Create), self-issued and
// signed by identityHandle's own private key -- the resulting token
// verifies against that same identity's public key (NodeID), matching
// ucan.Create's own documented convention. issuer/audience are opaque
// DID strings; macula-go's ucan package does not validate or resolve DID
// structure (that's macula_did_nif's job on the Erlang reference SDK,
// out of scope here and there) -- src/ucan.ts builds them itself as
// "did:macula:<hex nodeId>", matching the convention macula-go's own
// tests and examples/ucan/main.go already use, rather than this cabi
// layer inventing a different one.
//
// capabilitiesJSON is a JSON array of {"with":"...","can":"..."} (never
// NULL from the TS side -- src/ucan.ts always JSON.stringifies an array,
// even an empty one, but NULL is tolerated as "none" too).
// hasExpiresAt/hasNotBefore distinguish "no claim" from a genuine
// zero-value unix timestamp -- the same has-flag convention
// macula-php's cabi/ucan.go uses for its own analogous accessors. nonce
// is ""/NULL for "no nonce claim" (matching ucan.CreateOpts.Nonce's own
// ""-means-absent convention). factsJSON/proofsJSON are NULL for "none"
// -- a JSON object and a JSON array of proof CIDs respectively.
//
// No network I/O -- exports synchronously, called directly (not via
// Napi::AsyncWorker) from addon/binding.cc, like macula_identity_generate.
//
//export macula_ucan_mint
func macula_ucan_mint(
	identityHandle C.uintptr_t,
	issuer *C.char,
	audience *C.char,
	capabilitiesJSON *C.char,
	hasExpiresAt C.int, expiresAtUnixSec C.int64_t,
	hasNotBefore C.int, notBeforeUnixSec C.int64_t,
	nonce *C.char,
	factsJSON *C.char,
	proofsJSON *C.char,
	errOut **C.char,
) *C.char {
	id, ok := identityFromHandle(identityHandle)
	if !ok {
		setErr(errOut, errInvalidIdentityHandle)
		return nil
	}

	var caps []ucan.Capability
	if capabilitiesJSON != nil {
		if err := json.Unmarshal([]byte(C.GoString(capabilitiesJSON)), &caps); err != nil {
			setErr(errOut, fmt.Errorf("macula-ts/cabi: invalid capabilities JSON: %w", err))
			return nil
		}
	}

	opts := ucan.CreateOpts{}
	if hasExpiresAt != 0 {
		v := int64(expiresAtUnixSec)
		opts.ExpiresAt = &v
	}
	if hasNotBefore != 0 {
		v := int64(notBeforeUnixSec)
		opts.NotBefore = &v
	}
	if nonce != nil {
		opts.Nonce = C.GoString(nonce)
	}
	if factsJSON != nil {
		if err := json.Unmarshal([]byte(C.GoString(factsJSON)), &opts.Facts); err != nil {
			setErr(errOut, fmt.Errorf("macula-ts/cabi: invalid facts JSON: %w", err))
			return nil
		}
	}
	if proofsJSON != nil {
		if err := json.Unmarshal([]byte(C.GoString(proofsJSON)), &opts.Proofs); err != nil {
			setErr(errOut, fmt.Errorf("macula-ts/cabi: invalid proofs JSON: %w", err))
			return nil
		}
	}

	token, err := ucan.Create(C.GoString(issuer), C.GoString(audience), caps, id, opts)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return C.CString(string(token))
}

// macula_ucan_decode parses token's payload WITHOUT verifying its
// signature or checking expiration (ucan.Decode) -- callers get
// expiresAt back and decide expiry themselves (src/ucan.ts's own
// Ucan#isExpired getter), mirroring ucan.IsExpired's exact
// strict-greater-than semantics (a token with no exp claim is never
// expired; one expiring exactly now is not YET expired) without
// duplicating that check a second time on the Go side. Never use this
// token's claims for an authorization decision on their own -- this SDK
// deliberately does not expose ucan.Verify (see this file's own module
// doc: verification/gating is out of scope for this slice).
//
// No network I/O -- exports synchronously, like macula_ucan_mint.
//
//export macula_ucan_decode
func macula_ucan_decode(token *C.char, errOut **C.char) *C.char {
	payload, err := ucan.Decode([]byte(C.GoString(token)))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	b, err := json.Marshal(ucanPayloadToJSON(payload))
	if err != nil {
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode UCAN payload as JSON: %w", err))
		return nil
	}
	return C.CString(string(b))
}

// macula_session_call_with_ucan is macula_session_call (rpc.go), plus
// ucanToken attached to the outgoing CALL (connection.Session.
// CallWithUCAN) -- for invoking a procedure a provider has gated behind
// a ucan.Policy.Required policy on its own side. Reuses rpc.go's
// callEnvelope/callResponseToEnvelope verbatim (same package, same JSON
// envelope shape callers already parse via src/rpc.ts's CallEnvelope) --
// only the extra ucanToken parameter and the CallWithUCAN-vs-Call choice
// differ from macula_session_call itself. Per this SDK's own established
// finding (see the caller's own task notes and connection/connection.go's
// CallWithUCAN doc): macula's UCAN gate is a BEARER-token check -- it
// verifies the token's signature and expiry against its issuer, and does
// NOT check the calling identity against the token's own audience claim.
// This function attaches whatever ucanToken bytes it is given without
// any local "does my identity match this token's audience" guard, for
// exactly that reason -- such a guard would reject configurations the
// real wire-level gate accepts fine, and would misrepresent a security
// property the mesh does not actually enforce.
//
// Real network I/O -- a signed frame out (carrying ucanToken's bytes in
// its ucan_token field) and a wait for the matching RESULT or ERROR, up
// to timeoutMs -- so, like macula_session_call, this must run off Node's
// main thread (see addon/binding.cc's SessionCallWithUcanWorker).
//
//export macula_session_call_with_ucan
func macula_session_call_with_ucan(
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

	var tokenBytes []byte
	if ucanToken != nil {
		tokenBytes = []byte(C.GoString(ucanToken))
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	deadlineMs := time.Now().Add(timeout).UnixMilli()

	resp, err := session.CallWithUCAN(C.GoString(procedure), realm32OrZero(realm32), payload, deadlineMs, id, timeout, tokenBytes)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	envelopeJSON, err := json.Marshal(callResponseToEnvelope(resp))
	if err != nil {
		// Only reachable on a non-finite float in the payload -- see
		// macula_session_call's identical comment (rpc.go).
		setErr(errOut, fmt.Errorf("macula-ts/cabi: encode call response as JSON: %w", err))
		return nil
	}
	return C.CString(string(envelopeJSON))
}
