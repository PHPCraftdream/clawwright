//go:build linux && amd64

package service

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

const startupHelperEnv = "startupHelperEnv"

func TestStartupChild(t *testing.T) {
	if os.Getenv(startupHelperEnv) != "1" {
		return
	}
	ready := os.NewFile(3, "ready")
	release := os.NewFile(4, "release")
	if ready == nil || release == nil {
		os.Exit(91)
	}
	if _, err := ready.Write([]byte{1}); err != nil {
		os.Exit(92)
	}
	var b [1]byte
	if _, err := release.Read(b[:]); err != nil && err != io.EOF {
		os.Exit(93)
	}
	os.Exit(0)
}

func startupCommand(readyW, releaseR *os.File) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestStartupChild$")
	cmd.Env = []string{startupHelperEnv + "=1"}
	cmd.ExtraFiles = []*os.File{readyW, releaseR}
	return cmd
}

func startupPipes(t *testing.T) (readyR, readyW, releaseR, releaseW *os.File) {
	t.Helper()
	var err error
	if readyR, readyW, err = os.Pipe(); err != nil {
		t.Fatal(err)
	}
	if releaseR, releaseW, err = os.Pipe(); err != nil {
		readyR.Close()
		readyW.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = releaseW.Close()
		_ = readyR.Close()
		_ = readyW.Close()
		_ = releaseR.Close()
	})
	return
}

func startupReady(readyR *os.File) error {
	if err := readyR.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	var b [1]byte
	n, err := io.ReadFull(readyR, b[:])
	if err != nil {
		return err
	}
	if n != 1 || b[0] != 1 {
		return errors.New("invalid ready handshake")
	}
	return nil
}

func assertECHILD(t *testing.T, pid int) {
	t.Helper()
	var status syscall.WaitStatus
	_, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
	if !errors.Is(err, syscall.ECHILD) {
		t.Fatalf("Wait4 after reap: %v", err)
	}
}

func startupCaptureReadError(pid int) error {
	fd, err := syscall.Open("/proc/"+strconv.Itoa(pid)+"/stat", 0x200000|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var b [1]byte
	_, err = syscall.Read(fd, b[:])
	return err
}

func TestStartOwnedCaptureFailureReapsRealChild(t *testing.T) {
	readyR, readyW, releaseR, releaseW := startupPipes(t)
	cmd := startupCommand(readyW, releaseR)
	var actualErr error
	child, err := startOwned(cmd, func(pid int) (uint64, error) {
		_ = readyW.Close()
		_ = releaseR.Close()
		if readyErr := startupReady(readyR); readyErr != nil {
			return 0, readyErr
		}
		actualErr = startupCaptureReadError(pid)
		return 0, actualErr
	})
	_ = releaseW.Close()
	if child != nil {
		t.Cleanup(func() {
			_ = releaseW.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if stopErr := child.Stop(ctx); stopErr != nil {
				t.Errorf("cleanup child: %v", stopErr)
			}
			select {
			case <-child.Done():
			case <-time.After(time.Second):
				t.Error("child wait did not finish within 1s")
			}
		})
		t.Fatal("capture failure returned a child")
	}
	if !errors.Is(err, syscall.EBADF) || !errors.Is(actualErr, syscall.EBADF) {
		t.Fatalf("capture error=%v actual error=%v", err, actualErr)
	}
	if cmd.ProcessState == nil {
		t.Fatal("startup returned before child was reaped")
	}
	assertECHILD(t, cmd.Process.Pid)
}

func TestStartOwnedRealChildWait(t *testing.T) {
	readyR, readyW, releaseR, releaseW := startupPipes(t)
	cmd := startupCommand(readyW, releaseR)
	child, err := startOwned(cmd, func(pid int) (uint64, error) {
		_ = readyW.Close()
		_ = releaseR.Close()
		if readyErr := startupReady(readyR); readyErr != nil {
			return 0, readyErr
		}
		return procStart(pid)
	})
	t.Cleanup(func() {
		_ = releaseW.Close()
		if child == nil {
			return
		}
		select {
		case <-child.Done():
		case <-time.After(time.Second):
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if stopErr := child.Stop(ctx); stopErr != nil {
				t.Errorf("cleanup child: %v", stopErr)
			}
			select {
			case <-child.Done():
			case <-time.After(time.Second):
				t.Error("child wait did not finish after stop within 1s")
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.start == 0 {
		t.Fatal("missing real process start time")
	}
	if err = releaseW.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-child.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("child wait timed out")
	}
	if err = child.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	if cmd.ProcessState == nil {
		t.Fatal("child was not reaped")
	}
	assertECHILD(t, cmd.Process.Pid)
}

func TestStartupCleanupKillRefusal(t *testing.T) {
	if os.Getenv("TASK245_STARTUP_REFUSAL") != "1" {
		return
	}
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		t.Fatal("kill-refusal fixture requires root in GitHub Actions")
	}
	readyR, readyW, releaseR, releaseW := startupPipes(t)
	cmd := startupCommand(readyW, releaseR)
	cmd.Path = "/input/service-startup-test"
	cmd.Args[0] = cmd.Path
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
	t.Cleanup(func() {
		_ = releaseW.Close()
	})
	var actualErr error
	child, err := startOwned(cmd, func(pid int) (uint64, error) {
		_ = readyW.Close()
		_ = releaseR.Close()
		if readyErr := startupReady(readyR); readyErr != nil {
			return 0, readyErr
		}
		actualErr = startupCaptureReadError(pid)
		return 0, actualErr
	})
	if child == nil {
		t.Fatal("startup returned a nil child")
	}
	t.Cleanup(func() {
		_ = releaseW.Close()
		select {
		case <-child.Done():
		case <-time.After(time.Second):
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if stopErr := child.Stop(ctx); stopErr != nil {
				t.Errorf("cleanup child: %v", stopErr)
			}
			select {
			case <-child.Done():
			case <-time.After(time.Second):
				t.Error("child wait did not finish after stop within 1s")
			}
		}
	})
	if child.start != 0 {
		t.Fatalf("capture failure child start=%d, want unidentified child", child.start)
	}
	var serviceErr *Error
	if !errors.As(err, &serviceErr) || serviceErr.Code != "kill-refused" {
		t.Fatalf("startup error=%v, want kill-refused", err)
	}
	if !errors.Is(actualErr, syscall.EBADF) {
		t.Fatalf("capture error=%v, want EBADF", actualErr)
	}
	if err := cmd.Process.Kill(); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("direct kill error=%v, want EPERM", err)
	}
	select {
	case <-child.Done():
		t.Fatal("child wait completed before release")
	default:
	}
	if err := releaseW.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-child.Done():
	case <-time.After(time.Second):
		t.Fatal("child did not exit after release")
	}
	if err := child.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	assertECHILD(t, cmd.Process.Pid)
}

func TestStopUnidentifiedTimeoutDoesNotClaimReap(t *testing.T) {
	readyR, readyW, releaseR, releaseW := startupPipes(t)
	cmd := startupCommand(readyW, releaseR)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	receipt := make(chan error, 1)
	reaped := make(chan struct{})
	go func() {
		err := cmd.Wait()
		close(reaped)
		receipt <- err
	}()
	t.Cleanup(func() {
		_ = releaseW.Close()
		select {
		case <-reaped:
			return
		default:
		}
		if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("cleanup kill: %v", err)
		}
		select {
		case <-reaped:
		case <-time.After(time.Second):
			t.Error("actual waiter did not reap child within 1s")
		}
	})
	child := &Child{Cmd: cmd, done: make(chan error)}
	_ = readyW.Close()
	_ = releaseR.Close()
	if err := startupReady(readyR); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := child.stopUnidentified(ctx)
	var serviceErr *Error
	if !errors.As(err, &serviceErr) || serviceErr.Code != "reap-timeout" {
		t.Fatalf("stop error=%v", err)
	}
	select {
	case waitErr := <-receipt:
		if waitErr == nil {
			t.Fatal("expected killed child wait error")
		}
	case <-time.After(time.Second):
		t.Fatal("actual waiter did not reap child")
	}
	assertECHILD(t, cmd.Process.Pid)
	_ = releaseW.Close()
}
