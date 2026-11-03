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
	"syscall"
	"testing"
	"time"
)

const metadataProbeArg = "--task240-metadata-pipe-probe"

func init() {
	if len(os.Args) == 3 && os.Args[1] == metadataProbeArg {
		os.Exit(runMetadataPipeProbe(os.Args[2]))
	}
}

func runMetadataPipeProbe(mode string) int {
	if err := os.Stdin.SetReadDeadline(time.Now().Add(time.Second)); !errors.Is(err, os.ErrNoDeadline) {
		return 31
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	started := time.Now()
	if mode == "cancel" {
		time.AfterFunc(40*time.Millisecond, cancel)
	}
	if _, err := syscall.Write(3, []byte{1}); err != nil {
		return 32
	}
	var before syscall.Stat_t
	if syscall.Fstat(0, &before) != nil {
		return 33
	}
	got, err := readNativeMetadata(ctx)
	elapsed := time.Since(started)
	var after syscall.Stat_t
	if syscall.Fstat(0, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino {
		return 34
	}
	switch mode {
	case "valid":
		want := []byte(`{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`)
		if err != nil || !bytes.Equal(got, want) || parseNativeMetadata(got) != nil {
			return 35
		}
	case "at-limit":
		want := []byte(`{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`)
		want = append(want, bytes.Repeat([]byte{' '}, 4096-len(want))...)
		if err != nil || !bytes.Equal(got, want) || parseNativeMetadata(got) != nil {
			return 36
		}
	case "oversized", "invalid", "empty":
		if err == nil {
			return 37
		}
	case "timeout":
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
			return 38
		}
		if err == nil || ctx.Err() != context.DeadlineExceeded {
			return 38
		}
	case "cancel":
		if err == nil || ctx.Err() != context.Canceled || elapsed > 800*time.Millisecond {
			return 39
		}
	default:
		return 40
	}
	return 0
}

func TestReadNativeMetadataPipeSubprocess(t *testing.T) {
	valid := []byte(`{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`)
	modes := []string{"valid", "at-limit", "oversized", "invalid", "empty", "timeout", "cancel"}
	for _, mode := range modes {
		t.Run(mode, func(t *testing.T) {
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			readyR, readyW, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer readyR.Close()
			defer readyW.Close()
			cmd := exec.Command(os.Args[0], metadataProbeArg, mode)
			cmd.Stdin = reader
			cmd.ExtraFiles = []*os.File{readyW}
			cmd.Env = []string{}
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			_ = reader.Close()
			_ = readyW.Close()
			waited := make(chan error, 1)
			reaped := make(chan struct{})
			go func() {
				waited <- cmd.Wait()
				close(reaped)
			}()
			defer func() {
				_ = writer.Close()
				select {
				case <-reaped:
					return
				default:
					_ = cmd.Process.Kill()
				}
				select {
				case <-reaped:
				case <-time.After(time.Second):
					t.Error("probe process was not reaped within bound")
				}
			}()
			if err := readyR.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
				t.Fatalf("set readiness deadline: %v", err)
			}
			var signal [1]byte
			if _, err := io.ReadFull(readyR, signal[:]); err != nil || signal[0] != 1 {
				t.Fatalf("probe readiness handshake failed: %v", err)
			}
			switch mode {
			case "valid":
				if _, err := writer.Write(valid); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			case "at-limit":
				data := append(append([]byte(nil), valid...), bytes.Repeat([]byte{' '}, 4096-len(valid))...)
				if _, err := writer.Write(data); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				data := append(append([]byte(nil), valid...), bytes.Repeat([]byte{' '}, 4097-len(valid))...)
				if _, err := writer.Write(data); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			case "invalid":
				if _, err := writer.Write([]byte(`{"protocolVersion":1}`)); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			case "empty":
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-waited:
				if err != nil {
					t.Fatalf("probe failed: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("probe did not finish within bound")
			}
		})
	}
}

func TestNativeMetadataBoundariesAndValidation(t *testing.T) {
	valid := []byte(`{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`)
	atLimit := append(append([]byte(nil), valid...), bytes.Repeat([]byte{' '}, 4096-len(valid))...)
	if err := parseNativeMetadata(atLimit); err != nil {
		t.Fatalf("4096-byte valid metadata rejected: %v", err)
	}
	tooLong := append(atLimit, ' ')
	if err := parseNativeMetadata(tooLong); err == nil {
		t.Fatal("accepted metadata longer than 4096 bytes")
	}
	cases := map[string]string{
		"duplicate key": `{"protocolVersion":1,"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`,
		"escaped duplicate key": `{"protocolVersion":1,"protocolVers\u0069on":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`,
		"wrong provider": `{"protocolVersion":1,"provider":"other","ids":["gateway-token"]}`,
		"extra field": `{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"],"extra":true}`,
		"wrong ID": `{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["other"]}`,
		"null IDs": `{"protocolVersion":1,"provider":"clawwright-ssjack","ids":null}`,
		"malformed": `{"protocolVersion":`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if err := parseNativeMetadata([]byte(raw)); err == nil {
				t.Fatalf("accepted invalid metadata %s", raw)
			}
		})
	}
}

// This fixture encodes the Linux SOCK_DIAG_BY_FAMILY wire reply independently
// of production parsing helpers, including a two-word cookie and peer attribute.
func nativeDiagFixture(inode, cookieLow, cookieHigh, peer uint32) []byte {
	b := make([]byte, 16+16+8)
	binary.LittleEndian.PutUint32(b[0:4], uint32(len(b)))
	binary.LittleEndian.PutUint16(b[4:6], sockDiagByFamily)
	binary.LittleEndian.PutUint16(b[6:8], 1)
	binary.LittleEndian.PutUint32(b[8:12], 17)
	p := b[16:]
	p[0], p[1], p[2] = 1, 1, 1 // AF_UNIX, SOCK_STREAM, established
	binary.LittleEndian.PutUint32(p[4:8], inode)
	binary.LittleEndian.PutUint32(p[8:12], cookieLow)
	binary.LittleEndian.PutUint32(p[12:16], cookieHigh)
	binary.LittleEndian.PutUint16(p[16:18], 8)
	binary.LittleEndian.PutUint16(p[18:20], unixDiagPeer)
	binary.LittleEndian.PutUint32(p[20:24], peer)
	return b
}

func TestParseUnixReplyCookieFixture(t *testing.T) {
	const inode, peer = uint32(0x12345678), uint32(0x87654321)
	const low, high = uint32(0x89abcdef), uint32(0x01234567)
	fixture := nativeDiagFixture(inode, low, high, peer)
	got, err := parseUnixReply(fixture, inode, [2]uint32{low, high}, 17, 0)
	want := UnixEndpoint{Inode: inode, Cookie: [2]uint32{low, high}, PeerInode: peer}
	if err != nil || got != want {
		t.Fatalf("parse fixture = %#v, %v; want %#v", got, err, want)
	}
	if _, err := parseUnixReply(fixture, inode, [2]uint32{low, high ^ 1}, 17, 0); err == nil {
		t.Fatal("accepted mismatched upper cookie word")
	}
}

func TestParseUnixReplyRejectsNoCookie(t *testing.T) {
	fixture := nativeDiagFixture(11, unixNoCookie, unixNoCookie, 22)
	if _, err := parseUnixReply(fixture, 11, [2]uint32{unixNoCookie, unixNoCookie}, 17, 0); err == nil {
		t.Fatal("accepted NOCOOKIE as a returned socket identity")
	}
}

type nativeShortWriter struct {
	buf bytes.Buffer
	zero bool
}

func (w *nativeShortWriter) Write(p []byte) (int, error) {
	if w.zero {
		return 0, nil
	}
	if len(p) > 2 {
		p = p[:2]
	}
	return w.buf.Write(p)
}

func TestWriteNativeCompletesShortWrites(t *testing.T) {
	w := &nativeShortWriter{}
	want := []byte("supervisor record")
	if err := writeNative(w, want); err != nil {
		t.Fatalf("writeNative: %v", err)
	}
	if !bytes.Equal(w.buf.Bytes(), want) {
		t.Fatalf("written %q, want %q", w.buf.Bytes(), want)
	}
}

func TestWriteNativeRejectsZeroProgress(t *testing.T) {
	w := &nativeShortWriter{zero: true}
	if err := writeNative(w, []byte("record")); err != io.ErrShortWrite {
		t.Fatalf("zero-progress write error = %v, want %v", err, io.ErrShortWrite)
	}
}
