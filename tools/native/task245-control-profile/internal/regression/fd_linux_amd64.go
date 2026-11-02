//go:build linux && amd64

package regression

import (
	"errors"
	"fmt"
	"syscall"
)

const (
	fixedFD      = 1023
	fDupFD       = 0
	fGetFD       = 1
	fSetFD       = 2
	fDupFDCloexec = 1030
	fdCloexec    = 1
	fioclex      = 0x5451
	fionclex     = 0x5450
	statePath    = "/var/lib/ssjack/synthetic/state.json"
	metadataPath = "/lab/bin/metadata-child"
)

func fcntl(fd, command, arg int) (uintptr, syscall.Errno) {
	r, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), uintptr(command), uintptr(arg))
	return r, errno
}

func ioctl(fd int, request uintptr) syscall.Errno {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), request, 0)
	return errno
}

func expectErr(op string, got error, want error) error {
	if !errors.Is(got, want) {
		ReportFailure("fd_expected_errno", got)
		return fmt.Errorf("%s: got %v, want %v", op, got, want)
	}
	return nil
}

func rawSyscall(number, a1, a2, a3 uintptr) error {
	_, _, errno := syscall.RawSyscall(number, a1, a2, a3)
	if errno == 0 {
		return nil
	}
	return errno
}

// CheckFilteredDescriptors checks the installed descriptor filter; it does not install it.
func CheckFilteredDescriptors(original bool) error {
	fail := func(op string, err error) error { ReportFailure("fd_operation", err); return fmt.Errorf("%s: %w", op, err) }
	var st syscall.Stat_t

	if original {
		fd, err := syscall.Open(statePath, syscall.O_RDONLY, 0)
		if err != nil {
			return fail("open state", err)
		}
		buf := make([]byte, 4096)
		n, readErr := syscall.Read(fd, buf)
		if readErr != nil {
			_ = syscall.Close(fd)
			return fail("read state", readErr)
		}
		if string(buf[:n]) != "{}" {
			_ = syscall.Close(fd)
			ReportFailure("fd_state_contents", nil)
			return fmt.Errorf("read state: got %q, want {}", buf[:n])
		}
		seals, errno := fcntl(fd, 1034, 0)
		if errno != 0 {
			_ = syscall.Close(fd)
			return fail("F_GET_SEALS state", errno)
		}
		if seals != 15 {
			_ = syscall.Close(fd)
			ReportFailure("fd_state_seals", nil)
			return fmt.Errorf("F_GET_SEALS state: got %d, want 15", seals)
		}
		if err := syscall.Close(fd); err != nil {
			return fail("close state", err)
		}
	} else {
		fd, err := syscall.Open(statePath, syscall.O_RDONLY, 0)
		if err == nil {
			_ = syscall.Close(fd)
			ReportFailure("fd_state_denial", nil)
			return fmt.Errorf("open state: succeeded, want EACCES")
		}
		if err = expectErr("open state", err, syscall.EACCES); err != nil {
			return err
		}
	}

	fd, err := syscall.Open(metadataPath, syscall.O_RDONLY, 0)
	if err != nil {
		return fail("open metadata-child", err)
	}
	if err = syscall.Close(fd); err != nil {
		return fail("close metadata-child", err)
	}

	var p, q [2]int
	if err = syscall.Pipe(p[:]); err != nil {
		return fail("pipe", err)
	}
	defer syscall.Close(p[0])
	defer syscall.Close(p[1])
	if err = syscall.Pipe(q[:]); err != nil {
		return fail("second pipe", err)
	}
	defer syscall.Close(q[0])
	defer syscall.Close(q[1])

	fd, err = syscall.Dup(p[0])
	if err != nil {
		return fail("dup ordinary", err)
	}
	_ = syscall.Close(fd)
	for _, command := range []int{fDupFD, fDupFDCloexec} {
		dupFD, errno := fcntl(p[0], command, 10)
		if errno != 0 {
			return fail(fmt.Sprintf("fcntl ordinary command %d", command), errno)
		}
		_ = syscall.Close(int(dupFD))
	}
	if err = syscall.Dup2(p[0], q[1]); err != nil {
		return fail("dup2 ordinary", err)
	}
	if err = syscall.Dup3(p[0], q[1], 0); err != nil {
		return fail("dup3 ordinary", err)
	}
	if _, errno := fcntl(p[0], fSetFD, fdCloexec); errno != 0 {
		return fail("F_SETFD ordinary", errno)
	}
	if _, errno := fcntl(p[0], fSetFD, 0); errno != 0 {
		return fail("F_SETFD clear ordinary", errno)
	}

	protectedDupTests := []struct {
		name string
		run  func() error
	}{
		{"dup protected source", func() error { _, err := syscall.Dup(fixedFD); return err }},
		{"dup2 protected source", func() error { return syscall.Dup2(fixedFD, q[0]) }},
		{"dup3 protected source", func() error { return syscall.Dup3(fixedFD, q[0], 0) }},
		{"dup2 protected destination", func() error { return syscall.Dup2(p[0], fixedFD) }},
		{"dup3 protected destination", func() error { return syscall.Dup3(p[0], fixedFD, 0) }},
	}
	for _, test := range protectedDupTests {
		if err = expectErr(test.name, test.run(), syscall.EPERM); err != nil {
			return err
		}
	}
	for _, command := range []int{fDupFD, fDupFDCloexec} {
		_, errno := fcntl(fixedFD, command, 10)
		if err = expectErr(fmt.Sprintf("fcntl protected duplicate %d", command), errno, syscall.EPERM); err != nil {
			return err
		}
	}
	for _, arg := range []int{fdCloexec, 0} {
		_, errno := fcntl(fixedFD, fSetFD, arg)
		if err = expectErr(fmt.Sprintf("F_SETFD protected %d", arg), errno, syscall.EPERM); err != nil {
			return err
		}
	}
	for _, request := range []uintptr{fioclex, fionclex} {
		if err = expectErr(fmt.Sprintf("ioctl protected %#x", request), ioctl(fixedFD, request), syscall.EPERM); err != nil {
			return err
		}
	}
	if errno := ioctl(p[0], fioclex); errno != 0 {
		return fail("FIOCLEX ordinary", errno)
	}
	value, errno := fcntl(p[0], fGetFD, 0)
	if errno != 0 || value&fdCloexec == 0 {
		ReportFailure("fd_ioctl_set", errno)
		return fmt.Errorf("F_GETFD after FIOCLEX: value=%d errno=%v", value, errno)
	}
	if errno = ioctl(p[0], fionclex); errno != 0 {
		return fail("FIONCLEX ordinary", errno)
	}
	value, errno = fcntl(p[0], fGetFD, 0)
	if errno != 0 || value&fdCloexec != 0 {
		ReportFailure("fd_ioctl_clear", errno)
		return fmt.Errorf("F_GETFD after FIONCLEX: value=%d errno=%v", value, errno)
	}
	if err = expectErr("close_range", rawSyscall(436, fixedFD, fixedFD, 0), syscall.EPERM); err != nil {
		return err
	}

	if err = syscall.Fstat(fixedFD, &st); err != nil {
		return fail("Fstat protected before close", err)
	}
	if err = syscall.Close(fixedFD); err != nil {
		return fail("close protected", err)
	}
	if err = syscall.Fstat(fixedFD, &st); err != nil {
		return fail("Fstat protected after close", err)
	}
	for _, text := range []string{"release", "inactive"} {
		_, err = syscall.Write(fixedFD, []byte(text))
		if err = expectErr("write "+text, err, syscall.EACCES); err != nil {
			return err
		}
	}
	_, err = syscall.Pwrite(fixedFD, []byte("release"), 0)
	if err = expectErr("pwrite protected", err, syscall.EPERM); err != nil {
		return err
	}
	return nil
}
