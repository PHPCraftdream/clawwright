//go:build linux && amd64

package proof

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	socketPath = "/run/task245-metadata.sock"
	authPath   = "/run/task245-services/metadata.auth"
	binaryPath = "/lab/bin/native-metadata"
)

type record struct {
	pid, start, execDev, execIno, socketDev, socketIno uint64
	hash string
}

func parseRecord(data []byte) (record, error) {
	var result record
	if len(data) < 1 || len(data) > 511 || data[len(data)-1] != '\n' || strings.Count(string(data), "\n") != 1 {
		return result, errors.New("malformed service record")
	}
	line := string(data[:len(data)-1])
	fields := strings.Split(line, " ")
	if len(fields) != 8 || fields[0] != "OCLABAUTH1" || len(fields[7]) != 64 {
		return result, errors.New("malformed service record")
	}
	for _, c := range fields[7] {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return result, errors.New("malformed service hash")
		}
	}
	values := [6]uint64{}
	for i := range values {
		if fields[i+1] == "" || (len(fields[i+1]) > 1 && fields[i+1][0] == '0') {
			return result, errors.New("noncanonical service identity")
		}
		for _, c := range fields[i+1] {
			if c < '0' || c > '9' {
				return result, errors.New("noncanonical service identity")
			}
		}
		v, err := strconv.ParseUint(fields[i+1], 10, 64)
		if err != nil || strconv.FormatUint(v, 10) != fields[i+1] {
			return result, errors.New("invalid service identity")
		}
		values[i] = v
	}
	result = record{pid: values[0], start: values[1], execDev: values[2], execIno: values[3], socketDev: values[4], socketIno: values[5], hash: fields[7]}
	if result.pid <= 1 || result.pid > 2147483647 || result.start == 0 || result.execIno == 0 || result.socketIno == 0 {
		return record{}, errors.New("invalid service identity")
	}
	return result, nil
}

func rootPath(path string) error {
	root, err := os.Lstat("/")
	if err != nil || !root.IsDir() {
		return errors.New("untrusted service root")
	}
	rootStat, ok := root.Sys().(*syscall.Stat_t)
	if !ok || rootStat.Uid != 0 || rootStat.Mode&0022 != 0 {
		return errors.New("mutable service root")
	}
	cur := "/"
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		cur += part
		st, err := os.Lstat(cur)
		if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("untrusted service path")
		}
		s, ok := st.Sys().(*syscall.Stat_t)
		if !ok || s.Uid != 0 || s.Mode&0022 != 0 {
			return errors.New("mutable service path")
		}
		cur += "/"
	}
	return nil
}

func loadRecord() (record, error) {
	var empty record
	for _, dir := range []string{"/", "/run", "/run/task245-services", "/lab", "/lab/bin"} {
		if err := rootPath(dir); err != nil {
			return empty, err
		}
	}
	fd, err := syscall.Open(authPath, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return empty, err
	}
	f := os.NewFile(uintptr(fd), authPath)
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() < 1 || st.Size() > 511 {
		return empty, errors.New("invalid service record")
	}
	fs, ok := st.Sys().(*syscall.Stat_t)
	if !ok || fs.Uid != 0 || fs.Nlink != 1 || fs.Mode&07777 != 0444 {
		return empty, errors.New("untrusted service record")
	}
	data := make([]byte, int(st.Size()))
	n, err := f.Read(data)
	if err != nil || n != len(data) {
		return empty, errors.New("short service record")
	}
	p, err := parseRecord(data)
	if err != nil {
		return empty, err
	}
	if err = checkArtifact(p); err != nil {
		return empty, err
	}
	return p, nil
}

func checkArtifact(p record) error {
	st, err := os.Lstat(binaryPath)
	if err != nil {
		return err
	}
	s, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.Mode().IsRegular() || s.Uid != 0 || s.Nlink != 1 || s.Mode&07777 != 0555 || uint64(s.Dev) != p.execDev || s.Ino != p.execIno {
		return errors.New("metadata artifact identity mismatch")
	}
	sock, err := os.Lstat(socketPath)
	if err != nil {
		return err
	}
	ss, ok := sock.Sys().(*syscall.Stat_t)
	if !ok || sock.Mode()&os.ModeSocket == 0 || ss.Uid != 0 || ss.Mode&07777 != 0666 || uint64(ss.Dev) != p.socketDev || ss.Ino != p.socketIno {
		return errors.New("metadata socket identity mismatch")
	}
	return checkProc(p)
}

func checkProc(p record) error {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", p.pid))
	if err != nil || len(b) > 4096 {
		return errors.New("service process unavailable")
	}
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 {
		return errors.New("malformed service stat")
	}
	fields := strings.Fields(string(b[i+1:]))
	if len(fields) <= 19 {
		return errors.New("short service stat")
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || start != p.start {
		return errors.New("service process identity changed")
	}
	return nil
}

func ConnectAndVerify() (int, error) {
	p, err := loadRecord()
	if err != nil {
		return -1, err
	}
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	fail := func(e error) (int, error) {
		if closeErr := syscall.Close(fd); closeErr != nil {
			return -1, fmt.Errorf("%v (close socket: %w)", e, closeErr)
		}
		return -1, e
	}
	if err = syscall.Connect(fd, &syscall.SockaddrUnix{Name: socketPath}); err != nil {
		return fail(fmt.Errorf("metadata service connect: %w", err))
	}
	var cred syscall.Ucred
	size := uint32(unsafe.Sizeof(cred))
	_, _, errno := syscall.Syscall6(syscall.SYS_GETSOCKOPT, uintptr(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED, uintptr(unsafe.Pointer(&cred)), uintptr(unsafe.Pointer(&size)), 0)
	if errno != 0 {
		return fail(errno)
	}
	if cred.Uid != 0 || uint64(cred.Pid) != p.pid {
		return fail(errors.New("unexpected metadata service peer"))
	}
	if err = checkArtifact(p); err != nil {
		return fail(err)
	}
	return fd, nil
}
