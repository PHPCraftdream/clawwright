//go:build linux && amd64

package regression

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/proof"
)

const ackWaitLimit = 7 * time.Second

var (
	errACKMetadata   = errors.New("invalid active cancel acknowledgement metadata")
	errACKContents   = errors.New("invalid active cancel acknowledgement contents")
	errACKPathChanged = errors.New("active cancel acknowledgement path changed")
	errACKDisappeared = errors.New("active cancel acknowledgement disappeared")
	errACKTimeout     = errors.New("timed out waiting for active cancel acknowledgement")
)

// ackObservationHook runs synchronously at observer stages.
type ackObservationHook func(stage string) error

// observeACK observes one pinned inode until its complete release record is ready.
func observeACK(path string, ctx context.Context, timeout time.Duration, hook ackObservationHook) error {
	deadline := time.NewTimer(timeout)
	tick := time.NewTicker(time.Millisecond)
	defer deadline.Stop()
	defer tick.Stop()

	var pinned *syscall.Stat_t
	for pinned == nil {
		if err := ctx.Err(); err != nil {
			return err
		}
		select {
		case <-deadline.C:
			return errACKTimeout
		default:
		}

		f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err := ackHook(hook, "absent"); err != nil {
				return err
			}
			if err := ackWait(ctx, deadline.C, tick.C, hook); err != nil {
				return err
			}
			continue
		}

		var st syscall.Stat_t
		if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
			f.Close()
			return err
		}
		if !validACKMetadata(&st) {
			f.Close()
			return errACKMetadata
		}
		pinned = &st
		// Keep this descriptor open for all subsequent snapshots.
		return observePinned(f, path, pinned, ctx, deadline.C, tick.C, hook)
	}
	return nil
}

func observePinned(f *os.File, path string, identity *syscall.Stat_t, ctx context.Context, deadline <-chan time.Time, tick <-chan time.Time, hook ackObservationHook) error {
	defer f.Close()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		select {
		case <-deadline:
			return errACKTimeout
		default:
		}

		var before syscall.Stat_t
		if err := syscall.Fstat(int(f.Fd()), &before); err != nil {
			return err
		}
		if before.Nlink == 0 {
			return errACKDisappeared
		}
		if !sameACKInode(identity, &before) || !validACKMetadata(&before) {
			return errACKMetadata
		}
		if err := checkACKPath(path, identity); err != nil {
			return err
		}
		if err := ackHook(hook, "before-read"); err != nil {
			return err
		}

		buf := make([]byte, 8)
		n, readErr := syscall.Pread(int(f.Fd()), buf, 0)
		if readErr != nil {
			return readErr
		}
		var after syscall.Stat_t
		if err := syscall.Fstat(int(f.Fd()), &after); err != nil {
			return err
		}
		if after.Nlink == 0 {
			return errACKDisappeared
		}
		if !sameACKInode(identity, &after) || !validACKMetadata(&after) {
			return errACKMetadata
		}

		stage := "pending"
		if n == 0 && before.Size == 0 && (after.Size == 0 || after.Size == 7) {
			stage = "empty"
		} else if n == 7 && (before.Size == 0 || before.Size == 7) && after.Size == 7 && after.Uid == 65534 && string(buf[:n]) == "release" {
			stage = "ready"
		} else {
			return errACKContents
		}
		if err := ackHook(hook, stage); err != nil {
			return err
		}
		if err := checkACKPath(path, identity); err != nil {
			return err
		}
		if stage == "ready" {
			var current syscall.Stat_t
			if err := syscall.Lstat(path, &current); err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return errACKDisappeared
				}
				return err
			}
			if !sameACKInode(identity, &current) {
				return errACKPathChanged
			}
			if current.Nlink == 0 {
				return errACKDisappeared
			}
			if !validACKMetadata(&current) || current.Uid != 65534 || current.Size != 7 {
				return errACKMetadata
			}
			if err := os.Remove(path); err != nil {
				return err
			}
			return nil
		}
		if err := ackWait(ctx, deadline, tick, hook); err != nil {
			return err
		}
	}
}

func validACKMetadata(st *syscall.Stat_t) bool {
	return st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Nlink == 1 && st.Mode&07777 == 0600 && (st.Uid == 0 || st.Uid == 65534)
}

func checkACKPath(path string, identity *syscall.Stat_t) error {
	var current syscall.Stat_t
	if err := syscall.Lstat(path, &current); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errACKDisappeared
		}
		return err
	}
	if !sameACKInode(identity, &current) {
		return errACKPathChanged
	}
	if current.Nlink == 0 {
		return errACKDisappeared
	}
	return nil
}

func sameACKInode(a, b *syscall.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }

func ackHook(h ackObservationHook, stage string) error {
	if h != nil {
		return h(stage)
	}
	return nil
}

func ackWait(ctx context.Context, deadline, tick <-chan time.Time, hook ackObservationHook) error {
	if err := ackHook(hook, "waiting"); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-deadline:
		return errACKTimeout
	case <-tick:
		return nil
	}
}

func observeKernelACK(ctx context.Context) error { return observeACK(kernelACK, ctx, ackWaitLimit, nil) }

// RunACKObserverRegression covers deterministic publication stages under the privileged CI gate.
func RunACKObserverRegression() error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("ACK observer regression requires root in GitHub Actions")
	}
	return runACKObserverRegression()
}

func runACKObserverRegression() error {
	f, err := os.CreateTemp("/lab", "task245-ack-")
	if err != nil {
		return err
	}
	path := f.Name()
	defer os.Remove(path)
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	var st syscall.Stat_t
	if err = syscall.Fstat(int(f.Fd()), &st); err != nil {
		f.Close()
		return err
	}
	f.Close()
	ctx := context.Background()
	stages := 0
	err = observeACK(path, ctx, time.Second, func(stage string) error {
		if stage == "before-read" || stage == "waiting" {
			return nil
		}
		switch stages {
		case 0:
			if stage != "empty" {
				return fmt.Errorf("expected root empty, got %s", stage)
			}
			if err := os.Chown(path, 65534, 65534); err != nil {
				return err
			}
			stages++
		case 1:
			if stage != "empty" {
				return fmt.Errorf("expected owned empty, got %s", stage)
			}
			if _, err := os.Lstat(path); err != nil {
				return fmt.Errorf("removed pending ACK: %w", err)
			}
			if err := os.WriteFile(path, []byte("release"), 0600); err != nil {
				return err
			}
			stages++
		case 2:
			if stage != "ready" {
				return fmt.Errorf("expected release, got %s", stage)
			}
			stages++
		}
		return nil
	})
	if err != nil {
		return err
	}
	if stages != 3 {
		return fmt.Errorf("observer stages: got %d, want 3", stages)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("valid ACK was not removed: %v", err)
	}
	return nil
}

func terminateOwnedCmd(cmd *exec.Cmd, start uint64, done <-chan error, ctx context.Context, killStage, waitStage string) (consumed bool, cleanupErr error) {
	select {
	case waitErr := <-done:
		ReportDone(waitStage)
		return true, unexpectedOwnedWaitError(waitErr)
	default:
	}
	if cmd == nil || cmd.Process == nil || cmd.Process.Pid <= 1 || start == 0 {
		err := errors.New("invalid owned process identity")
		ReportFailure(killStage, err)
		return false, err
	}
	current, err := procStartTicks(cmd.Process.Pid)
	if err != nil {
		if os.IsNotExist(err) {
			select {
			case waitErr := <-done:
				ReportDone(waitStage)
				return true, unexpectedOwnedWaitError(waitErr)
			case <-ctx.Done():
				cleanupErr := errors.Join(err, ctx.Err())
				ReportFailure(waitStage, cleanupErr)
				return false, cleanupErr
			}
		}
		ReportFailure(killStage, err)
		return false, err
	}
	if current != start {
		err = errors.New("owned process identity changed")
		ReportFailure(killStage, err)
		return false, err
	}
	ReportStage(killStage)
	if err = cmd.Process.Kill(); err != nil {
		ReportFailure(killStage, err)
		if !errors.Is(err, os.ErrProcessDone) {
			return false, err
		}
	} else {
		ReportDone(killStage)
	}
	ReportStage(waitStage)
	select {
	case waitErr := <-done:
		ReportDone(waitStage)
		if err != nil {
			return true, unexpectedOwnedWaitError(waitErr)
		}
		return true, expectedKilledWaitError(waitErr)
	case <-ctx.Done():
		cleanupErr := errors.Join(err, ctx.Err())
		ReportFailure(waitStage, cleanupErr)
		return false, cleanupErr
	}
}

func unexpectedOwnedWaitError(err error) error {
	return expectedKilledWaitError(err)
}

func expectedKilledWaitError(err error) error {
	if exitErr, ok := err.(*exec.ExitError); ok {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() && status.Signal() == syscall.SIGKILL {
			return nil
		}
	}
	return err
}

func RunServicePeer() error {
	if os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("service peer regression requires GitHub Actions")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/lab/harness", "--service-peer-child")
	cmd.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("service peer child: %w", err)
	}
	return nil
}

func ServicePeerChild() error {
	if os.Getuid() != 65534 {
		return errors.New("service peer child is not uid 65534")
	}
	fd, err := proof.ConnectAndVerify()
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	name, err := syscall.BytePtrFromString("service-peer-fake")
	if err != nil {
		return err
	}
	memfd, _, errno := syscall.Syscall(319, uintptr(unsafe.Pointer(name)), uintptr(3), 0)
	if errno != 0 {
		return errno
	}
	defer syscall.Close(int(memfd))
	message := []byte("OCMETA01")
	oob := syscall.UnixRights(int(memfd))
	n, err := syscall.SendmsgN(fd, message, oob, nil, 0)
	if err != nil {
		return err
	}
	if n != 8 {
		return fmt.Errorf("service peer sent %d bytes, want 8", n)
	}
	return nil
}

func runDiagnosticStage(code string, run func() error) error {
	ReportStage(code)
	if err := run(); err != nil {
		ReportFailure(code, err)
		return err
	}
	ReportDone(code)
	return nil
}

// RunKernelDriver runs the privileged diagnostic regression cases.
func RunKernelDriver(ctx context.Context) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("kernel driver regression requires root in GitHub Actions")
	}
	if err := RunDiagnosticRegression(); err != nil {
		return err
	}

	stages := []struct {
		code string
		run  func() error
	}{
		{"observer_positive", RunACKObserverRegression},
		{"observer_negative", runACKObserverFailures},
		{"lifetime_cases", func() error { return RunDaemonLifetimeCases(ctx) }},
		{"service_proofs", func() error { return RunServiceProofCases(ctx) }},
		{"inactive", func() error { return runCase(ctx, false) }},
		{"active", func() error { return runCase(ctx, true) }},
		{"fault_write", func() error { return runFaultCase(ctx, "write") }},
		{"fault_fsync", func() error { return runFaultCase(ctx, "fsync") }},
		{"fault_close", func() error { return runFaultCase(ctx, "close") }},
		{"refusal_receipt", func() error { return runRefusalCase(ctx, "badreceipt") }},
		{"refusal_fault", func() error { return runRefusalCase(ctx, "wrongfault") }},
		{"fifo", func() error { return runRefusalCase(ctx, "receiptfifo")}},
	}
	for _, stage := range stages {
		if err := runDiagnosticStage(stage.code, stage.run); err != nil {
			return err
		}
	}
	return nil
}
