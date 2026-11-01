use core::arch::asm;
pub const SYS_READ: usize = 0;
pub const SYS_CLOSE: usize = 3;
pub const SYS_FCNTL: usize = 72;
pub const SYS_GETPID: usize = 39;
pub const SYS_GETTID: usize = 186;
pub const SYS_GETDENTS64: usize = 217;
pub const SYS_OPENAT: usize = 257;
pub const SYS_EXECVEAT: usize = 322;
pub const SYS_EXIT: usize = 60;
pub const SYS_PRCTL: usize = 157;
pub const ERRNO_EINTR: isize = 4;
pub const FD_CLOEXEC: usize = 1;
pub const F_GETFD: usize = 1;
pub const F_GETFL: usize = 3;
pub const F_SETFD: usize = 2;
pub const O_RDONLY: usize = 0;
pub const O_ACCMODE: usize = 3;
pub const O_CLOEXEC: usize = 0x80000;
pub const O_DIRECTORY: usize = 0x10000;
pub const AT_FDCWD: usize = (-100isize) as usize;
pub const AT_EMPTY_PATH: usize = 0x1000;
const PR_SET_SECCOMP: usize = 22;
const PR_SET_NO_NEW_PRIVS: usize = 38;
const SECCOMP_MODE_FILTER: usize = 2;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const EPERM: u32 = 1;
const ENOSYS: u32 = 38;
const SYS_CLONE: u32 = 56;
const SYS_IO_URING_SETUP: u32 = 425;
const SYS_CLONE3: u32 = 435;
const SYS_PTRACE: u32 = 101;
const SYS_PROCESS_VM_WRITEV: u32 = 311;
const SYS_UNSHARE: u32 = 272;
const SYS_SETNS: u32 = 308;
const SYS_MOUNT: u32 = 165;
const SYS_UMOUNT2: u32 = 166;
const SYS_PIVOT_ROOT: u32 = 155;
const SYS_CHROOT: u32 = 161;
const SYS_OPEN_TREE: u32 = 428;
const SYS_MOVE_MOUNT: u32 = 429;
const SYS_FSOPEN: u32 = 430;
const SYS_FSCONFIG: u32 = 431;
const SYS_FSMOUNT: u32 = 432;
const SYS_FSPICK: u32 = 433;
const SYS_MOUNT_SETATTR: u32 = 442;
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

/// Invoke a Linux x86-64 syscall directly.
///
/// # Safety
/// The caller must supply valid pointer extents for every pointer argument,
/// according to the Linux syscall ABI. The kernel consumes those extents
/// synchronously during the syscall.
pub unsafe fn call(n: usize, a: [usize; 6]) -> isize {
    let result: isize;
    // SAFETY: Register assignments match the Linux x86-64 syscall ABI. The
    // caller upholds pointer validity; rcx and r11 are syscall-clobbered.
    unsafe {
        asm!(
            "syscall",
            inlateout("rax") n as isize => result,
            in("rdi") a[0],
            in("rsi") a[1],
            in("rdx") a[2],
            in("r10") a[3],
            in("r8") a[4],
            in("r9") a[5],
            lateout("rcx") _,
            lateout("r11") _,
        );
    }
    result
}

/// Exit the process with the launch-stub failure status.
pub fn exit() -> ! {
    loop {
        // SAFETY: syscall 60 takes an integer status and no pointers; the
        // syscall does not return for this process.
        unsafe {
            let _ = call(SYS_EXIT, [111, 0, 0, 0, 0, 0]);
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Filter(u16, u8, u8, u32);

#[repr(C)]
struct Fprog {
    len: u16,
    filter: *const Filter,
}

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_JMP_JSET_K: u16 = 0x45;
const BPF_RET_K: u16 = 0x06;
const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
const fn stmt(code: u16, k: u32) -> Filter {
    Filter(code, 0, 0, k)
}

const fn jump(code: u16, k: u32, jt: u8, jf: u8) -> Filter {
    Filter(code, jt, jf, k)
}

const fn deny(nr: u32, action: u32) -> [Filter; 2] {
    [jump(BPF_JMP_JEQ_K, nr, 0, 1), stmt(BPF_RET_K, action)]
}

/// Construct the selected-ABI classic-BPF launch policy preserved from baseline 8eadbd4.
fn filter() -> [Filter; 45] {
    let mut f = [stmt(BPF_RET_K, 0); 45];
    let mut i = 0;
    f[i] = stmt(BPF_LD_W_ABS, 4); i += 1;
    f[i] = jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0); i += 1;
    f[i] = stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS); i += 1;
    f[i] = stmt(BPF_LD_W_ABS, 0); i += 1;
    f[i] = jump(BPF_JMP_JSET_K, 0x4000_0000, 0, 1); i += 1;
    f[i] = stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM); i += 1;

    let denied = [
        (SYS_CLONE3, SECCOMP_RET_ERRNO | ENOSYS), (SYS_IO_URING_SETUP, SECCOMP_RET_ERRNO | ENOSYS),
        (SYS_PTRACE, SECCOMP_RET_ERRNO | EPERM), (SYS_PROCESS_VM_WRITEV, SECCOMP_RET_ERRNO | EPERM),
        (SYS_UNSHARE, SECCOMP_RET_ERRNO | EPERM), (SYS_SETNS, SECCOMP_RET_ERRNO | EPERM),
        (SYS_MOUNT, SECCOMP_RET_ERRNO | EPERM), (SYS_UMOUNT2, SECCOMP_RET_ERRNO | EPERM),
        (SYS_PIVOT_ROOT, SECCOMP_RET_ERRNO | EPERM), (SYS_CHROOT, SECCOMP_RET_ERRNO | EPERM),
        (SYS_MOVE_MOUNT, SECCOMP_RET_ERRNO | EPERM), (SYS_OPEN_TREE, SECCOMP_RET_ERRNO | EPERM),
        (SYS_FSOPEN, SECCOMP_RET_ERRNO | EPERM), (SYS_FSCONFIG, SECCOMP_RET_ERRNO | EPERM),
        (SYS_FSMOUNT, SECCOMP_RET_ERRNO | EPERM), (SYS_FSPICK, SECCOMP_RET_ERRNO | EPERM),
        (SYS_MOUNT_SETATTR, SECCOMP_RET_ERRNO | EPERM),
    ];
    let mut j = 0;
    while j < denied.len() {
        let pair = deny(denied[j].0, denied[j].1);
        f[i] = pair[0]; i += 1;
        f[i] = pair[1]; i += 1;
        j += 1;
    }
    f[i] = jump(BPF_JMP_JEQ_K, SYS_CLONE, 0, 3); i += 1;
    f[i] = stmt(BPF_LD_W_ABS, 16); i += 1;
    f[i] = jump(BPF_JMP_JSET_K, 0x7e82_0000, 0, 1); i += 1;
    f[i] = stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM); i += 1;
    f[i] = stmt(BPF_RET_K, SECCOMP_RET_ALLOW);
    f
}

/// Install the launch-stub seccomp policy; returns false on either prctl error.
pub fn sandbox() -> bool {
    let instructions = filter();
    let program = Fprog {
        len: instructions.len() as u16,
        filter: instructions.as_ptr(),
    };
    // SAFETY: prctl's scalar arguments have no pointer extents.
    let no_new_privs = unsafe { call(SYS_PRCTL, [PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0, 0]) };
    if no_new_privs < 0 {
        return false;
    }
    // SAFETY: `program` and its backing filter remain alive through the
    // synchronous prctl call; the kernel reads exactly `len` Filter entries.
    unsafe {
        call(SYS_PRCTL, [PR_SET_SECCOMP, 2, &program as *const Fprog as usize, 0, 0, 0]) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_has_stub_instruction_count_and_clone_guard() {
        let instructions = filter();
        assert_eq!(instructions.len(), 45);
        assert_eq!(instructions[0], stmt(BPF_LD_W_ABS, 4));
        assert_eq!(instructions[1], jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0));
        assert_eq!(instructions[2], stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
        assert_eq!(instructions[3], stmt(BPF_LD_W_ABS, 0));
        assert_eq!(instructions[4], jump(BPF_JMP_JSET_K, 0x4000_0000, 0, 1));
        assert_eq!(instructions[5], stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));

        let denied = [
            (SYS_CLONE3, SECCOMP_RET_ERRNO | ENOSYS), (SYS_IO_URING_SETUP, SECCOMP_RET_ERRNO | ENOSYS),
            (SYS_PTRACE, SECCOMP_RET_ERRNO | EPERM), (SYS_PROCESS_VM_WRITEV, SECCOMP_RET_ERRNO | EPERM),
            (SYS_UNSHARE, SECCOMP_RET_ERRNO | EPERM), (SYS_SETNS, SECCOMP_RET_ERRNO | EPERM),
            (SYS_MOUNT, SECCOMP_RET_ERRNO | EPERM), (SYS_UMOUNT2, SECCOMP_RET_ERRNO | EPERM),
            (SYS_PIVOT_ROOT, SECCOMP_RET_ERRNO | EPERM), (SYS_CHROOT, SECCOMP_RET_ERRNO | EPERM),
            (SYS_MOVE_MOUNT, SECCOMP_RET_ERRNO | EPERM), (SYS_OPEN_TREE, SECCOMP_RET_ERRNO | EPERM),
            (SYS_FSOPEN, SECCOMP_RET_ERRNO | EPERM), (SYS_FSCONFIG, SECCOMP_RET_ERRNO | EPERM),
            (SYS_FSMOUNT, SECCOMP_RET_ERRNO | EPERM), (SYS_FSPICK, SECCOMP_RET_ERRNO | EPERM),
            (SYS_MOUNT_SETATTR, SECCOMP_RET_ERRNO | EPERM),
        ];
        for (index, (nr, action)) in denied.iter().enumerate() {
            let offset = 6 + index * 2;
            assert_eq!(instructions[offset], jump(BPF_JMP_JEQ_K, *nr, 0, 1));
            assert_eq!(instructions[offset + 1], stmt(BPF_RET_K, *action));
        }

        assert_eq!(instructions[40], jump(BPF_JMP_JEQ_K, SYS_CLONE, 0, 3));
        assert_eq!(instructions[41], stmt(BPF_LD_W_ABS, 16));
        assert_eq!(instructions[42], jump(BPF_JMP_JSET_K, 0x7e82_0000, 0, 1));
        assert_eq!(instructions[43], stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
        assert_eq!(instructions[44], stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
    }
}
