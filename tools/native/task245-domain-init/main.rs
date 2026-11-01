// Linux amd64-only, dependency-free port of init.c.
// Reference: ../task245-domain-init/init.c; launch contract: ../task245-lab-broker/launch_linux.go.
// Diagnostics report the checkpoint and the most recent raw syscall errno.

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("task245 domain init supports Linux amd64 only");

use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicI32, Ordering};

// Each forked process has its own copy; relaxed ordering is sufficient because this
// records diagnostics, not cross-thread publication.
static LAST_ERRNO: AtomicI32 = AtomicI32::new(0);

const SYS_WRITE: usize = 1;
const SYS_CLOSE: usize = 3;
const SYS_FSTAT: usize = 5;
const SYS_GETSOCKOPT: usize = 55;
const SYS_GETPID: usize = 39;
const SYS_FORK: usize = 57;
const SYS_EXIT: usize = 60;
const SYS_WAIT4: usize = 61;
const SYS_FCNTL: usize = 72;
const SYS_CHDIR: usize = 80;
const SYS_FCHDIR: usize = 81;
const SYS_GETRLIMIT: usize = 97;
const SYS_GETUID: usize = 102;
const SYS_GETGID: usize = 104;
const SYS_GETEUID: usize = 107;
const SYS_GETEGID: usize = 108;
const SYS_GETPPID: usize = 110;
const SYS_GETGROUPS: usize = 115;
const SYS_SETGROUPS: usize = 116;
const SYS_SETRESUID: usize = 117;
const SYS_SETRESGID: usize = 119;
const SYS_FSTATFS: usize = 138;
const SYS_PRCTL: usize = 157;
const SYS_CHROOT: usize = 161;
const SYS_MOUNT: usize = 165;
const SYS_GETTID: usize = 186;
const SYS_EXIT_GROUP: usize = 231;
const SYS_OPENAT: usize = 257;
const SYS_UNSHARE: usize = 272;
const SYS_EXECVEAT: usize = 322;
const SYS_DUP2: usize = 33;

const IMAGE: i32 = 3;
const CONTROL: i32 = 4;
const ROOT: i32 = 5;
const META: i32 = 6;
const EINTR: i64 = 4;
const O_CLOEXEC: usize = 0x80000;
const O_RDWR: usize = 2;
const AT_EMPTY_PATH: usize = 0x1000;
const F_GETFD: usize = 1;
const F_SETFD: usize = 2;
const F_GET_SEALS: usize = 1034;
const REQUIRED_SEALS: i32 = 0xf;
const FD_CLOEXEC: i32 = 1;
const CLONE_NEWNS: usize = 0x00020000;
const CLONE_NEWNET: usize = 0x40000000;
const CLONE_NEWPID: usize = 0x20000000;
const MS_RDONLY: usize = 1;
const MS_NOSUID: usize = 2;
const MS_NODEV: usize = 4;
const MS_NOEXEC: usize = 8;
const MS_REC: usize = 16384;
const MS_PRIVATE: usize = 1 << 18;
const PR_SET_PDEATHSIG: usize = 1;
const PR_SET_DUMPABLE: usize = 4;
const PR_SET_NO_NEW_PRIVS: usize = 38;
const SIGKILL: usize = 9;
const SOCK_SEQPACKET: i32 = 5;
const SO_TYPE: usize = 3;
const SOL_SOCKET: usize = 1;
const RLIMIT_NOFILE: usize = 7;
const MAX_FDS: u64 = 1_048_576;
const MAX_ID: u32 = u32::MAX;

const ARGV: [&[u8]; 3] = [b"native-supervisor\0", b"--task245-domain-worker\0", b"\0"];
static NULL_PATH: &[u8] = b"/dev/null\0";
static PROC: &[u8] = b"proc\0";
static PROC_PATH: &[u8] = b"/proc\0";
static PROC_FS: &[u8] = b"proc\0";
static PROC_OPTS: &[u8] = b"hidepid=0\0";
static RUN: &[u8] = b"/run\0";
static TMPFS: &[u8] = b"tmpfs\0";

#[repr(C)]
struct Rlimit {
    cur: u64,
    max: u64,
}

#[derive(Clone, Copy)]
struct Args {
    av: [*const i8; 3],
    ev: [*const i8; 1],
    run: [u8; 96],
}

// Private raw-syscall boundary. Module invariant: pointer arguments are only static,
// valid NUL-terminated byte strings, or pointers to live stack buffers with the exact
// extent required by the syscall. Buffer pointers are never accepted from external callers.
fn syscall6(n: usize, a: usize, b: usize, c: usize, d: usize, e: usize, f: usize) -> i64 {
    let mut ret = n as isize;
    // SAFETY: Linux x86_64 syscall ABI; arguments occupy the syscall argument registers,
    // while rcx/r11 are clobbered. Private call sites uphold the module pointer invariant.
    unsafe {
        core::arch::asm!(
            "syscall",
            inlateout("rax") ret,
            lateout("rcx") _,
            lateout("r11") _,
            in("rdi") a,
            in("rsi") b,
            in("rdx") c,
            in("r10") d,
            in("r8") e,
            in("r9") f,
            options(nostack)
        );
    }
    if let Some(errno) = syscall_error(ret as i64) {
        LAST_ERRNO.store(errno, Ordering::Relaxed);
    }
    ret as i64
}

fn syscall_error(result: i64) -> Option<i32> {
    if (-4095..=-1).contains(&result) { Some((-result) as i32) } else { None }
}

fn format_diagnostic(checkpoint: i32, errno: i32) -> ([u8; 64], usize) {
    let mut out = [0u8; 64];
    let mut len = 0usize;
    fn append(out: &mut [u8; 64], len: &mut usize, bytes: &[u8]) {
        out[*len..*len + bytes.len()].copy_from_slice(bytes);
        *len += bytes.len();
    }
    fn decimal(out: &mut [u8; 64], len: &mut usize, mut value: u32) {
        let mut digits = [0u8; 10];
        let mut start = digits.len();
        loop {
            start -= 1;
            digits[start] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 { break; }
        }
        append(out, len, &digits[start..]);
    }
    append(&mut out, &mut len, b"task245-init: checkpoint=");
    decimal(&mut out, &mut len, checkpoint as u32);
    append(&mut out, &mut len, b" errno=");
    decimal(&mut out, &mut len, errno as u32);
    append(&mut out, &mut len, b"\n");
    (out, len)
}

fn call0(n: usize) -> i64 {
    syscall6(n, 0, 0, 0, 0, 0, 0)
}
fn call1(n: usize, a: usize) -> i64 {
    syscall6(n, a, 0, 0, 0, 0, 0)
}
fn call2(n: usize, a: usize, b: usize) -> i64 {
    syscall6(n, a, b, 0, 0, 0, 0)
}
fn call3(n: usize, a: usize, b: usize, c: usize) -> i64 {
    syscall6(n, a, b, c, 0, 0, 0)
}
fn call4(n: usize, a: usize, b: usize, c: usize, d: usize) -> i64 {
    syscall6(n, a, b, c, d, 0, 0)
}
fn call5(n: usize, a: usize, b: usize, c: usize, d: usize, e: usize) -> i64 {
    syscall6(n, a, b, c, d, e, 0)
}
fn failed(r: i64) -> bool {
    r < 0
}
fn ptr(s: &[u8]) -> usize {
    s.as_ptr() as usize
}

fn parse_id(s: &[u8]) -> Option<u32> {
    if s.is_empty() || (s.len() > 1 && s[0] == b'0') {
        return None;
    }
    let mut n: u32 = 0;
    for &b in s {
        if !b.is_ascii_digit() {
            return None;
        }
        n = n.checked_mul(10)?.checked_add((b - b'0') as u32)?;
    }
    if n == 0 || n > MAX_ID { None } else { Some(n) }
}

#[repr(C)]
struct Stat {
    dev: u64,
    ino: u64,
    nlink: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    pad0: u32,
    rdev: u64,
    size: i64,
    blksize: i64,
    blocks: i64,
    atime: i64,
    atime_nsec: u64,
    mtime: i64,
    mtime_nsec: u64,
    ctime: i64,
    ctime_nsec: u64,
    unused: [i64; 3],
}

fn stat(fd: i32) -> Option<Stat> {
    let mut s = std::mem::MaybeUninit::<Stat>::zeroed();
    // fstat writes the Linux x86_64 struct stat into this aligned, full-sized buffer.
    if failed(call2(SYS_FSTAT, fd as usize, s.as_mut_ptr() as usize)) {
        return None;
    }
    // SAFETY: successful fstat initialized every Stat field; storage was zeroed for padding.
    Some(unsafe { s.assume_init() })
}

// Linux amd64 statfs is exactly 120 bytes; f_flags is the u64 at offset 80.
#[repr(C)]
struct StatFs {
    fields: [u8; 80],
    flags: i64,
    spare: [i64; 4],
}

fn root_readonly() -> bool {
    let mut s = std::mem::MaybeUninit::<StatFs>::zeroed();
    // ROOT was verified as a directory; fstatfs writes the Linux x86_64 statfs layout.
    if failed(call2(SYS_FSTATFS, ROOT as usize, s.as_mut_ptr() as usize)) {
        return false;
    }
    // SAFETY: successful fstatfs initialized the flags field; storage began zeroed.
    unsafe { s.assume_init().flags & 1 != 0 }
}

fn sealed(fd: i32, mode: u32) -> bool {
    let seals = call3(SYS_FCNTL, fd as usize, F_GET_SEALS, 0);
    if seals < 0 || seals as i32 & REQUIRED_SEALS != REQUIRED_SEALS {
        return false;
    }
    let Some(s) = stat(fd) else { return false };
    s.mode & 0o170000 == 0o100000 && s.uid == 0 && s.mode & 0o777 == mode
}

fn verify() -> bool {
    if !sealed(IMAGE, 0o555) || !sealed(META, 0o444) {
        return false;
    }
    let mut ty = 0i32;
    let mut len = std::mem::size_of::<i32>() as u32;
    // SAFETY: the live i32 and u32 stack variables provide writable storage of the
    // sizes passed to getsockopt; the kernel writes at most the supplied length.
    if failed(call5(
        SYS_GETSOCKOPT,
        CONTROL as usize,
        SOL_SOCKET,
        SO_TYPE,
        &mut ty as *mut _ as usize,
        &mut len as *mut _ as usize,
    )) || ty != SOCK_SEQPACKET
        || len != std::mem::size_of::<i32>() as u32
    {
        return false;
    }
    let Some(root) = stat(ROOT) else { return false };
    if root.mode & 0o170000 != 0o040000 || root.uid != 0 || root.mode & 0o022 != 0 || !root_readonly() {
        return false;
    }
    for fd in [IMAGE, CONTROL, META] {
        let old = call3(SYS_FCNTL, fd as usize, F_GETFD, 0);
        if old < 0 || failed(call3(SYS_FCNTL, fd as usize, F_SETFD, (old as usize) & !(FD_CLOEXEC as usize))) {
            return false;
        }
    }
    let mut lim = std::mem::MaybeUninit::<Rlimit>::uninit();
    // getrlimit writes one repr(C) rlimit into aligned storage; resource is RLIMIT_NOFILE.
    if failed(call2(SYS_GETRLIMIT, RLIMIT_NOFILE, lim.as_mut_ptr() as usize)) {
        return false;
    }
    // SAFETY: successful getrlimit initialized both fields.
    let lim = unsafe { lim.assume_init() };
    // Refuse infinity instead of guessing a descriptor ceiling: leaving a possibly open
    // inherited descriptor would violate the launch boundary, while scanning infinity is impossible.
    if lim.cur == u64::MAX || lim.cur > MAX_FDS {
        return false;
    }
    for fd in 7..lim.cur {
        let _ = call1(SYS_CLOSE, fd as usize);
    }
    true
}

#[inline(never)]
fn die(checkpoint: i32) -> ! {
    let errno = LAST_ERRNO.load(Ordering::Relaxed);
    let (message, len) = format_diagnostic(checkpoint, errno);
    let mut written = 0usize;
    let mut attempts = 0usize;
    while written < len && attempts < 64 {
        attempts += 1;
        // SAFETY: this live slice's pointer and length remain valid for the write syscall.
        let ret = syscall6(SYS_WRITE, 2, message[written..len].as_ptr() as usize, len - written, 0, 0, 0);
        if ret == -EINTR { continue; }
        if ret <= 0 { break; }
        written += ret as usize;
    }
    // SAFETY: exit_group terminates this process without touching Rust runtime state.
    unsafe {
        core::arch::asm!("syscall", in("rax") SYS_EXIT_GROUP, in("rdi") checkpoint as usize, options(noreturn, nostack));
    }
}

fn open_null() -> i32 {
    call4(SYS_OPENAT, (-100isize) as usize, ptr(NULL_PATH), O_RDWR | O_CLOEXEC, 0) as i32
}
fn guard(expected: i32) -> bool {
    let before = call0(SYS_GETPPID) as i32;
    if failed(call5(SYS_PRCTL, PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0))
        || before != expected
        || call0(SYS_GETPPID) as i32 != before
    {
        return false;
    }
    true
}
fn mount(src: &[u8], target: &[u8], fs: &[u8], flags: usize, data: &[u8]) -> bool {
    // All callers pass private static NUL-terminated values or the fixed, terminated run buffer.
    !failed(call5(SYS_MOUNT, ptr(src), ptr(target), ptr(fs), flags, ptr(data)))
}
fn wait_status(pid: i32) -> i32 {
    let mut status = 0i32;
    loop {
        // SAFETY: `status` is a live i32 output buffer valid for wait4's status write.
        let r = call4(SYS_WAIT4, pid as usize, &mut status as *mut _ as usize, 0, 0);
        if r == -EINTR {
            continue;
        }
        if r != pid as i64 {
            return 111;
        }
        if status & 0x7f == 0 {
            return (status >> 8) & 0xff;
        }
        if status & 0x7f == 0x7f {
            return 111;
        }
        return 128 + (status & 0x7f);
    }
}
fn closefd(fd: i32) {
    let _ = call1(SYS_CLOSE, fd as usize);
}
fn fork() -> i32 {
    call0(SYS_FORK) as i32
}
fn worker(uid: u32, gid: u32, nullfd: i32, args: Args) -> ! {
    if !guard(1)
        || call0(SYS_GETPID) != 2
        || nullfd < 0
        || call0(SYS_GETUID) != uid as i64
        || call0(SYS_GETEUID) != uid as i64
        || call0(SYS_GETGID) != gid as i64
        || call0(SYS_GETEGID) != gid as i64
        || call2(SYS_GETGROUPS, 0, 0) != 0
    {
        die(121);
    }
    for fd in 0..3 {
        if failed(call2(SYS_DUP2, nullfd as usize, fd as usize)) {
            die(121);
        }
    }
    if nullfd > 2 {
        closefd(nullfd);
    }
    if failed(call5(SYS_PRCTL, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))
        || failed(call5(SYS_PRCTL, PR_SET_DUMPABLE, 0, 0, 0, 0))
    {
        die(122);
    }
    // SAFETY: args and its NUL-terminated arrays were built before both forks and remain live
    // on this copied child stack; pointers reference static strings and a null-terminated env.
    // IMAGE is the verified sealed executable; AT_EMPTY_PATH executes it by descriptor.
    let _ = syscall6(
        SYS_EXECVEAT,
        IMAGE as usize,
        ptr(b"\0"),
        args.av.as_ptr() as usize,
        args.ev.as_ptr() as usize,
        AT_EMPTY_PATH,
        0,
    );
    die(123)
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    // Arguments are read and copied before the first fork; after fork only fixed buffers and raw syscalls are used.
    let argv: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let env_empty = std::env::vars_os().next().is_none();
    let uid = argv.get(1).and_then(|s| parse_id(s.as_os_str().as_bytes()));
    let gid = argv.get(2).and_then(|s| parse_id(s.as_os_str().as_bytes()));
    let Some(uid) = uid else { die(112) };
    let Some(gid) = gid else { die(112) };
    let pid = call0(SYS_GETPID);
    let tid = call0(SYS_GETTID);
    let tasks = std::fs::read_dir("/proc/self/task").unwrap_or_else(|_| die(112));
    let mut task_count = 0usize;
    for entry in tasks {
        let entry = entry.unwrap_or_else(|_| die(112));
        let name = entry.file_name();
        let Some(name) = name.to_str() else { die(112) };
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            die(112);
        }
        task_count += 1;
    }
    if argv.len() != 3 || !env_empty || pid <= 0 || pid != tid || task_count != 1
        || call0(SYS_GETUID) != 0 || call0(SYS_GETEUID) != 0 || !verify()
    {
        die(112);
    }
    drop(argv);
    let argbytes = ARGV;
    let av = [argbytes[0].as_ptr() as *const i8, argbytes[1].as_ptr() as *const i8, std::ptr::null()];
    let ev = [std::ptr::null()];
    let run = build_run(uid, gid);
    let args = Args { av, ev, run };
    let parent = call0(SYS_GETPPID) as i32;
    if parent <= 0 || !guard(parent) {
        die(113);
    }
    let nullfd = open_null();
    if nullfd < 0 {
        die(114);
    }
    if failed(call2(SYS_FCHDIR, ROOT as usize, 0)) || failed(call1(SYS_CHROOT, ptr(b".\0"))) || failed(call1(SYS_CHDIR, ptr(b"/\0"))) {
        die(116);
    }
    // Keep inherited resources until the root descriptor is closed before unshare.
    closefd(ROOT);
    if failed(call1(SYS_UNSHARE, CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID))
        || failed(call5(SYS_MOUNT, 0, ptr(b"/\0"), 0, MS_REC | MS_PRIVATE, 0))
    {
        die(114);
    }
    let init = fork();
    if init < 0 {
        die(115);
    }
    if init == 0 {
        if !guard(0) {
            die(116);
        }
        if !mount(PROC, PROC_PATH, PROC_FS, MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, PROC_OPTS) {
            die(117);
        }
        if !mount(TMPFS, RUN, TMPFS, MS_NOSUID | MS_NODEV | MS_NOEXEC, &args.run) {
            die(118);
        }
        if failed(call2(SYS_SETGROUPS, 0, 0))
            || failed(call3(SYS_SETRESGID, gid as usize, gid as usize, gid as usize))
            || failed(call3(SYS_SETRESUID, uid as usize, uid as usize, uid as usize))
            || failed(call5(SYS_PRCTL, PR_SET_DUMPABLE, 1, 0, 0, 0))
            || !guard(0)
        {
            die(119);
        }
        let child = fork();
        if child < 0 {
            die(120);
        }
        if child == 0 {
            worker(uid, gid, nullfd, args);
        }
        closefd(IMAGE);
        closefd(CONTROL);
        closefd(META);
        closefd(nullfd);
        // SAFETY: wait_status validates waitpid's child result; _exit avoids runtime cleanup after fork.
        unsafe {
            core::arch::asm!("syscall", in("rax") SYS_EXIT, in("rdi") wait_status(child) as usize, options(noreturn, nostack));
        }
    }
    closefd(IMAGE);
    closefd(CONTROL);
    closefd(META);
    closefd(nullfd);
    let code = wait_status(init);
    // SAFETY: _exit propagates the child status without post-fork runtime cleanup.
    unsafe {
        core::arch::asm!("syscall", in("rax") SYS_EXIT, in("rdi") code as usize, options(noreturn, nostack));
    }
}

fn build_run(uid: u32, gid: u32) -> [u8; 96] {
    let mut out = [0u8; 96];
    let mut p = 0usize;
    fn append(out: &mut [u8; 96], p: &mut usize, text: &[u8]) {
        for &b in text {
            out[*p] = b;
            *p += 1;
        }
    }
    fn decimal(out: &mut [u8; 96], p: &mut usize, mut n: u32) {
        let mut buf = [0u8; 10];
        let mut i = buf.len();
        loop {
            i -= 1;
            buf[i] = b'0' + (n % 10) as u8;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        append(out, p, &buf[i..]);
    }
    append(&mut out, &mut p, b"mode=0700,size=1m,uid=");
    decimal(&mut out, &mut p, uid);
    append(&mut out, &mut p, b",gid=");
    decimal(&mut out, &mut p, gid);
    out[p] = 0;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syscall_errors_are_bounded() {
        assert_eq!(syscall_error(-1), Some(1));
        assert_eq!(syscall_error(-4095), Some(4095));
        assert_eq!(syscall_error(-4096), None);
        assert_eq!(syscall_error(0), None);
        assert_eq!(syscall_error(1), None);
    }

    #[test]
    fn diagnostic_formats_checkpoint_and_errno() {
        for (errno, expected) in [
            (9, b"task245-init: checkpoint=112 errno=9\n" as &[u8]),
            (0, b"task245-init: checkpoint=112 errno=0\n" as &[u8]),
            (4095, b"task245-init: checkpoint=112 errno=4095\n" as &[u8]),
        ] {
            let (actual, len) = format_diagnostic(112, errno);
            assert_eq!(len, expected.len());
            assert_eq!(&actual[..len], expected);
        }
        let (actual, len) = format_diagnostic(129, 4095);
        assert_eq!(&actual[..len], b"task245-init: checkpoint=129 errno=4095\n");
        assert!(len <= 64);
    }

    #[test]
    fn parse_and_mount_options() {
        assert_eq!(parse_id(b""), None);
        assert_eq!(parse_id(b"12x"), None);
        assert_eq!(parse_id(b"4294967296"), None);
        assert_eq!(parse_id(b"4294967295"), Some(u32::MAX));
        assert_eq!(parse_id(b"42"), Some(42));
        assert_eq!(parse_id(b"01"), None);
        assert_eq!(parse_id(b"0"), None);
        let options = build_run(4294967295, 7);
        let expected = b"mode=0700,size=1m,uid=4294967295,gid=7";
        assert_eq!(&options[..expected.len()], expected);
    }

    #[test]
    fn stat_and_rlimit_abi_layout() {
        assert_eq!(std::mem::size_of::<Stat>(), 144);
        assert_eq!(std::mem::align_of::<Stat>(), 8);
        assert_eq!(std::mem::size_of::<StatFs>(), 120);
        assert_eq!(std::mem::align_of::<StatFs>(), 8);
        assert_eq!(std::mem::offset_of!(StatFs, flags), 80);
        assert_eq!(std::mem::size_of::<Rlimit>(), 16);
        assert_eq!(std::mem::align_of::<Rlimit>(), 8);
    }

    #[test]
    fn unequal_uid_gid_run_options() {
        let options = build_run(123, 456);
        let expected = b"mode=0700,size=1m,uid=123,gid=456";
        assert_eq!(&options[..expected.len()], expected);
    }
}
