//go:build linux && amd64

package regression

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
	"syscall"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/metadata"
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

func InitialIdentityChild(executed bool) error {
	if os.Getuid() != 65534 || os.Geteuid() != 65534 || os.Getenv("GITHUB_ACTIONS") != "true" {
		return syscall.EACCES
	}
	marker := "READY\n"
	if executed {
		marker = "EXEC\n"
	}
	if _, err := io.WriteString(os.Stdout, marker); err != nil {
		return err
	}
	var gate [1]byte
	_, err := io.ReadFull(os.Stdin, gate[:])
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return err
	}
	if executed || gate[0] != 'E' {
		return syscall.EINVAL
	}
	return syscall.Exec("/lab/bin/harness", []string{"/lab/bin/harness", "--initial-identity-exec"}, []string{"GITHUB_ACTIONS=true", "LANG=C", "LC_ALL=C"})
}

func runInitialIdentityCase(executable string, transition bool) (retErr error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := exec.Command(executable, "--initial-identity-child")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid:         65534,
			Gid:         65534,
			Groups:      []uint32{},
			NoSetGroups: true,
		},
	}
	cmd.Env = []string{"GITHUB_ACTIONS=true", "LANG=C", "LC_ALL=C"}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return err
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	owned := true
	var start uint64
	defer func() {
		_ = stdin.Close()
		_ = stdout.Close()
		if owned {
			wasConsumed, cleanupErr := terminateOwnedCmd(cmd, start, done, ctx, "life_kill_holder", "life_holder_wait")
			if wasConsumed {
				owned = false
			}
			retErr = errors.Join(retErr, cleanupErr)
		}
	}()
	if start, err = procStartTicks(cmd.Process.Pid); err != nil {
		return err
	}
	readMarker := func(want string) error {
		type resultType struct {
			data []byte
			err  error
		}
		result := make(chan resultType, 1)
		go func() {
			data := make([]byte, len(want))
			_, readErr := io.ReadFull(stdout, data)
			result <- resultType{data, readErr}
		}()
		select {
		case got := <-result:
			if got.err != nil {
				return got.err
			}
			if string(got.data) != want {
				return fmt.Errorf("unexpected initial identity marker %q", got.data)
			}
			return nil
		case waitErr := <-done:
			owned = false
			return fmt.Errorf("initial identity child exited before %q: %w", want, waitErr)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := readMarker("READY\n"); err != nil {
		return err
	}
	changed := false
	identityErr := metadata.InitialPeerIdentityRegression(cmd.Process.Pid, start, func(stage int) error {
		if stage != 3 || !transition {
			return nil
		}
		if _, err := stdin.Write([]byte{'E'}); err != nil {
			return err
		}
		if err := readMarker("EXEC\n"); err != nil {
			return err
		}
		changed = true
		return nil
	})
	if transition {
		if identityErr != nil {
			return identityErr
		}
		if !changed {
			return errors.New("initial identity regression did not observe exec transition")
		}
		exeInfo, err := os.Stat(fmt.Sprintf("/proc/%d/exe", cmd.Process.Pid))
		if err != nil {
			return err
		}
		harnessInfo, err := os.Stat("/lab/bin/harness")
		if err != nil {
			return err
		}
		controlInfo, err := os.Stat("/lab/control-profile")
		if err != nil {
			return err
		}
		exeStat, ok := exeInfo.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("cannot inspect process executable identity")
		}
		harnessStat, ok := harnessInfo.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("cannot inspect harness identity")
		}
		controlStat, ok := controlInfo.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("cannot inspect control profile identity")
		}
		if exeStat.Dev != harnessStat.Dev || exeStat.Ino != harnessStat.Ino {
			return errors.New("process executable does not match /lab/bin/harness device/inode")
		}
		if exeStat.Dev == controlStat.Dev && exeStat.Ino == controlStat.Ino {
			return errors.New("process executable still matches /lab/control-profile device/inode")
		}
		if err := verifyProcessIdentity(cmd.Process.Pid, start); err != nil {
			return err
		}
	} else {
		if !errors.Is(identityErr, syscall.EACCES) {
			return fmt.Errorf("unchanged identity result %v, want EACCES", identityErr)
		}
		if err := verifyProcessIdentity(cmd.Process.Pid, start); err != nil {
			return err
		}
		if err := holderStillAlive(cmd); err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if err := stdin.Close(); err != nil {
		return err
	}
	select {
	case waitErr := <-done:
		owned = false
		if waitErr != nil {
			return fmt.Errorf("initial identity child exit: %w", waitErr)
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}
