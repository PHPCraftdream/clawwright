//go:build linux && amd64

package regression

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type diagnosticFilter struct {
	out      io.Writer
	line     []byte
	dropping bool
}

func (w *diagnosticFilter) Write(p []byte) (int, error) {
	for _, b := range p {
		if w.dropping {
			if b == '\n' {
				w.dropping = false
				w.line = w.line[:0]
			}
			continue
		}
		if b != '\n' {
			if len(w.line) >= 256 {
				w.line = w.line[:0]
				w.dropping = true
				continue
			}
			w.line = append(w.line, b)
			continue
		}
		w.acceptLine()
	}
	return len(p), nil
}

func (w *diagnosticFilter) acceptLine() {
	line := string(w.line)
	w.line = w.line[:0]
	fields := strings.Split(line, " ")
	valid := false
	if len(fields) == 3 && fields[0] == "metadata-regression:" && strings.HasPrefix(fields[1], "stage=") {
		stage := strings.TrimPrefix(fields[1], "stage=")
		valid = diagnosticStage(stage) == stage && (fields[2] == "event=start" || fields[2] == "event=done")
	} else if len(fields) == 6 && fields[0] == "metadata-regression:" && strings.HasPrefix(fields[1], "stage=") {
		stage := strings.TrimPrefix(fields[1], "stage=")
		valid = diagnosticStage(stage) == stage && (fields[2] == "class=error" || fields[2] == "class=deadline" || fields[2] == "class=canceled")
		limits := []int{4095, 255, 64}
		for i, key := range []string{"errno=", "exit=", "signal="} {
			field := fields[i+3]
			if !strings.HasPrefix(field, key) {
				valid = false
				continue
			}
			value := strings.TrimPrefix(field, key)
			n, err := strconv.Atoi(value)
			min := 0
			if i == 1 {
				min = -1
			}
			if err != nil || n < min || n > limits[i] || strconv.Itoa(n) != value {
				valid = false
			}
		}
	}
	if valid {
		_, _ = io.WriteString(w.out, line+"\n")
	}
}

func RunKernelSuite() error {
	return runKernelSuite(false)
}

// RunConfinementSuite exercises the real Go-to-Rust control path via the fixed probe.
func RunConfinementSuite() error {
	return runKernelSuite(true)
}

func runKernelSuite(stageConfinement bool) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("kernel suite requires root in GitHub Actions")
	}
	if _, err := os.Lstat("/lab"); err == nil {
		return errors.New("kernel suite prerequisite: /lab must be absent")
	} else if !errors.Is(err, syscall.ENOENT) {
		return err
	}
	if err := os.Mkdir("/lab", 0755); err != nil {
		return err
	}
	if err := os.Chmod("/lab", 0755); err != nil {
		return err
	}
	if err := os.Mkdir("/lab/bin", 0755); err != nil {
		return err
	}
	if err := os.Chmod("/lab/bin", 0755); err != nil {
		return err
	}
	artifacts := [][2]string{{"/input/control-profile", "/lab/control-profile"}, {"/input/control-installer", "/lab/bin/control-installer"}, {"/input/native-metadata", "/lab/bin/native-metadata"}, {"/input/metadata-regression", "/lab/bin/harness"}, {"/input/control-profile", "/lab/harness"}, {"/input/metadata-regression", "/lab/ssjack"}, {"/input/metadata-regression", "/lab/bin/metadata-child"}}
	if stageConfinement {
		artifacts = [][2]string{{"/input/control-profile", "/lab/control-profile"}, {"/input/control-installer", "/lab/bin/control-installer"}, {"/input/native-metadata", "/lab/bin/native-metadata"}, {"/input/probe", "/lab/bin/harness"}}
	}
	for _, a := range artifacts {
		if err := stageKernelBinary(a[0], a[1]); err != nil {
			return err
		}
	}
	if stageConfinement {
		if err := syscall.Mount("/lab/bin", "/lab/bin", "", syscall.MS_BIND, ""); err != nil {
			return err
		}
		if err := syscall.Mount("", "/lab/bin", "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/lab/control-profile", "fixture-ref", "golden")
		cmd.Env = []string{"SSJACK_ENV_TOKEN=fixture-bootstrap-token", "SSJACK_SESSION=fixture-session", "SSJACK_ENDPOINT=https://127.0.0.1:1", "SSJACK_CERTIFICATE_SHA256=" + strings.Repeat("0", 64), "PATH=/lab/bin", "LANG=C", "LC_ALL=C"}
		cmd.Dir = "/lab"
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return errors.New("run golden confinement probe failed")
		}
		if stderr.Len() != 0 {
			return errors.New("golden confinement probe wrote to stderr")
		}
		if !bytes.Equal(out, []byte("CONTROL_CONFINEMENT_OK\n")) {
			return errors.New("unexpected golden confinement output")
		}
		return nil
	}
	if err := os.Chmod("/lab/ssjack", 0755); err != nil {
		return err
	}
	for p, content := range map[string][]byte{"/lab/disposable-profile": []byte("task249 component\n"), "/lab/scenario": []byte("cancel")} {
		if err := os.WriteFile(p, content, 0444); err != nil {
			return err
		}
		if err := os.Chmod(p, 0444); err != nil {
			return err
		}
	}
	for _, p := range []string{"/var/lib/ssjack", "/var/lib/ssjack/synthetic"} {
		if err := os.MkdirAll(p, 0755); err != nil {
			return err
		}
		if err := os.Chmod(p, 0755); err != nil {
			return err
		}
		if err := os.Chown(p, 0, 0); err != nil {
			return err
		}
	}
	if err := os.Chown("/var/lib/ssjack/synthetic", 65534, 65534); err != nil {
		return err
	}
	if err := os.Chmod("/var/lib/ssjack/synthetic", 0700); err != nil {
		return err
	}
	state := "/var/lib/ssjack/synthetic/state.json"
	if err := os.WriteFile(state, []byte("{}"), 0600); err != nil {
		return err
	}
	if err := os.Chown(state, 65534, 65534); err != nil {
		return err
	}
	receipt := "/var/lib/ssjack/synthetic/consumer-receipt"
	if err := os.WriteFile(receipt, bytes.Repeat([]byte{0x5a}, 48), 0600); err != nil {
		return err
	}
	if err := os.Chown(receipt, 65534, 65534); err != nil {
		return err
	}
	fault := "/var/lib/ssjack/synthetic/native-fault-reached"
	if err := os.WriteFile(fault, []byte("cancel"), 0600); err != nil {
		return err
	}
	if err := os.Chown(fault, 65534, 65534); err != nil {
		return err
	}
	if err := os.Chmod(fault, 0600); err != nil {
		return err
	}
	if err := syscall.Mount("/lab/bin", "/lab/bin", "", syscall.MS_BIND, ""); err != nil {
		return err
	}
	if err := syscall.Mount("", "/lab/bin", "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil {
		return err
	}
	ReportStage("suite_ack")
	if err := RunACKRegression(); err != nil {
		ReportFailure("suite_ack", err)
		return err
	}
	ReportDone("suite_ack")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/lab/ssjack", "--kernel-driver")
	cmd.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	cmd.Stderr = &diagnosticFilter{out: os.Stderr}
	ReportStage("suite_driver")
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), err)
		}
		return fmt.Errorf("run kernel driver: %w", err)
	}
	ReportDone("suite_driver")
	return nil
}

func stageKernelBinary(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open kernel artifact %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(dst)
		return closeErr
	}
	if err := os.Chmod(dst, 0555); err != nil {
		return err
	}
	return os.Chown(dst, 0, 0)
}

func ProofReadinessChild() error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("proof readiness child requires root in GitHub Actions")
	}
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrUnix{Name: kernelSocket}); err != nil {
		return err
	}
	if err := os.Chmod(kernelSocket, 0666); err != nil {
		return err
	}
	if _, err := io.WriteString(os.Stdout, "BOUND\n"); err != nil {
		return err
	}
	gate := make([]byte, 1)
	if _, err := io.ReadFull(os.Stdin, gate); err != nil {
		return err
	}
	switch gate[0] {
	case 'D':
		return nil
	case 'L':
		if err := syscall.Listen(fd, 4); err != nil {
			return err
		}
		if _, err := io.WriteString(os.Stdout, "LISTENING\n"); err != nil {
			return err
		}
		_, err := io.ReadFull(os.Stdin, gate)
		if errors.Is(err, io.EOF) {
			return nil
		}
		return errors.New("expected stdin EOF after listener gate")
	default:
		return errors.New("unknown proof readiness gate")
	}
}

func RunProofReadinessRegression(parent context.Context) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("proof readiness regression requires root in GitHub Actions")
	}
	for _, death := range []bool{false, true} {
		if err := runProofReadinessCase(parent, death); err != nil {
			return err
		}
	}
	return nil
}

func runProofReadinessCase(parent context.Context, death bool) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	if err := removeKernelFiles(); err != nil {
		return err
	}
	defer func() { retErr = errors.Join(retErr, removeKernelFiles()) }()
	exe := clientMetadataExe
	artifact, err := os.Lstat(exe)
	if err != nil {
		return err
	}
	artifactStat, ok := artifact.Sys().(*syscall.Stat_t)
	if !ok || !artifact.Mode().IsRegular() || artifactStat.Nlink != 1 || artifact.Mode().Perm() != 0555 || artifactStat.Uid != 0 {
		return errors.New("proof readiness artifact must be root-owned regular single-link mode 0555")
	}
	hash, err := hashFile(exe)
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--proof-readiness-child")
	cmd.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	reaped := make(chan struct{})
	go func() {
		done <- cmd.Wait()
		close(reaped)
	}()
	owned := true
	var start uint64
	defer func() {
		_ = stdin.Close()
		_ = stdout.Close()
		if owned {
			consumed, cleanupErr := terminateOwnedCmd(cmd, start, done, ctx, "life_kill_daemon", "life_daemon_wait")
			if consumed {
				owned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
	}()
	if start, err = procStartTicks(cmd.Process.Pid); err != nil {
		return err
	}
	readLine := func(want string) error {
		type lineResult struct {
			line []byte
			err  error
		}
		result := make(chan lineResult, 1)
		go func() {
			b := make([]byte, len(want))
			_, err := io.ReadFull(stdout, b)
			result <- lineResult{line: b, err: err}
		}()
		select {
		case r := <-result:
			if r.err != nil {
				return r.err
			}
			if string(r.line) != want {
				return fmt.Errorf("unexpected child marker %q", r.line)
			}
			return nil
		case err := <-done:
			owned = false
			return fmt.Errorf("child exited before marker: %v", err)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := readLine("BOUND\n"); err != nil {
		return err
	}
	var socket syscall.Stat_t
	boundObserved := false
	ready, readyErr := ownedProofSocketReady(cmd.Process.Pid, start, &socket)
	if ready || readyErr != nil || socket.Ino == 0 {
		return errors.New("bound-only child was accepted as ready")
	}
	wrongProcessStart, err := procStartTicks(os.Getpid())
	if err != nil {
		return err
	}
	if _, err := ownedProofSocketReady(os.Getpid(), wrongProcessStart, &socket); err == nil {
		return errors.New("wrong process identity was accepted")
	}
	wrongSocket := socket
	wrongSocket.Ino++
	if _, err := ownedProofSocketReady(cmd.Process.Pid, start, &wrongSocket); err == nil {
		return errors.New("wrong socket identity was accepted")
	}
	if err := publishKernelProof(cmd.Process.Pid, start, artifactStat, hash, &socket); err == nil {
		return errors.New("bound-only proof was published")
	}
	if _, err := os.Lstat(kernelAuth); !errors.Is(err, os.ErrNotExist) {
		return errors.New("bound-only authorization record exists")
	}
	if death {
		if _, err := stdin.Write([]byte{'D'}); err != nil {
			return err
		}
		select {
		case <-reaped:
		case <-ctx.Done():
			return ctx.Err()
		}
		if cmd.ProcessState == nil || !cmd.ProcessState.Success() {
			return errors.New("death fixture did not exit cleanly")
		}
		if err := waitOwnedProofSocket(ctx, cmd.Process.Pid, start, done, &owned, &socket); err == nil || owned {
			return errors.New("exited bound-only child remained owned or ready")
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := os.Lstat(kernelAuth); !errors.Is(err, os.ErrNotExist) {
			return errors.New("death fixture authorization record exists")
		}
		return nil
	}
	boundSocket := socket
	if err := waitOwnedProofSocket(ctx, cmd.Process.Pid, start, done, &owned, &socket, func(ready bool) error {
		if !boundObserved {
			if ready {
				return errors.New("bound-only child was accepted as ready before listener gate")
			}
			if socket.Ino == 0 || socket.Dev != boundSocket.Dev || socket.Ino != boundSocket.Ino {
				return errors.New("bound socket identity was not pinned")
			}
			if _, err := os.Lstat(kernelAuth); !errors.Is(err, os.ErrNotExist) {
				return errors.New("bound-only authorization record exists")
			}
			boundObserved = true
			if _, err := stdin.Write([]byte{'L'}); err != nil {
				return err
			}
			return readLine("LISTENING\n")
		}
		return nil
	}); err != nil {
		return err
	}
	if !boundObserved {
		return errors.New("full wait skipped bound observation")
	}
	if socket.Ino == 0 {
		return errors.New("ready socket identity is missing")
	}
	if err := publishKernelProof(cmd.Process.Pid, start, artifactStat, hash, &socket); err != nil {
		return err
	}
	if _, err := os.Stat(kernelAuth); err != nil {
		return err
	}
	if err := stdin.Close(); err != nil {
		return err
	}
	select {
	case <-reaped:
	case <-ctx.Done():
		return ctx.Err()
	}
	childErr := <-done
	owned = false
	if childErr != nil {
		return childErr
	}
	return nil
}
