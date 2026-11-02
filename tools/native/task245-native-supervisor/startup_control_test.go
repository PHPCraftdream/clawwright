//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func init() {
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

	if err = sendStartupFailure(tx, header, &startupFailure{stage: startupStageCode("node"), errno: uint32(syscall.ENOENT)}); err != nil {
		t.Fatal(err)
	}
	var packet [161]byte
	n, err := readStartupReply245(rx, packet[:])
	if err != nil {
		t.Fatal(err)
	}
	failure, ok := parseStartupFailure245(packet[:n], header)
	if !ok || startupStageName(failure.stage) != "node" || failure.errno != uint32(syscall.ENOENT) {
		t.Fatalf("round trip = %v, %v", failure, ok)
	}

	var valid [64]byte
	copy(valid[:8], "OCSTART1")
	copy(valid[8:56], header[8:56])
	binary.BigEndian.PutUint32(valid[56:60], startupStageCode("node"))
	binary.BigEndian.PutUint32(valid[60:64], uint32(syscall.ENOENT))
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
		{"stage fourteen", append([]byte(nil), valid[:]...)},
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
		case "stage fourteen":
			binary.BigEndian.PutUint32(tc.packet[56:60], 14)
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
