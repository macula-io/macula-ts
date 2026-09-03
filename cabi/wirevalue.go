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
//   - Bytes have no native JSON shape, so they round-trip as a
//     "0x"-prefixed hex string on the way out (ToJSON); nothing on the
//     way in (FromJSON) currently produces cbor.Bytes -- see that
//     function's own doc.
//
// Plain Go, no cgo -- the *C.char <-> string conversion happens at each
// export site in rpc.go/serve.go, not here.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/macula-io/macula-go/cbor"
)

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
// file's own doc for the bytes-as-hex-string convention.
func cborToJSON(v cbor.Value) any {
	if b, ok := v.AsBytes(); ok {
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
			out[i] = cborToJSON(item)
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
			out[key] = cborToJSON(e.Val)
		}
		return out
	}
	return v.String()
}
