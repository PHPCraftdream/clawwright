//go:build linux && amd64

package main

import "syscall"

// BuildLaunchFilter constructs the fixed, scalar seccomp policy for the trusted
// native launch stub. Install it before exec; do not treat this as a general
// application sandbox. The stub must validate/use these instructions as part
// of its trusted startup path.
func BuildLaunchFilter() []syscall.SockFilter {
	const (
		ldWAbs = 0x20
		jeqK   = 0x15
		jsetK  = 0x45
		retK   = 0x06
		allow  = 0x7fff0000
		errno  = 0x00050000
		kill   = 0x80000000
	)
	f := []syscall.SockFilter{
		{Code: ldWAbs, K: 4}, // seccomp_data.arch
		{Code: jeqK, Jt: 1, Jf: 0, K: 0xc000003e},
		{Code: retK, K: kill},
		{Code: ldWAbs, K: 0}, // syscall number
		{Code: jsetK, Jt: 0, Jf: 1, K: 0x40000000}, // reject x32 ABI
		{Code: retK, K: errno | uint32(syscall.EPERM)},
		{Code: ldWAbs, K: 0},
	}
	// Unsupported or dangerous operations are checked before the default allow.
	for _, r := range []struct{ nr, result uint32 }{
		{435, errno | uint32(syscall.ENOSYS)}, // clone3
		{425, errno | uint32(syscall.ENOSYS)}, // io_uring_setup
		{101, errno | uint32(syscall.EPERM)}, // ptrace
		{311, errno | uint32(syscall.EPERM)}, // process_vm_writev
		{272, errno | uint32(syscall.EPERM)}, // unshare
		{308, errno | uint32(syscall.EPERM)}, // setns
		{165, errno | uint32(syscall.EPERM)}, // mount
		{166, errno | uint32(syscall.EPERM)}, // umount2
		{155, errno | uint32(syscall.EPERM)}, // pivot_root
		{161, errno | uint32(syscall.EPERM)}, // chroot
		{429, errno | uint32(syscall.EPERM)}, // move_mount
		{428, errno | uint32(syscall.EPERM)}, // open_tree
		{430, errno | uint32(syscall.EPERM)}, // fsopen
		{431, errno | uint32(syscall.EPERM)}, // fsconfig
		{432, errno | uint32(syscall.EPERM)}, // fsmount
		{433, errno | uint32(syscall.EPERM)}, // fspick
		{442, errno | uint32(syscall.EPERM)}, // mount_setattr
	} {
		f = append(f, syscall.SockFilter{Code: jeqK, Jf: 1, K: r.nr}, syscall.SockFilter{Code: retK, K: r.result})
	}
	f = append(f,
		syscall.SockFilter{Code: jeqK, Jf: 3, K: 56},
		syscall.SockFilter{Code: ldWAbs, K: 16},
		syscall.SockFilter{Code: jsetK, Jt: 0, Jf: 1, K: 0x00020000 | 0x00800000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000},
		syscall.SockFilter{Code: retK, K: errno | uint32(syscall.EPERM)},
		syscall.SockFilter{Code: retK, K: allow},
	)
	return f
}
