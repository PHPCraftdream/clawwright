//go:build linux && amd64

package service

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestParseRecord(t *testing.T) {
	good := "OCLABAUTH1 123 456 7 8 9 10 " + strings.Repeat("a", 64) + "\n"
	r, err := parseRecord([]byte(good))
	if err != nil || r.pid != 123 || r.start != 456 || r.hash != strings.Repeat("a", 64) {
		t.Fatalf("parse canonical record: %#v %v", r, err)
	}
	for _, bad := range []string{"", strings.TrimSuffix(good, "\n"), good + "\n", strings.Replace(good, "123", "0123", 1), "OCLABAUTH1 123 456 7 8 9 10 " + strings.Repeat("G", 64) + "\n", "OCLABAUTH1 broken\n", "OCLABAUTH1 1 456 7 8 9 10 " + strings.Repeat("a", 64) + "\n"} {
		if _, err := parseRecord([]byte(bad)); err == nil { t.Errorf("accepted %q", bad) }
	}
}

func TestListenerRequiresListeningSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "listener.sock")
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET, 0)
	if err != nil { t.Fatal(err) }
	defer syscall.Close(fd)
	sa := &syscall.SockaddrUnix{Name: path}
	if err = syscall.Bind(fd, sa); err != nil { t.Fatal(err) }
	defer os.Remove(path)
	if err = os.Chmod(path, 0666); err != nil { t.Fatal(err) }
	if err = listener(os.Getpid(), path); err == nil { t.Fatal("accepted bound but non-listening socket") }
	if err = syscall.Listen(fd, 1); err != nil { t.Fatal(err) }
	if err = listener(os.Getpid(), path); err != nil { t.Fatalf("rejected owned listening socket: %v", err) }
	conn, err := net.Dial("unixpacket", path)
	if err != nil { t.Fatalf("kernel did not accept connection: %v", err) }
	conn.Close()
}

func TestWaitReadyRejectsMissingChild(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if err := WaitReady(ctx, nil, roles["metadata"].socket); err == nil { t.Fatal("accepted missing child") }
}
