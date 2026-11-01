#define _GNU_SOURCE
#include "metadata.h"
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/memfd.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/ioctl.h>
#include "metadata.h"

static int task245_metadata_filter(void) {
    int token = -1;
    struct rlimit limit;
    if (geteuid() != 65534 || getrlimit(RLIMIT_NOFILE, &limit) ||
        limit.rlim_cur <= TASK245_CANCEL_FD) return -1;
    errno = 0;
    if (fcntl(TASK245_CANCEL_FD, F_GETFD) != -1 || errno != EBADF) return -1;
    token = syscall(SYS_memfd_create, "cancel-token", MFD_ALLOW_SEALING);
    if (token < 0 || fcntl(token, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW |
                           F_SEAL_SHRINK | F_SEAL_SEAL) ||
        dup3(token, TASK245_CANCEL_FD, 0) < 0) {
        if (token >= 0) close(token);
        return -1;
    }
    close(token);
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_dup, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_dup2, 0, 6),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 2, 0),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_dup3, 0, 6),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 2, 0),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_fcntl, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_ioctl, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_write, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, TASK245_CANCEL_FD, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),

        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_close_range, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_open, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_openat, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_unlink, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_unlinkat, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_close, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog prog = {.len = sizeof code / sizeof code[0], .filter = code};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
    return syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                   SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
}

int task245_metadata_install(void) {
    static const char path[] = "/run/task245-metadata.sock";
    static const char peer[] = "/lab/bin/native-metadata";
    static const unsigned char magic[8] = {'O','C','M','E','T','A','0','1'};
    int fd = -1, listener = -1, rc = -1;
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    struct stat expected, actual;
    struct ucred cred;
    char proc[64];
    socklen_t clen = sizeof cred;
    if (geteuid() != 65534) return -1;
    fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (fd < 0) goto out;
    memcpy(addr.sun_path, path, sizeof path);
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) ||
        getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &clen) || cred.uid != 0 ||
        lstat(peer, &expected) || !S_ISREG(expected.st_mode) || expected.st_uid != 0 ||
        expected.st_nlink != 1 || (expected.st_mode & 07777) != 0555 ||
        snprintf(proc, sizeof proc, "/proc/%d/exe", cred.pid) < 0 ||
        stat(proc, &actual) || !S_ISREG(actual.st_mode) ||
        expected.st_dev != actual.st_dev || expected.st_ino != actual.st_ino) goto out;
    listener = task245_metadata_filter();
    if (listener < 0) goto out;
    struct iovec iov = {.iov_base = (void *)magic, .iov_len = sizeof magic};
    char control[CMSG_SPACE(sizeof(int))] = {0};
    struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof control};
    struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &listener, sizeof listener);
    if (sendmsg(fd, &msg, MSG_NOSIGNAL) != sizeof magic) goto out;
    rc = 0;
out:
    if (listener >= 0) close(listener);
    if (fd >= 0) close(fd);
    return rc;
}
