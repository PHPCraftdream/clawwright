//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestLifecycleDiagnostics245(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*testing.T) (int, func(), string)
	}{
		{"peer_eof", func(t *testing.T) (int, func(), string) {
			fd, peer := lifecyclePair(t)
			_ = syscall.Close(peer)
			return fd, func() { _ = syscall.Close(fd) }, "task245-broker: lifecycle=peer_eof errno=0\n"
		}},
		{"context_done", func(t *testing.T) (int, func(), string) {
			fd, peer := lifecyclePair(t)
			return fd, func() { _ = syscall.Close(fd); _ = syscall.Close(peer) }, "task245-broker: lifecycle=context_done errno=0\n"
		}},
		{"peer_error", func(t *testing.T) (int, func(), string) {
			fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			return fd, func() { _ = syscall.Close(fd) }, "task245-broker: lifecycle=peer_error errno=107\n"
		}},
		{"peer_rights", func(t *testing.T) (int, func(), string) {
			fd, peer := lifecyclePair(t)
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			defer w.Close()
			if _, err := syscall.SendmsgN(peer, []byte{'x'}, syscall.UnixRights(int(r.Fd())), nil, 0); err != nil {
				t.Fatal(err)
			}
			return fd, func() { _ = syscall.Close(fd); _ = syscall.Close(peer) }, "task245-broker: lifecycle=peer_rights errno=0\n"
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fd, cleanup, want := tt.setup(t)
			defer cleanup()
			cmd, release, waitDone := startLifecycleHelper(t)
			defer release.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if tt.name == "context_done" {
				cancel()
			}
			var diagnostics bytes.Buffer
			if err := ownChildLifecycleDiagnostics245(ctx, fd, cmd, waitDone, &diagnostics); err == nil {
				t.Fatal("expected lifecycle failure")
			}
			if got := diagnostics.String(); got != want {
				t.Fatalf("diagnostics %q, want %q", got, want)
			}
			assertChildReaped(t, cmd)
		})
	}
}

func TestWaitDiagnosticHelper245(t *testing.T) {
	switch os.Getenv("TASK245_WAIT_DIAGNOSTIC") {
	case "exit7":
		os.Exit(7)
	case "signal":
		if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
			os.Exit(8)
		}
		time.Sleep(time.Second)
		os.Exit(8)
	default:
		return
	}
}

func TestChildWaitDiagnosticsActualProcesses245(t *testing.T) {
	for _, tc := range []struct{ name, mode, want string }{
		{"exit7", "exit7", "task245-broker: wait=exit exit=7 signal=0"},
		{"signal", "signal", "task245-broker: wait=signal exit=-1 signal=15"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestWaitDiagnosticHelper245$")
			cmd.Env = []string{"TASK245_WAIT_DIAGNOSTIC=" + tc.mode}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := startChildWait245(cmd)
			timer := time.NewTimer(2 * time.Second)
			defer timer.Stop()
			select {
			case waitErr := <-done:
				if got := childWaitDiagnostic245(cmd, waitErr); got != tc.want {
					t.Fatalf("diagnostic %q, want %q", got, tc.want)
				}
			case <-timer.C:
				if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
					t.Errorf("kill timed-out child: %v", err)
				}
				select {
				case <-done:
				case <-time.After(2 * time.Second):
					t.Error("child reap unconfirmed")
				}
				t.Fatal("child wait timed out")
			}
		})
	}
}
