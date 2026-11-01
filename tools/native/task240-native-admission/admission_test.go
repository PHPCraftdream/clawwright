//go:build linux && amd64

package main

import (
	"encoding/binary"
	"syscall"
	"testing"
)

func admissionDiag(cookie [2]uint32, peer uint32) []byte {
	b := make([]byte, 40)
	binary.LittleEndian.PutUint32(b, uint32(len(b)))
	binary.LittleEndian.PutUint16(b[4:], 20)
	binary.LittleEndian.PutUint32(b[8:], 7)
	p := b[16:]
	p[0], p[1], p[2] = syscall.AF_UNIX, syscall.SOCK_STREAM, 1
	binary.LittleEndian.PutUint32(p[4:], 11)
	binary.LittleEndian.PutUint32(p[8:], cookie[0])
	binary.LittleEndian.PutUint32(p[12:], cookie[1])
	binary.LittleEndian.PutUint16(p[16:], 8)
	binary.LittleEndian.PutUint16(p[18:], 2)
	binary.LittleEndian.PutUint32(p[20:], peer)
	return b
}

func TestParseUnixReplyAdmission(t *testing.T) {
	cookie := [2]uint32{0xabcdef01, 0x76543210}
	base := admissionDiag(cookie, 22)
	got, err := parseUnixReply(base, 11, cookie, 7, 3)
	if err != nil || got != (UnixEndpoint{Inode: 11, Cookie: cookie, PeerInode: 22}) {
		t.Fatalf("valid reply: %#v, %v", got, err)
	}
	bad := map[string][]byte{}
	add := func(name string, f func([]byte) []byte) {
		b := append([]byte(nil), base...)
		bad[name] = f(b)
	}
	add("upper cookie", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[28:], cookie[1]^1); return b })
	add("family", func(b []byte) []byte { b[16] = syscall.AF_INET; return b })
	add("socket type", func(b []byte) []byte { b[17] = 2; return b })
	add("state", func(b []byte) []byte { b[18] = 2; return b })
	add("inode", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[20:], 12); return b })
	add("missing peer", func(b []byte) []byte { b = b[:32]; binary.LittleEndian.PutUint32(b, uint32(len(b))); return b })
	add("zero peer", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[36:], 0); return b })
	add("duplicate peer", func(b []byte) []byte { b = append(b, 8, 0, 2, 0, 23, 0, 0, 0); binary.LittleEndian.PutUint32(b, uint32(len(b))); return b })
	add("truncated attr", func(b []byte) []byte { b = b[:38]; binary.LittleEndian.PutUint32(b, uint32(len(b))); return b })
	add("sequence", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[8:], 8); return b })
	add("pid", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[12:], 4); return b })
	add("multipart", func(b []byte) []byte { binary.LittleEndian.PutUint16(b[6:], 2); return b })
	add("length", func(b []byte) []byte { binary.LittleEndian.PutUint32(b, 41); return b })
	add("second message", func(b []byte) []byte { b = append(b, base...); binary.LittleEndian.PutUint32(b, uint32(len(base))); return b })
	add("NLMSG_ERROR", func(b []byte) []byte { binary.LittleEndian.PutUint16(b[4:], 2); return b })
	for name, b := range bad {
		if _, e := parseUnixReply(b, 11, cookie, 7, 3); e == nil {
			t.Errorf("accepted %s", name)
		}
	}
	if _, e := parseUnixReply(base, 11, [2]uint32{0, 0}, 7, 3); e == nil {
		t.Error("accepted mismatched zero request cookie")
	}
	if _, e := parseUnixReply(admissionDiag([2]uint32{0, 0}, 22), 11, [2]uint32{0, 0}, 7, 3); e == nil {
		t.Error("accepted returned zero cookie")
	}
	if _, e := parseUnixReply(admissionDiag([2]uint32{^uint32(0), ^uint32(0)}, 22), 11, [2]uint32{^uint32(0), ^uint32(0)}, 7, 3); e == nil {
		t.Error("accepted returned upper cookie")
	}
	if got, e := parseUnixReply(base, 11, [2]uint32{^uint32(0), ^uint32(0)}, 7, 3); e != nil || got.Cookie != cookie {
		t.Errorf("wildcard request did not accept specific cookie: %#v, %v", got, e)
	}
}

func TestParseSocketLinkExact(t *testing.T) {
	for _, tc := range []struct {
		s string
		inode uint32
		socket, ok bool
	}{{"socket:[42]", 42, true, true}, {"socket:[0]", 0, false, false}, {"socket:[042]", 0, false, false}, {"socket:[42]x", 0, false, false}, {"socket:garbage", 0, false, false}, {"/tmp/file", 0, false, true}} {
		n, s, ok := parseSocketLink(tc.s)
		if n != tc.inode || s != tc.socket || ok != tc.ok {
			t.Errorf("parseSocketLink(%q)=(%d,%t,%t)", tc.s, n, s, ok)
		}
	}
}

type admissionSeccompData struct {
	nr int32
	arch uint32
	ip uint64
	args [6]uint64
}

func admissionRun(t *testing.T, f []syscall.SockFilter, d admissionSeccompData) uint32 {
	t.Helper()
	raw := make([]byte, 64)
	binary.LittleEndian.PutUint32(raw, uint32(d.nr))
	binary.LittleEndian.PutUint32(raw[4:], d.arch)
	for i, a := range d.args {
		binary.LittleEndian.PutUint64(raw[16+i*8:], a)
	}
	var a uint32
	for pc, steps := 0, 0; steps < 1000; steps++ {
		if pc < 0 || pc >= len(f) { t.Fatalf("jump out of range: %d", pc) }
		x := f[pc]
		switch x.Code {
		case 0x20:
			if int(x.K) > 60 { t.Fatalf("bad load %d", x.K) }
			a = binary.LittleEndian.Uint32(raw[x.K:]); pc++
		case 0x15:
			if a == x.K { pc += 1 + int(x.Jt) } else { pc += 1 + int(x.Jf) }
		case 0x45:
			if a&x.K != 0 { pc += 1 + int(x.Jt) } else { pc += 1 + int(x.Jf) }
		case 0x06:
			return x.K
		default:
			t.Fatalf("unexpected opcode %#x", x.Code)
		}
	}
	t.Fatal("filter exceeded step bound")
	return 0
}

func TestBuildLaunchFilterPolicy(t *testing.T) {
	f := BuildLaunchFilter()
	for i, x := range f {
		if x.Code == 0x15 || x.Code == 0x45 {
			for _, off := range []int{int(x.Jt), int(x.Jf)} {
				if i+1+off >= len(f) { t.Fatalf("jump at %d escapes filter", i) }
			}
		}
	}
	const arch = uint32(0xc000003e)
	const allow = uint32(0x7fff0000)
	ep := func(n uint32) uint32 { return 0x00050000 | n }
	cases := []struct { name string; nr int32; arg uint64; a, want uint32 }{
		{"read", 0, 0, arch, allow}, {"clone child", 56, 17, arch, allow},
		{"clone thread", 56, 0x10000, arch, allow}, {"clone3", 435, 0, arch, ep(uint32(syscall.ENOSYS))},
		{"io uring", 425, 0, arch, ep(uint32(syscall.ENOSYS))},
		{"x32 read", 0x40000000, 0, arch, ep(uint32(syscall.EPERM))},
		{"wrong arch", 0, 0, 0, 0x80000000},
	}
	for _, c := range cases {
		d := admissionSeccompData{nr: c.nr, arch: c.a}; d.args[0] = c.arg
		if got := admissionRun(t, f, d); got != c.want { t.Errorf("%s result %#x want %#x", c.name, got, c.want) }
	}
	for _, nr := range []int32{101, 311, 272, 308, 165, 166, 155, 161, 429, 428, 430, 431, 432, 433, 442} {
		d := admissionSeccompData{nr: nr, arch: arch}
		if got, want := admissionRun(t, f, d), ep(uint32(syscall.EPERM)); got != want {
			t.Errorf("syscall %d result %#x want %#x", nr, got, want)
		}
	}
	for _, flags := range []uint64{0x20000, 0x800000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000} {
		d := admissionSeccompData{nr: 56, arch: arch}; d.args[0] = flags
		if got, want := admissionRun(t, f, d), ep(uint32(syscall.EPERM)); got != want {
			t.Errorf("clone flags %#x result %#x want %#x", flags, got, want)
		}
	}
}
