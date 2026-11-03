//go:build linux && amd64

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestLifecycleHelperProcess(t *testing.T) {
	if os.Getenv("TASK245_HELPER") != "1" {
		return
	}
	readyFD, err := strconv.Atoi(os.Getenv("TASK245_READY_FD"))
	if err != nil {
		os.Exit(2)
	}
	releaseFD, err := strconv.Atoi(os.Getenv("TASK245_RELEASE_FD"))
	if err != nil {
		os.Exit(2)
	}
	if _, err := syscall.Write(readyFD, []byte{1}); err != nil {
		os.Exit(2)
	}
	var b [1]byte
	if _, err := syscall.Read(releaseFD, b[:]); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func lifecyclePair(t *testing.T) (int, int) {
	t.Helper()
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	return pair[0], pair[1]
}

func startLifecycleHelper(t *testing.T) (*exec.Cmd, *os.File, <-chan error) {
	t.Helper()
	readyR, readyW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	releaseR, releaseW, err := os.Pipe()
	if err != nil {
		readyR.Close()
		readyW.Close()
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestLifecycleHelperProcess$")
	cmd.Env = []string{"TASK245_HELPER=1", "TASK245_READY_FD=3", "TASK245_RELEASE_FD=4"}
	cmd.ExtraFiles = []*os.File{readyW, releaseR}
	if err := cmd.Start(); err != nil {
		readyR.Close()
		readyW.Close()
		releaseR.Close()
		releaseW.Close()
		t.Fatal(err)
	}
	waitDone := startChildWait245(cmd)
	lifecycleWait := make(chan error, 1)
	reaped := make(chan struct{})
	go func() {
		lifecycleWait <- <-waitDone
		close(lifecycleWait)
		close(reaped)
	}()
	t.Cleanup(func() {
		_ = readyR.Close()
		select {
		case <-reaped:
		default:
			if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("kill child: %v", err)
			}
			select {
			case <-reaped:
			case <-time.After(time.Second):
				t.Error("child was not reaped within 1s")
			}
		}
		_ = releaseW.Close()
	})
	if err := readyW.Close(); err != nil {
		t.Fatal(err)
	}
	if err := releaseR.Close(); err != nil {
		t.Fatal(err)
	}
	var ready [1]byte
	if err := readyR.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := readyR.Read(ready[:]); err != nil {
		t.Fatal(err)
	}
	if err := readyR.Close(); err != nil {
		t.Fatal(err)
	}
	return cmd, releaseW, lifecycleWait
}

func assertChildReaped(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if cmd.ProcessState == nil {
		t.Fatal("child process state is nil")
	}
	var status syscall.WaitStatus
	_, err := syscall.Wait4(cmd.Process.Pid, &status, syscall.WNOHANG, nil)
	if !errors.Is(err, syscall.ECHILD) {
		t.Fatalf("child not reaped: Wait4 err=%v", err)
	}
}

func TestStopChildCleanupWaitReceiptIsBounded(t *testing.T) {
	cmd, releaseW, actualWait := startLifecycleHelper(t)
	gated := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	started := time.Now()
	err := stopChild245(ctx, cmd, gated)
	if err != brokerErr {
		t.Fatalf("stopChild245 error = %v, want brokerErr", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("stopChild245 took %v; want bounded return within 500ms", elapsed)
	}

	select {
	case waitErr := <-actualWait:
		assertChildReaped(t, cmd)
		gated <- waitErr // Buffered publication after stopChild245 returns.
	case <-time.After(time.Second):
		_ = releaseW.Close()
		t.Fatal("owning waiter did not report child exit within 1s")
	}
}

func TestLifecycleNaturalSuccess(t *testing.T) {
	fd, peer := lifecyclePair(t)
	defer syscall.Close(fd)
	defer syscall.Close(peer)
	cmd, releaseW, waitDone := startLifecycleHelper(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := releaseW.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := ownChildLifecycle(ctx, fd, cmd, waitDone); err != nil {
		t.Fatalf("natural lifecycle failed: %v", err)
	}
	assertChildReaped(t, cmd)
}

func TestLifecycleTimeoutClearAndCancel(t *testing.T) {
	fd, peer := lifecyclePair(t)
	lifecycleStarted := false
	defer func() {
		if !lifecycleStarted {
			_ = syscall.Close(fd)
			_ = syscall.Close(peer)
		}
	}()
	tv := syscall.NsecToTimeval((30 * time.Millisecond).Nanoseconds())
	if err := syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv); err != nil {
		t.Fatal(err)
	}
	var b [1]byte
	started := time.Now()
	_, err := syscall.Read(fd, b[:])
	if err != syscall.EAGAIN && err != syscall.EWOULDBLOCK {
		t.Fatalf("expected actual socket timeout, got %v", err)
	}
	if time.Since(started) < 20*time.Millisecond {
		t.Fatal("socket timeout returned too early")
	}

	// Inspect through a duplicate so the lifecycle goroutine remains the sole
	// owner of the descriptor it was given.
	inspectFD, err := syscall.Dup(fd)
	if err != nil {
		t.Fatal(err)
	}
	syscall.CloseOnExec(inspectFD)
	defer syscall.Close(inspectFD)
	cmd, releaseW, waitDone := startLifecycleHelper(t)
	defer releaseW.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	finished := make(chan struct{})
	result := make(chan error, 1)
	lifecycleStarted = true
	go func() {
		defer close(finished)
		defer syscall.Close(fd)
		defer syscall.Close(peer)
		result <- ownChildLifecycle(ctx, fd, cmd, waitDone)
	}()
	// Registered before assertions: cancellation and bounded join happen even
	// when an assertion fails. The lifecycle goroutine closes its own sockets.
	defer func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("lifecycle did not finish within 3s cleanup bound; socket ownership remains with lifecycle")
		}
	}()
	time.Sleep(90 * time.Millisecond)
	select {
	case err := <-result:
		t.Fatalf("lifecycle returned before cancellation: %v", err)
	default:
	}
	if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("child did not remain alive: %v", err)
	}
	var got syscall.Timeval
	n := uint32(unsafe.Sizeof(got))
	_, _, errno := syscall.Syscall6(syscall.SYS_GETSOCKOPT, uintptr(inspectFD), syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, uintptr(unsafe.Pointer(&got)), uintptr(unsafe.Pointer(&n)), 0)
	if errno != 0 || got.Sec != 0 || got.Usec != 0 {
		t.Fatalf("receive timeout was not cleared by lifecycle: value=%v errno=%v", got, errno)
	}
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancellation was accepted as success")
		}
	case <-finished:
		err := <-result
		if err == nil {
			t.Fatal("cancellation was accepted as success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("lifecycle hung after cancellation")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("lifecycle goroutine did not finish after returning")
	}
	assertChildReaped(t, cmd)
}

func TestClearHandshakeTimeoutRejectsInvalidFD(t *testing.T) {
	if err := clearHandshakeTimeout245(-1); !errors.Is(err, syscall.EBADF) {
		t.Fatalf("expected EBADF, got %v", err)
	}
}

func TestLifecycleRefusesActualUnconnectedReceive(t *testing.T) {
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	tv := syscall.NsecToTimeval((30 * time.Millisecond).Nanoseconds())
	if err := syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv); err != nil {
		t.Fatal(err)
	}
	if err := clearHandshakeTimeout245(fd); err != nil {
		t.Fatalf("clear receive timeout: %v", err)
	}
	var b [1]byte
	if _, _, _, _, err := syscall.Recvmsg(fd, b[:], nil, syscall.MSG_DONTWAIT); err != syscall.ENOTCONN {
		t.Fatalf("unconnected receive error = %v, want ENOTCONN", err)
	}

	cmd, releaseW, waitDone := startLifecycleHelper(t)
	defer releaseW.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := ownChildLifecycle(ctx, fd, cmd, waitDone); err != brokerErr {
		t.Fatalf("lifecycle error = %v, want brokerErr", err)
	}
	if ctx.Err() != nil {
		t.Fatalf("lifecycle refusal timed out: %v", ctx.Err())
	}
	assertChildReaped(t, cmd)
	var got syscall.Timeval
	n := uint32(unsafe.Sizeof(got))
	_, _, errno := syscall.Syscall6(syscall.SYS_GETSOCKOPT, uintptr(fd), syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, uintptr(unsafe.Pointer(&got)), uintptr(unsafe.Pointer(&n)), 0)
	if errno != 0 || got.Sec != 0 || got.Usec != 0 {
		t.Fatalf("receive timeout was not cleared: value=%v errno=%v", got, errno)
	}
}

func TestLifecycleHandshakeFailures(t *testing.T) {
	tests := []struct {
		name string
		write []byte
		closePeer bool
	}{
		{name: "eof", closePeer: true},
		{name: "data", write: []byte{1}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fd, peer := lifecyclePair(t)
			defer syscall.Close(fd)
			if tt.closePeer {
				syscall.Close(peer)
			} else {
				defer syscall.Close(peer)
				if _, err := syscall.Write(peer, tt.write); err != nil {
					t.Fatal(err)
				}
			}
			cmd, releaseW, waitDone := startLifecycleHelper(t)
			defer releaseW.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := ownChildLifecycle(ctx, fd, cmd, waitDone); err == nil {
				t.Fatalf("expected handshake failure, got %v", err)
			}
			assertChildReaped(t, cmd)
		})
	}

	t.Run("invalid transition FD", func(t *testing.T) {
		cmd, releaseW, waitDone := startLifecycleHelper(t)
		defer releaseW.Close()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := ownChildLifecycle(ctx, -1, cmd, waitDone); err == nil {
			t.Fatal("expected timeout-transition failure")
		}
		assertChildReaped(t, cmd)
	})
}
