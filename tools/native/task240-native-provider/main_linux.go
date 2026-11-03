//go:build linux && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

var errAdmission = errors.New("admission rejected")

type policy struct {
	SupervisorSHA256 string `json:"supervisorSHA256"`
}

func main() {
	if run() != nil {
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 1 || os.Getuid() <= 0 || len(os.Environ()) != 1 {
		return errAdmission
	}
	sock, ok := os.LookupEnv("CLAWWRIGHT_NATIVE_SOCKET")
	if !ok || sock == "" || len(sock) > 256 || !utf8.ValidString(sock) {
		return errAdmission
	}
	var stdoutStat syscall.Stat_t
	if syscall.Fstat(1, &stdoutStat) != nil || stdoutStat.Mode&syscall.S_IFMT != syscall.S_IFSOCK || stdoutStat.Ino == 0 || stdoutStat.Ino > 0xffffffff {
		return errAdmission
	}
	socketType, err := syscall.GetsockoptInt(1, syscall.SOL_SOCKET, syscall.SO_TYPE)
	if err != nil || socketType != syscall.SOCK_STREAM {
		return errAdmission
	}
	peerAddress, err := syscall.Getpeername(1)
	if err != nil {
		return errAdmission
	}
	if _, ok := peerAddress.(*syscall.SockaddrUnix); !ok {
		return errAdmission
	}
	var limit syscall.Rlimit
	if syscall.Getrlimit(syscall.RLIMIT_CORE, &limit) != nil {
		return errAdmission
	}
	limit.Cur = 0
	if syscall.Setrlimit(syscall.RLIMIT_CORE, &limit) != nil {
		return errAdmission
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	metadata, err := readNativeMetadata(ctx)
	if err != nil {
		return errAdmission
	}
	defer clear(metadata)

	p, err := loadPolicy()
	if err != nil {
		return errAdmission
	}
	c, err := net.DialTimeout("unix", sock, 30*time.Second)
	if err != nil {
		return errAdmission
	}
	defer c.Close()
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return errAdmission
	}
	stopConn := context.AfterFunc(ctx, func() { _ = uc.Close(); _ = os.Stdout.Close() })
	defer stopConn()
	if ctx.Err() != nil {
		return errAdmission
	}
	peer, err := peerPID(uc)
	if err != nil || verifySupervisor(peer, p.SupervisorSHA256) != nil {
		return errAdmission
	}
	pair, err := ObserveUnixPair(ctx, uint32(stdoutStat.Ino))
	if err != nil || ctx.Err() != nil {
		return errAdmission
	}
	return serveNative(ctx, uc, metadata, pair, func() error {
		p2, e := peerPID(uc)
		if e != nil || p2 != peer {
			return errAdmission
		}
		return verifySupervisor(peer, p.SupervisorSHA256)
	})
}

func readNativeMetadata(ctx context.Context) (result []byte, resultErr error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, errAdmission
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, errAdmission
	}
	var st syscall.Stat_t
	if syscall.Fstat(0, &st) != nil {
		return nil, errAdmission
	}
	copyFD, _, errno := syscall.Syscall(syscall.SYS_FCNTL, 0, syscall.F_DUPFD_CLOEXEC, 3)
	if errno != 0 {
		return nil, errAdmission
	}
	if syscall.SetNonblock(int(copyFD), true) != nil {
		_ = syscall.Close(int(copyFD))
		return nil, errAdmission
	}
	in := os.NewFile(copyFD, "native-metadata-input")
	if in == nil {
		_ = syscall.Close(int(copyFD))
		return nil, errAdmission
	}
	closed := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = in.Close()
		close(closed)
	})
	defer func() {
		if !stop() {
			<-closed
		}
		_ = in.Close()
	}()
	if err := in.SetReadDeadline(deadline); err != nil {
		return nil, errAdmission
	}
	metadata := make([]byte, 4097)
	defer func() {
		if resultErr != nil {
			clear(metadata)
		}
	}()
	n, err := io.ReadFull(in, metadata)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, errAdmission
	}
	if n == 0 || n > 4096 || parseNativeMetadata(metadata[:n]) != nil || ctx.Err() != nil {
		return nil, errAdmission
	}
	return metadata[:n], nil
}

func parseNativeMetadata(raw []byte) error {
	if len(raw) == 0 || len(raw) > 4096 || !utf8.Valid(raw) {
		return errAdmission
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil || len(top) != 3 {
		return errAdmission
	}
	for _, key := range []string{"protocolVersion", "provider", "ids"} {
		if _, ok := top[key]; !ok {
			return errAdmission
		}
	}
	// Walk tokens to reject duplicate object keys and nested objects, including
	// duplicate keys whose spelling uses JSON escapes.
	d := json.NewDecoder(strings.NewReader(string(raw)))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return errAdmission
	}
	seen := make(map[string]bool, 3)
	for d.More() {
		keyToken, err := d.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok || seen[key] {
			return errAdmission
		}
		seen[key] = true
		var value json.RawMessage
		if err := d.Decode(&value); err != nil || bytesContainObject(value) {
			return errAdmission
		}
	}
	if _, err := d.Token(); err != nil {
		return errAdmission
	}
	if _, err := d.Token(); err != io.EOF {
		return errAdmission
	}
	var version int
	var provider string
	var ids []string
	if json.Unmarshal(top["protocolVersion"], &version) != nil || version != 1 ||
		json.Unmarshal(top["provider"], &provider) != nil || provider != "clawwright-ssjack" ||
		json.Unmarshal(top["ids"], &ids) != nil || len(ids) != 1 || ids[0] != "gateway-token" {
		return errAdmission
	}
	return nil
}

func bytesContainObject(raw []byte) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true
	}
	_, object := value.(map[string]any)
	return object
}

func loadPolicy() (policy, error) {
	bad := func() (policy, error) { return policy{}, errAdmission }
	for _, path := range []string{"/etc", "/etc/clawwright"} {
		fi, err := os.Lstat(path)
		if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 || fi.Mode().Perm()&0022 != 0 {
			return bad()
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 {
			return bad()
		}
	}
	const path = "/etc/clawwright/native-provider.json"
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return bad()
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0022 != 0 {
		return bad()
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 || st.Nlink != 1 {
		return bad()
	}
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(b) == 0 || len(b) > 4096 {
		return bad()
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return bad()
	}
	key, ok := func() (string, bool) {
		t, e := d.Token()
		k, ok := t.(string)
		return k, e == nil && ok
	}()
	if !ok || key != "supervisorSHA256" {
		return bad()
	}
	var hash string
	if d.Decode(&hash) != nil || hash == "" || len(hash) != 64 {
		return bad()
	}
	if t, err = d.Token(); err != nil || t != json.Delim('}') {
		return bad()
	}
	if _, err = d.Token(); err != io.EOF {
		return bad()
	}
	for _, c := range hash {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return bad()
		}
	}
	return policy{SupervisorSHA256: hash}, nil
}

func peerPID(c net.Conn) (int, error) {
	u, ok := c.(*net.UnixConn)
	if !ok {
		return 0, errAdmission
	}
	raw, err := u.SyscallConn()
	if err != nil {
		return 0, errAdmission
	}
	pid := 0
	err = raw.Control(func(fd uintptr) {
		cred, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if e == nil && cred != nil && cred.Uid == uint32(os.Getuid()) && cred.Uid > 0 && cred.Pid > 0 {
			pid = int(cred.Pid)
		}
	})
	if err != nil || pid == 0 {
		return 0, errAdmission
	}
	return pid, nil
}

func verifySupervisor(pid int, want string) error {
	base := "/proc/" + strconv.Itoa(pid) + "/"
	exe, err := os.Readlink(base + "exe")
	if err != nil || !strings.HasPrefix(exe, "/") {
		return errAdmission
	}
	f, err := os.Open(base + "exe")
	if err != nil {
		return errAdmission
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, 16<<20+1))
	if err != nil || n == 0 || n > 16<<20 || hex.EncodeToString(h.Sum(nil)) != want {
		return errAdmission
	}
	for _, ns := range []string{"pid", "mnt", "user", "net"} {
		a, err := os.Stat("/proc/self/ns/" + ns)
		if err != nil {
			return errAdmission
		}
		b, err := os.Stat(base + "ns/" + ns)
		if err != nil {
			return errAdmission
		}
		x, ok := a.Sys().(*syscall.Stat_t)
		y, ok2 := b.Sys().(*syscall.Stat_t)
		if !ok || !ok2 || x.Ino != y.Ino {
			return errAdmission
		}
	}
	return nil
}
