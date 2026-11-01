//go:build linux && amd64

package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

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
