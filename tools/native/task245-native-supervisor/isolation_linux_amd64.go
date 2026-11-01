//go:build linux && amd64

package main

import (
	"errors"
	"os"
	"strings"
	"syscall"
)

var errDomainWorker = errors.New("domain worker authentication rejected")

// domainWorkerMain authenticates the C bootstrap's inherited descriptors and
// the worker's placement in the private namespace before accepting any protocol.
func domainWorkerMain() error {
	if len(os.Args) != 2 || os.Args[1] != "--task245-domain-worker" || len(os.Environ()) != 0 || os.Geteuid() == 0 || os.Getpid() != 2 || os.Getppid() != 1 {
		return errDomainWorker
	}
	var image, sock, metadata syscall.Stat_t
	if syscall.Fstat(3, &image) != nil || image.Mode&syscall.S_IFMT != syscall.S_IFREG || image.Size <= 0 || image.Uid != 0 || image.Mode&0022 != 0 {
		return errDomainWorker
	}
	seals, _, errno := syscall.Syscall(syscall.SYS_FCNTL, 3, 1034, 0)
	if errno != 0 || seals&0xf != 0xf {
		return errDomainWorker
	}
	if syscall.Fstat(4, &sock) != nil || sock.Mode&syscall.S_IFMT != syscall.S_IFSOCK || syscall.Fstat(6, &metadata) != nil || metadata.Mode&syscall.S_IFMT != syscall.S_IFREG || metadata.Uid != 0 || metadata.Size <= 0 || metadata.Size > 16384 {
		return errDomainWorker
	}
	metaSeals, _, errno := syscall.Syscall(syscall.SYS_FCNTL, 6, 1034, 0)
	if errno != 0 || metaSeals&0xf != 0xf {
		return errDomainWorker
	}
	var pid, mnt, netns syscall.Stat_t
	if syscall.Stat("/proc/self/ns/pid", &pid) != nil || syscall.Stat("/proc/1/ns/pid", &mnt) != nil || pid.Ino != mnt.Ino || syscall.Stat("/proc/self/ns/mnt", &mnt) != nil || syscall.Stat("/proc/1/ns/mnt", &netns) != nil || mnt.Ino != netns.Ino {
		return errDomainWorker
	}
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil || len(b) == 0 || len(b) > 4<<20 || !hasExpectedPrivateMounts(string(b)) {
		return errDomainWorker
	}
	return runConnectedWorker()
}

func hasExpectedPrivateMounts(data string) bool {
	proc, run := false, false
	for _, line := range strings.Split(data, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 10 { return false }
		sep := -1
		for i := 6; i < len(f); i++ { if f[i] == "-" { sep = i; break } }
		if sep < 0 || len(f) <= sep+2 { return false }
		if f[4] == "/proc" && f[sep+1] == "proc" { proc = true }
		if f[4] == "/run" && f[sep+1] == "tmpfs" { run = true }
	}
	return proc && run
}

// Fixed response framing: callers must not interpret this as a general grant.
var domainReadyRecord = [8]byte{'S','S','R','D','Y','0','0','1'}
var domainAckRecord = [8]byte{'S','S','A','C','K','0','0','1'}
