//go:build linux && amd64

package main

import (
	"encoding/json"
	"os"
	"strconv"
	"syscall"
	"testing"
)

func TestInventoryOwnPipeTable245(t *testing.T) {
	var cp [2]syscall.Stat_t
	var pipes [2][2]*os.File
	for k := range pipes {
		r, w, err := os.Pipe()
		if err != nil { t.Fatal("pipe fixture") }
		defer r.Close(); defer w.Close()
		pipes[k] = [2]*os.File{r, w}
		if syscall.Fstat(int(r.Fd()), &cp[k]) != nil { t.Fatal("pipe identity") }
	}
	holders := [2]map[string]bool{make(map[string]bool), make(map[string]bool)}
	if !inventoryPipeTable245("/proc/self/fd", os.Getpid(), cp[:], holders) { t.Fatal("own fd table rejected") }
	for k := range pipes {
		if len(holders[k]) != 2 { t.Fatal("pipe holder count") }
		for _, f := range pipes[k] {
			key := strconv.Itoa(os.Getpid()) + ":" + strconv.Itoa(int(f.Fd()))
			if !holders[k][key] { t.Fatal("pipe holder missing") }
		}
	}
	if inventoryPipeTable245("/proc/self/fd/absent", os.Getpid(), cp[:], holders) { t.Fatal("inaccessible fd table accepted") }
}

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
