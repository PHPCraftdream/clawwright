//go:build linux && amd64

package metadata

import (
	"fmt"
	"os"
	"syscall"
	"time"
	"unsafe"
)

func (s *service) handleOpen(request notification, authorized bool) response {
	result := response{ID: request.ID, Errno: -int32(syscall.EACCES)}
	if !authorized {
		result.Errno = 0
		result.Flags = notificationContinue
		return result
	}

	address := request.Data.Args[0]
	dirfd := -100
	flags := int(request.Data.Args[1])
	if request.Data.Number == nrOpenat {
		dirfd = int(int32(request.Data.Args[0]))
		address = request.Data.Args[1]
		flags = int(request.Data.Args[2])
	}

	path, err := copyPath(int(request.PID), address)
	if err != nil {
		return result
	}

	if (dirfd == -100 || request.Data.Number == nrOpen) &&
		(path == basePath+"/"+stateName || path == basePath+"/"+receiptName) {
		if flags&syscall.O_ACCMODE != syscall.O_RDONLY ||
			flags&(syscall.O_CREAT|syscall.O_TRUNC|syscall.O_APPEND) != 0 {
			return result
		}

		name := stateName
		if path == basePath+"/"+receiptName {
			name = receiptName
		}
		data, readErr := boundedFile(s.root, name, name == receiptName)
		if readErr != nil {
			result.Errno = -int32(errnoNumber(readErr))
			return result
		}
		if name == receiptName && scenarioCancel() {
			if err := s.ownerCapture(); err != nil {
				for i := range data {
					data[i] = 0
				}
				return result
			}
		}
		fd, addErr := addMemfd(s.listener, request.ID, name, data)
		if addErr == nil && name == receiptName {
			copy(s.lastReceipt[:], data)
			s.haveReceipt = true
		}
		for i := range data {
			data[i] = 0
		}
		if addErr != nil {
			result.Errno = -int32(errnoNumber(addErr))
			return result
		}
		result.Errno = 0
		result.Value = int64(fd)
		return result
	}

	if (dirfd == -100 || request.Data.Number == nrOpen) && path == requestPath {
		if flags&(syscall.O_ACCMODE|syscall.O_CREAT|syscall.O_TRUNC) !=
			syscall.O_WRONLY|syscall.O_CREAT|syscall.O_TRUNC {
			return result
		}
		return s.openCancel(request)
	}

	result.Errno = 0
	result.Flags = notificationContinue
	return result
}

func (s *service) openCancel(request notification) response {
	result := response{ID: request.ID, Errno: -int32(syscall.EACCES)}
	if !scenarioCancel() || s.active || !validID(s.listener, request.ID) {
		return result
	}

	fd, err := memfd("cancel")
	if err != nil {
		result.Errno = -int32(errnoNumber(err))
		return result
	}
	if err = syscall.Ftruncate(fd, 7); err != nil {
		_ = syscall.Close(fd)
		result.Errno = -int32(errnoNumber(err))
		return result
	}
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), uintptr(fcntlAddSeals), uintptr(14))
	if errno != 0 {
		_ = syscall.Close(fd)
		result.Errno = -int32(errnoNumber(errno))
		return result
	}

	s.slot = fd
	s.active = true
	result.Errno = 0
	result.Value = cancelFD
	return result
}

func (s *service) handleWrite(request notification, authorized bool) response {
	result := response{ID: request.ID, Errno: -int32(syscall.EACCES)}
	if !authorized || !s.active || int(request.Data.Args[0]) != cancelFD ||
		request.Data.Args[2] != 7 || !validID(s.listener, request.ID) {
		return result
	}

	data, err := readRemote(int(request.PID), request.Data.Args[1], 7)
	if err != nil {
		result.Errno = -int32(errnoNumber(err))
		return result
	}
	written, err := syscall.Pwrite(s.slot, data, 0)
		if err != nil {
			result.Errno = -int32(errnoNumber(err))
			return result
		}
	if written != 7 {
		result.Errno = -int32(syscall.EIO)
		return result
	}
	result.Errno = 0
	result.Value = 7
	return result
}

func errnoNumber(err error) syscall.Errno {
	if errno, ok := err.(syscall.Errno); ok {
		return errno
	}
	return syscall.EIO
}

type notifierPollFD struct {
	FD      int32
	Events  int16
	Revents int16
}

func waitNotifier(fd int) (bool, error) {
	return waitNotifierUntil(fd, time.Time{})
}

func waitNotifierUntil(fd int, deadline time.Time) (bool, error) {
	for {
		if !deadline.IsZero() && !time.Now().Before(deadline) {
			return false, errDaemonTimeout
		}

		pollFD := notifierPollFD{FD: int32(fd), Events: 1}
		timeout := ^uintptr(0)
		if !deadline.IsZero() {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return false, errDaemonTimeout
			}
			milliseconds := (remaining + time.Millisecond - 1) / time.Millisecond
			timeout = uintptr(milliseconds)
		}

		result, _, errno := syscall.Syscall(
			syscall.SYS_POLL,
			uintptr(unsafe.Pointer(&pollFD)),
			1,
			timeout,
		)
		if errno == syscall.EINTR {
			continue
		}
		if errno != 0 {
			return false, errno
		}
		if result == 0 {
			if !deadline.IsZero() && !time.Now().Before(deadline) {
				return false, errDaemonTimeout
			}
			continue
		}

		// Do not accept readiness that arrived after the service deadline.
		if !deadline.IsZero() && !time.Now().Before(deadline) {
			return false, errDaemonTimeout
		}
		if pollFD.Revents&0x20 != 0 { // POLLNVAL
			return false, syscall.EBADF
		}
		if pollFD.Revents&0x08 != 0 { // POLLERR
			return false, syscall.EIO
		}
		if pollFD.Revents&0x01 != 0 { // POLLIN
			return true, nil
		}
		if pollFD.Revents&0x10 != 0 { // POLLHUP
			return false, nil
		}
		return false, syscall.EIO
	}
}

func (s *service) loop() error {
	for {
		ready, err := waitNotifierUntil(s.listener, s.deadline)
		if err != nil {
			return fmt.Errorf("poll notifier: %w", err)
		}
		if !ready {
			return nil
		}
		if s.beforeReceive != nil {
			hook := s.beforeReceive
			s.beforeReceive = nil
			if err := hook(); err != nil {
				return err
			}
		}

		var request notification
		_, err = ioctl(s.listener, ioctlRecv, unsafe.Pointer(&request))
		// A queued notification may be canceled between poll and RECV.
		if err == syscall.ENOENT {
			s.canceledReceives++
			continue
		}
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return fmt.Errorf("receive notifier: %w", err)
		}

		authorized := s.authorized(int(request.PID))
		result := response{ID: request.ID, Errno: -int32(syscall.EACCES)}
		switch request.Data.Number {
		case nrCloseRange:
			if request.Data.Args[0] <= cancelFD && request.Data.Args[1] >= cancelFD {
				result.Errno = -int32(syscall.EPERM)
			}
		case nrClose:
			if int(request.Data.Args[0]) == cancelFD {
				result = s.closeCancel(request, authorized)
			} else {
				result.Errno = 0
				result.Flags = notificationContinue
			}
		case 1:
			if int(request.Data.Args[0]) == cancelFD {
				result = s.handleWrite(request, authorized)
			}
		case nrOpen, nrOpenat:
			result = s.handleOpen(request, authorized)
		case nrUnlinkat:
			result = s.handleUnlink(request, authorized)
		}
		s.send(result)
	}
}

func scenarioCancel() bool {
	data, err := os.ReadFile("/lab/scenario")
	return err == nil && len(data) == 6 && string(data) == "cancel"
}

func waitBrief() {
	time.Sleep(10 * time.Millisecond)
}
