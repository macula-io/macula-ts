package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/macula-io/macula-go/cbor"
)

// Input side: a JSON object whose ONLY key is "$bytes" carries a CBOR byte
// string, as standard padded base64 (RFC 4648 section 4). Any other value
// under that sole key is an explicit error, never a silent fallback to a
// map. An object with more keys stays a map; a plain string is always text.

func TestJSONBytesTaggedObjectBecomesBytes(t *testing.T) {
	v, err := jsonToCbor(`{"$bytes":"aGVsbG8="}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, ok := v.AsBytes()
	if !ok {
		t.Fatalf("want a CBOR byte string, got %s", v.String())
	}
	if !bytes.Equal(b, []byte("hello")) {
		t.Fatalf("want hello, got %q", b)
	}
}

func TestJSONBytesEmptyBase64IsEmptyBytes(t *testing.T) {
	v, err := jsonToCbor(`{"$bytes":""}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, ok := v.AsBytes()
	if !ok || len(b) != 0 {
		t.Fatalf("want an empty byte string, got %s", v.String())
	}
}

func TestJSONBytesInvalidValueIsAnError(t *testing.T) {
	for _, in := range []string{
		`{"$bytes":"not base64!"}`,
		`{"$bytes":"aGVsbG8"}`,  // unpadded: only standard padded base64 is accepted
		`{"$bytes":"aGVs_G8="}`, // URL-safe alphabet
		`{"$bytes":5}`,
		`{"$bytes":null}`,
		`{"$bytes":{"x":"y"}}`,
	} {
		_, err := jsonToCbor(in)
		if err == nil {
			t.Errorf("%s: want an explicit error, got none", in)
			continue
		}
		if !strings.Contains(err.Error(), "$bytes") {
			t.Errorf("%s: the error should name $bytes, got %v", in, err)
		}
	}
}

func TestJSONBytesWithOtherKeysStaysAMap(t *testing.T) {
	v, err := jsonToCbor(`{"$bytes":"aGVsbG8=","other":1}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	entries, ok := v.AsMap()
	if !ok || len(entries) != 2 {
		t.Fatalf("want a 2-entry map, got %s", v.String())
	}
	got, _ := v.Get("$bytes")
	if s, isText := got.AsText(); !isText || s != "aGVsbG8=" {
		t.Fatalf("want \"$bytes\" kept as text inside an ordinary map, got %s", got.String())
	}
}

func TestJSONPlainStringsStayText(t *testing.T) {
	for _, in := range []string{`"aGVsbG8="`, `"0x68656c6c6f"`, `"hello"`} {
		v, err := jsonToCbor(in)
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", in, err)
		}
		if _, ok := v.AsText(); !ok {
			t.Errorf("%s: want text, got %s", in, v.String())
		}
	}
}

func TestJSONBytesNested(t *testing.T) {
	v, err := jsonToCbor(`{"id":{"$bytes":"AQID"},"list":[{"$bytes":"BAU="}]}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	id, _ := v.Get("id")
	if b, ok := id.AsBytes(); !ok || !bytes.Equal(b, []byte{1, 2, 3}) {
		t.Fatalf("id: want bytes 010203, got %s", id.String())
	}
	lst, _ := v.Get("list")
	items, ok := lst.AsList()
	if !ok || len(items) != 1 {
		t.Fatalf("list: want 1 item, got %s", lst.String())
	}
	if b, ok := items[0].AsBytes(); !ok || !bytes.Equal(b, []byte{4, 5}) {
		t.Fatalf("list[0]: want bytes 0405, got %s", items[0].String())
	}
}

// Output side: bytes render as "0x" hex by default, or as the tagged
// {"$bytes": base64} object when asked, and the tagged form round-trips.

func TestCborToJSONDefaultBytesAreHex(t *testing.T) {
	if got := cborToJSON(cbor.Bytes([]byte("hi")), bytesHex); got != "0x6869" {
		t.Fatalf("want 0x6869, got %#v", got)
	}
}

func TestCborToJSONTaggedBytes(t *testing.T) {
	got, ok := cborToJSON(cbor.Bytes([]byte("hi")), bytesTagged).(map[string]any)
	if !ok || len(got) != 1 || got["$bytes"] != "aGk=" {
		t.Fatalf(`want {"$bytes":"aGk="}, got %#v`, got)
	}
}

func TestCborToJSONTaggedLeavesTextAlone(t *testing.T) {
	if got := cborToJSON(cbor.Text("0x6869"), bytesTagged); got != "0x6869" {
		t.Fatalf("text must stay text, got %#v", got)
	}
}

func TestCborToJSONTaggedNestedAndRoundTrip(t *testing.T) {
	orig := cbor.Map([]cbor.MapEntry{
		{Key: cbor.Text("id"), Val: cbor.Bytes([]byte{1, 2, 3})},
		{Key: cbor.Text("list"), Val: cbor.List([]cbor.Value{cbor.Bytes([]byte{4, 5}), cbor.Text("t")})},
	})
	rendered, err := json.Marshal(cborToJSON(orig, bytesTagged))
	if err != nil {
		t.Fatal(err)
	}
	back, err := jsonToCbor(string(rendered))
	if err != nil {
		t.Fatalf("tagged output must be valid input: %v", err)
	}
	id, _ := back.Get("id")
	if b, ok := id.AsBytes(); !ok || !bytes.Equal(b, []byte{1, 2, 3}) {
		t.Fatalf("id did not round-trip as bytes: %s (json %s)", id.String(), rendered)
	}
	lst, _ := back.Get("list")
	items, _ := lst.AsList()
	if len(items) != 2 {
		t.Fatalf("list: %s", lst.String())
	}
	if b, ok := items[0].AsBytes(); !ok || !bytes.Equal(b, []byte{4, 5}) {
		t.Fatalf("list[0] did not round-trip as bytes: %s", items[0].String())
	}
	if s, ok := items[1].AsText(); !ok || s != "t" {
		t.Fatalf("list[1] text changed: %s", items[1].String())
	}
}

func TestParseBytesOutput(t *testing.T) {
	for _, c := range []struct {
		in   int
		want bytesOutput
		ok   bool
	}{{0, bytesHex, true}, {1, bytesTagged, true}, {2, bytesHex, false}, {-1, bytesHex, false}} {
		got, err := parseBytesOutput(c.in)
		if (err == nil) != c.ok || (c.ok && got != c.want) {
			t.Errorf("parseBytesOutput(%d) = %v, %v", c.in, got, err)
		}
	}
}
