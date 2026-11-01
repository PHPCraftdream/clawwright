#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <limits.h>
#include <assert.h>
#include <time.h>
#include <sys/mman.h>
#include <signal.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <linux/seccomp.h>
static ssize_t test_write(int, const void *, size_t);
static int test_fsync(int);
static int test_close(int);
#define write test_write
#define fsync test_fsync
#define close test_close
#define main metadata_daemon_main
#include "metadata.c"
#undef main
#undef close
#undef fsync
#undef write

static char rootpath[PATH_MAX];
static int fault_phase, fault_count, fault_errno;
static int is_ack(int fd) {
    char link[64], target[PATH_MAX];
    snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, target, sizeof target - 1);
    if (n < 0) return 0;
    target[n] = 0;
    char expected[PATH_MAX];
    snprintf(expected, sizeof expected, "%s/cancel-ack", rootpath);
    return !strcmp(target, expected);
}
static ssize_t test_write(int fd, const void *p, size_t n) {
    if (fault_phase == 1 && is_ack(fd)) {
        ++fault_count; syscall(SYS_close, fd);
        ssize_t r = syscall(SYS_write, fd, p, n); fault_errno = errno; return r;
    }
    return syscall(SYS_write, fd, p, n);
}
static int test_fsync(int fd) {
    if (fault_phase == 2 && is_ack(fd)) {
        ++fault_count; syscall(SYS_close, fd);
        int r = (int)syscall(SYS_fsync, fd); fault_errno = errno; return r;
    }
    return (int)syscall(SYS_fsync, fd);
}
static int test_close(int fd) {
    if (fault_phase == 3 && is_ack(fd)) {
        ++fault_count; int r = (int)syscall(SYS_close, fd);
        int second = (int)syscall(SYS_close, fd); fault_errno = errno;
        return second < 0 ? second : r;
    }
    return (int)syscall(SYS_close, fd);
}
static void must(int ok) { if (!ok) { perror("metadata regression assertion"); exit(1); } }
static void create_file(const char *name, const void *data, size_t n) {
    int fd = openat(rootdir, name, O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0600);
    must(fd >= 0 && write(fd, data, n) == (ssize_t)n);
    must(fchown(fd, 65534, 65534) == 0);
    must(close(fd) == 0);
}
static int absent(void) { struct stat st; return fstatat(rootdir, ACK, &st, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT; }
static void fixture(void) {
    strcpy(rootpath, "/lab/metadata-test-XXXXXX"); must(mkdtemp(rootpath) != NULL);
    rootdir = open(rootpath, O_RDONLY|O_DIRECTORY|O_CLOEXEC); must(rootdir >= 0);
    must(fchmod(rootdir, 0700) == 0 && fchown(rootdir, 65534, 65534) == 0);
    unsigned char receipt[48]; memset(receipt, 0x5a, sizeof receipt);
    memcpy(last_receipt, receipt, 48); have_receipt = 1;
    create_file("consumer-receipt", receipt, sizeof receipt);
    create_file("native-fault-reached", "cancel", 6);
    slot = (int)syscall(SYS_memfd_create, "release", MFD_CLOEXEC|MFD_ALLOW_SEALING);
    must(slot >= 0 && syscall(SYS_write, slot, "release", 7) == 7);
    owner_pid = getpid(); owner_parent = getppid();
    FILE *f = fopen("/proc/self/stat", "r"); must(f != NULL);
    char line[4096], *p, *save; unsigned long long ticks = 0;
    must(fgets(line, sizeof line, f) != NULL); fclose(f);
    p = strrchr(line, ')'); must(p != NULL); p += 2;
    p = strtok_r(p, " ", &save); must(p != NULL);
    for (int field = 4; field <= 22; ++field) { p = strtok_r(NULL, " ", &save); must(p != NULL); if (field == 22) ticks = strtoull(p, NULL, 10); }
    owner_ticks = ticks; must(owner_alive() == 1);
}
static void reset_ack(void) { unlinkat(rootdir, ACK, 0); fault_phase = fault_count = fault_errno = 0; }
static void fault_case(int phase) {
    reset_ack(); fault_phase = phase; must(release_ack() == 0);
    must(fault_count == 1 && fault_errno == EBADF && absent() && owner_alive() == 1);
}
static void success_case(void) {
    reset_ack(); pid_t child = fork(); must(child >= 0);
    if (!child) {
        for (int i=0;i<1000;i++) {
            struct stat st; char b[7]; int fd=openat(rootdir,ACK,O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
            if(fd>=0){int ok=fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==65534&&st.st_size==7&&pread(fd,b,7,0)==7&&!memcmp(b,"release",7);syscall(SYS_close,fd);if(ok&&unlinkat(rootdir,ACK,0)==0)_exit(0);}
            struct timespec t={0,1000000};nanosleep(&t,NULL);
        }
        _exit(2);
    }
    must(release_ack() == 1); int status; must(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static void negatives(void) {
    reset_ack(); last_receipt[0] ^= 1; must(release_ack() == 0 && absent()); last_receipt[0] ^= 1;
    reset_ack(); must(ftruncate(slot, 0) == 0); must(release_ack() == 0 && absent()); must(syscall(SYS_pwrite64, slot, "release", 7, 0) == 7 && ftruncate(slot, 7) == 0);
    reset_ack(); unlinkat(rootdir, "native-fault-reached", 0); must(release_ack() == 0 && absent()); create_file("native-fault-reached", "cancel", 6);
    reset_ack(); unlinkat(rootdir, "native-fault-reached", 0); create_file("native-fault-reached", "wrong!", 6); must(release_ack() == 0 && absent()); unlinkat(rootdir, "native-fault-reached", 0); create_file("native-fault-reached", "cancel", 6);
    reset_ack(); owner_parent ^= 1; must(release_ack() == 0 && absent()); owner_parent ^= 1;
    reset_ack(); must(ftruncate(slot, 7) == 0); must(syscall(SYS_pwrite64, slot, "release", 7, 0) == 7);
    reset_ack(); create_file(ACK, "keep", 4); must(release_ack() == 0);
    int fd=openat(rootdir, ACK, O_RDONLY|O_CLOEXEC); char b[4]; must(fd>=0 && read(fd,b,4)==4 && !memcmp(b,"keep",4)); syscall(SYS_close,fd); reset_ack();
}
int main(int argc, char **argv) {
    must(argc == 1 && getuid() == 0);
    const char *ci = getenv("GITHUB_ACTIONS"); must(ci && strcmp(ci, "true") == 0);
    fixture(); success_case(); fault_case(1); fault_case(2); fault_case(3); negatives();
    must(owner_alive() == 1);
    syscall(SYS_close, slot); slot = -1;
    unlinkat(rootdir, "consumer-receipt", 0); unlinkat(rootdir, "native-fault-reached", 0);
    syscall(SYS_close, rootdir); rootdir = -1;
    char path[PATH_MAX]; snprintf(path, sizeof path, "%s/consumer-receipt", rootpath); unlink(path);
    snprintf(path, sizeof path, "%s/native-fault-reached", rootpath); unlink(path);
    rmdir(rootpath);
    puts("metadata cancel-ack regression: PASS"); return 0;
}
