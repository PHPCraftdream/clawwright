//go:build linux && amd64

package regression

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const serviceAuth = "/run/task245-services/metadata.auth"

// RunServiceProofCases exercises the root fixture publisher and authenticated peer
// against a fresh native metadata daemon for each accepted/refused proof case.
func RunServiceProofCases(parent context.Context) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("service proof matrix requires root in GitHub Actions")
	}
	cases := []string{
		"good", "bad_pid", "bad_start", "bad_exe_inode", "bad_socket_inode",
		"malformed_hash", "malformed_record", "unprivileged_record",
		"unprivileged_socket", "wrong_service", "wrongcaller",
	}
	for _, name := range cases {
		if err := runServiceProofCase(parent, name); err != nil {
			return fmt.Errorf("service proof %s: %w", name, err)
		}
	}
	return nil
}

func runServiceProofCase(parent context.Context, name string) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	if err := removeKernelFiles(); err != nil {
		return err
	}
	defer removeKernelFiles()

	daemon := exec.CommandContext(ctx, "/lab/bin/native-metadata", "--disposable-lab")
	daemon.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	if err := daemon.Start(); err != nil {
		return fmt.Errorf("start actual metadata daemon: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- daemon.Wait() }()
	owned := true
	start, startErr := procStartTicks(daemon.Process.Pid)
	defer func() {
		if owned {
			consumed, cleanupErr := terminateOwnedCmd(daemon, start, done, ctx, "life_kill_daemon", "life_daemon_wait")
			if consumed {
				owned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
	}()
	if startErr != nil {
		return startErr
	}

	artifact, err := os.Stat("/lab/bin/native-metadata")
	if err != nil {
		return err
	}
	artifactStat, ok := artifact.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("metadata artifact stat unavailable")
	}
	hash, err := hashFile("/lab/bin/native-metadata")
	if err != nil {
		return err
	}
	var socket syscall.Stat_t
	if err := waitForProofSocket(ctx, done, &owned, &socket); err != nil {
		return err
	}
	if name == "wrong_service" {
		other, err := os.Stat("/lab/bin/metadata-child")
		if err != nil {
			return err
		}
		otherStat, ok := other.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("wrong-service artifact stat unavailable")
		}
		if err := publishKernelProof(daemon.Process.Pid, start, otherStat, hash, &socket); err == nil {
			return errors.New("wrong-service proof published")
		}
		if _, err := os.Lstat(kernelAuth); !errors.Is(err, os.ErrNotExist) {
			return errors.New("wrong-service record exists")
		}
		return nil
	}
	ReportStage("life_proof")
	if err := publishKernelProof(daemon.Process.Pid, start, artifactStat, hash, &socket); err != nil {
		ReportFailure("life_proof", err)
		return fmt.Errorf("publish actual daemon proof: %w", err)
	}
	ReportDone("life_proof")
	if name != "good" && name != "wrongcaller" {
		if err := mutateServiceProof(name); err != nil {
			return err
		}
	}

	clientPath := "/lab/bin/harness"
	if name == "wrongcaller" {
		clientPath = "/lab/bin/metadata-child"
	}
	client := exec.CommandContext(ctx, clientPath, "--service-peer-child")
	client.Env = []string{"GITHUB_ACTIONS=true", "PATH=/lab/bin", "LANG=C", "LC_ALL=C"}
	client.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{
		Uid: 65534, Gid: 65534, Groups: []uint32{},
	}}
	clientErr := client.Run()
	if name == "good" {
		if clientErr != nil {
			return fmt.Errorf("valid service peer refused: %w", clientErr)
		}
	} else if name != "wrongcaller" {
		if ctx.Err() != nil {
			return fmt.Errorf("client proof check interrupted: %w", ctx.Err())
		}
		if !exitCodeIs(clientErr, 1) {
			return fmt.Errorf("invalid service proof client error = %v, want exit code 1", clientErr)
		}
	}
	if name == "good" || name == "wrongcaller" {
		select {
		case daemonErr := <-done:
			owned = false
			if !exitCodeIs(daemonErr, 1) {
				return fmt.Errorf("daemon exit = %v, want exit code 1", daemonErr)
			}
		case <-ctx.Done():
			return errors.New("daemon did not reject service handoff before deadline")
		}
	}
	return nil
}

// RunDaemonLifetimeCases checks deadline expiry against three independently-owned
// instances of the real daemon, without using the caller's context as the oracle.
func RunDaemonLifetimeCases(parent context.Context) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("daemon lifetime matrix requires root in GitHub Actions")
	}
	for _, name := range []string{"no-client", "incomplete-handoff", "live-listener"} {
		code := map[string]string{"no-client": "life_no_client", "incomplete-handoff": "life_handoff", "live-listener": "life_listener"}[name]
		if err := runDiagnosticStage(code, func() error { return runDaemonLifetimeCase(parent, name) }); err != nil {
			return err
		}
	}
	return runDiagnosticStage("life_canceled", func() error { return RunCanceledNotificationCase(parent) })
}

// RunCanceledNotificationCase proves the real notifier's stale-event path after
// the filtered holder is killed while its first notification is outstanding.
func RunCanceledNotificationCase(parent context.Context) (retErr error) {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return errors.New("canceled notification case requires root in GitHub Actions")
	}

	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()

	if err := removeKernelFiles(); err != nil {
		return err
	}
	defer removeKernelFiles()

	artifact, err := os.Stat("/lab/bin/native-metadata")
	if err != nil {
		return err
	}
	artifactStat, ok := artifact.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("metadata artifact stat unavailable")
	}
	ReportStage("life_hash")
	hash, err := hashFile("/lab/bin/native-metadata")
	if err != nil {
		ReportFailure("life_hash", err)
		return err
	}
	ReportDone("life_hash")
	var stderr bytes.Buffer
	daemon := exec.CommandContext(ctx, "/lab/bin/native-metadata", "--owning-regression-daemon-canceled")
	daemon.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	daemon.Stderr = &stderr
	control, err := daemon.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := daemon.StdoutPipe()
	if err != nil {
		return err
	}
	if err := daemon.Start(); err != nil {
		return fmt.Errorf("start actual canceled daemon: %w", err)
	}
	daemonDone := make(chan error, 1)
	go func() {
		daemonDone <- daemon.Wait()
	}()
	daemonOwned := true
	daemonStart, startErr := procStartTicks(daemon.Process.Pid)
	defer func() {
		_ = control.Close()
		_ = stdout.Close()
		if daemonOwned {
			consumed, cleanupErr := terminateOwnedCmd(daemon, daemonStart, daemonDone, ctx, "life_kill_daemon", "life_daemon_wait")
			if consumed {
				daemonOwned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
	}()
	if startErr != nil {
		return startErr
	}
	var socket syscall.Stat_t
	if err := waitForProofSocket(ctx, daemonDone, &daemonOwned, &socket); err != nil {
		return err
	}
	start := daemonStart
	ReportStage("life_proof")
	if err := publishKernelProof(daemon.Process.Pid, start, artifactStat, hash, &socket); err != nil {
		ReportFailure("life_proof", err)
		return fmt.Errorf("publish actual daemon proof: %w", err)
	}
	ReportDone("life_proof")

	holder := exec.CommandContext(ctx, "/lab/control-profile", "kernel-lifetime", "cancel")
	holder.Env = []string{"GITHUB_ACTIONS=true", "PATH=/lab/bin", "LANG=C", "LC_ALL=C", "SSJACK_ENV_TOKEN=fixture-bootstrap-token", "SSJACK_SESSION=fixture-session", "SSJACK_ENDPOINT=https://127.0.0.1:1", "SSJACK_CERTIFICATE_SHA256=" + strings.Repeat("0", 64)}
	holder.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534, Groups: []uint32{}}}
	if err := holder.Start(); err != nil {
		return fmt.Errorf("start filtered holder: %w", err)
	}
	holderDone := make(chan error, 1)
	go func() {
		holderDone <- holder.Wait()
	}()
	holderOwned := true
	holderStart, startErr := procStartTicks(holder.Process.Pid)
	defer func() {
		if holderOwned {
			consumed, cleanupErr := terminateOwnedCmd(holder, holderStart, holderDone, ctx, "life_kill_holder", "life_holder_wait")
			if consumed {
				holderOwned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
	}()
	if startErr != nil {
		return startErr
	}

	marker := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(io.LimitReader(stdout, 64)).ReadString('\n')
		if err == nil && line != "CANCEL_PENDING\n" {
			err = fmt.Errorf("unexpected cancellation marker %q", line)
		}
		marker <- err
	}()
	select {
	case err := <-marker:
		if err != nil {
			return fmt.Errorf("daemon cancellation handoff: %w", err)
		}
	case err := <-daemonDone:
		daemonOwned = false
		return fmt.Errorf("daemon exited before cancellation marker: %v", err)
	case <-ctx.Done():
		return errors.New("cancellation marker deadline")
	}

	currentHolderStart, startErr := procStartTicks(holder.Process.Pid)
	if startErr != nil {
		return startErr
	}
	if currentHolderStart != holderStart {
		return fmt.Errorf("holder start ticks changed: got %d, want %d", currentHolderStart, holderStart)
	}
	ReportStage("life_kill_holder")
	if err := holder.Process.Kill(); err != nil {
		ReportFailure("life_kill_holder", err)
		return fmt.Errorf("kill filtered holder: %w", err)
	}
	ReportDone("life_kill_holder")
	var holderErr error
	select {
	case holderErr = <-holderDone:
	case <-ctx.Done():
		return fmt.Errorf("holder wait deadline: %w", ctx.Err())
	}
	holderOwned = false
	exit, ok := holderErr.(*exec.ExitError)
	if !ok {
		return fmt.Errorf("holder wait = %v, want SIGKILL", holderErr)
	}
	status, ok := exit.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		return fmt.Errorf("holder status = %v, want SIGKILL", exit.Sys())
	}
	if _, err := control.Write([]byte{'C'}); err != nil {
		return fmt.Errorf("release daemon cancellation gate: %w", err)
	}
	select {
	case daemonErr := <-daemonDone:
		daemonOwned = false
		if ctx.Err() != nil {
			return fmt.Errorf("outer context expired: %w", ctx.Err())
		}
		if daemonErr != nil {
			return fmt.Errorf("canceled daemon exit: %w", daemonErr)
		}
	case <-ctx.Done():
		return fmt.Errorf("canceled daemon deadline: %w", ctx.Err())
	}
	if stderr.Len() != 0 {
		return fmt.Errorf("canceled daemon stderr: %q", stderr.String())
	}
	if _, err := os.Lstat(kernelACK); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("unexpected cancellation ACK: %v", err)
	}
	if _, err := os.Lstat(kernelSocket); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("canceled daemon socket remains: %v", err)
	}
	return nil
}

func runDaemonLifetimeCase(parent context.Context, name string) (retErr error) {
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	if err := removeKernelFiles(); err != nil {
		return err
	}
	defer removeKernelFiles()

	artifact, err := os.Stat("/lab/bin/native-metadata")
	if err != nil {
		return err
	}
	artifactStat, ok := artifact.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("metadata artifact stat unavailable")
	}
	ReportStage("life_hash")
	hash, err := hashFile("/lab/bin/native-metadata")
	if err != nil {
		ReportFailure("life_hash", err)
		return err
	}
	ReportDone("life_hash")
	var stderr bytes.Buffer
	daemon := exec.CommandContext(ctx, "/lab/bin/native-metadata", "--owning-regression-daemon-lifetime")
	daemon.Env = append(os.Environ(), "GITHUB_ACTIONS=true")
	daemon.Stderr = &stderr
	ReportStage("life_start")
	if err := daemon.Start(); err != nil {
		ReportFailure("life_start", err)
		return fmt.Errorf("start actual lifetime daemon: %w", err)
	}
	ReportDone("life_start")
	done := make(chan error, 1)
	go func() { done <- daemon.Wait() }()
	daemonOwned := true
	daemonStart, startErr := procStartTicks(daemon.Process.Pid)
	defer func() {
		if daemonOwned {
			consumed, cleanupErr := terminateOwnedCmd(daemon, daemonStart, done, ctx, "life_kill_daemon", "life_daemon_wait")
			if consumed {
				daemonOwned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
	}()
	if startErr != nil {
		return startErr
	}

	var socket syscall.Stat_t
	ReportStage("life_socket")
	if err := waitForProofSocket(ctx, done, &daemonOwned, &socket); err != nil {
		ReportFailure("life_socket", err)
		return err
	}
	ReportDone("life_socket")
	ReportStage("life_proof")
	if err := publishKernelProof(daemon.Process.Pid, daemonStart, artifactStat, hash, &socket); err != nil {
		ReportFailure("life_proof", err)
		return fmt.Errorf("publish actual daemon proof: %w", err)
	}
	ReportDone("life_proof")

	var holder *exec.Cmd
	var holderDone chan error
	var holderStart uint64
	holderOwned := false
	var holderStdin io.WriteCloser
	defer func() {
		if holderOwned {
			consumed, cleanupErr := terminateOwnedCmd(holder, holderStart, holderDone, ctx, "life_kill_holder", "life_holder_wait")
			if consumed {
				holderOwned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
		if holderStdin != nil {
			ReportStage("life_cleanup")
			_ = holderStdin.Close()
			ReportDone("life_cleanup")
		}
	}()
	if name != "no-client" {
		args := []string{"--lifetime-handoff"}
		program := "/lab/bin/harness"
		if name == "live-listener" {
			program = "/lab/control-profile"
			args = []string{"kernel-lifetime", "cancel"}
		}
		holder = exec.CommandContext(ctx, program, args...)
		holder.Env = []string{
			"GITHUB_ACTIONS=true", "PATH=/lab/bin", "LANG=C", "LC_ALL=C",
			"SSJACK_ENV_TOKEN=fixture-bootstrap-token", "SSJACK_SESSION=fixture-session",
			"SSJACK_ENDPOINT=https://127.0.0.1:1", "SSJACK_CERTIFICATE_SHA256=" + strings.Repeat("0", 64),
		}
		holder.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{
			Uid: 65534, Gid: 65534, Groups: []uint32{},
		}}
		stdout, err := holder.StdoutPipe()
		if err != nil {
			return err
		}
		holderStdin, err = holder.StdinPipe()
		if err != nil {
			return err
		}
		ReportStage("life_holder")
		if err := holder.Start(); err != nil {
			ReportFailure("life_holder", err)
			return fmt.Errorf("start lifetime holder: %w", err)
		}
		ReportDone("life_holder")
		holderDone = make(chan error, 1)
		holderOwned = true
		go func() { holderDone <- holder.Wait() }()
		holderStart, err = procStartTicks(holder.Process.Pid)
		if err != nil {
			return err
		}
		marker := make(chan error, 1)
		go func() {
			line, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil {
				marker <- err
				return
			}
			want := "LIFETIME_CONNECTED\n"
			if name == "live-listener" {
				want = "LIFETIME_LISTENER\n"
			}
			if line != want {
				marker <- fmt.Errorf("unexpected lifetime marker %q, want %q", line, want)
				return
			}
			marker <- nil
		}()
		ReportStage("life_marker")
		select {
		case err := <-marker:
			if err != nil {
				return fmt.Errorf("lifetime holder readiness: %w", err)
			}
		case err := <-holderDone:
			holderOwned = false
			return fmt.Errorf("lifetime holder exited before marker: %v", err)
		case err := <-done:
			daemonOwned = false
			return fmt.Errorf("daemon exited before holder marker: %v", err)
		case <-ctx.Done():
			ReportFailure("life_marker", ctx.Err())
			return errors.New("lifetime holder marker deadline")
		}
		select {
		case err := <-holderDone:
			holderOwned = false
			return fmt.Errorf("lifetime holder exited before daemon: %v", err)
		default:
		}
	}

	ReportStage("life_daemon_wait")
	select {
	case daemonErr := <-done:
		daemonOwned = false
		if ctx.Err() != nil {
			return fmt.Errorf("outer context expired: %w", ctx.Err())
		}
		if !exitCodeIs(daemonErr, 1) {
			return fmt.Errorf("daemon exit = %v, want exit code 1", daemonErr)
		}
		if !strings.Contains(stderr.String(), "metadata daemon lifetime expired") {
			return fmt.Errorf("daemon stderr lacks lifetime diagnostic: %q", stderr.String())
		}
		expectedStage := map[string]string{
			"no-client":          "metadata accept timeout",
			"incomplete-handoff": "metadata registration timeout",
			"live-listener":      "metadata notifier lifecycle",
		}[name]
		if !strings.Contains(stderr.String(), expectedStage) {
			return fmt.Errorf("wrong lifetime stage: stderr=%q want=%q", stderr.String(), expectedStage)
		}
	case <-ctx.Done():
		ReportFailure("life_daemon_wait", ctx.Err())
		return fmt.Errorf("outer context expired before daemon lifetime: %w", ctx.Err())
	}
	ReportDone("life_daemon_wait")
	if holder != nil {
		ReportStage("life_holder_wait")
		if err := holderStillAlive(holder); err != nil {
			ReportFailure("life_holder_wait", err)
			return fmt.Errorf("holder did not survive daemon exit: %w", err)
		}
		ReportDone("life_holder_wait")
	}
	if _, err := os.Lstat(kernelSocket); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("daemon socket remains after owned wait: %v", err)
	}
	if _, err := os.Lstat(kernelACK); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("unexpected lifetime ACK: %v", err)
	}
	return nil
}

func waitForProofSocket(ctx context.Context, done <-chan error, owned *bool, socket *syscall.Stat_t) error {
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return errors.New("daemon socket readiness timeout")
		}
		if err := syscall.Stat(kernelSocket, socket); err == nil && socket.Mode&syscall.S_IFMT == syscall.S_IFSOCK {
			return nil
		}
		select {
		case daemonErr := <-done:
			*owned = false
			return fmt.Errorf("daemon exited before socket: %v", daemonErr)
		case <-ctx.Done():
			return errors.New("daemon socket readiness timeout")
		case <-tick.C:
		}
	}
}

func holderStillAlive(holder *exec.Cmd) error {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", holder.Process.Pid))
	if err != nil {
		return err
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return errors.New("malformed lifetime holder stat")
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) == 0 || fields[0] == "Z" || fields[0] == "X" {
		return errors.New("lifetime holder is not running")
	}
	return nil
}

func mutateServiceProof(name string) error {
	data, err := os.ReadFile(kernelAuth)
	if err != nil {
		return err
	}
	fields := strings.Fields(string(data))
	if len(fields) != 8 {
		return errors.New("published service record has wrong field count")
	}
	switch name {
	case "bad_pid":
		fields[1] = "99999999"
	case "bad_start":
		fields[2] = "1"
	case "bad_exe_inode":
		fields[4] = fmt.Sprint(parseUintField(fields[4]) + 1)
	case "bad_socket_inode":
		fields[6] = fmt.Sprint(parseUintField(fields[6]) + 1)
	case "malformed_hash":
		fields[7] = strings.Repeat("x", 64)
	case "malformed_record":
		data = []byte("OCLABAUTH1 broken\n")
	case "unprivileged_record":
	case "unprivileged_socket":
		return os.Chown(kernelSocket, 65534, 65534)
	default:
		return fmt.Errorf("unknown proof mutation %q", name)
	}
	if name != "malformed_record" {
		data = []byte(strings.Join(fields, " ") + "\n")
	}
	tmp := kernelAuth + ".test"
	if err := os.WriteFile(tmp, data, 0444); err != nil {
		return err
	}
	if err := os.Chown(tmp, 0, 0); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0444); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, kernelAuth); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if name == "unprivileged_record" {
		return os.Chown(kernelAuth, 65534, 65534)
	}
	return nil
}

func exitCodeIs(err error, want int) bool {
	exitErr, ok := err.(*exec.ExitError)
	return ok && exitErr.ExitCode() == want
}

func parseUintField(s string) uint64 {
	var n uint64
	_, _ = fmt.Sscan(s, &n)
	return n
}
