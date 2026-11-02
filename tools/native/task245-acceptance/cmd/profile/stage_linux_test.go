//go:build linux && amd64

package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

func TestReportProfileFailureNestedStage(t *testing.T) {
	err := atProfileStage("setup", atProfileStage("metadata_preflight", errors.New("private")))
	var inner profileFailure
	if !errors.As(err, &inner) || inner.stage != "metadata_preflight" {
		t.Fatalf("preserved stage = %q, want metadata_preflight", inner.stage)
	}
	var direct bytes.Buffer
	if err := reportProfileFailure(&direct, err); err != nil {
		t.Fatal(err)
	}
	var outer bytes.Buffer
	if err := diagnostics.ContainerFailure(&outer, true, 7, 0, direct.Bytes()); err != nil {
		t.Fatal(err)
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: stage=metadata_preflight\n"
	if outer.String() != want {
		t.Fatalf("outer diagnostics = %q, want %q", outer.String(), want)
	}
}

func TestReportProfileFailureUnknownStageIsFiltered(t *testing.T) {
	var out bytes.Buffer
	err := atProfileStage("unknown_secret", errors.New("private secret"))
	if err := reportProfileFailure(&out, err); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "task245-profile: failed\n"; got != want {
		t.Fatalf("report = %q, want %q", got, want)
	}
	if strings.Contains(out.String(), "secret") {
		t.Fatalf("report leaked secret: %q", out.String())
	}
}

func TestReportProfileFailureNilIsSilent(t *testing.T) {
	var out bytes.Buffer
	if err := reportProfileFailure(&out, nil); err != nil || out.Len() != 0 {
		t.Fatalf("report = %q, error = %v", out.String(), err)
	}
}

func TestReportProfileFailureKernelStage(t *testing.T) {
	var direct bytes.Buffer
	err := directKernelResult(&direct, []byte("    protocol_test.go:51: namespace helper failed diagnostic=fixture_connect (output length 23)\n"), nil, errors.New("private"))
	if err == nil {
		t.Fatal("directKernelResult returned nil")
	}
	var reported bytes.Buffer
	if err := reportProfileFailure(&reported, err); err != nil {
		t.Fatal(err)
	}
	var outer bytes.Buffer
	if err := diagnostics.ContainerFailure(&outer, true, 7, 0, reported.Bytes()); err != nil {
		t.Fatal(err)
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: stage=kernel\n"
	if outer.String() != want {
		t.Fatalf("outer diagnostics = %q, want %q", outer.String(), want)
	}
}

func TestReportProfileFailureWriterErrorPropagates(t *testing.T) {
	if err := reportProfileFailure(errorWriter{}, errors.New("failure")); err == nil {
		t.Fatal("writer failure returned nil")
	}
}
