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
#include <limits.h>
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

static int service_rootdir(const char *p) {
    struct stat s;
    return !lstat(p, &s) && S_ISDIR(s.st_mode) && s.st_uid == 0 &&
           !(s.st_mode & 0022);
}

static int metadata_service(int fd) {
    static const char record_path[] = "/run/task245-services/metadata.auth";
    static const char artifact[] = "/lab/bin/native-metadata";
    static const char socket_path[] = "/run/task245-metadata.sock";
    struct stat auth, bin, sock, after;
    unsigned long long pid, start, edev, eino, sdev, sino;
    char hash[65], extra, line[512], canonical[512], proc[64], statbuf[4096];
    int af = -1, pf = -1, rc = -1, n;
    struct ucred cred;
    socklen_t clen = sizeof cred;
    if (!service_rootdir("/") || !service_rootdir("/run") || !service_rootdir("/run/task245-services") ||
        !service_rootdir("/lab") || !service_rootdir("/lab/bin")) return -1;
    af = open(record_path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (af < 0 || fstat(af, &auth) || !S_ISREG(auth.st_mode) || auth.st_uid ||
        auth.st_nlink != 1 || (auth.st_mode & 07777) != 0444 ||
        auth.st_size < 1 || auth.st_size > 511) goto done;
    n = pread(af, line, (size_t)auth.st_size, 0);
    if (n != auth.st_size) goto done;
    line[n] = 0;
    int used = 0;
    if (sscanf(line, "OCLABAUTH1 %llu %llu %llu %llu %llu %llu %64[0-9a-f]%c%n",
               &pid, &start, &edev, &eino, &sdev, &sino, hash, &extra, &used) != 8 ||
        extra != '\n' || used != n || strlen(line) != (size_t)n || strlen(hash) != 64 ||
        pid <= 1 || pid > INT_MAX || start == 0 || eino == 0 || sino == 0) goto done;
    int canonical_len = snprintf(canonical, sizeof canonical,
        "OCLABAUTH1 %llu %llu %llu %llu %llu %llu %s\n",
        pid, start, edev, eino, sdev, sino, hash);
    if (canonical_len < 0 || (size_t)canonical_len != (size_t)n ||
        memcmp(line, canonical, (size_t)n) != 0) goto done;
    if (lstat(artifact, &bin) || !S_ISREG(bin.st_mode) || bin.st_uid ||
        bin.st_nlink != 1 || (bin.st_mode & 07777) != 0555 ||
        (unsigned long long)bin.st_dev != edev || (unsigned long long)bin.st_ino != eino ||
        lstat(socket_path, &sock) || !S_ISSOCK(sock.st_mode) || sock.st_uid ||
        (sock.st_mode & 07777) != 0666 || (unsigned long long)sock.st_dev != sdev ||
        (unsigned long long)sock.st_ino != sino) goto done;
    if (snprintf(proc, sizeof proc, "/proc/%llu/stat", pid) < 0) goto done;
    pf = open(proc, O_RDONLY | O_CLOEXEC);
    if (pf < 0 || (n = (int)read(pf, statbuf, sizeof statbuf - 1)) <= 0) goto done;
    statbuf[n] = 0;
    char *q = strrchr(statbuf, ')');
    if (!q || q[1] != ' ') goto done;
    q += 2;
    char *save = NULL, *tok = strtok_r(q, " ", &save);
    for (int field = 3; field < 22; ++field) {
        if (!tok) goto done;
        tok = strtok_r(NULL, " ", &save);
    }
    if (!tok || strtoull(tok, NULL, 10) != start) goto done;
    if (connect(fd, &(struct sockaddr_un){.sun_family = AF_UNIX, .sun_path = "/run/task245-metadata.sock"},
                sizeof(struct sockaddr_un)) ||
        getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &clen) ||
        cred.uid != 0 || cred.pid != (pid_t)pid || lstat(socket_path, &after) ||
        after.st_dev != sock.st_dev || after.st_ino != sock.st_ino || !S_ISSOCK(after.st_mode)) goto done;
    rc = 0;
done:
    if (pf >= 0) close(pf);
    if (af >= 0) close(af);
    return rc;
}

int task245_metadata_install(void) {
    static const unsigned char magic[8] = {'O','C','M','E','T','A','0','1'};
    int fd = -1, listener = -1, rc = -1;
    if (geteuid() != 65534) return -1;
    fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (fd < 0) goto out;
    if (metadata_service(fd)) goto out;
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
