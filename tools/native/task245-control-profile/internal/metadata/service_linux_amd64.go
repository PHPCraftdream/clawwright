//go:build linux && amd64

package metadata

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
	"unsafe"
)

var errDaemonTimeout = errors.New("metadata daemon lifetime expired")

func waitSocketUntil(fd int, deadline time.Time) error {
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return errDaemonTimeout
		}

		var pollFD notifierPollFD
		pollFD.FD = int32(fd)
		pollFD.Events = 1 // POLLIN
		milliseconds := (remaining + time.Millisecond - 1) / time.Millisecond
		result, _, errno := syscall.Syscall(
			syscall.SYS_POLL,
			uintptr(unsafe.Pointer(&pollFD)),
			1,
			uintptr(milliseconds),
		)
		if errno == syscall.EINTR {
			continue
		}
		if errno != 0 {
			return errno
		}
		if result == 0 {
			return errDaemonTimeout
		}

		// A readable socket takes precedence over HUP: recv/accept must drain
		// any queued data and report its own result.
		if !time.Now().Before(deadline) {
			return errDaemonTimeout
		}
		if pollFD.Revents&1 != 0 { // POLLIN
			return nil
		}
		if pollFD.Revents&0x20 != 0 { // POLLNVAL
			return syscall.EBADF
		}
		if pollFD.Revents&0x08 != 0 { // POLLERR
			return syscall.EIO
		}
		if pollFD.Revents&0x10 != 0 { // POLLHUP
			return syscall.EPIPE
		}
		return syscall.EIO
	}
}

func Serve() error {
	return serveWithACKFaultDeadline("", 600*time.Second)
}

func ServeLifetimeRegression() error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return syscall.EPERM
	}
	return serveWithACKFaultDeadline("", 2*time.Second)
}

func ServeCanceledRegression() error {
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return syscall.EPERM
	}
	return serveWithACKFaultDeadline("canceled", 2*time.Second)
}

func ServeACKRegression(phase string) error {
	if phase != "write" && phase != "fsync" && phase != "close" {
		return syscall.EINVAL
	}
	if os.Geteuid() != 0 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return syscall.EPERM
	}
	return serveWithACKFault(phase)
}

func serveWithACKFault(phase string) error {
	return serveWithACKFaultDeadline(phase, 600*time.Second)
}

func serveWithACKFaultDeadline(phase string, lifetime time.Duration) error {
	deadline := time.Now().Add(lifetime)
	if err := requireRoot(); err != nil {
		return err
	}
	if !marker("/lab/disposable-profile") || !marker("/lab/scenario") {
		return errors.New("missing disposable lab markers")
	}
	if _, err := lstatPath(socketPath); err == nil || err != syscall.ENOENT {
		return errors.New("metadata socket already exists")
	}

	listener, err := syscall.Socket(
		syscall.AF_UNIX,
		syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC|syscall.SOCK_NONBLOCK,
		0,
	)
	if err != nil {
		return err
	}
	defer syscall.Close(listener)
	if err := syscall.Bind(listener, &syscall.SockaddrUnix{Name: socketPath}); err != nil {
		return err
	}
	defer syscall.Unlink(socketPath)
	if err := syscall.Chmod(socketPath, 0666); err != nil {
		return err
	}
	if err := syscall.Listen(listener, 4); err != nil {
		return err
	}

	var client int
	for {
		if !time.Now().Before(deadline) {
			return fmt.Errorf("metadata accept timeout: %w", errDaemonTimeout)
		}
		client, _, err = syscall.Accept4(listener, syscall.SOCK_CLOEXEC|syscall.SOCK_NONBLOCK)
		if err == syscall.EINTR {
			continue
		}
		if err == syscall.EAGAIN || err == syscall.EWOULDBLOCK {
			if waitErr := waitSocketUntil(listener, deadline); waitErr != nil {
				if errors.Is(waitErr, errDaemonTimeout) {
					return fmt.Errorf("metadata accept timeout: %w", waitErr)
				}
				return fmt.Errorf("metadata accept poll: %w", waitErr)
			}
			continue
		}
		if err != nil {
			return err
		}
		break
	}
	defer syscall.Close(client)

	var credential syscall.Ucred
	size := uint32(unsafe.Sizeof(credential))
	_, _, errno := syscall.Syscall6(
		syscall.SYS_GETSOCKOPT,
		uintptr(client),
		syscall.SOL_SOCKET,
		syscall.SO_PEERCRED,
		uintptr(unsafe.Pointer(&credential)),
		uintptr(unsafe.Pointer(&size)),
		0,
	)
	if errno != 0 {
		return errno
	}
	if credential.Uid != 65534 {
		return syscall.EACCES
	}
	peerStart, err := startTime(int(credential.Pid))
	if err != nil {
		return err
	}
	peer := processIdentity{PID: int(credential.Pid), Start: peerStart}
	identityPaths := []string{
		"/lab/harness",
		"/lab/bin/harness",
		"/lab/bin/control-installer",
		"/lab/control-profile",
	}
	matchedIdentity := false
	for _, path := range identityPaths {
		if _, identityErr := identityAt(peer.PID, path); identityErr == nil {
			matchedIdentity = true
			break
		}
	}
	if !matchedIdentity {
		return syscall.EACCES
	}

	root, err := openMetadataRoot()
	if err != nil {
		return err
	}
	defer syscall.Close(root)

	message := make([]byte, 8)
	oob := make([]byte, syscall.CmsgSpace(4)*4)
	var n, on, flags int
	for {
		if !time.Now().Before(deadline) {
			closeRights(oob)
			return fmt.Errorf("metadata registration timeout: %w", errDaemonTimeout)
		}
		n, on, flags, _, err = syscall.Recvmsg(client, message, oob, syscall.MSG_DONTWAIT)
		if err == syscall.EINTR {
			continue
		}
		if err == syscall.EAGAIN || err == syscall.EWOULDBLOCK {
			if waitErr := waitSocketUntil(client, deadline); waitErr != nil {
				closeRights(oob)
				if errors.Is(waitErr, errDaemonTimeout) {
					return fmt.Errorf("metadata registration timeout: %w", waitErr)
				}
				return fmt.Errorf("metadata registration poll: %w", waitErr)
			}
			continue
		}
		break
	}
	if err != nil {
		closeRights(oob)
		return err
	}
	control, parseErr := syscall.ParseSocketControlMessage(oob[:on])
	fds := collectRights(control)
	if flags&(syscall.MSG_CTRUNC|syscall.MSG_TRUNC) != 0 || n != 8 ||
		string(message) != "OCMETA01" || parseErr != nil || len(control) != 1 || len(fds) != 1 {
		closeFDs(fds)
		return errors.New("invalid notifier registration")
	}
	notifier := fds[0]
	defer syscall.Close(notifier)
	probe := uint64(0)
	_, probeErr := ioctl(notifier, ioctlValid, unsafe.Pointer(&probe))
	if probeErr != nil && probeErr != syscall.ENOENT {
		return fmt.Errorf("invalid seccomp listener: %w", probeErr)
	}

	svc := &service{
		listener: notifier,
		root:     root,
		peer:     peer,
		slot:     -1,
		deadline: deadline,
	}
	if phase == "canceled" {
		svc.beforeReceive = func() error {
			if _, err := fmt.Fprint(os.Stdout, "CANCEL_PENDING\n"); err != nil {
				return err
			}
			if err := waitSocketUntil(0, deadline); err != nil {
				return err
			}
			var gate [1]byte
			n, err := syscall.Read(0, gate[:])
			if err != nil {
				return err
			}
			if n != 1 || gate[0] != 'C' {
				return errors.New("invalid cancellation gate")
			}
			return nil
		}
	}
	faultCalls := 0
	var faultErr error
	if phase != "" && phase != "canceled" {
		observe := func(fd int, operation func() error) error {
			if err := syscall.Close(fd); err != nil {
				return err
			}
			faultCalls++
			err := operation()
			faultErr = err
			return err
		}
		switch phase {
		case "write":
			svc.ackWrite = func(fd int, data []byte) (int, error) {
				err := observe(fd, func() error {
					_, writeErr := syscall.Write(fd, data)
					return writeErr
				})
				return 0, err
			}
		case "fsync":
			svc.ackSync = func(fd int) error {
				return observe(fd, func() error { return syscall.Fsync(fd) })
			}
		case "close":
			svc.ackClose = func(fd int) error {
				return observe(fd, func() error { return syscall.Close(fd) })
			}
		}
	}
	defer func() {
		if svc.active && svc.slot >= 0 {
			_ = syscall.Close(svc.slot)
			svc.slot = -1
			svc.active = false
		}
	}()
	if err := svc.loop(); err != nil {
		return fmt.Errorf("metadata notifier lifecycle: %w", err)
	}
	if phase == "canceled" && svc.canceledReceives == 0 {
		return errors.New("canceled notification ENOENT not observed")
	}
	if phase != "" && phase != "canceled" && (faultCalls != 1 || !errors.Is(faultErr, syscall.EBADF)) {
		return errors.New("ACK syscall fault was not observed")
	}
	return nil
}

func collectRights(messages []syscall.SocketControlMessage) []int {
	var descriptors []int
	for _, message := range messages {
		if message.Header.Level != syscall.SOL_SOCKET || message.Header.Type != syscall.SCM_RIGHTS {
			continue
		}
		fds, err := syscall.ParseUnixRights(&message)
		if err == nil {
			descriptors = append(descriptors, fds...)
		}
	}
	return descriptors
}

func closeFDs(descriptors []int) {
	for _, descriptor := range descriptors {
		_ = syscall.Close(descriptor)
	}
}

func closeRights(data []byte) {
	messages, _ := syscall.ParseSocketControlMessage(data)
	closeFDs(collectRights(messages))
}
