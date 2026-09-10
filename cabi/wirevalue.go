// wirevalue.go bridges JSON (what src/rpc.ts's JsonValue actually is on
// the wire between the addon and TypeScript) and cbor.Value (what
// macula-go's CALL/RESULT frames actually carry). Ported line-for-line
// from macula-io/macula-cli's internal/wirevalue package (FromJSON/
// ToJSON) rather than reinvented -- that package already solved this
// exact problem, including the two rules that matter most:
//
//   - No CBOR bool: cbor.Value's Kind enum is UInt/NegInt/Bytes/Text/
//     List/Map/Null/Float -- there is no KindBool. A JSON `true`/`false`
//     is rejected outright with an explicit error instead of being
//     silently coerced to 0/1 or dropped.
//   - Bytes have no native JSON shape. On the way IN, a JSON object whose
//     ONLY key is "$bytes" carries a CBOR byte string as standard padded
//     base64 (RFC 4648 section 4): {"$bytes": "aGVsbG8="}. Any other value
//     under that sole key is an explicit error, never a silent fallback to
//     a map. An object with more keys stays an ordinary map, and a plain
//     string is always text: there is no "0x" input form. The sole-key
//     "$bytes" object is therefore reserved.
//   - On the way OUT, bytes render as a "0x"-prefixed hex string by
//     default (bytesHex), or, when the caller asks (bytesTagged), as the
//     same {"$bytes": "<base64>"} object the input side accepts, so a
//     returned value can be sent straight back. Only Go can make that
//     choice: once rendered as hex, bytes and a text value that happens
//     to look like "0x..." can no longer be told apart.
//
// Plain Go, no cgo -- the *C.char <-> string conversion happens at each
// export site in rpc.go/serve.go, not here.
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/macula-io/macula-go/cbor"
)

// bytesKey is the reserved sole key of a tagged bytes object.
const bytesKey = "$bytes"

// bytesOutput selects how cborToJSON renders a CBOR byte string.
type bytesOutput int

const (
	// bytesHex renders bytes as a "0x"-prefixed lowercase hex string: the
	// default, and the only form before the tagged object existed.
	bytesHex bytesOutput = 0
	// bytesTagged renders bytes as {"$bytes": "<standard padded base64>"}.
	bytesTagged bytesOutput = 1
)

// parseBytesOutput validates a mode passed across the FFI boundary. An
// unknown value is an error rather than a silent fallback, so a caller and
// callee that disagree about the modes fail visibly.
func parseBytesOutput(mode int) (bytesOutput, error) {
	switch bytesOutput(mode) {
	case bytesHex, bytesTagged:
		return bytesOutput(mode), nil
	}
	return bytesHex, fmt.Errorf("macula-ts/cabi: unknown bytes output mode %d (0 = hex, 1 = tagged)", mode)
}

// taggedBytesToCbor decodes the value under a sole "$bytes" key.
func taggedBytesToCbor(raw any) (cbor.Value, error) {
	s, ok := raw.(string)
	if !ok {
		return cbor.Value{}, fmt.Errorf(`macula-ts/cabi: a {"$bytes": ...} value must be a standard padded base64 string, got %T`, raw)
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil {
		return cbor.Value{}, fmt.Errorf(`macula-ts/cabi: {"$bytes": ...} is not valid standard padded base64 (RFC 4648 section 4): %w`, err)
	}
	return cbor.Bytes(b), nil
}

// jsonToCbor parses a JSON document (a CALL/RESULT payload, JSON-
// encoded on the TypeScript side via JSON.stringify) into a cbor.Value.
// An empty string is treated the same as literal JSON "null" -- the TS
// side always sends *something* (see rpc.go/serve.go's callers), but
// this keeps the function total rather than erroring on an edge case
// that would otherwise need its own guard at every call site.
func jsonToCbor(jsonText string) (cbor.Value, error) {
	if jsonText == "" {
		return cbor.Null(), nil
	}
	var v any
	if err := json.Unmarshal([]byte(jsonText), &v); err != nil {
		return cbor.Value{}, fmt.Errorf("macula-ts/cabi: invalid payload JSON: %w", err)
	}
	return jsonValueToCbor(v)
}

func jsonValueToCbor(v any) (cbor.Value, error) {
	switch t := v.(type) {
	case nil:
		return cbor.Null(), nil
	case bool:
		return cbor.Value{}, fmt.Errorf("macula-ts/cabi: JSON boolean %v has no wire representation (macula's CBOR has no bool type) -- use 0/1 instead", t)
	case string:
		return cbor.Text(t), nil
	case float64:
		if t == float64(int64(t)) {
			return cbor.Int(int64(t)), nil
		}
		return cbor.Float(t), nil
	case []any:
		vals := make([]cbor.Value, len(t))
		for i, item := range t {
			cv, err := jsonValueToCbor(item)
			if err != nil {
				return cbor.Value{}, err
			}
			vals[i] = cv
		}
		return cbor.List(vals), nil
	case map[string]any:
		if raw, isTagged := t[bytesKey]; isTagged && len(t) == 1 {
			return taggedBytesToCbor(raw)
		}
		entries := make([]cbor.MapEntry, 0, len(t))
		for k, item := range t {
			cv, err := jsonValueToCbor(item)
			if err != nil {
				return cbor.Value{}, err
			}
			entries = append(entries, cbor.MapEntry{Key: cbor.Text(k), Val: cv})
		}
		return cbor.Map(entries), nil
	default:
		return cbor.Value{}, fmt.Errorf("macula-ts/cabi: unsupported JSON value of type %T", v)
	}
}

// cborToJSON converts a cbor.Value into a plain Go value that
// encoding/json can marshal directly -- jsonToCbor's inverse. See this
// file's own doc for how mode renders bytes (hex or the tagged object).
func cborToJSON(v cbor.Value, mode bytesOutput) any {
	if b, ok := v.AsBytes(); ok {
		if mode == bytesTagged {
			return map[string]any{bytesKey: base64.StdEncoding.EncodeToString(b)}
		}
		return "0x" + hex.EncodeToString(b)
	}
	if s, ok := v.AsText(); ok {
		return s
	}
	if i, ok := v.AsInt64(); ok {
		return i
	}
	if f, ok := v.AsFloat(); ok {
		return f
	}
	if v.IsNull() {
		return nil
	}
	if list, ok := v.AsList(); ok {
		out := make([]any, len(list))
		for i, item := range list {
			out[i] = cborToJSON(item, mode)
		}
		return out
	}
	if entries, ok := v.AsMap(); ok {
		out := make(map[string]any, len(entries))
		for _, e := range entries {
			key := e.Key.String()
			if s, ok := e.Key.AsText(); ok {
				key = s
			}
			out[key] = cborToJSON(e.Val, mode)
		}
		return out
	}
	return v.String()
}
