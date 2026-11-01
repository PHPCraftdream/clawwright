use crate::filters::Filter;
use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CString};
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::mem::{align_of, size_of};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

const EBADF: i32 = 9;
const O_CLOEXEC: i32 = 0o2000000;
const O_NOFOLLOW: i32 = 0o400000;
const O_PATH: i32 = 0o10000000;
const SOCK_SEQPACKET: i32 = 5;
const SOL_SOCKET: i32 = 1;
const SO_PEERCRED: i32 = 17;
const SO_TYPE: i32 = 3;
const SCM_RIGHTS: i32 = 1;
const PR_SET_DUMPABLE: c_int = 4;
const PR_SET_NO_NEW_PRIVS: c_int = 38;
const PR_SET_SECCOMP: c_int = 22;
const SECCOMP_MODE_FILTER: c_int = 2;
const SECCOMP_SET_MODE_FILTER: c_int = 1;
const SECCOMP_FILTER_FLAG_NEW_LISTENER: c_uint = 8;
const RLIMIT_CORE: c_int = 4;
const RLIMIT_NOFILE: c_int = 7;
const MFD_ALLOW_SEALING: c_uint = 2;
const F_GETFD: c_int = 1;
const F_ADD_SEALS: c_int = 1033;
const F_SEAL_ALL: c_int = 15;
const SYS_MEMFD_CREATE: c_long = 319;
const SYS_SECCOMP: c_long = 317;
const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
const SYS_LANDLOCK_ADD_RULE: c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: c_long = 446;
const CANCEL_FD: c_int = 1023;
const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_USER_NOTIF: u32 = 0x7fc0_0000;

#[repr(C)]
struct RLimit {
    current: u64,
    maximum: u64,
}
#[repr(C)]
struct UCred {
    pid: i32,
    uid: u32,
    gid: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}
#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
}
#[repr(C)]
struct Iovec {
    base: *mut c_void,
    len: usize,
}
#[repr(C, align(8))]
struct Cmsghdr {
    len: usize,
    level: i32,
    kind: i32,
}
#[repr(C)]
struct Control {
    header: Cmsghdr,
    fd: i32,
    pad: i32,
}
#[repr(C)]
struct Msghdr {
    name: *mut c_void,
    name_len: u32,
    iov: *mut Iovec,
    iov_len: usize,
    control: *mut c_void,
    control_len: usize,
    flags: i32,
}
#[repr(C)]
struct Statvfs {
    bsize: u64,
    frsize: u64,
    blocks: u64,
    bfree: u64,
    bavail: u64,
    files: u64,
    ffree: u64,
    favail: u64,
    fsid: u64,
    flag: u64,
    namemax: u64,
    spare: [i32; 6],
}
#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
}
#[repr(C, packed)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

unsafe extern "C" {
    fn geteuid() -> u32;
    fn getuid() -> u32;
    fn getpid() -> i32;
    fn prctl(option: c_int, ...) -> c_int;
    fn getrlimit(resource: c_int, limit: *mut RLimit) -> c_int;
    fn setrlimit(resource: c_int, limit: *const RLimit) -> c_int;
    fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn dup3(oldfd: c_int, newfd: c_int, flags: c_int) -> c_int;
    fn getsockopt(fd: c_int, level: c_int, name: c_int, value: *mut c_void, len: *mut u32) -> c_int;
    fn sendmsg(fd: c_int, message: *const Msghdr, flags: c_int) -> isize;
    fn syscall(number: c_long, ...) -> c_long;
    fn statvfs(path: *const c_char, value: *mut Statvfs) -> c_int;
    fn execve(path: *const c_char, argv: *const *const c_char, envp: *const *const c_char) -> c_int;
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidData)
}

fn trusted_dir(path: &str) -> io::Result<()> {
    if !Path::new(path).is_absolute() {
        return Err(invalid());
    }
    let m = fs::symlink_metadata(path)?;
    if !m.file_type().is_dir() || m.uid() != 0 || m.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    Ok(())
}

fn nofollow_file(path: &str) -> io::Result<fs::File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)
}

fn trusted_marker(path: &str) -> io::Result<Vec<u8>> {
    let f = nofollow_file(path)?;
    let m = f.metadata()?;
    if !m.file_type().is_file() || m.uid() != 0 || m.nlink() != 1
        || m.mode() & 0o7777 != 0o444
        || m.len() == 0
        || m.len() > 128
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    f.take(129).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > 128 {
        return Err(invalid());
    }
    Ok(bytes)
}

pub(crate) fn prepare(mode: &str) -> io::Result<()> {
    // SAFETY: geteuid/getuid/getpid and prctl are process scalar operations with no pointers.
    let (uid, euid, pid) = unsafe { (getuid(), geteuid(), getpid()) };
    if uid != 65534 || euid != 65534 || pid <= 1 {
        return Err(invalid());
    }
    // SAFETY: statically sized single-thread task directory; path CString remains live for call.
    let tasks = CString::new("/proc/self/task").map_err(|_| invalid())?;
    let entries = fs::read_dir("/proc/self/task")?;
    if entries.count() != 1 { return Err(invalid()); }
    for path in ["/", "/lab", "/lab/bin"] {
        trusted_dir(path)?;
    }
    let harness = fs::symlink_metadata("/lab/bin/harness")?;
    if !harness.file_type().is_file() || harness.uid() != 0 || harness.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    if mode != "golden" {
        let _profile = trusted_marker("/lab/disposable-profile")?;
        let scenario = trusted_marker("/lab/scenario")?;
        let scenario = std::str::from_utf8(&scenario).map_err(|_| invalid())?;
        let permitted = match scenario {
            "wrong-holder" | "unexpected-exec" => mode == "withheld",
            "partial-ack" | "lost-ack" => mode == "unknown",
            "cancel" => mode == "cancel",
            _ => false,
        };
        if !permitted {
            return Err(invalid());
        }
        let fd3 = 3;
        let mut kind = 0i32;
        let mut kind_len = size_of::<i32>() as u32;
        // SAFETY: initialized output and length pointers refer to live locals; fd 3 is validated as a socket.
        let type_rc = unsafe { getsockopt(fd3, SOL_SOCKET, SO_TYPE, (&mut kind as *mut i32).cast(), &mut kind_len) };
        if type_rc != 0 { return Err(last_error()); }
        if kind != SOCK_SEQPACKET || kind_len as usize != size_of::<i32>() {
            return Err(invalid());
        }
        let mut cred = UCred { pid: 0, uid: 0, gid: 0 };
        let mut length = size_of::<UCred>() as u32;
        // SAFETY: initialized credential output and length pointers refer to live, correctly sized locals.
        let rc = unsafe { getsockopt(fd3, SOL_SOCKET, SO_PEERCRED, (&mut cred as *mut UCred).cast(), &mut length) };
        if rc != 0 { return Err(last_error()); }
        if cred.uid != 0 || cred.pid <= 1 || length as usize != size_of::<UCred>() {
            return Err(invalid());
        }
    }
    let core = RLimit { current: 0, maximum: 0 };
    // SAFETY: setrlimit receives a valid initialized ABI-compatible limit; prctl scalar arguments only.
    if unsafe { setrlimit(RLIMIT_CORE, &core) } != 0 { return Err(last_error()); }
    // SAFETY: PR_SET_DUMPABLE takes scalar arguments; no pointer is supplied.
    let dumpable = unsafe { prctl(PR_SET_DUMPABLE, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) };
    if dumpable != 0 {
        return Err(last_error());
    }
    drop(tasks);
    Ok(())
}

pub(crate) fn close_inherited(golden: bool) -> io::Result<()> {
    let mut limit = RLimit { current: 0, maximum: 0 };
    // SAFETY: getrlimit writes one initialized ABI-compatible local.
    if unsafe { getrlimit(RLIMIT_NOFILE, &mut limit) } != 0 { return Err(last_error()); }
    if limit.current > 1_048_576 {
        return Err(invalid());
    }
    let max = limit.current;
    for fd in 4..max {
        // SAFETY: close is called only on the enumerated descriptor; EBADF is handled below.
        let rc = unsafe { close(fd as i32) };
        if rc != 0 {
            let error = last_error();
            if error.raw_os_error() != Some(EBADF) { return Err(error); }
        }
    }
    if golden {
        // SAFETY: descriptor 3 is explicitly excluded only for non-golden profiles.
        let rc = unsafe { close(3) };
        if rc != 0 {
            let error = last_error();
            if error.raw_os_error() != Some(EBADF) { return Err(error); }
        }
    }
    Ok(())
}

pub(crate) fn reserve_cancel_fd() -> io::Result<()> {
    let mut limit = RLimit { current: 0, maximum: 0 };
    // SAFETY: getrlimit writes the valid local output structure.
    if unsafe { getrlimit(RLIMIT_NOFILE, &mut limit) } != 0 { return Err(last_error()); }
    if limit.current <= CANCEL_FD as u64 {
        return Err(invalid());
    }
    // SAFETY: fcntl only inspects the fixed descriptor; no variadic argument is required for F_GETFD.
    let probe = unsafe { fcntl(CANCEL_FD, F_GETFD) };
    if probe != -1 || last_error().raw_os_error() != Some(EBADF) {
        return Err(invalid());
    }
    let name = CString::new("cancel-token").map_err(|_| invalid())?;
    // SAFETY: syscall receives a valid NUL-terminated name and scalar creation flags.
    let fd = unsafe { syscall(SYS_MEMFD_CREATE, name.as_ptr(), MFD_ALLOW_SEALING) };
    if fd < 0 {
        return Err(last_error());
    }
    let fd = fd as i32;
    // SAFETY: fcntl F_ADD_SEALS takes the scalar seal mask for this owned memfd.
    if unsafe { fcntl(fd, F_ADD_SEALS, F_SEAL_ALL) } != 0 {
        let error = last_error();
        // SAFETY: fd remains owned here and is closed once on this failure path.
        unsafe { close(fd); }
        return Err(error);
    }
    // SAFETY: dup3 atomically installs the owned memfd into the previously verified free slot.
    if unsafe { dup3(fd, CANCEL_FD, 0) } < 0 {
        let error = last_error();
        // SAFETY: fd remains owned here and is closed once on this failure path.
        unsafe { close(fd); }
        return Err(error);
    }
    // SAFETY: successful dup3 created an independent descriptor; close the original owned descriptor.
    if unsafe { close(fd) } != 0 { return Err(last_error()); }
    Ok(())
}

fn bpf(filters: &[Filter]) -> io::Result<Vec<SockFilter>> {
    if filters.is_empty() || filters.len() > u16::MAX as usize { return Err(invalid()); }
    Ok(filters.iter().map(|f| SockFilter { code: f.code, jt: f.jt, jf: f.jf, k: f.k }).collect())
}

fn install_filter(filters: &[Filter], listener: bool) -> io::Result<i32> {
    let code = bpf(filters)?;
    let program = SockFprog { len: u16::try_from(code.len()).map_err(|_| invalid())?, filter: code.as_ptr() };
    // SAFETY: program points to a live immutable BPF array of len instructions for the synchronous kernel call.
    if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) } != 0 { return Err(last_error()); }
    if listener {
        // SAFETY: syscall receives the valid filter program pointer and known seccomp operation/flag ABI.
        let result = unsafe { syscall(SYS_SECCOMP, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program) };
        if result < 0 { return Err(last_error()); }
        Ok(result as i32)
    } else {
        // SAFETY: PR_SET_SECCOMP consumes the live, correctly laid out program synchronously.
        if unsafe { prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER as c_ulong, (&program as *const SockFprog) as c_ulong) } != 0 { return Err(last_error()); }
        Ok(-1)
    }
}

pub(crate) fn handoff(filters: &[Filter]) -> io::Result<()> {
    let listener = install_filter(filters, true)?;
    let fd = 3;
    let mut payload = *b"OCMETA01";
    let mut iov = Iovec { base: payload.as_mut_ptr().cast(), len: payload.len() };
    let mut control = Control { header: Cmsghdr { len: size_of::<Cmsghdr>() + size_of::<i32>(), level: SOL_SOCKET, kind: SCM_RIGHTS }, fd: listener, pad: 0 };
    let message = Msghdr {
        name: std::ptr::null_mut(), name_len: 0, iov: &mut iov, iov_len: 1,
        control: (&mut control as *mut Control).cast(), control_len: size_of::<Control>(), flags: 0,
    };
    // SAFETY: descriptor 3 is the root-credential SOCK_SEQPACKET endpoint validated in prepare.
    // SAFETY: message, iovec, payload and control buffer are live and initialized for the synchronous call.
    let sent = unsafe { sendmsg(fd, &message, 0x4000) };
    let result = if sent == payload.len() as isize { Ok(()) } else if sent < 0 { Err(last_error()) } else { Err(io::Error::from(io::ErrorKind::WriteZero)) };
    // SAFETY: fd 3 is inherited and listener is locally owned; each is closed exactly once after send.
    let fd3_close = unsafe { close(fd) };
    let fd3_error = if fd3_close != 0 { Some(last_error()) } else { None };
    // SAFETY: listener remains locally owned until this close.
    let listener_close = unsafe { close(listener) };
    let listener_error = if listener_close != 0 { Some(last_error()) } else { None };
    result.and_then(|()| fd3_error.map_or(Ok(()), Err)).and_then(|()| listener_error.map_or(Ok(()), Err))
}

fn readonly_mount(path: &str) -> io::Result<bool> {
    let cpath = CString::new(path).map_err(|_| invalid())?;
    let mut value = Statvfs { bsize: 0, frsize: 0, blocks: 0, bfree: 0, bavail: 0,
        files: 0, ffree: 0, favail: 0, fsid: 0, flag: 0, namemax: 0, spare: [0; 6] };
    // SAFETY: statvfs receives a live NUL-terminated path and a correctly-sized amd64 statvfs output.
    if unsafe { statvfs(cpath.as_ptr(), &mut value) } != 0 { return Err(last_error()); }
    Ok(value.flag & 1 != 0)
}

fn landlock() -> io::Result<()> {
    const HANDLED: u64 = 0x7fff;
    const READ_EXEC: u64 = 13;
    const RULE_PATH_BENEATH: c_int = 1;
    const VERSION_FLAG: c_uint = 1;
    let attr = LandlockRulesetAttr { handled_access_fs: HANDLED };
    // SAFETY: ruleset attr is a valid initialized eight-byte kernel ABI structure.
    let ruleset = unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, &attr, size_of::<LandlockRulesetAttr>(), 0) };
    if ruleset < 0 { return Err(last_error()); }
    // SAFETY: version query intentionally passes NULL with size zero and the documented version flag.
    let version = unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, std::ptr::null::<LandlockRulesetAttr>(), 0, VERSION_FLAG) };
    if version < 3 { // SAFETY: ruleset is the valid locally-owned descriptor returned above.
        unsafe { close(ruleset as i32); }
        return Err(invalid());
    }
    let readonly = match readonly_mount("/lab/bin") {
        Ok(readonly) => readonly,
        Err(error) => {
            // SAFETY: close the locally-owned ruleset before returning the original error.
            unsafe { close(ruleset as i32); }
            return Err(error);
        }
    };
    if !readonly {
        // SAFETY: locally-owned ruleset descriptor is closed on the read-only check failure.
        unsafe { close(ruleset as i32); }
        return Err(invalid());
    }
    let path = match CString::new("/lab/bin") {
        Ok(path) => path,
        Err(_) => {
            // SAFETY: close the locally-owned ruleset before returning.
            unsafe { close(ruleset as i32); }
            return Err(invalid());
        }
    };
    // SAFETY: libc open receives a live NUL-terminated path and returns a newly-owned descriptor.
    let parent = unsafe { libc_open(path.as_ptr(), O_PATH | O_CLOEXEC) };
    if parent < 0 {
        let error = last_error();
        // SAFETY: close the locally-owned ruleset on this failure path.
        unsafe { close(ruleset as i32); }
        return Err(error);
    }
    let rule = LandlockPathBeneathAttr { allowed_access: READ_EXEC, parent_fd: parent };
    // SAFETY: rule has Linux's packed 12-byte ABI, initialized fields, and both descriptors stay open for syscall.
    let added = unsafe { syscall(SYS_LANDLOCK_ADD_RULE, ruleset, RULE_PATH_BENEATH, &rule, 0) };
    let added_error = if added < 0 { Some(last_error()) } else { None };
    // SAFETY: parent was opened locally and is closed once after add_rule returns.
    unsafe { close(parent); }
    if let Some(error) = added_error {
        // SAFETY: close the locally-owned ruleset on error.
        unsafe { close(ruleset as i32); }
        return Err(error);
    }
    // SAFETY: no_new_privs scalar operation; restrict_self consumes the owned ruleset synchronously.
    if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) } != 0 {
        let error = last_error();
        // SAFETY: close the locally-owned ruleset on this failure path.
        unsafe { close(ruleset as i32); }
        return Err(error);
    }
    // SAFETY: ruleset remains open and is a valid descriptor for restrict_self.
    let restricted = unsafe { syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0) };
    let error = if restricted < 0 { Some(last_error()) } else { None };
    // SAFETY: locally-owned ruleset descriptor is closed exactly once.
    unsafe { close(ruleset as i32); }
    if let Some(error) = error { return Err(error); }
    Ok(())
}

unsafe extern "C" { #[link_name = "open"] fn libc_open(path: *const c_char, flags: c_int, ...) -> c_int; }

pub(crate) fn confine(filters: &[Filter]) -> io::Result<()> {
    landlock()?;
    install_filter(filters, false)?;
    Ok(())
}

pub(crate) fn exec(argv: &[CString], env: &[CString]) -> io::Result<()> {
    if argv.is_empty() { return Err(invalid()); }
    let mut args: Vec<*const c_char> = argv.iter().map(|s| s.as_ptr()).collect();
    let mut environment: Vec<*const c_char> = env.iter().map(|s| s.as_ptr()).collect();
    args.push(std::ptr::null());
    environment.push(std::ptr::null());
    // SAFETY: both null-terminated pointer arrays and every CString owner remain live for synchronous execve.
    let rc = unsafe { execve(argv[0].as_ptr(), args.as_ptr(), environment.as_ptr()) };
    if rc == -1 { Err(last_error()) } else { Err(io::Error::other("execve returned unexpectedly")) }
}

#[cfg(test)]
mod abi_tests {
    use super::*;
    #[test]
    fn bpf_rejects_empty_and_oversized_programs() {
        let error = bpf(&[]).err().expect("empty program accepted");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let oversized = vec![Filter { code: 0, jt: 0, jf: 0, k: 0 }; u16::MAX as usize + 1];
        let error = bpf(&oversized).err().expect("oversized program accepted");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn empty_exec_is_rejected_before_execve() {
        let error = exec(&[], &[]).err().expect("empty exec accepted");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn linux_amd64_abi_layouts() {
        assert_eq!(size_of::<SockFilter>(), 8);
        assert_eq!(size_of::<SockFprog>(), 16);
        assert_eq!(size_of::<Cmsghdr>(), 16);
        assert_eq!(size_of::<Control>(), 24);
        assert_eq!(std::mem::offset_of!(Control, header), 0);
        assert_eq!(std::mem::offset_of!(Control, fd), 16);
        assert_eq!(std::mem::offset_of!(Control, pad), 20);
        assert_eq!(align_of::<Cmsghdr>(), 8);
        assert_eq!(size_of::<Iovec>(), 16);
        assert_eq!(size_of::<Msghdr>(), 56);
        assert_eq!(size_of::<Statvfs>(), 112);
        assert_eq!(size_of::<LandlockRulesetAttr>(), 8);
        assert_eq!(size_of::<LandlockPathBeneathAttr>(), 12);
    }
}
