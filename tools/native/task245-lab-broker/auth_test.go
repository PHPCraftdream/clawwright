//go:build linux && amd64

package main

import (
	"encoding/json"
	"testing"
)

func TestDuplicateJSONClosedCases(t *testing.T) {
	bad := []string{
		`{"a":1,"a":2}`,
		`{"outer":{"key":1,"key":2}}`,
		`{"a":1,"\u0061":2}`,
		`{"a":1} {"b":2}`,
	}
	for _, input := range bad {
		t.Run(input, func(t *testing.T) {
			if err := duplicateJSON([]byte(input)); err == nil {
				t.Fatalf("duplicateJSON accepted %s", input)
			}
		})
	}
	good := []string{
		`{"RuntimeUID":1,"SelectedImage":"image"}`,
		`{"nested":[{"x":1},{"x":2}],"escaped":"quote: \\\""}`,
	}
	for _, input := range good {
		t.Run("accept/"+input, func(t *testing.T) {
			if err := duplicateJSON([]byte(input)); err != nil {
				t.Fatalf("duplicateJSON rejected valid JSON %s: %v", input, err)
			}
			var v any
			if err := json.Unmarshal([]byte(input), &v); err != nil {
				t.Fatalf("test fixture is not valid JSON: %v", err)
			}
		})
	}
}
