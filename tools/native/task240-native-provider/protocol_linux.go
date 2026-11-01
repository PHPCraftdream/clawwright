//go:build linux && amd64

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"syscall"
	"unicode/utf8"
)

// serveNative consumes an authenticated supervisor admission record. The
// supervisor remains the authority for its own policy; this server record
// binds the admitted request to the observed Unix pipe endpoints, not a keeper grant.
func serveNative(ctx context.Context, c *net.UnixConn, metadata []byte, pair UnixPair, recheck func() error) error {
	reject := func() error { return errAdmission }
	check := func() error { if recheck == nil || recheck() != nil { return reject() }; return nil }
	if check() != nil { return reject() }
	if ctx == nil || c == nil || len(metadata) == 0 || len(metadata) > 4096 || !utf8.Valid(metadata) {
		return reject()
	}
	deadline, ok := ctx.Deadline()
	if !ok || ctx.Err() != nil || c.SetDeadline(deadline) != nil {
		return reject()
	}
	// Send metadata before waiting for the supervisor record to avoid a pipe deadlock.
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(metadata)))
	if err := writeNative(c, length[:]); err != nil { return reject() }
	if err := writeNative(c, metadata); err != nil { return reject() }

	var record [92]byte
	if _, err := io.ReadFull(c, record[:]); err != nil || string(record[:8]) != "OCADMIT1" { return reject() }
	nonce, binding := record[8:24], record[24:56]
	var nz byte
	for _, b := range nonce { nz |= b }
	if nz == 0 { return reject() }
	nz = 0
	for _, b := range binding { nz |= b }
	if nz == 0 { return reject() }
	granted := UnixPair{
		Writer: UnixEndpoint{Inode: binary.BigEndian.Uint32(record[56:60]), Cookie: [2]uint32{binary.BigEndian.Uint32(record[60:64]), binary.BigEndian.Uint32(record[64:68])}},
		Reader: UnixEndpoint{Inode: binary.BigEndian.Uint32(record[68:72]), Cookie: [2]uint32{binary.BigEndian.Uint32(record[72:76]), binary.BigEndian.Uint32(record[76:80])}},
	}
	granted.Writer.PeerInode = granted.Reader.Inode
	granted.Reader.PeerInode = granted.Writer.Inode
	generation := binary.BigEndian.Uint64(record[80:88])
	payloadLen := binary.BigEndian.Uint32(record[88:92])
	if generation == 0 || payloadLen == 0 || payloadLen > 16384 || granted != pair ||
		!validCookie(granted.Writer.Cookie) || !validCookie(granted.Reader.Cookie) ||
		granted.Writer.Inode == 0 || granted.Reader.Inode == 0 { return reject() }

	current, err := ObserveUnixPair(ctx, pair.Writer.Inode)
	if err != nil || current != pair || ctx.Err() != nil { return reject() }
	payload := make([]byte, int(payloadLen))
	defer clear(payload)
	if _, err := io.ReadFull(c, payload); err != nil || !utf8.Valid(payload) || ctx.Err() != nil { return reject() }
	message := struct {
		ProtocolVersion int               `json:"protocolVersion"`
		Values          map[string]string `json:"values"`
	}{1, map[string]string{"gateway-token": string(payload)}}
	encoded, err := json.Marshal(message)
	if err != nil || len(encoded)+1 > 65536 { return reject() }
	defer clear(encoded)
	encoded = append(encoded, '\n')
	for offset := 0; offset < len(encoded); {
		if check() != nil { return reject() }
		if ctx.Err() != nil { return reject() }
		current, err = ObserveUnixPair(ctx, pair.Writer.Inode)
		if err != nil || current != pair { return reject() }
		var st syscall.Stat_t
		if err = syscall.Fstat(int(os.Stdout.Fd()), &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Ino != uint64(pair.Writer.Inode) { return reject() }
		end := offset + 4096
		if end > len(encoded) { end = len(encoded) }
		written, err := os.Stdout.Write(encoded[offset:end])
		if err != nil || written != end-offset { return reject() }
		offset = end
	}
	ack := make([]byte, 56)
	copy(ack[:8], "OCPIPE01")
	copy(ack[8:24], nonce)
	copy(ack[24:56], binding)
	if err := writeNative(c, ack); err != nil {
		return reject()
	}
	if ctx.Err() != nil { return reject() }
	return nil
}

func writeNative(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil { return err }
		if n <= 0 { return io.ErrShortWrite }
		p = p[n:]
	}
	return nil
}
