//go:build linux && amd64

package metadata

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	cancelOwnerName  = "native-cancel-owner"
	faultReachedName = "native-fault-reached"
	cancelAckName    = "cancel-ack"
)

func (s *service) ownerCapture() error {
	fd, err := syscall.Openat(s.root, cancelOwnerName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)

	var st syscall.Stat_t
	if err = syscall.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != 65534 || st.Mode&07777 != 0600 || st.Nlink != 1 || st.Size < 1 || st.Size > 96 {
		return syscall.EACCES
	}
	data := make([]byte, int(st.Size)+1)
	n, err := syscall.Pread(fd, data[:len(data)-1], 0)
	if err != nil {
		return err
	}
	if n != int(st.Size) {
		return syscall.EACCES
	}
	text := string(data[:n])
	fields := strings.Fields(text)
	if len(fields) != 3 {
		return syscall.EACCES
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil || pid <= 1 || strconv.Itoa(pid) != fields[0] {
		return syscall.EACCES
	}
	ticks, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil || strconv.FormatUint(ticks, 10) != fields[1] {
		return syscall.EACCES
	}
	parent, err := strconv.Atoi(fields[2])
	if err != nil || parent <= 1 || strconv.Itoa(parent) != fields[2] {
		return syscall.EACCES
	}
	parentExe, err := statPath("/proc/" + itoa(parent) + "/exe")
	if err != nil {
		return err
	}
	expected, err := lstatPath("/lab/ssjack")
	if err != nil {
		return err
	}
	if !rootArtifact(&expected) || parentExe.Mode&syscall.S_IFMT != syscall.S_IFREG || parentExe.Dev != expected.Dev || parentExe.Ino != expected.Ino {
		return syscall.EACCES
	}
	s.owner = processIdentity{PID: pid, Start: ticks}
	s.ownerParent = parent
	s.ownerSet = true
	alive, err := s.ownerAlive()
	if err != nil || !alive {
		s.ownerSet = false
		if err != nil {
			return err
		}
		return syscall.EACCES
	}
	return nil
}

func (s *service) ownerAlive() (bool, error) {
	if !s.ownerSet {
		return false, syscall.EACCES
	}
	data, err := os.ReadFile("/proc/" + itoa(s.owner.PID) + "/stat")
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return false, nil
		}
		return false, err
	}
	if len(data) > 4096 {
		return false, syscall.EIO
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return false, syscall.EIO
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) <= 19 {
		return false, syscall.EIO
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return false, syscall.EIO
	}
	if parent != s.ownerParent {
		return false, syscall.EACCES
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return false, syscall.EIO
	}
	return ticks == s.owner.Start, nil
}

func (s *service) faultCancel() bool {
	fd, err := syscall.Openat(s.root, faultReachedName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != 65534 || st.Mode&07777 != 0600 || st.Nlink != 1 || st.Size != 6 {
		return false
	}
	data := make([]byte, 6)
	n, err := syscall.Pread(fd, data, 0)
	return err == nil && n == 6 && string(data) == "cancel"
}

func (s *service) releaseACK() bool {
	content := make([]byte, 7)
	n, err := syscall.Pread(s.slot, content, 0)
	if err != nil || n != 7 || string(content) != "release" || !s.haveReceipt || !s.faultCancel() {
		return false
	}
	fd, err := syscall.Openat(s.root, receiptName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false
	}
	var st syscall.Stat_t
	valid := syscall.Fstat(fd, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Uid == 65534 && st.Nlink == 1 && st.Mode&07777 == 0600 && st.Size == 48
	current := make([]byte, 48)
	if valid {
		n, err = syscall.Pread(fd, current, 0)
		valid = err == nil && n == 48 && string(current) == string(s.lastReceipt[:])
	}
	closeErr := syscall.Close(fd)
	if !valid || closeErr != nil {
		return false
	}
	alive, err := s.ownerAlive()
	if err != nil {
		return false
	}
	if !alive {
		return true
	}
	ack, err := syscall.Openat(s.root, cancelAckName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return false
	}
	cleanup := func() {
		_ = syscall.Close(ack)
		_ = syscall.Unlinkat(s.root, cancelAckName)
	}
	if err = syscall.Fchown(ack, 65534, 65534); err != nil {
		cleanup()
		return false
	}
	var ackStat syscall.Stat_t
	if err = syscall.Fstat(ack, &ackStat); err != nil || ackStat.Mode&syscall.S_IFMT != syscall.S_IFREG || ackStat.Uid != 65534 || ackStat.Nlink != 1 || ackStat.Mode&07777 != 0600 {
		cleanup()
		return false
	}
	written, err := s.writeACK(ack, []byte("release"))
	if err != nil || written != 7 {
		cleanup()
		return false
	}
	if err = s.syncACK(ack); err != nil {
		cleanup()
		return false
	}
	if err = s.closeACK(ack); err != nil {
		_ = syscall.Unlinkat(s.root, cancelAckName)
		return false
	}
	for i := 0; i < 100; i++ {
		alive, err = s.ownerAlive()
		if err != nil {
			return false
		}
		if !alive {
			_ = syscall.Unlinkat(s.root, cancelAckName)
			return true
		}
		if err = syscall.Faccessat(s.root, cancelAckName, 0, 0x100); errors.Is(err, syscall.ENOENT) {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	alive, err = s.ownerAlive()
	return err == nil && !alive
}

func (s *service) handleUnlink(request notification, authorized bool) response {
	result := response{ID: request.ID, Errno: -int32(syscall.EACCES)}
	if !authorized || int(int32(request.Data.Args[0])) != -100 {
		return result
	}
	path, err := copyPath(int(request.PID), request.Data.Args[1])
	if err != nil || path != requestPath {
		return result
	}
	fd, err := syscall.Openat(s.root, cancelAckName, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err == syscall.ENOENT {
		result.Errno = -int32(syscall.ENOENT)
		return result
	}
	if err != nil {
		return result
	}
	var st syscall.Stat_t
	valid := syscall.Fstat(fd, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Uid == 65534 && st.Nlink == 1 && st.Mode&07777 == 0600 && st.Size == 7
	data := make([]byte, 7)
	if valid {
		n, readErr := syscall.Pread(fd, data, 0)
		valid = readErr == nil && n == 7 && string(data) == "release"
	}
	_ = syscall.Close(fd)
	if !valid {
		return result
	}
	if !validID(s.listener, request.ID) {
		return result
	}
	if err = syscall.Unlinkat(s.root, cancelAckName); err != nil {
		result.Errno = -int32(errnoNumber(err))
		return result
	}
	result.Errno = 0
	return result
}

func (s *service) closeCancel(request notification, authorized bool) response {
	result := response{ID: request.ID}
	if !s.active || !authorized {
		return result
	}
	if !validID(s.listener, request.ID) {
		result.Errno = -int32(syscall.EACCES)
		return result
	}
	released := s.releaseACK()
	_ = syscall.Close(s.slot)
	s.slot = -1
	s.active = false
	if !released {
		result.Errno = -int32(syscall.EIO)
	}
	return result
}
