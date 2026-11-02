//go:build linux && amd64

package metadata

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func statPath(path string) (syscall.Stat_t, error) {
	var st syscall.Stat_t
	err := syscall.Stat(path, &st) // Stat follows /proc/TID/exe symlinks.
	return st, err
}

func lstatPath(path string) (syscall.Stat_t, error) {
	var st syscall.Stat_t
	err := syscall.Lstat(path, &st)
	return st, err
}

func startTime(pid int) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	if len(data) > 4096 {
		return 0, errors.New("proc stat exceeds limit")
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return 0, errors.New("malformed proc stat")
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) <= 19 {
		return 0, errors.New("short proc stat")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}

func sameProcess(a, b processIdentity) bool {
	if a.PID != b.PID {
		return false
	}
	current, err := startTime(a.PID)
	return err == nil && current == a.Start
}

func rootArtifact(st *syscall.Stat_t) bool {
	return st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Uid == 0 && st.Nlink == 1 && st.Mode&0022 == 0
}

func artifact(path string) (inode, error) {
	st, err := lstatPath(path)
	if err != nil { return inode{}, err }
	if !rootArtifact(&st) { return inode{}, syscall.EACCES }
	return inode{Device: uint64(st.Dev), Number: st.Ino}, nil
}

func initialPeerIdentity(peer processIdentity, observe func(index int) error) (inode, error) {
	if !sameProcess(peer, peer) {
		return inode{}, syscall.EACCES
	}
	st, err := statPath(fmt.Sprintf("/proc/%d/exe", peer.PID))
	if err != nil {
		return inode{}, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return inode{}, syscall.EACCES
	}
	actual := inode{Device: uint64(st.Dev), Number: st.Ino}
	if !sameProcess(peer, peer) {
		return inode{}, syscall.EACCES
	}
	paths := [...]string{"/lab/harness", "/lab/bin/harness", "/lab/bin/control-installer", "/lab/control-profile"}
	for index, path := range paths {
		if observe != nil {
			if err := observe(index); err != nil {
				return inode{}, err
			}
		}
		expected, err := artifact(path)
		if err == nil && actual == expected {
			if !sameProcess(peer, peer) {
				return inode{}, syscall.EACCES
			}
			return actual, nil
		}
	}
	return inode{}, syscall.EACCES
}

func InitialPeerIdentityRegression(pid int, start uint64, observe func(int) error) error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return syscall.EACCES
	}
	if pid <= 1 || start == 0 {
		return syscall.EACCES
	}
	_, err := initialPeerIdentity(processIdentity{PID: pid, Start: start}, observe)
	return err
}

func identityAt(pid int, path string) (inode, error) {
	st, err := statPath(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return inode{}, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return inode{}, syscall.EACCES
	}
	expected, err := artifact(path)
	if err != nil { return inode{}, err }
	actual := inode{Device: uint64(st.Dev), Number: st.Ino}
	if actual != expected {
		return inode{}, syscall.EACCES
	}
	return actual, nil
}

func processTGID(tid int) (int, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", tid))
	if err != nil {
		return 0, err
	}
	if len(data) > 16<<10 {
		return 0, errors.New("proc status exceeds limit")
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "Tgid:") {
			return strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "Tgid:")))
		}
	}
	return 0, errors.New("missing process TGID")
}

func marker(path string) bool {
	st, err := lstatPath(path)
	return err == nil && rootArtifact(&st) && st.Mode&07777 == 0444 && st.Size > 0 && st.Size <= 128
}
