//go:build linux && amd64

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"clawforge/tools/native/task240-native/task245-control-profile/internal/proof"
)

const installerPath = "/lab/bin/control-installer"

var bootstrapNames = [...]string{"SSJACK_ENV_TOKEN", "SSJACK_SESSION", "SSJACK_ENDPOINT", "SSJACK_CERTIFICATE_SHA256"}

func validRef(s string) bool {
	if len(s) == 0 || len(s) > 32768 || s == "." || s == ".." || strings.ContainsAny(s, "/\x00") {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return false
		}
	}
	return true
}

func validMode(s string) bool {
	return s == "golden" || s == "withheld" || s == "unknown" || s == "cancel"
}

func safeEnvironment() ([]string, error) {
	out := make([]string, 0, 7)
	for _, name := range bootstrapNames {
		value, ok := os.LookupEnv(name)
		if !ok || value == "" || strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("missing bootstrap variable %s", name)
		}
		out = append(out, name+"="+value)
	}
	return append(out, "PATH=/lab/bin", "LANG=C", "LC_ALL=C"), nil
}

func installerPresent() error {
	st, err := os.Lstat(installerPath)
	if err != nil {
		return fmt.Errorf("installer unavailable: %w", err)
	}
	s, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.Mode().IsRegular() || s.Uid != 0 || st.Mode().Perm()&0022 != 0 || s.Nlink != 1 {
		return errors.New("installer is not an immutable root-owned regular file")
	}
	return nil
}

func disableDumps() error {
	limit := syscall.Rlimit{Cur: 0, Max: 0}
	if err := syscall.Setrlimit(syscall.RLIMIT_CORE, &limit); err != nil {
		return fmt.Errorf("disable core dumps: %w", err)
	}
	const prSetDumpable = 4
	_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prSetDumpable, 0, 0, 0, 0, 0)
	if errno != 0 {
		return fmt.Errorf("disable dumpability: %w", errno)
	}
	return nil
}

func setCloseOnExec(fd int, enabled bool) error {
	var flags uintptr
	if enabled {
		flags = syscall.FD_CLOEXEC
	}
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, flags)
	if errno != 0 {
		return errno
	}
	return nil
}

func run(ref, mode string) error {
	if !validRef(ref) || !validMode(mode) {
		return errors.New("expected bounded REF and supported mode")
	}
	if os.Getuid() != 65534 || os.Geteuid() != 65534 {
		return errors.New("control profile requires uid 65534")
	}
	if err := disableDumps(); err != nil {
		return err
	}
	if err := installerPresent(); err != nil {
		return err
	}
	env, err := safeEnvironment()
	if err != nil {
		return err
	}
	if mode != "golden" {
		fd, connectErr := proof.ConnectAndVerify()
		if connectErr != nil {
			return connectErr
		}
		if fd != 3 {
			if err = syscall.Dup3(fd, 3, 0); err != nil {
				if closeErr := syscall.Close(fd); closeErr != nil {
					return fmt.Errorf("place metadata socket at fd 3: %v (close original: %w)", err, closeErr)
				}
				return fmt.Errorf("place metadata socket at fd 3: %w", err)
			}
			if err = syscall.Close(fd); err != nil {
				if closeErr := syscall.Close(3); closeErr != nil {
					return fmt.Errorf("close original metadata socket: %v (close fd 3: %w)", err, closeErr)
				}
				return fmt.Errorf("close original metadata socket: %w", err)
			}
		}
		if err = setCloseOnExec(3, false); err != nil {
			if closeErr := syscall.Close(3); closeErr != nil {
				return fmt.Errorf("inherit metadata socket: %v (close fd 3: %w)", err, closeErr)
			}
			return fmt.Errorf("inherit metadata socket: %w", err)
		}
	}
	if err = syscall.Exec(installerPath, []string{"control-installer", ref, mode}, env); err != nil {
		if mode != "golden" {
			if closeErr := syscall.Close(3); closeErr != nil {
				return fmt.Errorf("exec control installer: %v (close metadata socket: %w)", err, closeErr)
			}
		}
		return fmt.Errorf("exec control installer: %w", err)
	}
	return nil
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "control-profile: expected REF MODE")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "control-profile:", err)
		os.Exit(126)
	}
}

var _ = unsafe.Pointer(nil)
