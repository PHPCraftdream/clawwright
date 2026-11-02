//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func init() {
	if len(os.Args) == 3 && os.Args[1] == "--task245-wait-probe" {
		switch os.Args[2] {
		case "pending":
			_, _ = syscall.Write(4, []byte{1})
			var b [1]byte
			_, _ = syscall.Read(3, b[:])
		case "exited":
			os.Exit(7)
		case "exit111":
			os.Exit(111)
		case "signaled":
			_ = syscall.Kill(syscall.Getpid(), syscall.SIGKILL)
		}
		os.Exit(8)
	}
	if len(os.Args) == 2 && os.Args[1] == "--task245-startup-consumer-probe" {
		var header [64]byte
		if n, err := syscall.Read(3, header[:]); err != nil || n != len(header) {
			os.Exit(102)
		}
		_, _ = io.WriteString(os.Stderr, "suppressed-consumer-stderr-marker\n")
		if err := syscall.SetNonblock(3, true); err != nil {
			os.Exit(102)
		}
		control := os.NewFile(3, "startup-consumer-control")
		if err := control.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			os.Exit(102)
		}
		var packet [161]byte
		n, err := readStartupReply245(control, packet[:])
		if err != nil {
			os.Exit(102)
		}
		cfg := launchConfig{LabReceiptPath: "/var/lib/ssjack/synthetic/consumer-receipt"}
		if handleStartupFailure245(packet[:n], header, cfg) {
			os.Exit(101)
		}
		os.Exit(102)
	}
}

func TestStartupRootObservation(t *testing.T) {
	owned := make(map[int]bool)
	t.Cleanup(func() {
		for pid, live := range owned {
			if !live {
				continue
			}
			_ = syscall.Kill(pid, syscall.SIGKILL)
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				var status syscall.WaitStatus
				got, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
				if err == syscall.ECHILD || err == nil && got == pid && (status.Exited() || status.Signaled()) {
					owned[pid] = false
					break
				}
				time.Sleep(time.Millisecond)
			}
			if owned[pid] {
				t.Errorf("owned pid %d remained unreaped after cleanup deadline", pid)
			}
		}
	})

	spawn := func(mode string, extra ...*os.File) int {
		files := []uintptr{0, 1, 2}
		for _, file := range extra {
			files = append(files, file.Fd())
		}
		pid, err := syscall.ForkExec(os.Args[0], []string{os.Args[0], "--task245-wait-probe", mode}, &syscall.ProcAttr{Files: files, Env: []string{}})
		if err != nil {
			t.Fatal(err)
		}
		owned[pid] = true
		return pid
	}
	observe := func(pid int, want string, wantReaped bool) {
		t.Helper()
		deadline := time.Now().Add(time.Second)
		for {
			got, reaped := observeStartupRoot245(pid)
			if got == "nochild" || reaped {
				owned[pid] = false
			}
			if got == want {
				if reaped != wantReaped {
					t.Fatalf("%s reaped=%v, want %v", got, reaped, wantReaped)
				}
				return
			}
			if want == "pending" || time.Now().After(deadline) {
				t.Fatalf("observation=%s, want %s", got, want)
			}
			time.Sleep(time.Millisecond)
		}
	}

	readGate, writeGate, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readGate.Close()
	defer writeGate.Close()
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readReady.Close()
	pid := spawn("pending", readGate, writeReady)
	_ = writeReady.Close()
	if err := readReady.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var ready [1]byte
	if _, err := io.ReadFull(readReady, ready[:]); err != nil || ready[0] != 1 {
		t.Fatalf("pending child readiness = %v, %v", ready, err)
	}
	observe(pid, "pending", false)
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	observe(pid, "signaled", true)
	if got, reaped := observeStartupRoot245(pid); got != "nochild" || reaped {
		t.Fatalf("second wait = %s, %v", got, reaped)
	}

	for _, tc := range []struct {
		mode string
		want string
	}{
		{mode: "exit111", want: "exit111"},
		{mode: "exited", want: "exited"},
		{mode: "signaled", want: "signaled"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			child := spawn(tc.mode)
			observe(child, tc.want, true)
		})
	}
}

func TestStartupControlProtocol(t *testing.T) {
	var header [64]byte
	copy(header[:8], "SSINK001")
	copy(header[8:24], "0123456789abcdef")
	copy(header[24:56], strings.Repeat("b", 32))
	binary.BigEndian.PutUint64(header[56:], 8192)

	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC|syscall.SOCK_NONBLOCK, 0)
	if err != nil {
		t.Fatal(err)
	}
	tx := os.NewFile(uintptr(pair[0]), "startup-protocol-tx")
	if err = syscall.SetNonblock(pair[1], true); err != nil {
		_ = tx.Close()
		_ = syscall.Close(pair[1])
		t.Fatal(err)
	}
	rx := os.NewFile(uintptr(pair[1]), "startup-protocol-rx")
	t.Cleanup(func() {
		_ = tx.Close()
		_ = rx.Close()
	})
	if err = tx.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err = rx.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	if err = sendStartupFailure(tx, header, &startupFailure{stage: startupStageCode("tracker_seize"), errno: uint32(syscall.EPERM)}); err != nil {
		t.Fatal(err)
	}
	var packet [161]byte
	n, err := readStartupReply245(rx, packet[:])
	if err != nil {
		t.Fatal(err)
	}
	failure, ok := parseStartupFailure245(packet[:n], header)
	if !ok || startupStageName(failure.stage) != "tracker_seize" || failure.errno != uint32(syscall.EPERM) {
		t.Fatalf("round trip = %v, %v", failure, ok)
	}

	if err = sendStartupFailure(tx, header, &startupFailure{stage: startupStageCode("tracker_wait_nochild"), errno: uint32(syscall.ECHILD)}); err != nil {
		t.Fatal(err)
	}
	n, err = readStartupReply245(rx, packet[:])
	if err != nil {
		t.Fatal(err)
	}
	failure, ok = parseStartupFailure245(packet[:n], header)
	if !ok || startupStageName(failure.stage) != "tracker_wait_nochild" || failure.errno != uint32(syscall.ECHILD) {
		t.Fatalf("round trip = %v, %v", failure, ok)
	}
	var valid [64]byte
	copy(valid[:8], "OCSTART1")
	copy(valid[8:56], header[8:56])
	binary.BigEndian.PutUint32(valid[56:60], startupStageCode("tracker_seize"))
	binary.BigEndian.PutUint32(valid[60:64], uint32(syscall.EPERM))
	var waitNoChild [64]byte
	copy(waitNoChild[:8], "OCSTART1")
	copy(waitNoChild[8:56], header[8:56])
	binary.BigEndian.PutUint32(waitNoChild[56:60], startupStageCode("tracker_wait_nochild"))
	binary.BigEndian.PutUint32(waitNoChild[60:64], uint32(syscall.ECHILD))
	if _, ok := parseStartupFailure245(waitNoChild[:], header); !ok {
		t.Fatal("valid tracker wait no-child reply rejected")
	}
	bad := []struct {
		name   string
		packet []byte
	}{}
	for _, tc := range []struct {
		name   string
		packet []byte
	}{
		{"short", valid[:len(valid)-1]},
		{"extra", append(append([]byte(nil), valid[:]...), 0)},
		{"magic", append([]byte(nil), valid[:]...)},
		{"nonce", append([]byte(nil), valid[:]...)},
		{"binding", append([]byte(nil), valid[:]...)},
		{"stage zero", append([]byte(nil), valid[:]...)},
		{"stage invalid", append([]byte(nil), valid[:]...)},
		{"errno 4096", append([]byte(nil), valid[:]...)},
	} {
		switch tc.name {
		case "magic":
			tc.packet[0] ^= 1
		case "nonce":
			tc.packet[8] ^= 1
		case "binding":
			tc.packet[24] ^= 1
		case "stage zero":
			binary.BigEndian.PutUint32(tc.packet[56:60], 0)
		case "stage invalid":
			binary.BigEndian.PutUint32(tc.packet[56:60], 35)
		case "errno 4096":
			binary.BigEndian.PutUint32(tc.packet[60:64], 4096)
		}
		bad = append(bad, tc)
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := parseStartupFailure245(tc.packet, header); ok {
				t.Fatal("invalid reply accepted")
			}
		})
	}
	for _, field := range []int{8, 24, 56} {
		invalid := header
		length := 16
		if field == 8 {
			length = 16
		} else if field == 24 {
			length = 32
		} else {
			length = 8
		}
		clear(invalid[field : field+length])
		if _, ok := parseStartupFailure245(valid[:], invalid); ok {
			t.Fatal("invalid SSINK header accepted")
		}
	}
	oversized := bytes.Repeat([]byte{'x'}, 162)
	if _, err = syscall.SendmsgN(int(tx.Fd()), oversized, nil, nil, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = readStartupReply245(rx, packet[:]); err == nil {
		t.Fatal("oversized packet accepted")
	}
	readEnd, writeEnd, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readEnd.Close()
	defer writeEnd.Close()
	if _, err = syscall.SendmsgN(int(tx.Fd()), valid[:], syscall.UnixRights(int(writeEnd.Fd())), nil, 0); err != nil {
		t.Fatal(err)
	}
	if err = writeEnd.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = readStartupReply245(rx, packet[:]); err == nil {
		t.Fatal("packet with rights accepted")
	}
	if err = readEnd.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if n, err := readEnd.Read(packet[:1]); n != 0 || err != io.EOF {
		t.Fatalf("received right kept pipe open: n=%d err=%v", n, err)
	}
}

func TestDomainInitStartupControlKernel(t *testing.T) {
	path := os.Getenv("TASK245_INIT")
	if path == "" || os.Geteuid() != 0 {
		t.Fatal("TASK245_INIT and root required")
	}
	_, image, original, rootfd, pair := domainFixture245(t, true)
	metaBytes, err := io.ReadAll(original)
	if err != nil {
		t.Fatal("read fixture metadata")
	}
	meta := memfdDomain245(t, "startup-metadata", append(metaBytes, 1), 0444, true)
	control := os.NewFile(uintptr(pair[1]), "startup-control-child")
	t.Cleanup(func() {
		_ = control.Close()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.Command(path, "65534", "65533")
	cmd.Env = []string{}
	cmd.ExtraFiles = []*os.File{image, control, rootfd, meta}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal("domain-init start")
	}
	_ = control.Close()
	_ = syscall.SetNonblock(pair[0], true)
	waited, reaped := make(chan error, 1), make(chan struct{})
	go func() {
		waited <- cmd.Wait()
		close(reaped)
	}()
	defer func() {
		select {
		case <-reaped:
			return
		default:
		}
		_ = cmd.Process.Kill()
		select {
		case <-reaped:
		case <-time.After(time.Second):
			t.Error("domain-init process did not reap after kill")
		}
	}()
	var header [64]byte
	copy(header[:8], "SSINK001")
	copy(header[8:24], "0123456789abcdef")
	copy(header[24:56], strings.Repeat("b", 32))
	binary.BigEndian.PutUint64(header[56:], 8192)
	if _, err = syscall.Write(pair[0], header[:]); err != nil {
		t.Fatal("startup header")
	}
	deadline := time.Now().Add(12 * time.Second)
	var packet [65]byte
	for {
		n, _, readErr := syscall.Recvfrom(pair[0], packet[:], syscall.MSG_DONTWAIT)
		if readErr == nil {
			failure, ok := parseStartupFailure245(packet[:n], header)
			if !ok || startupStageName(failure.stage) != "node" || failure.errno != uint32(syscall.ENOENT) {
				t.Fatalf("startup packet rejected: %v %v", failure, ok)
			}
			break
		}
		if readErr != syscall.EAGAIN && readErr != syscall.EWOULDBLOCK {
			t.Fatalf("control read: %v", readErr)
		}
		if ctx.Err() != nil || time.Now().After(deadline) {
			t.Fatal("startup packet timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case err = <-waited:
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 101 {
			t.Fatalf("exit = %v, want 101", err)
		}
	case <-ctx.Done():
		t.Fatal("worker exit timeout")
	}
	select {
	case <-reaped:
	case <-ctx.Done():
		t.Error("domain-init process reap timeout")
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatal("worker stdout/stderr escaped suppression")
	}
}

func startupControlProbe245() int {
	var header [64]byte
	if _, err := syscall.Read(4, header[:]); err != nil || string(header[:8]) != "SSINK001" {
		return 42
	}
	_, _ = io.WriteString(os.Stderr, "suppressed-worker-stderr-marker\n")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tracker, _, err := startGatewayControl(ctx, workerConfig{Node: "/missing-node"}, os.NewFile(4, "outer-control"), header)
	if tracker != nil {
		tracker.Close()
	}
	var startup *startupFailure
	if !errors.As(err, &startup) {
		return 43
	}
	return 101
}

func bootstrapTrackerProbe245() int {
	var header [64]byte
	if _, err := syscall.Read(4, header[:]); err != nil || string(header[:8]) != "SSINK001" {
		return 51
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	readHash := func(path string) string {
		b, err := os.ReadFile(path)
		if err != nil {
			return ""
		}
		h := sha256.Sum256(b)
		return hex.EncodeToString(h[:])
	}
	hash := readHash("/node")
	if hash == "" {
		return 52
	}
	registry := &execRegistry245{roles: map[int]string{}}
	config := workerConfig{
		Node:         "/node",
		Stub:         "/stub",
		Provider:     "/node",
		ConfigPath:   "/fixture",
		SocketPath:   "/run/probe.sock",
		GatewayArgv:  []string{"/node", "--task245-bootstrap-target"},
		NodeSHA256:   hash,
		StubSHA256:   readHash("/stub"),
		ProviderSHA256: hash,
		registry:     registry,
	}
	tracker, pid, err := startGatewayControl(ctx, config, os.NewFile(4, "outer-control"), header)
	if err != nil {
		return 53
	}
	if pid <= 0 || tracker == nil {
		return 54
	}
	for {
		registry.mu.Lock()
		_, ok := registry.roles[pid]
		registry.mu.Unlock()
		if ok {
			break
		}
		select {
		case <-ctx.Done():
			tracker.Close()
			return 55
		case <-time.After(10 * time.Millisecond):
		}
	}
	tracker.Close()
	if err = syscall.Kill(pid, 0); err != syscall.ESRCH {
		return 56
	}
	if _, err = syscall.Write(4, []byte("OCBOOTOK")); err != nil {
		return 57
	}
	return 0
}

func TestDomainInitBootstrapTrackerKernel(t *testing.T) {
	initPath, stubPath := os.Getenv("TASK245_INIT"), os.Getenv("TASK240_STUB")
	if initPath == "" || stubPath == "" || os.Geteuid() != 0 {
		t.Fatal("TASK245_INIT, TASK240_STUB and root required")
	}
	root, image, meta, rootfd, pair := domainFixture245(t, true)
	if err := syscall.Mount("", root, "", syscall.MS_BIND|syscall.MS_REMOUNT, ""); err != nil {
		t.Fatal(err)
	}
	copyExec := func(src, dst string) {
		b, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, dst), b, 0755); err != nil {
			t.Fatal(err)
		}
	}
	copyExec(stubPath, "stub")
	copyExec(os.Args[0], "node")
	if err := syscall.Mount("", root, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil {
		t.Fatal(err)
	}
	metaBytes, err := io.ReadAll(meta)
	if err != nil {
		t.Fatal(err)
	}
	bootstrapMeta := memfdDomain245(t, "bootstrap-metadata", append(metaBytes, 1, 2), 0444, true)
	control := os.NewFile(uintptr(pair[1]), "bootstrap-control-child")
	t.Cleanup(func() {
		_ = control.Close()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.Command(initPath, "65534", "65533")
	cmd.Env = []string{}
	cmd.ExtraFiles = []*os.File{image, control, rootfd, bootstrapMeta}
	if err = cmd.Start(); err != nil {
		t.Fatal("domain-init start")
	}
	_ = control.Close()
	_ = syscall.SetNonblock(pair[0], true)
	waited, reaped := make(chan error, 1), make(chan struct{})
	go func() {
		waited <- cmd.Wait()
		close(reaped)
	}()
	defer func() {
		select {
		case <-reaped:
			return
		default:
		}
		_ = cmd.Process.Kill()
		select {
		case <-reaped:
		case <-time.After(time.Second):
			t.Error("domain-init process did not reap")
		}
	}()
	var header [64]byte
	copy(header[:8], "SSINK001")
	copy(header[8:24], "0123456789abcdef")
	copy(header[24:56], "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	binary.BigEndian.PutUint64(header[56:], 8192)
	if _, err = syscall.Write(pair[0], header[:]); err != nil {
		t.Fatal("startup header")
	}
	deadline := time.Now().Add(12 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		var packet [161]byte
		n, _, readErr := syscall.Recvfrom(pair[0], packet[:], syscall.MSG_DONTWAIT)
		if readErr == nil {
			if string(packet[:n]) != "OCBOOTOK" {
				if failure, ok := parseStartupFailure245(packet[:n], header); ok {
					t.Fatalf("bootstrap failed at stage %s errno %d", startupStageName(failure.stage), failure.errno)
				}
				t.Fatal("unexpected bootstrap reply")
			}
			ready = true
			break
		}
		if readErr != syscall.EAGAIN && readErr != syscall.EWOULDBLOCK {
			t.Fatalf("control read: %v", readErr)
		}
		select {
		case <-ctx.Done():
			t.Fatal("bootstrap timeout")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if !ready {
		t.Fatal("bootstrap readiness timeout")
	}
	select {
	case err = <-waited:
		if err != nil {
			t.Fatalf("domain-init exit: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("domain-init wait timeout")
	}
}
