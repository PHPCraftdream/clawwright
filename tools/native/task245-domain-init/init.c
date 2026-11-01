#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/mount.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "task245 domain init supports Linux amd64 only"
#endif

#define IMAGE_FD 3
#define CONTROL_FD 4
#define ROOT_FD 5
#define META_FD 6
static uid_t runtime_uid;
static gid_t runtime_gid;
extern char **environ;

static int exit_checkpoint = 111;
static void die(void) { int saved = errno; dprintf(2, "task245-init: checkpoint=%d errno=%d\n", exit_checkpoint, saved); _exit(exit_checkpoint); }

static int parse_id(const char *s, unsigned long *out) {
    char *end = NULL;
    unsigned long n;
    if (!s || !*s || (s[0] == '0' && s[1])) return -1;
    for (const char *p = s; *p; ++p) if (*p < '0' || *p > '9') return -1;
    errno = 0;
    n = strtoul(s, &end, 10);
    if (errno || !end || *end || n == 0 || n > UINT_MAX) return -1;
    *out = n;
    return 0;
}

static int sealed_file(int fd, mode_t mode) {
    struct stat st;
    int seals = fcntl(fd, F_GET_SEALS);
    const int required = F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE;
    return seals >= 0 && (seals & required) == required && fstat(fd, &st) == 0 &&
           S_ISREG(st.st_mode) && st.st_uid == 0 && (st.st_mode & 0777) == mode;
}

static int close_extras(void) {
    struct rlimit lim;
    long maxfd;
    if (getrlimit(RLIMIT_NOFILE, &lim) < 0) return -1;
    maxfd = lim.rlim_cur == RLIM_INFINITY ? sysconf(_SC_OPEN_MAX) : (long)lim.rlim_cur;
    if (maxfd < 0 || maxfd > 1048576) return -1;
    for (int fd = 7; fd < maxfd; ++fd) close(fd);
    return 0;
}

static int verify_fds(void) {
    struct stat st;
    struct statvfs sv;
    int type = 0;
    socklen_t len = sizeof type;
    if (!sealed_file(IMAGE_FD, 0555) || !sealed_file(META_FD, 0444) ||
        getsockopt(CONTROL_FD, SOL_SOCKET, SO_TYPE, &type, &len) < 0 ||
        type != SOCK_SEQPACKET || fstat(ROOT_FD, &st) < 0 || !S_ISDIR(st.st_mode) ||
        st.st_uid != 0 || (st.st_mode & 022) || fstatvfs(ROOT_FD, &sv) < 0 ||
        !(sv.f_flag & ST_RDONLY)) return -1;
    if (fcntl(IMAGE_FD, F_SETFD, fcntl(IMAGE_FD, F_GETFD) & ~FD_CLOEXEC) < 0 ||
        fcntl(CONTROL_FD, F_SETFD, fcntl(CONTROL_FD, F_GETFD) & ~FD_CLOEXEC) < 0 ||
        fcntl(META_FD, F_SETFD, fcntl(META_FD, F_GETFD) & ~FD_CLOEXEC) < 0) return -1;
    return close_extras();
}

static int parent_guard(pid_t expected) {
    pid_t before = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || before != expected || getppid() != before)
        return -1;
    return 0;
}

static void worker(int nullfd) {
    char *const av[] = {(char *)"native-supervisor", (char *)"--task245-domain-worker", NULL};
    char *const ev[] = {NULL};
    exit_checkpoint = 121;
    if (parent_guard(1) < 0 || getpid() != 2 || nullfd < 0 ||
        getuid() != runtime_uid || geteuid() != runtime_uid || getgid() != runtime_gid ||
        getegid() != runtime_gid || getgroups(0, NULL) != 0 ||
        dup2(nullfd, 0) < 0 || dup2(nullfd, 1) < 0 || dup2(nullfd, 2) < 0) die();
    if (nullfd > 2) close(nullfd);
    exit_checkpoint = 122;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 || prctl(PR_SET_DUMPABLE, 0) < 0) die();
    exit_checkpoint = 123;
    execveat(IMAGE_FD, "", av, ev, AT_EMPTY_PATH);
    die();
}

static int wait_child(pid_t child) {
    int status;
    pid_t r;
    do { r = waitpid(child, &status, 0); } while (r < 0 && errno == EINTR);
    if (r != child) return 111;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 111;
}

int main(int argc, char **argv) {
    unsigned long u, g;
    pid_t original_parent, init, child;
    int nullfd;
    exit_checkpoint = 112;
    if (argc != 3 || !argv || !environ || environ[0] != NULL || getuid() != 0 || geteuid() != 0 ||
        parse_id(argv[1], &u) < 0 || parse_id(argv[2], &g) < 0 || verify_fds() < 0) die();
    runtime_uid = (uid_t)u;
    runtime_gid = (gid_t)g;
    exit_checkpoint = 113;
    original_parent = getppid();
    if (original_parent <= 0 || parent_guard(original_parent) < 0) die();
    exit_checkpoint = 114;
    nullfd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (nullfd < 0 || unshare(CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID) < 0 ||
        mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0) die();
    exit_checkpoint = 115;
    init = fork();
    if (init < 0) die();
    if (init == 0) {
        exit_checkpoint = 116;
        if (parent_guard(0) < 0 || fchdir(ROOT_FD) < 0 || chroot(".") < 0 || chdir("/") < 0) die();
        close(ROOT_FD);
        exit_checkpoint = 117;
        if (mount("proc", "/proc", "proc", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "hidepid=0") < 0) die();
        exit_checkpoint = 118;
        char run_options[128];
        if (snprintf(run_options, sizeof run_options, "mode=0700,size=1m,uid=%lu,gid=%lu",
                     (unsigned long)runtime_uid, (unsigned long)runtime_gid) < 0 ||
            mount("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, run_options) < 0) die();
        /* Make PID 1 the runtime UID before forking: same-UID worker checks can
         * stat PID 1 namespaces without hidepid=2 or CAP_SYS_PTRACE, and the
         * worker's parent-death signal cannot be invalidated by a later drop. */
        exit_checkpoint = 119;
        if (setgroups(0, NULL) < 0 || setresgid(runtime_gid, runtime_gid, runtime_gid) < 0 ||
            setresuid(runtime_uid, runtime_uid, runtime_uid) < 0 ||
            prctl(PR_SET_DUMPABLE, 1) < 0 || parent_guard(0) < 0) die();
        exit_checkpoint = 120;
        child = fork();
        if (child < 0) die();
        if (child == 0) worker(nullfd);
        close(IMAGE_FD);
        close(CONTROL_FD);
        close(META_FD);
        close(nullfd);
        _exit(wait_child(child));
    }
    close(IMAGE_FD);
    close(CONTROL_FD);
    close(ROOT_FD);
    close(META_FD);
    close(nullfd);
    return wait_child(init);
}
