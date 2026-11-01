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
#include <sys/prctl.h>
#include <grp.h>
extern char **environ;
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

#include "metadata_client.c"
#define main control_profile_main
#include "control-profile.c"
#undef main

static char rootpath[sizeof "/lab/metadata-test-XXXXXX"];
static int fault_phase, fault_count, fault_errno;
static int *fault_report;
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
        ssize_t r = syscall(SYS_write, fd, p, n); fault_errno = errno; if(fault_report){fault_report[0]++;fault_report[1]=fault_errno;} return r;
    }
    return syscall(SYS_write, fd, p, n);
}
static int test_fsync(int fd) {
    if (fault_phase == 2 && is_ack(fd)) {
        ++fault_count; syscall(SYS_close, fd);
        int r = (int)syscall(SYS_fsync, fd); fault_errno = errno; if(fault_report){fault_report[0]++;fault_report[1]=fault_errno;} return r;
    }
    return (int)syscall(SYS_fsync, fd);
}
static int test_close(int fd) {
    if (fault_phase == 3 && is_ack(fd)) {
        ++fault_count; int r = (int)syscall(SYS_close, fd);
        int second = (int)syscall(SYS_close, fd); fault_errno = errno; if(fault_report){fault_report[0]++;fault_report[1]=fault_errno;}
        return second < 0 ? second : r;
    }
    return (int)syscall(SYS_close, fd);
}
#define must(ok) do { if (!(ok)) { fprintf(stderr,"metadata-test: line=%d errno=%d\n",__LINE__,errno); exit(1); } } while (0)
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
static int notifier_checks(int original,int emit) {
    struct stat st; char b[3]; int fd, p[2], q[2];
    if(original){fd=open(STATE,O_RDONLY);if(fd<0||read(fd,b,2)!=2||memcmp(b,"{}",2))return 1;if(close(fd))return 1;}
    else {errno=0;if(open(STATE,O_RDONLY)!=-1||errno!=EACCES)return 1;}
    fd=open("/lab/bin/metadata-child",O_RDONLY);if(fd<0)return 2;close(fd);
    if(pipe(p)||pipe(q))return 2;
    int d=dup(p[0]);if(d<0)return 3;close(d);
    d=fcntl(p[0],F_DUPFD,10);if(d<0)return 3;close(d);
    d=fcntl(p[0],F_DUPFD_CLOEXEC,10);if(d<0)return 3;close(d);
    if(dup2(p[0],q[1])!=q[1]||dup3(p[0],q[1],0)!=q[1]||fcntl(p[0],F_SETFD,FD_CLOEXEC)!=0)return 3;
    errno=0;if(dup(TASK245_CANCEL_FD)!=-1||errno!=EPERM)return 5;
    errno=0;if(dup2(TASK245_CANCEL_FD,q[0])!=-1||errno!=EPERM)return 5;
    errno=0;if(dup3(TASK245_CANCEL_FD,q[0],0)!=-1||errno!=EPERM)return 5;
    errno=0;if(dup2(p[0],TASK245_CANCEL_FD)!=-1||errno!=EPERM)return 5;
    errno=0;if(dup3(p[0],TASK245_CANCEL_FD,0)!=-1||errno!=EPERM)return 5;
    errno=0;if(fcntl(TASK245_CANCEL_FD,F_DUPFD,10)!=-1||errno!=EPERM)return 7;
    errno=0;if(fcntl(TASK245_CANCEL_FD,F_DUPFD_CLOEXEC,10)!=-1||errno!=EPERM)return 7;
    errno=0;if(fcntl(TASK245_CANCEL_FD,F_SETFD,FD_CLOEXEC)!=-1||errno!=EPERM)return 7;
    errno=0;if(fcntl(TASK245_CANCEL_FD,F_SETFD,0)!=-1||errno!=EPERM)return 7;
    errno=0;if(ioctl(TASK245_CANCEL_FD,FIOCLEX)!=-1||errno!=EPERM)return 7;
    errno=0;if(ioctl(TASK245_CANCEL_FD,FIONCLEX)!=-1||errno!=EPERM)return 7;
    if(ioctl(p[0],FIOCLEX)!=0||!(fcntl(p[0],F_GETFD)&FD_CLOEXEC))return 7;
    if(ioctl(p[0],FIONCLEX)!=0||(fcntl(p[0],F_GETFD)&FD_CLOEXEC))return 7;
    errno=0;if(syscall(SYS_close_range,TASK245_CANCEL_FD,TASK245_CANCEL_FD,0)!=-1||errno!=EPERM)return 8;
    errno=0;if(close(TASK245_CANCEL_FD)!=0)return 9;
    if(fstat(TASK245_CANCEL_FD,&st))return 10;
    errno=0;if(write(TASK245_CANCEL_FD,"release",7)!=-1||errno!=EACCES)return 11;
    errno=0;if(write(TASK245_CANCEL_FD,"inactive",8)!=-1||errno!=EACCES)return 11;
    errno=0;if(pwrite(TASK245_CANCEL_FD,"release",7,0)!=-1||errno!=EPERM)return 11;
    errno=0;if(open(REQ,O_WRONLY|O_CREAT|O_TRUNC,0600)!=-1||errno!=EACCES)return 12;
    if(close(p[0])||close(p[1])||close(q[0])||close(q[1]))return 14;
    errno=0;if(fstat(p[0],&st)!=-1||errno!=EBADF)return 14;
    if(emit&&dprintf(STDOUT_FILENO,"metadata notifier exec: PASS\n")<0)return 13;
    return 0;
}
static void notifier_exec(void) { if(getuid()!=65534)_exit(99); int r=notifier_checks(0,1); _exit(r?100+r:0); }
static void active_client(int sock,int phase) {
    must(getuid()==0); alarm(20); pid_t parent=getppid();
    must(setgroups(0,NULL)==0 && setgid(65534)==0 && setuid(65534)==0);
    must(prctl(PR_SET_PDEATHSIG,SIGKILL)==0 && getppid()==parent);
    peer_pid=getpid(); int l=task245_metadata_filter(); must(l>=0);
    char data[CMSG_SPACE(sizeof(int))]={0},magic[8]="LISTENER";
    struct iovec iov={.iov_base=magic,.iov_len=8};
    struct msghdr m={.msg_iov=&iov,.msg_iovlen=1,.msg_control=data,.msg_controllen=sizeof data};
    struct cmsghdr*c=CMSG_FIRSTHDR(&m);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&l,sizeof l);
    must(sendmsg(sock,&m,0)==8); syscall(SYS_close,l); landlock(); seccomp();
    char gate; must(read(sock,&gate,1)==1);
    unsigned char receipt[48];int fd=open(RECEIPT,O_RDONLY);must(fd>=0&&read(fd,receipt,48)==48);must(close(fd)==0);
    for(size_t i=0;i<sizeof receipt;i++)must(receipt[i]==0x5a);
    must(write(sock,"S",1)==1 && read(sock,&gate,1)==1 && gate=='W');
    fd=open(REQ,O_WRONLY|O_CREAT|O_TRUNC,0600);must(fd==TASK245_CANCEL_FD&&write(fd,"release",7)==7);
    errno=0;int r=close(fd);must((phase==0&&r==0)||(phase!=0&&r==-1&&errno==EIO));
    struct stat st;must(fstat(TASK245_CANCEL_FD,&st)==0);errno=0;must(write(TASK245_CANCEL_FD,"release",7)==-1&&errno==EACCES);
    must(write(sock,"D",1)==1&&read(sock,&gate,1)==1&&gate=='X');_exit(0);
}
static void active_case(int phase) {
    int sv[2], status; pid_t child, med, observer=-1;
    must(socketpair(AF_UNIX,SOCK_SEQPACKET,0,sv)==0);
    unlinkat(rootdir,"consumer-receipt",0);unlinkat(rootdir,"native-fault-reached",0);
    unsigned char receipt[48];memset(receipt,0x5a,sizeof receipt);create_file("consumer-receipt",receipt,sizeof receipt);create_file("native-fault-reached","cancel",6);
    pid_t root_pid=getpid();
    child=fork(); must(child>=0);
    if(!child) {
        must(prctl(PR_SET_PDEATHSIG,SIGKILL)==0 && getppid()==root_pid);
        syscall(SYS_close,sv[0]); syscall(SYS_close,rootdir);
        char sock[32], ph[16]; snprintf(sock,sizeof sock,"%d",sv[1]); snprintf(ph,sizeof ph,"%d",phase);
        char *av[]={"/lab/harness","--active-client",sock,ph,NULL}; execve(av[0],av,environ); _exit(127);
    }
    close(sv[1]);
    char magic[8]; struct iovec io={.iov_base=magic,.iov_len=sizeof magic};
    char control[CMSG_SPACE(sizeof(int))]={0}; struct msghdr msg={.msg_iov=&io,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    must(recvmsg(sv[0],&msg,0)==8&&!memcmp(magic,"LISTENER",8));
    struct cmsghdr *c=CMSG_FIRSTHDR(&msg); must(c&&c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS&&c->cmsg_len==CMSG_LEN(sizeof(int))&&!(msg.msg_flags&(MSG_CTRUNC|MSG_TRUNC)));
    memcpy(&listener,CMSG_DATA(c),sizeof listener); peer_pid=child;
    fault_report=mmap(NULL,2*sizeof(int),PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0); must(fault_report!=MAP_FAILED); fault_report[0]=fault_report[1]=0;
    char line[4096], owner[128]; FILE *f; unsigned long long ticks=0; char *p,*save;
    char statpath[64]; snprintf(statpath,sizeof statpath,"/proc/%ld/stat",(long)child); f=fopen(statpath,"r"); must(f&&fgets(line,sizeof line,f)); fclose(f);
    p=strrchr(line,')'); must(p); p+=2; p=strtok_r(p," ",&save); must(p);
    for(int field=4;field<=22;field++){p=strtok_r(NULL," ",&save);must(p);if(field==22)ticks=strtoull(p,NULL,10);}
    snprintf(owner,sizeof owner,"%ld %llu %ld\n",(long)child,ticks,(long)getpid()); unlinkat(rootdir,"native-cancel-owner",0); create_file("native-cancel-owner",owner,strlen(owner));
    med=fork(); must(med>=0); if(!med){peer_pid=child;have_receipt=0;owner_pid=owner_parent=0;owner_ticks=0;fault_phase=phase<=3?phase:0; fault_count=fault_errno=0;handle();_exit(0);}
    close(listener); listener=-1; must(write(sv[0],"G",1)==1);
    char ready;must(read(sv[0],&ready,1)==1&&ready=='S');
    if(phase==4){int fd=openat(rootdir,"consumer-receipt",O_WRONLY|O_CLOEXEC);must(fd>=0&&syscall(SYS_pwrite64,fd,"X",1,0)==1&&syscall(SYS_close,fd)==0);}
    if(phase==5){unlinkat(rootdir,"native-fault-reached",0);create_file("native-fault-reached","wrong!",6);}
    if(phase==0){observer=fork();must(observer>=0);if(!observer){must(prctl(PR_SET_PDEATHSIG,SIGKILL)==0 && getppid()==root_pid);for(int i=0;i<1000;i++){struct stat st;char b[7];int fd=openat(rootdir,ACK,O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);if(fd>=0){int ok=fstat(fd,&st)==0&&S_ISREG(st.st_mode)&&st.st_uid==65534&&st.st_size==7&&pread(fd,b,7,0)==7&&!memcmp(b,"release",7);syscall(SYS_close,fd);if(ok&&unlinkat(rootdir,ACK,0)==0)_exit(0);}struct timespec t={0,1000000};nanosleep(&t,NULL);}_exit(2);}}
    must(write(sv[0],"W",1)==1);
    char done; must(read(sv[0],&done,1)==1&&done=='D'); if(observer>0)must(waitpid(observer,&status,0)==observer&&WIFEXITED(status)&&WEXITSTATUS(status)==0); must(kill(child,0)==0&&absent());
    if(phase>=4)must(fault_report[0]==0);else if(phase)must(fault_report[0]==1&&fault_report[1]==EBADF);else must(fault_report[0]==0);
    must(write(sv[0],"X",1)==1); must(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    kill(med,SIGTERM); waitpid(med,&status,0); close(sv[0]); must(munmap(fault_report,2*sizeof(int))==0); fault_report=NULL; unlinkat(rootdir,"native-cancel-owner",0);
}
static void notifier_case(void) {
    int sv[2], ctl[2], status; pid_t clientpid, medpid;
    create_file("state.json","{}",2);
    must(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,sv)==0);
    must(pipe(ctl)==0);
    clientpid=fork();must(clientpid>=0);
    if(!clientpid){
        close(sv[0]);close(ctl[0]);syscall(SYS_close,rootdir);syscall(SYS_close,slot);
        peer_pid=getpid();must(setgroups(0,NULL)==0&&setgid(65534)==0&&setuid(65534)==0);
        int l=task245_metadata_filter();must(l>=0);
        char data[CMSG_SPACE(sizeof(int))]={0};char magic[8]="LISTENER";struct iovec iov={.iov_base=magic,.iov_len=8};struct msghdr m={.msg_iov=&iov,.msg_iovlen=1,.msg_control=data,.msg_controllen=sizeof data};
        struct cmsghdr*c=CMSG_FIRSTHDR(&m);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&l,sizeof l);must(sendmsg(sv[1],&m,0)==8);close(l);close(sv[1]);
        landlock();seccomp(); int rc=notifier_checks(1,0); if(rc){dprintf(2,"metadata-test: check=%d\n",rc);_exit(30+rc);}
        pid_t g=fork();must(g>=0);if(!g){int r=notifier_checks(0,0);_exit(r?70+r:0);}must(waitpid(g,&status,0)==g&&WIFEXITED(status)&&!WEXITSTATUS(status));
        char *av[]={"/lab/bin/metadata-child","--notifier-exec",NULL};if(dup3(ctl[1],STDOUT_FILENO,0)!=STDOUT_FILENO)_exit(127);execve(av[0],av,environ);_exit(127);
    }
    close(sv[1]);close(ctl[1]);peer_pid=clientpid;
    char magic[8];struct iovec iov={.iov_base=magic,.iov_len=sizeof magic};char control[CMSG_SPACE(sizeof(int))]={0};struct msghdr m={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    must(recvmsg(sv[0],&m,0)==8&&!memcmp(magic,"LISTENER",8));struct cmsghdr*c=CMSG_FIRSTHDR(&m);must(c&&c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS&&c->cmsg_len==CMSG_LEN(sizeof(int))&&!(m.msg_flags&(MSG_CTRUNC|MSG_TRUNC)));memcpy(&listener,CMSG_DATA(c),sizeof listener);close(sv[0]);
    medpid=fork();must(medpid>=0);if(!medpid){handle();_exit(0);}close(listener);listener=-1;
    char out[128]={0};size_t used=0;for(;;){ssize_t n=read(ctl[0],out+used,sizeof out-1-used);if(n<0&&errno==EINTR)continue;must(n>=0);if(!n)break;used+=(size_t)n;must(used<sizeof out-1);}
    must(waitpid(clientpid,&status,0)==clientpid&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    must(absent());
    must(!strcmp(out,"metadata notifier exec: PASS\n"));kill(medpid,SIGTERM);waitpid(medpid,&status,0);close(listener);listener=-1;close(ctl[0]);
}
int main(int argc, char **argv) {
    if(argc==2&&!strcmp(argv[1],"--service-peer")) {
        if(geteuid()!=0||!getenv("GITHUB_ACTIONS")||strcmp(getenv("GITHUB_ACTIONS"),"true"))_exit(2);
        int fd=socket(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0);if(fd<0)_exit(2);
        if(setgroups(0,NULL)||setgid(65534)||setuid(65534))_exit(2);
        int result=metadata_service(fd);if(result){close(fd);_exit(1);}
        int pair[2];must(pipe2(pair,O_CLOEXEC)==0);char magic[8]="OCMETA01",control[CMSG_SPACE(sizeof(int))]={0};
        struct iovec io={.iov_base=magic,.iov_len=8};struct msghdr msg={.msg_iov=&io,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
        struct cmsghdr*c=CMSG_FIRSTHDR(&msg);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&pair[0],sizeof(int));
        must(sendmsg(fd,&msg,0)==8);char reply;must(recv(fd,&reply,1,0)==0);close(pair[0]);close(pair[1]);close(fd);_exit(0);
    }
    if(argc==4&&!strcmp(argv[1],"--active-client")) {
        char *end; errno=0; long sock=strtol(argv[2],&end,10); must(!errno&&*argv[2]&&!*end&&sock>=0&&sock<=INT_MAX);
        errno=0; long phase=strtol(argv[3],&end,10); must(!errno&&*argv[3]&&!*end&&phase>=0&&phase<=5);
        active_client((int)sock,(int)phase);
    }
    if(argc==2&&!strcmp(argv[1],"--notifier-exec"))notifier_exec();
    int notify=argc==2&&!strcmp(argv[1],"--notifier");
    int inactive=argc==2&&!strcmp(argv[1],"--notifier-inactive");
    must((argc==1||notify||inactive)&&getuid()==0);
    const char *ci = getenv("GITHUB_ACTIONS"); must(ci && strcmp(ci, "true") == 0);
    alarm(30);fixture(); if(inactive){syscall(SYS_close,slot);slot=-1;notifier_case();}else if(notify){syscall(SYS_close,slot);slot=-1;for(int phase=0;phase<6;phase++)active_case(phase);}else {success_case(); fault_case(1); fault_case(2); fault_case(3); negatives();}
    must(owner_alive() == 1);
    if(slot>=0){syscall(SYS_close, slot); slot=-1;}
    unlinkat(rootdir, "consumer-receipt", 0); unlinkat(rootdir, "native-fault-reached", 0);unlinkat(rootdir,"state.json",0);
    syscall(SYS_close, rootdir); rootdir = -1;
    char path[PATH_MAX]; snprintf(path, sizeof path, "%s/consumer-receipt", rootpath); unlink(path);
    snprintf(path, sizeof path, "%s/native-fault-reached", rootpath); unlink(path);
    snprintf(path, sizeof path, "%s/state.json", rootpath); unlink(path);
    rmdir(rootpath);
    if(inactive)puts("metadata notifier inactive: PASS");else if(notify)puts("metadata notifier regression: PASS");else puts("metadata cancel-ack regression: PASS"); return 0;
}
