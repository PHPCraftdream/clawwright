//go:build linux && amd64

package regression

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	kernelSocket = "/run/task245-metadata.sock"
	kernelAuth = "/run/task245-services/metadata.auth"
	kernelOwner = "/var/lib/ssjack/synthetic/native-cancel-owner"
	kernelACK = "/var/lib/ssjack/synthetic/cancel-ack"
)

type kernelIdentity struct {
	pid   int
	start uint64
}

// RunNotifierPreflight runs a single notifier case against a prepared lab.
func RunNotifierPreflight(active bool) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("kernel regression driver requires root in GitHub Actions")
	}
	timeout := 15 * time.Second
	if active {
		timeout = 35 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return runCase(ctx, active)
}

func runCase(parent context.Context, active bool) error {
	return runCasePhase(parent, active, "")
}

// runFaultCase uses the protected metadata artifact as the daemon and requests
// only one of the finite ACK regression fault phases.
func runFaultCase(parent context.Context, phase string) error {
	if phase != "write" && phase != "fsync" && phase != "close" {
		return fmt.Errorf("unsupported kernel fault phase %q", phase)
	}
	return runCasePhase(parent, false, phase)
}

func runCasePhase(parent context.Context, active bool, phase string) error {
	return runCasePhaseKind(parent, active, phase, "")
}

func runRefusalCase(parent context.Context, kind string) error {
	if kind != "badreceipt" && kind != "wrongfault" && kind != "receiptfifo" {
		return fmt.Errorf("unsupported kernel refusal kind %q", kind)
	}
	return runCasePhaseKind(parent, false, "", kind)
}

func runCasePhaseKind(parent context.Context, active bool, phase, refusal string) error {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	mode := "inactive"
	if active {
		mode = "active"
	}
	if err := removeKernelFiles(); err != nil {
		return err
	}
	if err := resetRefusalTargets(); err != nil {
		return err
	}
	if err := requireACKAbsent(kernelACK); err != nil {
		return err
	}
	if refusal == "receiptfifo" {
		defer removeFIFOReceipt()
	}
	defer removeKernelFiles()
	withheldScenario := !active && phase == "" && refusal == ""
	if withheldScenario {
		if err := os.WriteFile("/lab/scenario", []byte("wrong-holder"), 0444); err != nil {
			return err
		}
		if err := os.Chmod("/lab/scenario", 0444); err != nil {
			return err
		}
		defer func() {
			_ = os.WriteFile("/lab/scenario", []byte("cancel"), 0444)
			_ = os.Chmod("/lab/scenario", 0444)
		}()
	}

	daemonArgs := []string{"--disposable-lab"}
	if phase != "" {
		daemonArgs = []string{"--owning-regression-daemon-" + phase}
	}
	if refusal == "receiptfifo" {
		daemonArgs = []string{"--owning-regression-daemon-lifetime"}
	}
	daemon := exec.CommandContext(ctx, "/lab/bin/native-metadata", daemonArgs...)
	daemon.Env = append(os.Environ(), "PATH=/lab/bin", "LANG=C", "LC_ALL=C")
	if err := daemon.Start(); err != nil {
		return fmt.Errorf("start daemon: %w", err)
	}
	daemonDone := make(chan error, 1)
	go func() { daemonDone <- daemon.Wait() }()
	daemonOwned := true
	defer func() {
		if daemonOwned {
			if daemon.Process != nil {
				_ = daemon.Process.Kill()
			}
			<-daemonDone
		}
	}()

	artifact, err := os.Stat("/lab/bin/native-metadata")
	if err != nil {
		return err
	}
	artifactStat, ok := artifact.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("native metadata artifact has no stat identity")
	}
	artifactHash, err := hashFile("/lab/bin/native-metadata")
	if err != nil {
		return err
	}
	var socketStat syscall.Stat_t
	start, err := procStartTicks(daemon.Process.Pid)
	if err != nil { return err }
	readyCtx, readyCancel := context.WithTimeout(ctx, 2*time.Second)
	err = waitOwnedProofSocket(readyCtx, daemon.Process.Pid, start, daemonDone, &daemonOwned, &socketStat)
	readyCancel()
	if err != nil {
		return err
	}
	if socketStat.Uid != 0 || socketStat.Mode&07777 != 0666 { return errors.New("daemon socket has wrong owner or mode") }
	if err = publishKernelProof(daemon.Process.Pid, start, artifactStat, artifactHash, &socketStat); err != nil {
		return err
	}

	childMode := "kernel-" + mode
	childArg := "cancel"
	if withheldScenario {
		childArg = "withheld"
	}
	if phase != "" {
		childMode = "kernel-fault-" + phase
	}
	child := exec.CommandContext(ctx, "/lab/control-profile", childMode, childArg)
	if refusal != "" {
		childMode = "kernel-refusal-" + refusal
		child = exec.CommandContext(ctx, "/lab/control-profile", childMode, "cancel")
	}
	child.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
	child.Env = []string{
		"SSJACK_ENV_TOKEN=fixture-bootstrap-token",
		"SSJACK_SESSION=fixture-session",
		"SSJACK_ENDPOINT=https://127.0.0.1:1",
		"SSJACK_CERTIFICATE_SHA256=" + strings.Repeat("0", 64),
		"PATH=/lab/bin", "LANG=C", "LC_ALL=C",
	}
	gate, err := child.StdinPipe()
	if err != nil {
		return err
	}
	var childStdout io.ReadCloser
	childStdout, err = child.StdoutPipe()
	if err != nil {
		_ = gate.Close()
		return err
	}
	child.Stderr = &diagnosticFilter{out: os.Stderr}
	if err = child.Start(); err != nil {
		_ = gate.Close()
		return fmt.Errorf("start harness: %w", err)
	}
	childDone := make(chan error, 1)
	go func() {
		childDone <- child.Wait()
	}()
	childOwned := true
	defer func() {
		if childOwned {
			if child.Process != nil {
				_ = child.Process.Kill()
			}
			<-childDone
		}
	}()
	childStart, err := procStartTicks(child.Process.Pid)
	if err != nil {
		return err
	}
	owner := fmt.Sprintf("%d %d %d\n", child.Process.Pid, childStart, os.Getpid())
	if err = writeKernelOwner(owner); err != nil {
		_ = gate.Close()
		return err
	}
	if _, err = gate.Write([]byte{1}); err != nil {
		_ = gate.Close()
		return fmt.Errorf("write harness gate: %w", err)
	}
	var ackDone chan error
	if active {
		ackDone = make(chan error, 1)
		go func() { ackDone <- observeKernelACK(ctx) }()
	}
	if refusal != "" {
		err = runRefusalChild(ctx, childStdout, gate, child.Process.Pid, childStart, daemon.Process.Pid, start, refusal)
		if err != nil {
			return err
		}
	} else if err = runRootIdentityWitnesses(ctx, childStdout, gate, child.Process.Pid, childStart); err != nil {
		return err
	}
	select {
	case childErr := <-childDone:
		childOwned = false
		if childErr != nil {
			return fmt.Errorf("harness: %w", childErr)
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if active {
		select {
		case ackErr := <-ackDone:
			if ackErr != nil {
				return ackErr
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if phase != "" {
		if _, err := os.Lstat(kernelACK); !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("fault acknowledgement remains: %v", err)
		}
	}
	select {
	case daemonErr := <-daemonDone:
		daemonOwned = false
		if daemonErr != nil {
			return fmt.Errorf("daemon: %w", daemonErr)
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func runRootIdentityWitnesses(ctx context.Context, stdout io.ReadCloser, gate io.WriteCloser, childPID int, childStart uint64) (retErr error) {
	defer func() {
		if retErr != nil {
			_ = stdout.Close()
			_ = gate.Close()
		}
	}()

	reader := bufio.NewReader(stdout)
	type lineResult struct {
		line string
		err  error
	}
	readLine := func() (string, error) {
		result := make(chan lineResult, 1)
		go func() {
			line, err := reader.ReadSlice('\n')
			if len(line) > 64 {
					err = errors.New("identity witness line exceeds 64 bytes")
			}
			result <- lineResult{line: string(line), err: err}
		}()
		select {
		case got := <-result:
			return got.line, got.err
		case <-ctx.Done():
			_ = stdout.Close()
			return "", ctx.Err()
		}
	}
	readWitness := func(want string) (int, error) {
		line, err := readLine()
		if err != nil {
			return 0, err
		}
		line = strings.TrimSuffix(line, "\n")
		fields := strings.Split(line, " ")
		if len(fields) != 2 || fields[0] != want {
			return 0, fmt.Errorf("invalid %s identity witness %q", want, line)
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil || pid <= 1 || strconv.Itoa(pid) != fields[1] {
			return 0, fmt.Errorf("invalid %s identity witness PID %q", want, fields[1])
		}
		return pid, nil
	}

	if err := verifyProcessIdentity(childPID, childStart); err != nil {
		return err
	}
	harness, err := os.Stat("/lab/bin/harness")
	if err != nil {
		return err
	}
	harnessStat, ok := harness.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("harness has no stat identity")
	}
	pid, err := readWitness("I")
	if err != nil {
		return err
	}
	if pid == childPID {
		return errors.New("same-image witness reused registered PID")
	}
	registeredHarness, err := os.Stat(fmt.Sprintf("/proc/%d/exe", childPID))
	if err != nil {
		return err
	}
	registeredStat, ok := registeredHarness.Sys().(*syscall.Stat_t)
	if !ok || registeredStat.Dev != harnessStat.Dev || registeredStat.Ino != harnessStat.Ino {
		return errors.New("registered process executable does not match harness")
	}
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return err
	}
	var tgid int
	foundTGID := false
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "Tgid:") {
			fields := strings.Fields(line)
			if len(fields) != 2 {
				return errors.New("malformed process Tgid")
			}
			tgid, err = strconv.Atoi(fields[1])
			if err != nil {
				return fmt.Errorf("parse process Tgid: %w", err)
			}
			foundTGID = true
			break
		}
	}
	if !foundTGID || tgid != pid {
		return errors.New("same-image witness is not a process leader")
	}
	var image syscall.Stat_t
	if err = syscall.Stat(fmt.Sprintf("/proc/%d/exe", pid), &image); err != nil {
		return err
	}
	if image.Dev != harnessStat.Dev || image.Ino != harnessStat.Ino {
		return errors.New("same-image witness executable mismatch")
	}
	if err = verifyProcessIdentity(childPID, childStart); err != nil {
		return err
	}
	if _, err = gate.Write([]byte{'I'}); err != nil {
		return err
	}

	pid, err = readWitness("E")
	if err != nil {
		return err
	}
	if pid != childPID {
		return errors.New("same-pid exec witness PID mismatch")
	}
	if err = verifyProcessIdentity(childPID, childStart); err != nil {
		return err
	}
	metadata, err := os.Stat(clientMetadataExe)
	if err != nil {
		return err
	}
	metadataStat, ok := metadata.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("metadata executable has no stat identity")
	}
	if err = syscall.Stat(fmt.Sprintf("/proc/%d/exe", pid), &image); err != nil {
		return err
	}
	if image.Dev != metadataStat.Dev || image.Ino != metadataStat.Ino || (image.Dev == harnessStat.Dev && image.Ino == harnessStat.Ino) {
		return errors.New("same-pid exec witness executable mismatch")
	}
	if _, err = gate.Write([]byte{'E'}); err != nil {
		return err
	}
	return gate.Close()
}

func runRefusalChild(ctx context.Context, stdout io.ReadCloser, gate io.WriteCloser, childPID int, childStart uint64, daemonPID int, daemonStart uint64, kind string) (retErr error) {
	defer func() {
		if retErr != nil {
			_ = stdout.Close()
		}
	}()
	readByte := func(want byte) error {
		result := make(chan error, 1)
		go func() {
			b := []byte{0}
			_, err := io.ReadFull(stdout, b)
			if err == nil && b[0] != want {
				err = fmt.Errorf("refusal signal: got %q, want %q", b[0], want)
			}
			result <- err
		}()
		select {
		case err := <-result:
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := readByte('S'); err != nil {
		return fmt.Errorf("wait for client receipt readiness: %w", err)
	}
	var err error
	if kind == "receiptfifo" {
		if err := replaceReceiptWithFIFO(); err != nil {
			return err
		}
	} else {
		path := clientReceiptPath
		data := []byte{'X'}
		if kind == "wrongfault" {
			path = "/var/lib/ssjack/synthetic/native-fault-reached"
			data = []byte("wrong!")
		}
		f, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
		if err != nil { return fmt.Errorf("open refusal target: %w", err) }
		n, writeErr := f.WriteAt(data, 0)
		if writeErr == nil && n != len(data) { writeErr = io.ErrShortWrite }
		closeErr := f.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if _, err = gate.Write([]byte{'W'}); err != nil {
		return fmt.Errorf("write refusal mutation gate: %w", err)
	}
	if err = readByte('D'); err != nil {
		return fmt.Errorf("wait for client refusal: %w", err)
	}
	if err = verifyProcessIdentity(daemonPID, daemonStart); err != nil { return err }
	if err = verifyProcessIdentity(childPID, childStart); err != nil {
		return fmt.Errorf("refusing child is not alive: %w", err)
	}
	if _, err = os.Lstat(kernelACK); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("refusal acknowledgement exists: %v", err)
	}
	if _, err = gate.Write([]byte{'X'}); err != nil {
		return fmt.Errorf("write refusal completion gate: %w", err)
	}
	_ = gate.Close()
	return nil
}

func resetRefusalTargets() error {
	if err := os.MkdirAll(filepath.Dir(clientReceiptPath), 0755); err != nil {
		return err
	}
	flags := os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW
	f, err := os.OpenFile(clientReceiptPath, flags, 0600)
	if err != nil {
		return err
	}
	n, writeErr := f.Write(bytes.Repeat([]byte{0x5a}, 48))
	if writeErr == nil && n != 48 { writeErr = io.ErrShortWrite }
	if writeErr == nil {
		writeErr = f.Chown(65534, 65534)
	}
	closeErr := f.Close()
	if writeErr != nil { return writeErr }
	if closeErr != nil { return closeErr }
	if err = os.Chmod(clientReceiptPath, 0600); err != nil {
		return err
	}
	faultPath := "/var/lib/ssjack/synthetic/native-fault-reached"
	f, err = os.OpenFile(faultPath, flags, 0600)
	if err != nil {
		return err
	}
	n, writeErr = f.Write([]byte("cancel"))
	if writeErr == nil && n != 6 { writeErr = io.ErrShortWrite }
	if writeErr == nil {
		writeErr = f.Chown(65534, 65534)
	}
	closeErr = f.Close()
	if writeErr != nil { return writeErr }
	if closeErr != nil { return closeErr }
	return os.Chmod(faultPath, 0600)
}

func verifyProcessIdentity(pid int, start uint64) error {
	current, err := procStartTicks(pid)
	if err != nil {
		return err
	}
	if current != start {
		return fmt.Errorf("process %d identity changed", pid)
	}
	return nil
}

func verifyDaemonListener(pid int, socketPath string) error {
	const tableLimit = 1 << 20
	data, err := os.ReadFile("/proc/net/unix")
	if err != nil { return fmt.Errorf("read unix listener table: %w", err) }
	if len(data) > tableLimit { return errors.New("unix listener table exceeds limit") }
	var inode string
	matches := 0
	for _, line := range bytes.Split(data, []byte{'\n'})[1:] {
		fields := bytes.Fields(line)
		if len(fields) >= 8 && bytes.Equal(fields[3], []byte("00010000")) && bytes.Equal(fields[4], []byte("0005")) && bytes.Equal(fields[7], []byte(socketPath)) {
			inode = string(fields[6]); matches++
		}
	}
	if matches != 1 { return errors.New("expected exactly one listening SOCK_SEQPACKET unix socket") }
	entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil { return fmt.Errorf("read daemon fds: %w", err) }
	if len(entries) > 4096 { return errors.New("daemon fd count exceeds limit") }
	target := "socket:[" + inode + "]"
	for _, entry := range entries {
		fdPath := fmt.Sprintf("/proc/%d/fd/%s", pid, entry.Name())
		link, err := os.Readlink(fdPath)
		if err != nil { return fmt.Errorf("read daemon fd link: %w", err) }
		if link != target { continue }
		var st syscall.Stat_t
		if err := syscall.Stat(fdPath, &st); err != nil { return fmt.Errorf("stat daemon socket fd: %w", err) }
		if st.Mode&syscall.S_IFMT == syscall.S_IFSOCK { return nil }
	}
	return errors.New("daemon does not own the listening socket")
}

func publishKernelProof(pid int, start uint64, artifact *syscall.Stat_t, hash string, socket *syscall.Stat_t) error {
	var protected syscall.Stat_t
	if err := syscall.Stat(fmt.Sprintf("/proc/%d/exe", pid), &protected); err != nil {
		return fmt.Errorf("stat daemon executable: %w", err)
	}
	if protected.Dev != artifact.Dev || protected.Ino != artifact.Ino {
		return errors.New("daemon executable does not match protected artifact")
	}
	if artifact.Uid != 0 || artifact.Nlink != 1 || artifact.Mode&07777 != 0555 {
		return errors.New("protected artifact has wrong owner, link count, or mode")
	}
	currentStart, err := procStartTicks(pid)
	if err != nil {
		return err
	}
	if currentStart != start { return errors.New("daemon process identity changed") }
	var currentSocket syscall.Stat_t
	if err = syscall.Lstat(kernelSocket, &currentSocket); err != nil { return err }
	if currentSocket.Dev != socket.Dev || currentSocket.Ino != socket.Ino || currentSocket.Uid != 0 || currentSocket.Mode&07777 != 0666 || currentSocket.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
		return errors.New("daemon socket identity or permissions changed")
	}
	if err := verifyDaemonListener(pid, kernelSocket); err != nil { return err }
	if err := os.MkdirAll(filepath.Dir(kernelAuth), 0755); err != nil { return err }
	if err := os.Chmod(filepath.Dir(kernelAuth), 0755); err != nil { return err }
	record := fmt.Sprintf("OCLABAUTH1 %d %d %d %d %d %d %s\n", pid, start, uint64(artifact.Dev), artifact.Ino, uint64(socket.Dev), socket.Ino, hash)
	f, err := os.OpenFile(kernelAuth, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0444)
	if err != nil {
		return err
	}
	_, writeErr := io.WriteString(f, record)
	closeErr := f.Close()
	if writeErr != nil { _ = os.Remove(kernelAuth); return writeErr }
	if closeErr != nil { _ = os.Remove(kernelAuth); return closeErr }
	if err = os.Chown(kernelAuth, 0, 0); err != nil { return err }
	return os.Chmod(kernelAuth, 0444)
}

func writeKernelOwner(record string) error {
	f, err := os.OpenFile(kernelOwner, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := io.WriteString(f, record)
	if writeErr == nil {
		writeErr = f.Chown(65534, 65534)
	}
	closeErr := f.Close()
	if writeErr != nil { _ = os.Remove(kernelOwner); return writeErr }
	if closeErr != nil { _ = os.Remove(kernelOwner); return closeErr }
	if err = os.Chmod(kernelOwner, 0600); err != nil { return err }
	return nil
}

func removeKernelFiles() error {
	for _, path := range []string{kernelAuth, kernelSocket, kernelOwner, kernelACK} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) { return err }
	}
	return nil
}

func procStartTicks(pid int) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil { return 0, err }
	if len(data) > 4096 { return 0, errors.New("proc stat exceeds limit") }
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 { return 0, errors.New("malformed proc stat") }
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) <= 19 { return 0, errors.New("short proc stat") }
	return strconv.ParseUint(fields[19], 10, 64)
}


func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil { return "", err }
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil { return "", err }
	return hex.EncodeToString(h.Sum(nil)), nil
}
