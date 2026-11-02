//go:build linux && amd64

package main

import (
	"bytes"
	"errors"
	"testing"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

const kernelFrame = "    protocol_test.go:51: namespace helper failed diagnostic=fixture_connect (output length 23)\n"

func TestDirectKernelResultFailureDiagnosticsReachContainer(t *testing.T) {
	var direct bytes.Buffer
	gotErr := directKernelResult(&direct, []byte(kernelFrame), nil, errors.New("private command error"))
	if gotErr == nil {
		t.Fatal("command failure returned nil error")
	}
	var outer bytes.Buffer
	if err := diagnostics.ContainerFailure(&outer, true, 7, 0, direct.Bytes()); err != nil {
		t.Fatalf("ContainerFailure: %v", err)
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: kernel=fixture_connect\n"
	if outer.String() != want {
		t.Fatalf("outer diagnostics = %q, want %q", outer.String(), want)
	}
}

func TestDirectKernelResultStderrFailureAndWriterFailure(t *testing.T) {
	var out bytes.Buffer
	if err := directKernelResult(&out, []byte(kernelFrame), []byte("stderr"), nil); err == nil {
		t.Fatal("stderr failure returned nil error")
	}
	var forwarded bytes.Buffer
	if err := diagnostics.ForwardFailure(&forwarded, true, out.Bytes()); err != nil {
		t.Fatalf("ForwardFailure: %v", err)
	}
	if forwarded.String() != "task245-profile: kernel=fixture_connect\n" {
		t.Fatalf("forwarded diagnostics = %q", forwarded.String())
	}

	if err := directKernelResult(errorWriter{}, []byte(kernelFrame), nil, errors.New("failure")); err == nil || err.Error() != "kernel diagnostic output failed" {
		t.Fatalf("writer failure error = %v", err)
	}
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

func TestDirectKernelResultSuccessSuppressesRawOutput(t *testing.T) {
	var out bytes.Buffer
	if err := directKernelResult(&out, []byte("scary untrusted output\n"), nil, nil); err != nil {
		t.Fatalf("success returned error: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("success emitted %q", out.String())
	}
}

func TestDirectKernelResultMalformedFramesEmitNothing(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{name: "unknown_diagnostic", raw: "    protocol_test.go:51: namespace helper failed diagnostic=unknown (output length 23)\n"},
		{name: "diagnostic_with_secret", raw: "    protocol_test.go:51: namespace helper failed diagnostic=fixture_connect secret (output length 23)\n"},
		{name: "missing_newline", raw: "    protocol_test.go:51: namespace helper failed diagnostic=fixture_connect (output length 23)"},
		{name: "untrusted_cli_output", raw: "untrusted raw cli output\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := directKernelResult(&out, []byte(tc.raw), nil, errors.New("failure")); err == nil {
				t.Fatal("failure returned nil error")
			}
			if out.Len() != 0 {
				t.Fatalf("malformed frame emitted %q", out.String())
			}
		})
	}
}
