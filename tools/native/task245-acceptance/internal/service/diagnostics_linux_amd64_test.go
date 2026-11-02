//go:build linux && amd64

package service

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

const (
	diagnosticHelperEnv  = "TASK245_DIAGNOSTIC_HELPER"
	diagnosticReleaseEnv = "TASK245_DIAGNOSTIC_RELEASE"
)

func TestDaemonDiagnosticHelper(t *testing.T) {
	mode := os.Getenv(diagnosticHelperEnv)
	if mode != "1" && mode != "2" {
		return
	}
	if mode == "2" {
		_, _ = os.Stderr.Write(bytes.Repeat([]byte("x"), 4097))
		_, _ = os.Stderr.Write([]byte("\ntask245-broker: stage=2\n"))
	} else {
		_, _ = os.Stderr.Write([]byte("task245-broker: sta"))
		_, _ = os.Stderr.Write([]byte("ge=2\ntask245-init: checkpoint=112 errno=7\n"))
		_, _ = os.Stderr.Write([]byte("token=private-value\nmalformed trailing data\n"))
	}
	releasePath := os.Getenv(diagnosticReleaseEnv)
	release, err := os.Open(releasePath)
	if err != nil {
		os.Exit(8)
	}
	var signal [1]byte
	_, err = release.Read(signal[:])
	_ = release.Close()
	if err != nil {
		os.Exit(8)
	}
	os.Exit(7)
}

func startDiagnosticHelper(t *testing.T, mode string) *Child {
	t.Helper()
	releasePath := filepath.Join(t.TempDir(), "diagnostic-release")
	if err := syscall.Mkfifo(releasePath, 0600); err != nil {
		t.Fatal("could not prepare diagnostic release")
	}
	releaseFD, err := syscall.Open(releasePath, syscall.O_RDWR|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal("could not open diagnostic release")
	}
	releaseFile := os.NewFile(uintptr(releaseFD), "diagnostic-release")
	t.Cleanup(func() { _ = releaseFile.Close() })
	child, err := StartDaemon([]string{diagnosticHelperEnv + "=" + mode, diagnosticReleaseEnv + "=" + releasePath}, os.Args[0], "-test.run=^TestDaemonDiagnosticHelper$")
	if err != nil {
		if child != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = child.Stop(ctx)
			cancel()
		}
		t.Fatal("StartDaemon failed")
	}
	t.Cleanup(func() {
		select {
		case <-child.Done():
			return
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if stopErr := child.Stop(ctx); stopErr != nil {
			t.Error("could not stop diagnostic helper")
		}
	})
	if _, err := releaseFile.Write([]byte{1}); err != nil {
		t.Fatal("could not release diagnostic helper")
	}
	select {
	case <-child.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("diagnostic helper timed out")
	}
	return child
}

func waitForDiagnosticHelper(t *testing.T, child *Child) {
	t.Helper()
	waitErr := child.Wait()
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) || exitErr.ExitCode() != 7 {
		t.Fatal("diagnostic helper did not produce the expected nonzero wait receipt")
	}
}

func TestStartDaemonCapturesSafeDiagnostics(t *testing.T) {
	child := startDiagnosticHelper(t, "1")
	waitForDiagnosticHelper(t, child)
	raw := child.DiagnosticBytes()
	if !bytes.Contains(raw, []byte("task245-broker: stage=2")) || !bytes.Contains(raw, []byte("task245-init: checkpoint=112 errno=7")) {
		t.Fatal("captured diagnostics omitted expected records")
	}
	var report bytes.Buffer
	if err := diagnostics.ReportFailure(&report, true, "task245-profile: checkpoints=1-2-32", raw, nil, "stderr", 7); err != nil {
		t.Fatal("ReportFailure failed")
	}
	var container bytes.Buffer
	if err := diagnostics.ContainerFailure(&container, true, 7, 0, report.Bytes()); err != nil {
		t.Fatal("ContainerFailure failed")
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: checkpoints=1-2-32\ntask245-profile: task245-conductor: event=stderr exit=7\ntask245-profile: task245-broker: stage=2\ntask245-profile: task245-init: checkpoint=112 errno=7\n"
	if container.String() != want || strings.Contains(container.String(), "private-value") || strings.Contains(container.String(), "malformed") {
		t.Fatal("diagnostic report was not sanitized and ordered as expected")
	}
	var success bytes.Buffer
	if err := diagnostics.ReportFailure(&success, false, "", raw, nil, "", 0); err != nil || success.Len() != 0 {
		t.Fatal("successful operations must emit no diagnostic report")
	}
}

func TestStartDaemonDiagnosticOverflowOmitsRecords(t *testing.T) {
	child := startDiagnosticHelper(t, "2")
	waitForDiagnosticHelper(t, child)
	raw := child.DiagnosticBytes()
	if raw != nil {
		t.Fatal("overflow diagnostics must not be retained")
	}
	var report bytes.Buffer
	if err := diagnostics.ReportFailure(&report, true, "task245-profile: checkpoints=1-2-32", raw, nil, "stderr", 7); err != nil {
		t.Fatal("ReportFailure failed")
	}
	var container bytes.Buffer
	if err := diagnostics.ContainerFailure(&container, true, 7, 0, report.Bytes()); err != nil {
		t.Fatal("ContainerFailure failed")
	}
	want := "task245-container: command_exit=7 container_exit=0\ntask245-profile: checkpoints=1-2-32\ntask245-profile: task245-conductor: event=stderr exit=7\n"
	if container.String() != want || strings.Contains(container.String(), "task245-broker") || strings.Contains(container.String(), "task245-init") || strings.Contains(container.String(), "private-value") {
		t.Fatal("overflow report included broker, init, or secret diagnostics")
	}
}
