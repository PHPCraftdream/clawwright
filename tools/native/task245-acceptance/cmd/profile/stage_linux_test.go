//go:build linux && amd64

package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
	"clawforge/tools/native/task240-native/task245-acceptance/internal/service"
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

func TestReportProfileFailureServicePreflightMetadata(t *testing.T) {
	err := atProfileStage("service_preflight", &service.PreflightError{
		Role: "metadata",
		Case: "good",
		Cause: &service.Error{Code: "probe-status"},
	})
	var direct bytes.Buffer
	if err := reportProfileFailure(&direct, err); err != nil {
		t.Fatal(err)
	}
	var outer bytes.Buffer
	if err := diagnostics.ContainerFailure(&outer, true, 7, 0, direct.Bytes()); err != nil {
		t.Fatal(err)
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: stage=service_preflight\ntask245-profile: service role=metadata case=good code=probe-status\n"
	if outer.String() != want {
		t.Fatalf("outer diagnostics = %q, want %q", outer.String(), want)
	}
}

func TestReportProfileFailureServicePreflightUnknownCause(t *testing.T) {
	err := atProfileStage("service_preflight", &service.PreflightError{
		Cause: errors.New("private cause"),
	})
	var direct bytes.Buffer
	if err := reportProfileFailure(&direct, err); err != nil {
		t.Fatal(err)
	}
	var outer bytes.Buffer
	if err := diagnostics.ContainerFailure(&outer, true, 7, 0, direct.Bytes()); err != nil {
		t.Fatal(err)
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: stage=service_preflight\ntask245-profile: service role=unknown case=setup code=unknown\n"
	if outer.String() != want {
		t.Fatalf("outer diagnostics = %q, want %q", outer.String(), want)
	}
	if strings.Contains(outer.String(), "private") {
		t.Fatalf("report leaked private cause: %q", outer.String())
	}
}

func TestReportProfileFailureServicePreflightUnsafeValuesFallback(t *testing.T) {
	err := atProfileStage("service_preflight", &service.PreflightError{
		Role: "private-role",
		Case: "private-case",
		Cause: &service.Error{Code: "private-code"},
	})
	var direct bytes.Buffer
	if err := reportProfileFailure(&direct, err); err != nil {
		t.Fatal(err)
	}
	if got, want := direct.String(), "task245-profile: stage=service_preflight\ntask245-profile: service role=unknown case=unknown code=unknown\ntask245-profile: failed\n"; got != want {
		t.Fatalf("report = %q, want %q", got, want)
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
