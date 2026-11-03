#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(C)]
pub(crate) struct Filter {
    pub(crate) code: u16,
    pub(crate) jt: u8,
    pub(crate) jf: u8,
    pub(crate) k: u32,
}

const LD_W_ABS: u16 = 0x20;
const JMP_JEQ_K: u16 = 0x15;
const JMP_JSET_K: u16 = 0x45;
const RET_K: u16 = 0x06;
const ALLOW: u32 = 0x7fff_0000;
const ERRNO: u32 = 0x0005_0000;
const USER_NOTIF: u32 = 0x7fc0_0000;
const KILL_PROCESS: u32 = 0x8000_0000;
const ARCH_X86_64: u32 = 0xc000_003e;
const EPERM: u32 = 1;
const ENOSYS: u32 = 38;
const CANCEL_FD: u32 = 1023;

const fn stmt(code: u16, k: u32) -> Filter {
    Filter { code, jt: 0, jf: 0, k }
}

const fn jump(code: u16, k: u32, jt: u8, jf: u8) -> Filter {
    Filter { code, jt, jf, k }
}

const fn deny(errno: u32) -> Filter {
    stmt(RET_K, ERRNO | errno)
}

/// Builds the metadata broker's x86-64 descriptor protection filter.
pub(crate) fn metadata_filter() -> Vec<Filter> {
    vec![
        stmt(LD_W_ABS, 4),
        jump(JMP_JEQ_K, ARCH_X86_64, 1, 0),
        stmt(RET_K, KILL_PROCESS),
        stmt(LD_W_ABS, 0),
        // dup: skip the fd test when this is another syscall.
        jump(JMP_JEQ_K, 32, 0, 4),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, CANCEL_FD, 0, 1),
        deny(EPERM),
        stmt(RET_K, ALLOW),
        // dup2: either source or destination descriptor is protected.
        jump(JMP_JEQ_K, 33, 0, 6),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, CANCEL_FD, 2, 0),
        stmt(LD_W_ABS, 24),
        jump(JMP_JEQ_K, CANCEL_FD, 0, 1),
        deny(EPERM),
        stmt(RET_K, ALLOW),
        // dup3 has the same source/destination protection.
        jump(JMP_JEQ_K, 292, 0, 6),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, CANCEL_FD, 2, 0),
        stmt(LD_W_ABS, 24),
        jump(JMP_JEQ_K, CANCEL_FD, 0, 1),
        deny(EPERM),
        stmt(RET_K, ALLOW),
        // fcntl and ioctl may mutate descriptor state or perform I/O.
        jump(JMP_JEQ_K, 72, 0, 4),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, CANCEL_FD, 0, 1),
        deny(EPERM),
        stmt(RET_K, ALLOW),
        jump(JMP_JEQ_K, 16, 0, 4),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, CANCEL_FD, 0, 1),
        deny(EPERM),
        stmt(RET_K, ALLOW),
        // A write to the control descriptor must be mediated.
        jump(JMP_JEQ_K, 1, 0, 4),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, CANCEL_FD, 0, 1),
        stmt(RET_K, USER_NOTIF),
        stmt(RET_K, ALLOW),
        // Prevent a range operation from indirectly closing the descriptor.
        jump(JMP_JEQ_K, 436, 0, 1),
        deny(EPERM),
        jump(JMP_JEQ_K, 2, 0, 1),
        stmt(RET_K, USER_NOTIF),
        jump(JMP_JEQ_K, 257, 0, 1),
        stmt(RET_K, USER_NOTIF),
        jump(JMP_JEQ_K,  unlink_syscall(), 0, 1),
        stmt(RET_K, USER_NOTIF),
        jump(JMP_JEQ_K, 263, 0, 1),
        stmt(RET_K, USER_NOTIF),
        jump(JMP_JEQ_K, 3, 0, 1),
        stmt(RET_K, USER_NOTIF),
        stmt(RET_K, ALLOW),
    ]
}

const fn unlink_syscall() -> u32 { 87 }

/// Builds the control profile filter from the native x86-64 policy.
pub(crate) fn control_filter() -> Vec<Filter> {
    let mut f = vec![
        stmt(LD_W_ABS, 4),
        jump(JMP_JEQ_K, ARCH_X86_64, 1, 0),
        stmt(RET_K, KILL_PROCESS),
        stmt(LD_W_ABS, 0),
        jump(JMP_JSET_K, 0x4000_0000, 0, 1),
        deny(EPERM),
    ];
    for syscall in [53, 46, 47, 307, 299, 101, 310, 311, 434, 438, 440, 312, 321, 298, 323, 425, 426, 427, 303, 304, 308, 272, 165, 166, 155, 161] {
        f.push(jump(JMP_JEQ_K, syscall, 0, 1));
        f.push(deny(EPERM));
    }
    f.extend([
        jump(JMP_JEQ_K, 435, 0, 1),
        deny(ENOSYS),
        jump(JMP_JEQ_K, 56, 0, 4),
        stmt(LD_W_ABS, 16),
        jump(JMP_JSET_K, 0x7e82_0000, 0, 1),
        deny(EPERM),
        stmt(LD_W_ABS, 0),
        jump(JMP_JEQ_K, 41, 0, 5),
        stmt(LD_W_ABS, 16),
        jump(JMP_JEQ_K, 2, 2, 0),
        jump(JMP_JEQ_K, 10, 1, 0),
        deny(EPERM),
        stmt(RET_K, ALLOW),
        stmt(RET_K, ALLOW),
    ]);
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    struct Data { nr: u32, arch: u32, args: [u64; 6] }

    fn interpret(program: &[Filter], data: Data) -> u32 {
        let mut accumulator = 0u32;
        let mut pc = 0usize;
        for _ in 0..program.len() {
            let ins = program.get(pc).expect("BPF program fell off the end");
            match ins.code {
                LD_W_ABS => accumulator = match ins.k {
                    0 => data.nr,
                    4 => data.arch,
                    16 => data.args[0] as u32,
                    24 => data.args[1] as u32,
                    other => panic!("unsupported absolute offset {other}"),
                },
                JMP_JEQ_K => {
                    pc += 1 + usize::from(if accumulator == ins.k { ins.jt } else { ins.jf });
                    continue;
                }
                JMP_JSET_K => {
                    pc += 1 + usize::from(if accumulator & ins.k != 0 { ins.jt } else { ins.jf });
                    continue;
                }
                RET_K => return ins.k,
                other => panic!("unsupported BPF opcode {other:#x}"),
            }
            pc += 1;
        }
        panic!("BPF instruction limit exceeded")
    }

    fn data(nr: u32, a0: u64, a1: u64) -> Data {
        Data { nr, arch: ARCH_X86_64, args: [a0, a1, 0, 0, 0, 0] }
    }

    fn action(result: u32) -> (u32, u32) { (result & 0xffff_0000, result & 0xffff) }

    #[test]
    fn metadata_descriptor_policy_and_mediation() {
        let p = metadata_filter();
        for nr in [33, 292] {
            assert_eq!(action(interpret(&p, data(nr, 1023, 8))), (ERRNO, 1));
            assert_eq!(action(interpret(&p, data(nr, 8, 1023))), (ERRNO, 1));
            assert_eq!(action(interpret(&p, data(nr, 8, 9))), (ALLOW, 0));
        }
        assert_eq!(action(interpret(&p, data(32, 1023, 8))), (ERRNO, 1));
        assert_eq!(action(interpret(&p, data(32, 8, 1023))), (ALLOW, 0));
        for nr in [72, 16] {
            assert_eq!(action(interpret(&p, data(nr, 1023, 0))), (ERRNO, 1));
            assert_eq!(action(interpret(&p, data(nr, 7, 0))), (ALLOW, 0));
        }
        assert_eq!(action(interpret(&p, data(1, 1023, 0))), (USER_NOTIF, 0));
        assert_eq!(action(interpret(&p, data(1, 7, 0))), (ALLOW, 0));
        for nr in [2, 257, 87, 263, 3] {
            assert_eq!(action(interpret(&p, data(nr, 0, 0))), (USER_NOTIF, 0));
        }
        assert_eq!(action(interpret(&p, data(436, 0, 0))), (ERRNO, 1));
        assert_eq!(action(interpret(&p, data(999, 0, 0))), (ALLOW, 0));
    }

    #[test]
    fn control_arch_syscall_and_argument_policy() {
        let p = control_filter();
        let mut wrong_arch = data(999, 0, 0);
        wrong_arch.arch = 0x4000_0003;
        assert_eq!(interpret(&p, wrong_arch), KILL_PROCESS);
        assert_eq!(action(interpret(&p, data(0x4000_0001, 0, 0))), (ERRNO, 1));
        assert_eq!(action(interpret(&p, data(435, 0, 0))), (ERRNO, 38));
        assert_eq!(action(interpret(&p, data(41, 1, 0))), (ERRNO, 1));
        assert_eq!(action(interpret(&p, data(41, 2, 0))), (ALLOW, 0));
        assert_eq!(action(interpret(&p, data(41, 10, 0))), (ALLOW, 0));
        assert_eq!(action(interpret(&p, data(41, 16, 0))), (ERRNO, 1));
        assert_eq!(action(interpret(&p, data(56, 0x7e82_0000, 0))), (ERRNO, 1));
        assert_eq!(action(interpret(&p, data(56, 0, 0))), (ALLOW, 0));
        assert_eq!(action(interpret(&p, data(999, 0, 0))), (ALLOW, 0));
    }
}
