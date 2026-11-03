//go:build linux && amd64

package proof

import (
	"strings"
	"testing"
)

const canonicalRecord = "OCLABAUTH1 123 456 7 8 9 10 abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n"

func TestParseRecordCanonical(t *testing.T) {
	got, err := parseRecord([]byte(canonicalRecord))
	if err != nil {
		t.Fatalf("parseRecord() error = %v", err)
	}
	want := record{
		pid: 123, start: 456, execDev: 7, execIno: 8,
		socketDev: 9, socketIno: 10,
		hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	}
	if got != want {
		t.Errorf("parseRecord() = %#v, want %#v", got, want)
	}
}

func TestParseRecordRejectsMalformed(t *testing.T) {
	base := strings.TrimSuffix(canonicalRecord, "\n")
	fields := strings.Split(base, " ")
	mutate := func(index int, value string) string {
		copy := append([]string(nil), fields...)
		copy[index] = value
		return strings.Join(copy, " ") + "\n"
	}
	cases := []struct {
		name string
		data string
	}{
		{"pid zero", mutate(1, "0")},
		{"pid one", mutate(1, "1")},
		{"pid above int max", mutate(1, "2147483648")},
		{"zero start", mutate(2, "0")},
		{"zero exec inode", mutate(4, "0")},
		{"zero socket inode", mutate(6, "0")},
		{"uint64 overflow", mutate(3, "18446744073709551616")},
		{"leading zero", mutate(2, "0456")},
		{"plus integer", mutate(1, "+123")},
		{"minus integer", mutate(1, "-123")},
		{"missing field", strings.Join(fields[:7], " ") + "\n"},
		{"extra field", base + " extra\n"},
		{"tab separator", strings.Replace(base, " ", "\t", 1) + "\n"},
		{"double spaces", strings.Replace(base, " ", "  ", 1) + "\n"},
		{"no LF", base},
		{"extra LF", base + "\n\n"},
		{"NUL", strings.Replace(base, " 123 ", " 123\x00 ", 1) + "\n"},
		{"uppercase hash", mutate(7, strings.Repeat("A", 64))},
		{"nonhex hash", mutate(7, strings.Repeat("g", 64))},
		{"short hash", mutate(7, strings.Repeat("a", 63))},
		{"long hash", mutate(7, strings.Repeat("a", 65))},
		{"over 511 bytes", strings.Repeat("x", 511) + "\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := parseRecord([]byte(tc.data)); err == nil {
				t.Errorf("parseRecord() = %#v, want error", got)
			}
		})
	}
}
