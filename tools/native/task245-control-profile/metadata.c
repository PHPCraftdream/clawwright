#define _GNU_SOURCE
#include "metadata.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <unistd.h>
#define SOCK "/run/task245-metadata.sock"
#define BASE "/var/lib/ssjack/synthetic"
#define STATE BASE "/state.json"
#define RECEIPT BASE "/consumer-receipt"
#define ACK "cancel-ack"
#define REQ BASE "/cancel-ack"
#define MAX_STATE 4096
static int rootdir = -1, slot = -1, targetfd = -1, listener = -1, client = -1;
static pid_t peer_pid, cancel_tgid, owner_pid, owner_parent; static unsigned long long owner_ticks; static unsigned char last_receipt[48]; static int have_receipt;
static int scenario_cancel(void); static int root_artifact(const struct stat *st);
static int owner_alive(void) {
    char path[64], line[4096], *p, *save; unsigned long long ticks; FILE *f;
    snprintf(path,sizeof path,"/proc/%d/stat",owner_pid); f=fopen(path,"re"); if(!f) return errno==ENOENT?0:-1;
    if(!fgets(line,sizeof line,f) || !strrchr(line,')')) { fclose(f); return -1; } fclose(f);
    p=strrchr(line,')')+2; p=strtok_r(p," ",&save); if(!p)return -1; p=strtok_r(NULL," ",&save); if(!p||strtol(p,NULL,10)!=owner_parent)return -1;
    for(int field=2;field<=19;field++) p=strtok_r(NULL," ",&save);
    if(!p) return -1; errno=0; ticks=strtoull(p,NULL,10); return errno?-1:ticks==owner_ticks;
}
static int owner_capture(void) {
    struct stat st, exe, expected; char data[97], extra; unsigned long long ticks; int pid,ppid,fd=openat(rootdir,"native-cancel-owner",O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK); ssize_t n;
    if(fd<0)return -1; if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_uid!=65534||(st.st_mode&07777)!=0600||st.st_nlink!=1||st.st_size<1||st.st_size>96){close(fd);return -1;}
    n=pread(fd,data,96,0); close(fd); if(n!=st.st_size)return -1; data[n]=0;
    if(sscanf(data,"%d %llu %d %c",&pid,&ticks,&ppid,&extra)!=3||pid<=1||ppid<=1)return -1;
    char path[64]; snprintf(path,sizeof path,"/proc/%d/exe",ppid);
    if(stat(path,&exe)||lstat("/lab/ssjack",&expected)||!root_artifact(&expected)||exe.st_dev!=expected.st_dev||exe.st_ino!=expected.st_ino)return -1;
    owner_pid=pid; owner_parent=ppid; owner_ticks=ticks; return owner_alive()==1?0:-1;
}
static int valid(uint64_t id) {
    return ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &id) == 0;
}
static int copy_string(pid_t pid, uint64_t address, char *out, size_t size) {
    struct iovec local = {out, size}, remote = {(void *)(uintptr_t)address, size};
    ssize_t n = process_vm_readv(pid, &local, 1, &remote, 1, 0);
    return n > 0 && memchr(out, 0, (size_t)n) ? 0 : -1;
}
static int same_tgid(pid_t tid) {
    char path[64], line[128];
    FILE *file;
    int tgid = -1;
    snprintf(path, sizeof path, "/proc/%d/status", tid);
    file = fopen(path, "re");
    if (!file) return 0;
    while (fgets(line, sizeof line, file))
        if (sscanf(line, "Tgid:\t%d", &tgid) == 1) break;
    fclose(file);
    return tgid == peer_pid;
}
static int auth_check, auth_errno;
static int authorized(pid_t tid) {
    char path[64];
    struct stat actual, expected;
    const char *paths[] = {"/lab/harness", "/lab/bin/harness"};
    int i;
    auth_check=1; auth_errno=0; errno=0; if (!same_tgid(tid)) { auth_errno=errno; return 0; }
    snprintf(path, sizeof path, "/proc/%d/exe", tid);
    auth_check=2; errno=0; if (stat(path, &actual) || !S_ISREG(actual.st_mode)) { auth_errno=errno; return 0; }
    auth_check=3;
    for (i = 0; i < 2; i++) {
        if (lstat(paths[i], &expected) || !root_artifact(&expected)) continue;
        auth_check=4;
        if (actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino) { auth_check=0; return 1; }
    }
    return 0;
}
static int root_artifact(const struct stat *st) {
    return S_ISREG(st->st_mode) && st->st_uid == 0 && st->st_nlink == 1 && !(st->st_mode & 022);
}
static int add_memfd(uint64_t id, const void *data, size_t size) {
    int memfd = syscall(SYS_memfd_create, "metadata", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    int result = -1;
    if (memfd < 0) return -1;
    if (write(memfd, data, size) == (ssize_t)size &&
        fcntl(memfd, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW |
              F_SEAL_SHRINK | F_SEAL_SEAL) == 0 && lseek(memfd, 0, SEEK_SET) == 0 && valid(id))
        result = ioctl(listener, SECCOMP_IOCTL_NOTIF_ADDFD,
                       &(struct seccomp_notif_addfd){.id=id, .srcfd=memfd,
                                                    .newfd_flags=O_CLOEXEC});
    close(memfd); return result;
}
static int metadata(uint64_t id, const char *name) {
    const char *relative = name + sizeof(BASE);
    struct stat before, after;
    unsigned char data[MAX_STATE];
    size_t limit = !strcmp(name, RECEIPT) ? 48 : MAX_STATE;
    int fd = openat(rootdir, relative, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    ssize_t n;
    if (fd < 0) return -errno;
    if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_uid != 65534 ||
        before.st_nlink != 1 || (before.st_mode & 07777) != 0600 ||
        (!strcmp(name, RECEIPT) ? before.st_size != 48 :
         before.st_size < 1 || before.st_size > MAX_STATE)) {
        close(fd); return -EACCES;
    }
    n = pread(fd, data, limit, 0);
    if (n != before.st_size || fstat(fd, &after) || before.st_dev != after.st_dev ||
        before.st_ino != after.st_ino || before.st_size != after.st_size) {
        close(fd); return -EACCES;
    }
    close(fd);
    if (!strcmp(name, RECEIPT) && scenario_cancel() && owner_capture()) return -EACCES;
    int added = add_memfd(id, data, (size_t)n);
    if (added >= 0 && !strcmp(name, RECEIPT)) {
        memcpy(last_receipt, data, 48); have_receipt = 1;
    }
    memset(data, 0, sizeof data);
    if (added < 0) return -EACCES;
    return added;
}
static int scenario_cancel(void) {
    int fd = open("/lab/scenario", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    char data[16] = {0};
    ssize_t n;
    if (fd < 0) return 0;
    n = read(fd, data, sizeof data);
    close(fd);
    return n == 6 && !memcmp(data, "cancel", 6);
}
static int open_cancel(uint64_t id) {
    int memfd;
    if (slot >= 0 || !scenario_cancel() || !valid(id)) return -EACCES;
    memfd = syscall(SYS_memfd_create, "cancel", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (memfd < 0) return -errno;
    if (ftruncate(memfd, 7) || fcntl(memfd, F_ADD_SEALS, F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL)) { close(memfd); return -EACCES; }
    slot = memfd; targetfd = TASK245_CANCEL_FD; return TASK245_CANCEL_FD;
}
static int fault_cancel(void) {
    struct stat st;
    char data[6];
    int fd = openat(rootdir, "native-fault-reached", O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return 0;
    int ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 65534 &&
             (st.st_mode & 07777) == 0600 && st.st_nlink == 1 && st.st_size == 6 &&
             pread(fd, data, 6, 0) == 6 && !memcmp(data, "cancel", 6);
    close(fd); return ok;
}
static int release_ack(void) {
    struct stat receipt_stat, ack_stat;
    unsigned char current[48], content[7];
    int fd, ack, ok = 0;
    if (pread(slot, content, sizeof content, 0) != 7 ||
        memcmp(content, "release", 7) || !have_receipt || !fault_cancel()) return 0;
    fd = openat(rootdir, "consumer-receipt", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &receipt_stat) == 0 && S_ISREG(receipt_stat.st_mode) &&
        receipt_stat.st_uid == 65534 && receipt_stat.st_nlink == 1 &&
        (receipt_stat.st_mode & 07777) == 0600 && receipt_stat.st_size == 48 &&
        pread(fd, current, sizeof current, 0) == 48 &&
        !memcmp(current, last_receipt, 48)) ok = 1;
    close(fd); if (!ok) return 0; int alive=owner_alive(); if(alive==0)return 1; if(alive<0)return 0;
    ack = openat(rootdir, ACK, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (ack < 0) return 0;
    if (fchown(ack, 65534, 65534) || fstat(ack, &ack_stat)) {
        close(ack); unlinkat(rootdir, ACK, 0); return 0;
    }
    ok = S_ISREG(ack_stat.st_mode) && ack_stat.st_uid == 65534 &&
         ack_stat.st_nlink == 1 && (ack_stat.st_mode & 07777) == 0600;
    if (!ok) { close(ack); unlinkat(rootdir, ACK, 0); return 0; }
    if (write(ack, "release", 7) != 7 || fsync(ack) != 0) {
        close(ack); unlinkat(rootdir, ACK, 0); return 0;
    }
    if (close(ack) != 0) { unlinkat(rootdir, ACK, 0); return 0; }
    for (int i=0;i<100;i++) { if(owner_alive()==0) { unlinkat(rootdir,ACK,0); return 1; } if(faccessat(rootdir,ACK,F_OK,AT_SYMLINK_NOFOLLOW)<0 && errno==ENOENT)return 1; struct timespec ts={0,10000000}; nanosleep(&ts,NULL); }
    return owner_alive()==0;
}
static void handle(void) {
    struct seccomp_notif request;
    for (;;) {
        struct seccomp_notif_resp response = {.error=-EACCES}; char path[512]; int result=-EACCES, isauth;
        memset(&request, 0, sizeof request);
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request) < 0) { if(errno==EINTR)continue; return; }
        response.id=request.id; isauth=authorized(request.pid);
        if(request.data.nr==SYS_close_range && request.data.args[0]<=TASK245_CANCEL_FD && request.data.args[1]>=TASK245_CANCEL_FD) { response.error=-EPERM; goto send; }
        if(request.data.nr==SYS_write && (int)request.data.args[0]==TASK245_CANCEL_FD) {
            unsigned char data[7]; struct iovec local={data,7}, remote={(void *)(uintptr_t)request.data.args[1],7};
            if(isauth && slot>=0 && request.data.args[2]==7 && valid(request.id) && process_vm_readv(request.pid,&local,1,&remote,1,0)==7 && pwrite(slot,data,7,0)==7) { response.error=0; response.val=7; }
            goto send;
        }
        if(request.data.nr==SYS_close && (int)request.data.args[0]==TASK245_CANCEL_FD) {
            int released=1;
            if(isauth && slot>=0) {
                if(!valid(request.id)) goto send;
                released=release_ack(); close(slot); slot=-1; targetfd=-1;
            }
            response.error=released?0:-EIO; response.val=0; goto send;
        }
        if(request.data.nr==SYS_close) { response.error=0; response.flags=SECCOMP_USER_NOTIF_FLAG_CONTINUE; goto send; }
        if(!isauth) {
            if(request.data.nr==SYS_open || request.data.nr==SYS_openat) { response.error=0; response.flags=SECCOMP_USER_NOTIF_FLAG_CONTINUE; }
            goto send;
        }
        if(request.data.nr==SYS_open || request.data.nr==SYS_openat) {
            uint64_t address=request.data.nr==SYS_open?request.data.args[0]:request.data.args[1];
            int dirfd=request.data.nr==SYS_open?AT_FDCWD:(int)request.data.args[0];
            int flags=(int)(request.data.nr==SYS_open?request.data.args[1]:request.data.args[2]);
            if(copy_string(request.pid,address,path,sizeof path)) goto send;
            if((dirfd==AT_FDCWD || request.data.nr==SYS_open) && (!strcmp(path,STATE)||!strcmp(path,RECEIPT))) {
                if((flags&O_ACCMODE)!=O_RDONLY || (flags&(O_CREAT|O_TRUNC|O_APPEND))) goto send;
                result=metadata(request.id,path);
            } else if((dirfd==AT_FDCWD || request.data.nr==SYS_open) && !strcmp(path,REQ) && (flags&(O_ACCMODE|O_CREAT|O_TRUNC))==(O_WRONLY|O_CREAT|O_TRUNC)) {
                result=open_cancel(request.id); if(result>=0)cancel_tgid=peer_pid;
            } else { response.error=0; response.flags=SECCOMP_USER_NOTIF_FLAG_CONTINUE; goto send; }
        } else if(request.data.nr==SYS_unlinkat && (int)request.data.args[0]==AT_FDCWD && copy_string(request.pid,request.data.args[1],path,sizeof path)==0 && !strcmp(path,REQ)) {
            struct stat st; int fd=openat(rootdir,ACK,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
            if(fd<0) result=errno==ENOENT?-ENOENT:-EACCES;
            else { if(fstat(fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==65534 && st.st_nlink==1 && (st.st_mode&07777)==0600 && st.st_size==7 && pread(fd,path,7,0)==7 && !memcmp(path,"release",7) && valid(request.id)) result=unlinkat(rootdir,ACK,0)?-errno:0; close(fd); }
        }
        if(result>=0) { response.error=0; response.val=result; } else response.error=result;
    send: if(valid(request.id)) ioctl(listener,SECCOMP_IOCTL_NOTIF_SEND,&response);
    }
}
static int marker(const char *path) {
    struct stat st;
    return lstat(path, &st) == 0 && root_artifact(&st) &&
           (st.st_mode & 07777) == 0444 && st.st_size > 0 && st.st_size <= 128;
}
static void cleanup(int socketfd) {
    if (slot >= 0) close(slot);
    if (listener >= 0) close(listener);
    if (client >= 0) close(client);
    if (rootdir >= 0) close(rootdir);
    if (socketfd >= 0) close(socketfd);
    unlink(SOCK);
}
int main(int argc, char **argv) {
    int socketfd = -1, received = -1, status = 1, stage = 0; struct sockaddr_un address = {.sun_family = AF_UNIX};
    struct stat st; struct ucred credentials; socklen_t credentials_size = sizeof credentials; unsigned char message[9]; char control[CMSG_SPACE(sizeof(int))] = {0};
    struct iovec iov = {message, sizeof message}; struct msghdr header = {.msg_iov=&iov, .msg_iovlen=1, .msg_control=control, .msg_controllen=sizeof control};
    if (argc != 2 || strcmp(argv[1], "--disposable-lab") || getuid() != 0 ||
        !marker("/lab/disposable-profile") || !marker("/lab/scenario") ||
        lstat(SOCK, &st) == 0 || errno != ENOENT) return 2;
    alarm(600);
    socketfd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (socketfd < 0) goto out;
    strncpy(address.sun_path, SOCK, sizeof address.sun_path - 1);
    if (bind(socketfd, (struct sockaddr *)&address, sizeof address) || chmod(SOCK, 0666) || listen(socketfd, 4)) goto out;
    stage = 1; client = accept4(socketfd, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0 || getsockopt(client, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_size) ||
        credentials.uid != 65534) goto out;
    peer_pid = credentials.pid;
    stage = 2; if (!authorized(peer_pid)) goto out;
    stage = 3; rootdir = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    const char *parts[] = {"var", "lib", "ssjack"};
    for (size_t i = 0; rootdir >= 0 && i < sizeof parts / sizeof *parts; i++) {
        int next = openat(rootdir, parts[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (next < 0 || fstat(next, &st) || !S_ISDIR(st.st_mode) || st.st_uid != 0 || (st.st_mode & 022)) { if (next >= 0) close(next); close(rootdir); rootdir = -1; break; }
        close(rootdir); rootdir = next;
    }
    int next = rootdir < 0 ? -1 : openat(rootdir, "synthetic", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (rootdir >= 0) close(rootdir); rootdir=next;
    stage = 4; if (rootdir < 0 || fstat(rootdir, &st) || !S_ISDIR(st.st_mode) ||
        st.st_uid != 65534 || st.st_nlink < 2 || (st.st_mode & 07777) != 0700) goto out;
    stage = 5; if (recvmsg(client, &header, 0) != 8 || memcmp(message, "OCMETA01", 8) ||
        (header.msg_flags & (MSG_CTRUNC|MSG_TRUNC))) goto out;
    struct cmsghdr *item = CMSG_FIRSTHDR(&header);
    if (!item || item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS ||
        item->cmsg_len != CMSG_LEN(sizeof(int)) || CMSG_NXTHDR(&header, item)) goto out;
    memcpy(&received, CMSG_DATA(item), sizeof received); listener = received; received = -1; stage = 6; handle(); status = 0;
out: if (status) fprintf(stderr,"metadata-daemon: stage=%d auth=%d errno=%d\n",stage,auth_check,auth_errno); if (received >= 0) close(received); cleanup(socketfd); return status;
}
