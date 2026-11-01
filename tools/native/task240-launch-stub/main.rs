#![cfg_attr(not(all(target_os = "linux", target_arch = "x86_64")), allow(dead_code))]

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("task240 launch stub supports Linux amd64 only");

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "packet.rs"]
mod packet;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "linux.rs"]
mod linux;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod platform {
    use super::{linux, packet};
    use std::fs;
    use std::mem::ManuallyDrop;
    use std::os::fd::FromRawFd;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::ptr;

    const EINTR: isize = linux::ERRNO_EINTR;
    const O_RDONLY: usize = linux::O_RDONLY;
    const O_CLOEXEC: usize = linux::O_CLOEXEC;
    const O_DIRECTORY: usize = linux::O_DIRECTORY;
    const AT_FDCWD: usize = linux::AT_FDCWD;
    const FD_CLOEXEC: usize = linux::FD_CLOEXEC;
    const F_GETFL: usize = linux::F_GETFL;
    const F_SETFD: usize = linux::F_SETFD;
    const O_ACCMODE: usize = linux::O_ACCMODE;
    const AT_EMPTY_PATH: usize = linux::AT_EMPTY_PATH;
    const AT_FDCWD_DIR: usize = AT_FDCWD;

    #[cfg(all(not(test), target_os = "linux", target_arch = "x86_64"))]
    #[used]
    #[link_section = ".init_array"]
    static CHECK_INHERITED_FDS: extern "C" fn() = check_inherited_fds;

    #[cfg(all(not(test), target_os = "linux", target_arch = "x86_64"))]
    // SAFETY: Linux's GNU linker invokes this constructor before Rust main; it must not panic or allocate.
    extern "C" fn check_inherited_fds() {
        for fd in 0..=5 {
            // SAFETY: fcntl F_GETFD uses only scalar arguments and no pointers.
            if unsafe { linux::call(linux::SYS_FCNTL, [fd, linux::F_GETFD, 0, 0, 0, 0]) } < 0 {
                linux::exit();
            }
        }
    }

    fn die() -> ! {
        linux::exit()
    }

    fn raw(nr: usize, args: [usize; 6]) -> isize {
        // SAFETY: Each call site documents the syscall-specific pointer extent and lifetime.
        unsafe { linux::call(nr, args) }
    }

    fn check_start() {
        if std::env::args_os().len() != 1 || std::env::vars_os().next().is_some() {
            die();
        }
        // SAFETY: getpid/gettid take no pointers and return the current task IDs.
        if raw(linux::SYS_GETPID, [0; 6]) != raw(linux::SYS_GETTID, [0; 6]) {
            die();
        }
        let entries = match fs::read_dir("/proc/self/task") {
            Ok(v) => v,
            Err(_) => die(),
        };
        let mut count = 0usize;
        for entry in entries {
            let entry = match entry {
                Ok(v) => v,
                Err(_) => die(),
            };
            let name = entry.file_name();
            let bytes = name.as_encoded_bytes();
            if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
                die();
            }
            count += 1;
        }
        if count != 1 {
            die();
        }
    }

    // linux_dirent64: ino:u64, off:i64, reclen:u16, type:u8, name[].
    fn fd_inventory() {
        static PROC_FD: &[u8] = b"/proc/self/fd\0";
        // SAFETY: the NUL-terminated path remains live for openat; flags are Linux constants.
        let dirfd = raw(
            linux::SYS_OPENAT,
            [
                AT_FDCWD_DIR,
                PROC_FD.as_ptr() as usize,
                O_RDONLY | O_DIRECTORY | O_CLOEXEC,
                0,
                0,
                0,
            ],
        );
        if dirfd < 0 {
            die();
        }
        let dirfd = dirfd as usize;
        let mut seen = [false; 6];
        let mut buf = [0u8; 4096];
        loop {
            // SAFETY: buf is writable for its full extent; dirfd is the opened directory.
            let n = raw(linux::SYS_GETDENTS64, [dirfd, buf.as_mut_ptr() as usize, buf.len(), 0, 0, 0]);
            if n == -EINTR {
                continue;
            }
            if n < 0 {
                close(dirfd);
                die();
            }
            if n == 0 {
                break;
            }
            let mut off = 0usize;
            while off < n as usize {
                if n as usize - off < 19 {
                    close(dirfd);
                    die();
                }
                let reclen = u16::from_ne_bytes([buf[off + 16], buf[off + 17]]) as usize;
                if reclen < 20 || reclen > n as usize - off {
                    close(dirfd);
                    die();
                }
                let name = &buf[off + 19..off + reclen];
                let nul = match name.iter().position(|&b| b == 0) {
                    Some(v) => v,
                    None => {
                        close(dirfd);
                        die();
                    }
                };
                let name = &name[..nul];
                if name != b"." && name != b".." {
                    if name.is_empty() || !name.iter().all(u8::is_ascii_digit) {
                        close(dirfd);
                        die();
                    }
                    let mut value = 0usize;
                    for &b in name {
                        value = match value
                            .checked_mul(10)
                            .and_then(|v| v.checked_add((b - b'0') as usize))
                        {
                            Some(v) => v,
                            None => {
                                close(dirfd);
                                die();
                            }
                        };
                    }
                    // Ignore the scanner's own descriptor; it has been closed before final checks.
                    if value != dirfd {
                        if value >= seen.len() {
                            close(dirfd);
                            die();
                        }
                        seen[value] = true;
                    }
                }
                off += reclen;
            }
        }
        close(dirfd);
        if seen.iter().any(|v| !v) {
            die();
        }
    }

    fn close(fd: usize) {
        // SAFETY: close consumes only the specified descriptor; errors are handled by the caller where needed.
        let _ = raw(linux::SYS_CLOSE, [fd, 0, 0, 0, 0, 0]);
    }

    fn inspect_fds() {
        fd_inventory();
        for fd in 0..=5 {
            let path = format!("/proc/self/fd/{fd}");
            let target = match fs::read_link(path) {
                Ok(v) => v,
                Err(_) => die(),
            };
            if target
                .as_os_str()
                .as_encoded_bytes()
                .windows(b"io_uring".len())
                .any(|w| w == b"io_uring")
            {
                die();
            }
        }
        // SAFETY: fd 3 is known present from the inventory; ManuallyDrop prevents closing it.
        let executable = ManuallyDrop::new(unsafe { fs::File::from_raw_fd(3) });
        let meta = match executable.metadata() {
            Ok(v) => v,
            Err(_) => die(),
        };
        if !meta.file_type().is_file()
            || meta.uid() != 0
            || meta.nlink() != 1
            || meta.mode() & 0o022 != 0
            || meta.mode() & 0o111 == 0
        {
            die();
        }
        for fd in 4..=5 {
            // SAFETY: fcntl F_GETFL accepts this valid descriptor and no pointer arguments.
            let flags = raw(linux::SYS_FCNTL, [fd, F_GETFL, 0, 0, 0, 0]);
            if flags < 0 || flags as usize & O_ACCMODE != O_RDONLY {
                die();
            }
            // SAFETY: borrowed descriptor wrapper is never dropped, so it cannot close fd.
            let file = ManuallyDrop::new(unsafe { fs::File::from_raw_fd(fd as i32) });
            let meta = match file.metadata() {
                Ok(v) => v,
                Err(_) => die(),
            };
            if !meta.file_type().is_fifo() {
                die();
            }
        }
        // SAFETY: F_SETFD changes only descriptor 3's close-on-exec flag.
        if raw(linux::SYS_FCNTL, [3, F_SETFD, FD_CLOEXEC, 0, 0, 0]) < 0 {
            die();
        }
    }

    fn read_packet() -> packet::Packet {
        let mut bytes = Vec::with_capacity(packet::MAX_PACKET + 1);
        let mut scratch = [0u8; packet::MAX_PACKET + 1];
        loop {
            // Read up to 4097 total bytes, distinguishing a valid maximum from overflow.
            let remaining = scratch.len() - bytes.len();
            if remaining == 0 {
                die();
            }
            // SAFETY: scratch's remaining region is writable and fd 5 is the validated packet pipe.
            let result = raw(
                linux::SYS_READ,
                [
                    5,
                    scratch.as_mut_ptr().wrapping_add(bytes.len()) as usize,
                    remaining,
                    0,
                    0,
                    0,
                ],
            );
            if result == -EINTR {
                continue;
            }
            if result < 0 {
                die();
            }
            if result == 0 {
                break;
            }
            let got = result as usize;
            bytes.extend_from_slice(&scratch[bytes.len()..bytes.len() + got]);
            if bytes.len() > packet::MAX_PACKET || packet::validate_prefix(&bytes).is_err() {
                die();
            }
        }
        let parsed = match packet::parse(&bytes) {
            Ok(value) => value,
            Err(_) => die(),
        };
        bytes.fill(0);
        scratch.fill(0);
        parsed
    }

    fn await_gate() {
        let mut byte = 0u8;
        loop {
            // SAFETY: byte is writable for one byte; fd 4 is the validated gate pipe.
            let n = raw(linux::SYS_READ, [4, &mut byte as *mut u8 as usize, 1, 0, 0, 0]);
            if n == -EINTR {
                continue;
            }
            if n != 1 || byte != 0xa5 {
                die();
            }
            break;
        }
        loop {
            // SAFETY: byte remains writable and the read checks EOF after the gate token.
            let n = raw(linux::SYS_READ, [4, &mut byte as *mut u8 as usize, 1, 0, 0, 0]);
            if n == -EINTR {
                continue;
            }
            if n != 0 {
                die();
            }
            break;
        }
    }

    pub fn run() -> ! {
        std::panic::set_hook(Box::new(|_| {}));
        check_start();
        inspect_fds();
        let owned = read_packet();
        let mut argv = [ptr::null_mut(); packet::MAX_ARGS + 1];
        let mut envp = [ptr::null_mut(); packet::MAX_ENV + 1];
        for (i, slot) in argv.iter_mut().take(owned.argc).enumerate() {
            *slot = owned.argv.as_ptr().wrapping_add(owned.argv_offsets[i]) as *mut i8;
        }
        for (i, slot) in envp.iter_mut().take(owned.envc).enumerate() {
            *slot = owned.env.as_ptr().wrapping_add(owned.env_offsets[i]) as *mut i8;
        }
        close(5);
        await_gate();
        close(4);
        check_start();
        if !linux::sandbox() {
            die();
        }
        static EMPTY: &[u8] = b"\0";
        // SAFETY: fd 3 is the validated executable; empty path requests AT_EMPTY_PATH.
        // argv/envp point into `owned`, which remains unmoved and alive for this syscall;
        // each pointed-to string is NUL-terminated and both pointer arrays are NULL-terminated.
        let result = unsafe {
            linux::call(
                linux::SYS_EXECVEAT,
                [
                    3,
                    EMPTY.as_ptr() as usize,
                    argv.as_ptr() as usize,
                    envp.as_ptr() as usize,
                    AT_EMPTY_PATH,
                    0,
                ],
            )
        };
        let _ = result;
        die()
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn main() {
    platform::run()
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn main() {}
