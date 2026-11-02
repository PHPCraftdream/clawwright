//go:build linux && amd64

package regression

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/proof"
)

const (
	clientReceiptPath = "/var/lib/ssjack/synthetic/consumer-receipt"
	clientCancelPath  = "/var/lib/ssjack/synthetic/cancel-ack"
	clientMetadataExe = "/lab/bin/metadata-child"
	getSeals          = 1034
	sealAll           = 15
)

func LifetimeHandoffClient() error {
	if os.Geteuid() != 65534 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("lifetime handoff requires uid 65534 in GitHub Actions")
	}
	fd, err := proof.ConnectAndVerify()
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	if _, err := fmt.Fprint(os.Stdout, "LIFETIME_CONNECTED\n"); err != nil {
		return err
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		return fmt.Errorf("lifetime handoff gate released: %w", err)
	}
	return errors.New("lifetime handoff gate released unexpectedly")
}

func KernelLifetimeClient() error {
	if os.Getuid() != 65534 || os.Geteuid() != 65534 {
		return errors.New("kernel lifetime requires uid 65534")
	}
	if err := CheckFilteredDescriptors(true); err != nil {
		return fmt.Errorf("lifetime filtered descriptors: %w", err)
	}
	if _, err := fmt.Fprint(os.Stdout, "LIFETIME_LISTENER\n"); err != nil {
		return err
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		return fmt.Errorf("kernel lifetime gate released: %w", err)
	}
	return errors.New("kernel lifetime gate released unexpectedly")
}

func KernelClient(active bool) error {
	gate := make([]byte, 1)
	if n, err := io.ReadFull(os.Stdin, gate); err != nil || n != 1 {
		return fmt.Errorf("read notifier gate: %w", err)
	}
	if err := CheckFilteredDescriptors(true); err != nil {
		return fmt.Errorf("filtered descriptors: %w", err)
	}
	if !active {
		fd, err := syscall.Open(clientCancelPath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC, 0600)
		if err == nil {
			_ = syscall.Close(fd)
			return errors.New("inactive cancel acknowledgement unexpectedly opened")
		}
		if !errors.Is(err, syscall.EACCES) {
			return fmt.Errorf("open inactive cancel acknowledgement: %w, want EACCES", err)
		}
	}
	if active {
		if _, err := readClientReceipt(); err != nil {
			return err
		}

		fd, err := syscall.Open(clientCancelPath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC, 0600)
		if err != nil {
			return fmt.Errorf("open cancel acknowledgement: %w", err)
		}
		if fd != 1023 {
			_ = syscall.Close(fd)
			return fmt.Errorf("cancel acknowledgement fd: got %d, want 1023", fd)
		}
		if n, err := syscall.Write(fd, []byte("release")); err != nil || n != 7 {
			_ = syscall.Close(fd)
			return fmt.Errorf("write cancel acknowledgement: n=%d err=%v", n, err)
		}
		if err = syscall.Close(fd); err != nil {
			return fmt.Errorf("close cancel acknowledgement: %w", err)
		}
	}
	return runSameImageChild()
}

func runSameImageChild() error {
	pid := os.Getpid()
	cmd := exec.Command("/lab/bin/harness", "--notifier-same-image-child", fmt.Sprint(pid))
	cmd.Env = []string{"PATH=/lab/bin", "LANG=C", "LC_ALL=C"}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("same-image child: %w", err)
	}
	execErr := syscall.Exec(clientMetadataExe, []string{clientMetadataExe, "--notifier-same-pid-exec", fmt.Sprint(pid)}, []string{"PATH=/lab/bin", "LANG=C", "LC_ALL=C"})
	return fmt.Errorf("same-pid metadata exec: %w", execErr)
}

func SameImageChild(expectedPID int) error {
	if expectedPID <= 1 || os.Getpid() <= 1 || os.Getpid() == expectedPID {
		return errors.New("same-image child PID is not distinct")
	}
	if _, err := fmt.Fprintf(os.Stdout, "I %d\n", os.Getpid()); err != nil {
		return err
	}
	gate := make([]byte, 1)
	if _, err := io.ReadFull(os.Stdin, gate); err != nil {
		return fmt.Errorf("read root identity gate: %w", err)
	}
	if gate[0] != 'I' {
		return fmt.Errorf("root identity gate: got %q, want %q", gate[0], 'I')
	}
	return CheckFilteredDescriptors(false)
}

func SamePIDExecClient(expectedPID int) error {
	if expectedPID <= 1 || os.Getpid() <= 1 || os.Getpid() != expectedPID {
		return errors.New("same-pid exec changed process ID")
	}
	if _, err := fmt.Fprintf(os.Stdout, "E %d\n", os.Getpid()); err != nil {
		return err
	}
	gate := make([]byte, 1)
	if _, err := io.ReadFull(os.Stdin, gate); err != nil {
		return fmt.Errorf("read root exec gate: %w", err)
	}
	if gate[0] != 'E' {
		return fmt.Errorf("root exec gate: got %q, want %q", gate[0], 'E')
	}
	return CheckFilteredDescriptors(false)
}

func runExecChild() error {
	cmd := exec.Command(clientMetadataExe, "--notifier-exec")
	cmd.Env = []string{"PATH=/lab/bin", "LANG=C", "LC_ALL=C"}
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("metadata child: %w", err)
	}
	if string(output) != "metadata notifier exec: PASS\n" {
		return fmt.Errorf("metadata child output mismatch")
	}
	return nil
}

func readClientReceipt() ([]byte, error) {
	fd, err := syscall.Open(clientReceiptPath, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, fmt.Errorf("open consumer receipt: %w", err)
	}

	buf := make([]byte, 49)
	n, readErr := syscall.Read(fd, buf)
	if readErr != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("read consumer receipt: %w", readErr)
	}
	if n != 48 {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("consumer receipt length: got %d, want 48", n)
	}
	for i, b := range buf[:48] {
		if b != 0x5a {
			_ = syscall.Close(fd)
			return nil, fmt.Errorf("consumer receipt byte %d: got %#x, want 0x5a", i, b)
		}
	}

	seals, errno := fcntl(fd, getSeals, 0)
	if errno != 0 {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("receipt F_GET_SEALS: %w", errno)
	}
	if seals != sealAll {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("receipt seals: got %d, want %d", seals, sealAll)
	}
	if err = syscall.Close(fd); err != nil {
		return nil, fmt.Errorf("close consumer receipt: %w", err)
	}
	return buf[:48], nil
}

// KernelFaultClient verifies a close-time ACK failure clears the daemon slot.
func KernelFaultClient(phase string) error {
	if phase != "write" && phase != "fsync" && phase != "close" {
		return fmt.Errorf("unsupported kernel fault phase %q", phase)
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		return fmt.Errorf("read fault gate: %w", err)
	}
	if _, err := readClientReceipt(); err != nil {
		return err
	}

	fd, err := syscall.Open(clientCancelPath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("open acknowledgement: %w", err)
	}
	if fd != 1023 {
		_ = syscall.Close(fd)
		return fmt.Errorf("acknowledgement fd: got %d, want 1023", fd)
	}
	if n, writeErr := syscall.Write(fd, []byte("release")); n != 7 || writeErr != nil {
		_ = syscall.Close(fd)
		return fmt.Errorf("write acknowledgement: n=%d err=%v, want n=7 err=nil", n, writeErr)
	}
	if err = syscall.Close(fd); !errors.Is(err, syscall.EIO) {
		return fmt.Errorf("close acknowledgement: %v, want EIO", err)
	}

	var st syscall.Stat_t
	if err = syscall.Fstat(fd, &st); err != nil {
		return fmt.Errorf("fstat acknowledgement after close: %w", err)
	}
	if st.Size != 0 {
		return fmt.Errorf("acknowledgement size: got %d, want 0", st.Size)
	}
	if _, err = syscall.Write(fd, []byte("release")); !errors.Is(err, syscall.EACCES) {
		return fmt.Errorf("subsequent write: %v, want EACCES", err)
	}
	if err = syscall.Close(fd); err != nil {
		return fmt.Errorf("close acknowledgement again: %w", err)
	}
	return runSameImageChild()
}

func KernelRefusalClient(kind string) error {
	if kind != "badreceipt" && kind != "wrongfault" && kind != "receiptfifo" {
		return fmt.Errorf("unsupported kernel refusal kind %q", kind)
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		return fmt.Errorf("read refusal start gate: %w", err)
	}
	if err := CheckFilteredDescriptors(true); err != nil {
		return fmt.Errorf("refusal filtered descriptors: %w", err)
	}
	if _, err := readClientReceipt(); err != nil {
		return err
	}
	if _, err := os.Stdout.Write([]byte{'S'}); err != nil {
		return fmt.Errorf("signal receipt ready: %w", err)
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		return fmt.Errorf("read refusal mutation gate: %w", err)
	}

	fd, err := syscall.Open(clientCancelPath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("open refusal acknowledgement: %w", err)
	}
	if fd != 1023 {
		_ = syscall.Close(fd)
		return fmt.Errorf("refusal acknowledgement fd: got %d, want 1023", fd)
	}
	if n, writeErr := syscall.Write(fd, []byte("release")); n != 7 || writeErr != nil {
		_ = syscall.Close(fd)
		return fmt.Errorf("write refusal acknowledgement: n=%d err=%v", n, writeErr)
	}
	if err = syscall.Close(fd); !errors.Is(err, syscall.EIO) {
		return fmt.Errorf("close refusal acknowledgement: %v, want EIO", err)
	}

	var st syscall.Stat_t
	if err = syscall.Fstat(fd, &st); err != nil {
		return fmt.Errorf("fstat refusal acknowledgement: %w", err)
	}
	if st.Size != 0 {
		return fmt.Errorf("refusal acknowledgement size: got %d, want 0", st.Size)
	}
	if _, err = syscall.Write(fd, []byte("release")); !errors.Is(err, syscall.EACCES) {
		return fmt.Errorf("subsequent refusal write: %v, want EACCES", err)
	}
	if err = syscall.Close(fd); err != nil {
		return fmt.Errorf("close refusal acknowledgement again: %w", err)
	}
	if _, err = os.Stdout.Write([]byte{'D'}); err != nil {
		return fmt.Errorf("signal refusal done: %w", err)
	}
	if _, err = io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		return fmt.Errorf("read refusal completion gate: %w", err)
	}
	return nil
}

// KernelExecClient checks the unprivileged post-exec filter in the real child.
func KernelExecClient() error {
	if err := CheckFilteredDescriptors(false); err != nil {
		return err
	}
	return nil
}

func RunOwnedCleanupRefusal() (result error) {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("life_cleanup: refusal fixture requires root in GitHub Actions")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(executable, "--owned-cleanup-child")
	cmd.Env = []string{"GITHUB_ACTIONS=true", "LANG=C", "LC_ALL=C"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
	gate, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("life_cleanup: gate: %w", err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("life_cleanup: stdout: %w", errors.Join(err, gate.Close()))
	}
	if err = cmd.Start(); err != nil {
		return fmt.Errorf("life_cleanup: start: %w", errors.Join(err, gate.Close()))
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	start, startErr := procStartTicks(cmd.Process.Pid)
	owned := true
	consumed := false
	var stages []error
	defer func() {
		if !owned {
			return
		}
		if closeErr := gate.Close(); closeErr != nil {
			stages = append(stages, fmt.Errorf("life_cleanup: close gate: %w", closeErr))
		}
		select {
		case waitErr := <-done:
			owned = false
			consumed = true
			if waitErr != nil {
				stages = append(stages, errors.New("life_cleanup: child cleanup failed"))
			}
		case <-ctx.Done():
			stages = append(stages, errors.New("life_cleanup: child cleanup timed out"))
		}
		result = errors.Join(result, errors.Join(stages...))
	}()
	if startErr != nil {
		return fmt.Errorf("life_cleanup: start ticks: %w", startErr)
	}
	ready := make(chan error, 1)
	go func() {
		marker := make([]byte, len("OWNED_CLEANUP_READY\n"))
		_, readErr := io.ReadFull(out, marker)
		if readErr == nil && string(marker) != "OWNED_CLEANUP_READY\n" {
			readErr = errors.New("marker mismatch")
		}
		ready <- readErr
	}()
	select {
	case err = <-ready:
		if err != nil {
			return errors.New("life_cleanup: child readiness failed")
		}
	case err = <-done:
		owned = false
		consumed = true
		if err != nil {
			return errors.New("life_cleanup: child exited before readiness")
		}
		return errors.New("life_cleanup: child exited before readiness")
	case <-ctx.Done():
		return errors.New("life_cleanup: readiness timed out")
	}
	consumed, cleanupErr := terminateOwnedCmd(cmd, start, done, ctx, "life_kill_holder", "life_holder_wait")
	if consumed {
		owned = false
	}
	if !errors.Is(cleanupErr, syscall.EPERM) || consumed || ctx.Err() != nil {
		return errors.New("life_cleanup: expected live-child EPERM refusal")
	}
	current, err := procStartTicks(cmd.Process.Pid)
	if err != nil || current != start || holderStillAlive(cmd) != nil {
		return errors.New("life_cleanup: refused cleanup did not preserve child")
	}
	if err = gate.Close(); err != nil {
		return fmt.Errorf("life_cleanup: close gate failed: %w", err)
	}
	select {
	case err = <-done:
		owned = false
		consumed = true
		if err != nil || ctx.Err() != nil {
			return errors.New("life_cleanup: child did not exit cleanly")
		}
	case <-ctx.Done():
		return errors.New("life_cleanup: child exit timed out")
	}
	if err = cmd.Process.Kill(); !errors.Is(err, os.ErrProcessDone) {
		return errors.New("life_cleanup: reaped process kill did not report done")
	}
	return nil
}

func OwnedCleanupChild() error {
	if os.Getuid() != 65534 || os.Geteuid() != 65534 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("life_cleanup: child identity gate failed")
	}
	if _, err := io.WriteString(os.Stdout, "OWNED_CLEANUP_READY\n"); err != nil {
		return errors.New("life_cleanup: ready marker write failed")
	}
	var one [1]byte
	_, err := io.ReadFull(os.Stdin, one[:])
	if errors.Is(err, io.EOF) {
		return nil
	}
	return errors.New("life_cleanup: gate did not close with EOF")
}
