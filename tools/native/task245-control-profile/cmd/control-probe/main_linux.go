//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

const harnessPath = "/lab/bin/harness"
const childMarker = "--control-probe-child"
const processVMReadv = 310
const pidfdOpen = 434

func denied(result uintptr, errno syscall.Errno, want syscall.Errno) bool {
	return result == ^uintptr(0) && errno == want
}

func ptraceDenied() bool {
	r, _, e := syscall.RawSyscall(syscall.SYS_PTRACE, 0, 0, 0)
	return denied(r, e, syscall.EPERM)
}

func check() bool {
	if !ptraceDenied() {
		return false
	}
	bytebuf := byte(0)
	local := syscall.Iovec{Base: &bytebuf, Len: 1}
	remote := syscall.Iovec{Base: &bytebuf, Len: 1}
	r, _, e := syscall.RawSyscall6(processVMReadv, uintptr(os.Getppid()), uintptr(unsafe.Pointer(&local)), 1, uintptr(unsafe.Pointer(&remote)), 1, 0)
	runtime.KeepAlive(&bytebuf)
	runtime.KeepAlive(&local)
	runtime.KeepAlive(&remote)
	if !denied(r, e, syscall.EPERM) {
		return false
	}
	r, _, e = syscall.RawSyscall(pidfdOpen, uintptr(os.Getppid()), 0, 0)
	if !denied(r, e, syscall.EPERM) {
		if r != ^uintptr(0) {
			_ = syscall.Close(int(r))
		}
		return false
	}
	fd, socketErr := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if fd >= 0 {
		_ = syscall.Close(fd)
	}
	if socketErr != syscall.EPERM {
		return false
	}
	pair, pairErr := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if pairErr == nil {
		syscall.Close(pair[0])
		syscall.Close(pair[1])
		return false
	}
	if pairErr != syscall.EPERM {
		return false
	}
	for _, path := range []string{"/proc/self/mem", "/proc/self/fd/0"} {
		fd, openErr := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
		if openErr != syscall.EACCES {
			return false
		}
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		return false
	}
	return syscall.Close(fd) == nil
}

func child() {
	if len(os.Args) != 2 || os.Args[1] != childMarker || !check() {
		os.Exit(1)
	}
	os.Exit(0)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == childMarker {
		child()
	}
	if len(os.Args) != 3 {
		os.Exit(2)
	}
	if !check() {
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, harnessPath, childMarker)
	cmd.Env = []string{}
	cmd.Stdin = os.Stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil || stdout.Len() != 0 || stderr.Len() != 0 {
		os.Exit(1)
	}
	n, err := os.Stdout.WriteString("CONTROL_CONFINEMENT_OK\n")
	if err != nil || n != len("CONTROL_CONFINEMENT_OK\n") {
		os.Exit(1)
	}
}
