//go:build linux && amd64

package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"clawforge/tools/native/task240-native/task245-acceptance/internal/diagnostics"
)

const maxExecutable = 64 << 20
const authDir = "/run/task245-services"

type Error struct{ Code string }

type PreflightError struct {
	Role, Case string
	Cause      error
}

func (e *PreflightError) Error() string { return "service preflight failed" }
func (e *PreflightError) Unwrap() error { return e.Cause }

func (e *Error) Error() string { return "service attestation: " + e.Code }
func fail(code string) error  { return &Error{Code: code} }

type roleSpec struct{ executable, socket string }

var roles = map[string]roleSpec{
	"metadata": {"/lab/bin/native-metadata", "/run/task245-metadata.sock"},
	"broker":   {"/lab/bin/native-lab-broker", "/run/task245-lab/broker.sock"},
}

type Child struct {
	Cmd         *exec.Cmd
	diagnostics *diagnostics.Capture
	done        chan error
	once        sync.Once
	waitErr     error
	start       uint64
}

func (c *Child) DiagnosticBytes() []byte {
	if c == nil || c.diagnostics == nil {
		return nil
	}
	return c.diagnostics.Bytes()
}

func Start(ctx context.Context, executable string, args ...string) (*Child, error) {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = []string{}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	return startOwned(cmd, procStart)
}

func startOwned(cmd *exec.Cmd, capture func(int) (uint64, error)) (*Child, error) {
	if err := cmd.Start(); err != nil {
		return nil, fail("start")
	}
	c := &Child{Cmd: cmd, done: make(chan error, 1)}
	go c.Wait()
	start, err := capture(cmd.Process.Pid)
	if err == nil && start != 0 {
		c.start = start
		return c, nil
	}
	if err == nil {
		err = fail("process-stat")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cleanupErr := c.stopUnidentified(ctx)
	if cleanupErr != nil {
		return c, cleanupErr
	}
	return nil, err
}

func (c *Child) stopUnidentified(ctx context.Context) error {
	if c == nil || c.Cmd == nil || c.Cmd.Process == nil {
		return fail("process")
	}
	if err := c.Cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fail("kill-refused")
	}
	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return fail("reap-timeout")
	}
}

func (c *Child) Wait() error {
	if c == nil {
		return fail("process")
	}
	c.once.Do(func() {
		c.waitErr = c.Cmd.Wait()
		c.done <- c.waitErr
		close(c.done)
	})
	return c.waitErr
}

func (c *Child) Done() <-chan error {
	if c == nil {
		return nil
	}
	return c.done
}

func (c *Child) Stop(ctx context.Context) error {
	if c == nil || c.Cmd == nil || c.Cmd.Process == nil {
		return fail("process")
	}
	select {
	case <-c.done:
		return nil
	default:
	}
	if c.start == 0 {
		return c.stopUnidentified(ctx)
	}
	now, err := procStart(c.Cmd.Process.Pid)
	if err != nil || now != c.start {
		if err != nil {
			return fail("kill-refused")
		}
		return fail("process-changed")
	}
	if err = c.Cmd.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fail("kill-refused")
	}
	timer := time.NewTimer(500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-c.done:
		return nil
	case <-timer.C:
	}
	now, err = procStart(c.Cmd.Process.Pid)
	if err != nil || now != c.start {
		if err != nil {
			select {
			case <-c.done:
				return nil
			case <-ctx.Done():
				return fail("reap-timeout")
			}
		}
		return fail("process-changed")
	}
	if err = c.Cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fail("kill-refused")
	}
	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return fail("reap-timeout")
	}
}

func procStart(pid int) (uint64, error) {
	f, e := os.Open(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return 0, fail("process-stat")
	}
	b, e := io.ReadAll(io.LimitReader(f, 8193))
	_ = f.Close()
	if e != nil || len(b) > 8192 {
		return 0, fail("process-stat")
	}
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return 0, fail("process-stat")
	}
	fields := strings.Fields(string(b[i+1:]))
	if len(fields) <= 19 {
		return 0, fail("process-stat")
	}
	n, e := strconv.ParseUint(fields[19], 10, 64)
	if e != nil {
		return 0, fail("process-stat")
	}
	return n, nil
}

func digest(f *os.File) (string, error) {
	if n, e := f.Seek(0, 0); e != nil || n != 0 {
		return "", fail("executable-file")
	}
	h := sha256.New()
	size, e := io.Copy(h, io.LimitReader(f, maxExecutable+1))
	if e != nil || size > maxExecutable {
		return "", fail("executable-size")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func rootCheck() error {
	if os.Geteuid() != 0 {
		return fail("root-required")
	}
	if os.Getenv("GITHUB_ACTIONS") != "true" {
		return fail("ci-required")
	}
	var m syscall.Stat_t
	if syscall.Lstat("/lab/disposable-profile", &m) != nil || m.Mode&syscall.S_IFMT != syscall.S_IFREG || m.Mode&07777 != 0444 || m.Uid != 0 {
		return fail("profile-marker")
	}
	for _, p := range []string{"/", "/run", "/lab", "/lab/bin", "/run/task245-lab"} {
		s, e := os.Lstat(p)
		if e != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
			return fail("directory")
		}
		st, ok := s.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || st.Mode&0022 != 0 {
			return fail("directory")
		}
	}
	var fs syscall.Statfs_t
	if syscall.Statfs("/lab/bin", &fs) != nil || uint64(fs.Flags)&1 == 0 {
		return fail("lab-not-readonly")
	}
	return nil
}

func artifact(path string) (*os.File, *syscall.Stat_t, string, error) {
	f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, nil, "", fail("executable-file")
	}
	var s syscall.Stat_t
	if syscall.Fstat(int(f.Fd()), &s) != nil || s.Mode&syscall.S_IFMT != syscall.S_IFREG || s.Uid != 0 || s.Nlink != 1 || s.Mode&0022 != 0 || s.Mode&0111 != 0111 || s.Size < 1 || s.Size > maxExecutable {
		_ = f.Close()
		return nil, nil, "", fail("executable-file")
	}
	h, e := digest(f)
	if e != nil {
		_ = f.Close()
		return nil, nil, "", e
	}
	return f, &s, h, nil
}

func listener(pid int, path string) error {
	f, e := os.Open("/proc/net/unix")
	if e != nil {
		return fail("listener-table")
	}
	b, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	_ = f.Close()
	if e != nil || len(b) > 1<<20 {
		return fail("listener-table")
	}
	var inode string
	count := 0
	for _, line := range bytes.Split(b, []byte{'\n'})[1:] {
		fields := bytes.Fields(line)
		if len(fields) >= 8 && bytes.Equal(fields[3], []byte("00010000")) && bytes.Equal(fields[4], []byte("0005")) && bytes.Equal(fields[7], []byte(path)) {
			inode = string(fields[6])
			count++
		}
	}
	if count != 1 {
		return fail("listener")
	}
	entries, e := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if e != nil || len(entries) > 4096 {
		return fail("process-fds")
	}
	target := "socket:[" + inode + "]"
	for _, entry := range entries {
		p := fmt.Sprintf("/proc/%d/fd/%s", pid, entry.Name())
		link, e := os.Readlink(p)
		if e == nil && link == target {
			var s syscall.Stat_t
			if syscall.Stat(p, &s) == nil && s.Mode&syscall.S_IFMT == syscall.S_IFSOCK {
				return nil
			}
		}
	}
	return fail("listener-owner")
}

func socketIdentity(path string) (syscall.Stat_t, error) {
	var st syscall.Stat_t
	if syscall.Lstat(path, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Uid != 0 || st.Mode&07777 != 0666 {
		return st, fail("socket")
	}
	return st, nil
}

func Attest(c *Child, executable, socket, role string) error {
	spec, ok := roles[role]
	if !ok {
		return fail("role")
	}
	if executable != spec.executable || socket != spec.socket {
		return fail("role-path")
	}
	if e := rootCheck(); e != nil {
		return e
	}
	if c == nil || c.Cmd == nil || c.Cmd.Process == nil {
		return fail("process-exited")
	}
	select {
	case <-c.done:
		return fail("process-exited")
	default:
	}
	pid := c.Cmd.Process.Pid
	start, e := procStart(pid)
	if e != nil || start != c.start {
		return fail("process-stat")
	}
	expected, es, hash, e := artifact(spec.executable)
	if e != nil {
		return e
	}
	defer expected.Close()
	actual, e := os.Open(fmt.Sprintf("/proc/%d/exe", pid))
	if e != nil {
		return fail("process-executable")
	}
	var as syscall.Stat_t
	ae := syscall.Fstat(int(actual.Fd()), &as)
	ah, he := digest(actual)
	_ = actual.Close()
	if ae != nil || he != nil || as.Dev != es.Dev || as.Ino != es.Ino || ah != hash {
		return fail("process-executable")
	}
	ss, e := socketIdentity(socket)
	if e != nil {
		return e
	}
	if e = listener(pid, socket); e != nil {
		return e
	}
	if e = validateAuthDir(true); e != nil {
		return e
	}
	payload := fmt.Sprintf("OCLABAUTH1 %d %d %d %d %d %d %s\n", pid, start, es.Dev, es.Ino, ss.Dev, ss.Ino, hash)
	tmp := filepath.Join(authDir, role+".new")
	final := filepath.Join(authDir, role+".auth")
	fd, e := syscall.Open(tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0644)
	if e != nil {
		return fail("publish")
	}
	f := os.NewFile(uintptr(fd), tmp)
	published := false
	defer func() {
		_ = f.Close()
		if !published {
			_ = os.Remove(tmp)
		}
	}()
	if _, e = f.Write([]byte(payload)); e != nil {
		return fail("publish-write")
	}
	if e = f.Sync(); e != nil {
		return fail("publish-write")
	}
	if e = f.Chown(0, 0); e != nil {
		return fail("publish-write")
	}
	if e = f.Chmod(0444); e != nil {
		return fail("publish-write")
	}
	var pub syscall.Stat_t
	if syscall.Fstat(int(f.Fd()), &pub) != nil || pub.Mode&syscall.S_IFMT != syscall.S_IFREG || pub.Uid != 0 || pub.Nlink != 1 || pub.Mode&07777 != 0444 {
		return fail("publish-write")
	}
	if e = f.Close(); e != nil {
		return fail("publish")
	}
	if _, e = os.Lstat(final); e == nil {
		return fail("attestation-exists")
	} else if !errors.Is(e, os.ErrNotExist) {
		return fail("publish")
	}
	n, e := procStart(pid)
	if e != nil || n != start {
		return fail("process-changed")
	}
	again, e := socketIdentity(socket)
	if e != nil || again.Dev != ss.Dev || again.Ino != ss.Ino {
		return fail("socket-changed")
	}
	if e = listener(pid, socket); e != nil {
		return e
	}
	if e = os.Rename(tmp, final); e != nil {
		return fail("publish")
	}
	published = true
	return nil
}
func validateAuthDir(create bool) error {
	if create {
		if e := os.Mkdir(authDir, 0755); e != nil && !errors.Is(e, os.ErrExist) {
			return fail("attestation-directory")
		}
	}
	var st syscall.Stat_t
	if e := syscall.Lstat(authDir, &st); e != nil {
		if !create && errors.Is(e, os.ErrNotExist) {
			return e
		}
		return fail("attestation-directory")
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&07777 != 0755 {
		return fail("attestation-directory")
	}
	return nil
}

func Remove(role string) error {
	if _, ok := roles[role]; !ok {
		return fail("role")
	}
	if e := rootCheck(); e != nil {
		return e
	}
	if e := validateAuthDir(false); e != nil {
		if errors.Is(e, os.ErrNotExist) {
			return nil
		}
		return e
	}
	var e error
	if e = os.Remove(filepath.Join(authDir, role+".auth")); e != nil && !errors.Is(e, os.ErrNotExist) {
		return fail("remove")
	}
	return nil
}

func WaitReady(ctx context.Context, c *Child, socket string) error {
	if c == nil || c.Cmd == nil || c.Cmd.Process == nil {
		return fail("process")
	}
	spec := roles["metadata"]
	if socket != spec.socket && socket != roles["broker"].socket {
		return fail("role-path")
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return fail("readiness-timeout")
		}
		select {
		case <-c.done:
			return fail("process-exited")
		default:
		}
		n, e := procStart(c.Cmd.Process.Pid)
		if e != nil || n != c.start {
			return fail("process-changed")
		}
		_, e = socketIdentity(socket)
		if e == nil {
			if e = listener(c.Cmd.Process.Pid, socket); e == nil {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fail("readiness-timeout")
		case <-ticker.C:
		}
	}
}
