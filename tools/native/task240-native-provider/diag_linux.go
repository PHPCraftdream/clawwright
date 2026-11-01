//go:build linux && amd64

package main

import (
	"context"
	"encoding/binary"
	"syscall"
	"time"
)

const (
	nlmsgHeaderSize  = 16
	unixDiagReqSize  = 24
	sockDiagByFamily = 20
	nlmsgError       = 2
	unixDiagPeer     = 2
	netlinkSockDiag  = 4
	unixNoCookie     = uint32(0xffffffff)
)

// UnixEndpoint is an observed AF_UNIX stream identity.
type UnixEndpoint struct {
	Inode     uint32
	Cookie    [2]uint32
	PeerInode uint32
}

// UnixPair contains mutually verified peer endpoints.
type UnixPair struct {
	Writer UnixEndpoint
	Reader UnixEndpoint
}

// ObserveUnixPair discovers and then revalidates both reciprocal endpoints.
func ObserveUnixPair(ctx context.Context, inode uint32) (UnixPair, error) {
	if ctx == nil || inode == 0 {
		return UnixPair{}, errAdmission
	}
	if err := ctx.Err(); err != nil {
		return UnixPair{}, err
	}
	first, err := queryUnix(ctx, inode, [2]uint32{unixNoCookie, unixNoCookie})
	if err != nil || first.PeerInode == 0 || !validCookie(first.Cookie) {
		return UnixPair{}, errAdmission
	}
	second, err := queryUnix(ctx, first.PeerInode, [2]uint32{unixNoCookie, unixNoCookie})
	if err != nil || second.PeerInode != inode || !validCookie(second.Cookie) {
		return UnixPair{}, errAdmission
	}
	verifiedFirst, err := queryUnix(ctx, inode, first.Cookie)
	if err != nil {
		return UnixPair{}, errAdmission
	}
	verifiedSecond, err := queryUnix(ctx, second.Inode, second.Cookie)
	if err != nil || verifiedFirst != first || verifiedSecond != second {
		return UnixPair{}, errAdmission
	}
	return UnixPair{Writer: verifiedFirst, Reader: verifiedSecond}, nil
}

func validCookie(cookie [2]uint32) bool {
	return cookie != [2]uint32{} && cookie != [2]uint32{unixNoCookie, unixNoCookie}
}

func queryUnix(ctx context.Context, inode uint32, cookie [2]uint32) (UnixEndpoint, error) {
	if ctx == nil || ctx.Err() != nil {
		return UnixEndpoint{}, errAdmission
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return UnixEndpoint{}, errAdmission
	}
	left := time.Until(deadline)
	if left <= 0 {
		return UnixEndpoint{}, errAdmission
	}
	fd, err := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, netlinkSockDiag)
	if err != nil {
		return UnixEndpoint{}, errAdmission
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); err != nil {
		return UnixEndpoint{}, errAdmission
	}
	local, err := syscall.Getsockname(fd)
	if err != nil {
		return UnixEndpoint{}, errAdmission
	}
	port := local.(*syscall.SockaddrNetlink).Pid
	request := make([]byte, nlmsgHeaderSize+unixDiagReqSize)
	binary.LittleEndian.PutUint32(request[0:4], uint32(len(request)))
	binary.LittleEndian.PutUint16(request[4:6], sockDiagByFamily)
	binary.LittleEndian.PutUint16(request[6:8], 1) // NLM_F_REQUEST
	binary.LittleEndian.PutUint32(request[8:12], 1)
	r := request[nlmsgHeaderSize:]
	r[0] = syscall.AF_UNIX
	binary.LittleEndian.PutUint32(r[4:8], ^uint32(0)) // states: ALL
	binary.LittleEndian.PutUint32(r[8:12], inode)
	binary.LittleEndian.PutUint32(r[12:16], 4) // show peer
	binary.LittleEndian.PutUint32(r[16:20], cookie[0])
	binary.LittleEndian.PutUint32(r[20:24], cookie[1])
	if err := syscall.Sendto(fd, request, 0, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); err != nil {
		return UnixEndpoint{}, errAdmission
	}
	left = time.Until(deadline)
	if left <= 0 {
		return UnixEndpoint{}, errAdmission
	}
	if left > time.Second {
		left = time.Second
	}
	tv := syscall.NsecToTimeval(left.Nanoseconds())
	if tv.Sec == 0 && tv.Usec == 0 {
		tv.Usec = 1
	}
	if err := syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv); err != nil {
		return UnixEndpoint{}, errAdmission
	}
	buf := make([]byte, 65536)
	n, _, flags, from, err := syscall.Recvmsg(fd, buf, nil, 0)
	if err != nil || ctx.Err() != nil || flags&syscall.MSG_TRUNC != 0 {
		return UnixEndpoint{}, errAdmission
	}
	sender, ok := from.(*syscall.SockaddrNetlink)
	if !ok || sender.Pid != 0 {
		return UnixEndpoint{}, errAdmission
	}
	return parseUnixReply(buf[:n], inode, cookie, 1, port)
}

// parseUnixReply accepts exactly one non-multipart SOCK_DIAG_BY_FAMILY reply.
func parseUnixReply(b []byte, inode uint32, cookie [2]uint32, seq, port uint32) (UnixEndpoint, error) {
	if len(b) < nlmsgHeaderSize || int(binary.LittleEndian.Uint32(b[:4])) != len(b) ||
		binary.LittleEndian.Uint16(b[4:6]) != sockDiagByFamily ||
		binary.LittleEndian.Uint16(b[6:8])&2 != 0 ||
		binary.LittleEndian.Uint32(b[8:12]) != seq {
		return UnixEndpoint{}, errAdmission
	}
	pid := binary.LittleEndian.Uint32(b[12:16])
	if pid != 0 && pid != port {
		return UnixEndpoint{}, errAdmission
	}
	p := b[nlmsgHeaderSize:]
	if len(p) < 16 || p[0] != syscall.AF_UNIX || p[1] != syscall.SOCK_STREAM || p[2] != 1 ||
		binary.LittleEndian.Uint32(p[4:8]) != inode {
		return UnixEndpoint{}, errAdmission
	}
	gotCookie := [2]uint32{binary.LittleEndian.Uint32(p[8:12]), binary.LittleEndian.Uint32(p[12:16])}
	if !validCookie(gotCookie) || (cookie != [2]uint32{unixNoCookie, unixNoCookie} && gotCookie != cookie) {
		return UnixEndpoint{}, errAdmission
	}
	var peer uint32
	seenPeer := false
	attrs := p[16:]
	for len(attrs) > 0 {
		if len(attrs) < 4 {
			return UnixEndpoint{}, errAdmission
		}
		length := int(binary.LittleEndian.Uint16(attrs[:2]))
		if length < 4 || length > len(attrs) {
			return UnixEndpoint{}, errAdmission
		}
		typ := binary.LittleEndian.Uint16(attrs[2:4]) & 0x3fff
		if typ == unixDiagPeer {
			if seenPeer || length != 8 {
				return UnixEndpoint{}, errAdmission
			}
			seenPeer = true
			peer = binary.LittleEndian.Uint32(attrs[4:8])
		}
		step := (length + 3) &^ 3
		if step > len(attrs) {
			if length != len(attrs) {
				return UnixEndpoint{}, errAdmission
			}
			step = length
		}
		attrs = attrs[step:]
	}
	if !seenPeer || peer == 0 || peer == inode {
		return UnixEndpoint{}, errAdmission
	}
	return UnixEndpoint{Inode: inode, Cookie: gotCookie, PeerInode: peer}, nil
}
