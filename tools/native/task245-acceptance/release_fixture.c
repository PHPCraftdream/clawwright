#define _GNU_SOURCE
#include <arpa/inet.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

#define SOCKET_PATH "/run/clawwright-native.sock"
#define CASE_PATH "/etc/release-case"
#define MUTATED_PATH "/run/release-mutated"
#define RECEIVED_PATH "/run/release-received"
#define DRAIN_PATH "/run/release-drain"
#define EXTRA_PATH "/run/release-extra"
#define PROVIDER_PATH "/usr/libexec/release-provider"
#define REQUEST "{\"protocolVersion\":1,\"provider\":\"clawwright-ssjack\",\"ids\":[\"gateway-token\"]}"

static void fail(int n) { dprintf(2,"release-fixture: code=%d\n",n); _exit(n); }
static int exact_write(int fd, const void *v, size_t n) {
    const char *p=v;
    while (n) { ssize_t k=write(fd,p,n); if(k<0&&errno==EINTR) continue; if(k<=0)return -1; p+=k; n-=(size_t)k; }
    return 0;
}
static int exact_read(int fd, void *v, size_t n) {
    char *p=v;
    while (n) { ssize_t k=read(fd,p,n); if(k<0&&errno==EINTR) continue; if(k<=0)return -1; p+=k; n-=(size_t)k; }
    return 0;
}
static int scenario(void) {
    char b[32]; struct stat s;
    int fd=open(CASE_PATH,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0||fstat(fd,&s)||!S_ISREG(s.st_mode)||s.st_uid!=0||(s.st_mode&022)) fail(10);
    ssize_t n=read(fd,b,sizeof b); close(fd);
    if(n==9&&!memcmp(b,"positive\n",9)) return 0;
    if(n==13&&!memcmp(b,"wrong-holder\n",13)) return 1;
    if(n==12&&!memcmp(b,"partial-ack\n",12)) return 2;
    if(n==13&&!memcmp(b,"backpressure\n",13)) return 7;
    if(n==9&&!memcmp(b,"lost-ack\n",9)) return 3;
    if(n==7&&!memcmp(b,"cancel\n",7)) return 4;
    if(n==16&&!memcmp(b,"unexpected-exec\n",16)) return 5;
    if(n==sizeof("between-write-holder\n")-1&&!memcmp(b,"between-write-holder\n",sizeof("between-write-holder\n")-1)) return 6;
    fail(11); return -1;
}
static void mark(const char *path) {
    int fd=open(path,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW,0600);
    if(fd<0||exact_write(fd,"M",1)||fsync(fd)||close(fd)) fail(12);
}
static int provider(void) {
    int mode=scenario(), s=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);
    struct sockaddr_un a={.sun_family=AF_UNIX};
    if(s<0) fail(20); strcpy(a.sun_path,SOCKET_PATH);
    if(connect(s,(struct sockaddr*)&a,sizeof a)) fail(21);
    uint32_t len=htonl(sizeof REQUEST-1);
    if(exact_write(s,&len,4)||exact_write(s,REQUEST,sizeof REQUEST-1)) fail(22);
    unsigned char admit[92]; if(exact_read(s,admit,sizeof admit)) fail(23);
    if(memcmp(admit,"OCADMIT1",8)) fail(24);
    uint32_t payload_len; memcpy(&payload_len,admit+88,4); payload_len=ntohl(payload_len);
    if(payload_len<1||payload_len>16384) fail(25);
    if(mode==1&&dup2(1,7)<0) fail(26);
    mark(MUTATED_PATH);
    if(mode==6) { unsigned char first[4096]; if(exact_read(s,first,sizeof first)) fail(26); mark(RECEIVED_PATH); if(dup2(1,7)<0) fail(26); mark("/run/release-mutated-after"); for(;;) { unsigned char extra; ssize_t n=read(s,&extra,1); if(n>0) mark(EXTRA_PATH); if(n<0&&errno==EINTR)continue; pause(); } }
    if(mode==5) { char *av[]={(char*)PROVIDER_PATH,(char*)"unexpected",NULL}; execve(PROVIDER_PATH,av,environ); fail(33); }
    if(mode==7) while(access("/run/release-drain",F_OK)!=0) usleep(1000);
    char payload[16384]; size_t got=0;
    while(got<payload_len) {
        size_t want=(size_t)payload_len-got;
        if(got>=sizeof payload||want>sizeof payload-got) fail(27);
        ssize_t n=read(s,payload+got,want);
        if(n<0&&errno==EINTR) continue;
        if(n<=0||(size_t)n>want) fail(27);
        if(!got) mark(RECEIVED_PATH);
        got+=(size_t)n;
    }
    unsigned char receipt[56]; memcpy(receipt,"OCPIPE01",8); memcpy(receipt+8,admit+8,48);
    if(mode==2) { if(exact_write(s,receipt,28)||shutdown(s,SHUT_WR)) fail(28); }
    else if(mode==3) { if(shutdown(s,SHUT_WR)) fail(28); }
    else if(mode!=4) { if(exact_write(s,receipt,sizeof receipt)||shutdown(s,SHUT_WR)) fail(28); }
    memset(payload,0,sizeof payload);
    for(;;) pause();
}
static int send_reader(int ctrl,int reader) {
    char b='F', c[CMSG_SPACE(sizeof(int))]={0}; struct iovec i={&b,1}; struct msghdr m={0};
    m.msg_iov=&i; m.msg_iovlen=1; m.msg_control=c; m.msg_controllen=sizeof c;
    struct cmsghdr *h=CMSG_FIRSTHDR(&m); h->cmsg_level=SOL_SOCKET; h->cmsg_type=SCM_RIGHTS; h->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(h),&reader,sizeof reader); return sendmsg(ctrl,&m,0)==1?0:-1;
}
static int broker(void) {
    int ctrl=3,out[2],in[2]; if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,out)||pipe(in)) fail(30);
    pid_t p=fork(); if(p<0) fail(31);
    if(!p) {
        int r=fcntl(in[0],F_DUPFD_CLOEXEC,10),w=fcntl(out[1],F_DUPFD_CLOEXEC,10);
        if(r<0||w<0||dup2(r,0)<0||dup2(w,1)<0) fail(32);
        for(int f=3;f<1024;f++) close(f);
        char *av[]={(char*)PROVIDER_PATH,NULL}; execve(PROVIDER_PATH,av,environ); fail(33);
    }
    close(in[0]); close(out[1]);
    if(exact_write(in[1],REQUEST,sizeof REQUEST-1)) fail(34); close(in[1]);
    if(send_reader(ctrl,out[0])) fail(35); close(out[0]);
    for(;;) pause();
}
static int gateway(void) {
    int pair[2]; if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair)) fail(40);
    pid_t p=fork(); if(p<0) fail(41);
    if(!p) { int x=fcntl(pair[1],F_DUPFD_CLOEXEC,10); if(x<0||dup2(x,3)<0) fail(42); int f=fcntl(3,F_GETFD); if(f<0||fcntl(3,F_SETFD,f&~FD_CLOEXEC)<0) fail(43);
        for(int d=4;d<1024;d++) close(d); char *av[]={(char*)"/usr/bin/node",(char*)"broker",NULL}; execve(av[0],av,environ); fail(44); }
    close(pair[1]); char b, c[CMSG_SPACE(sizeof(int))]={0}; struct iovec i={&b,1}; struct msghdr m={0};
    m.msg_iov=&i;m.msg_iovlen=1;m.msg_control=c;m.msg_controllen=sizeof c;
    if(recvmsg(pair[0],&m,0)!=1||b!='F'||(m.msg_flags&MSG_CTRUNC)) fail(45);
    struct cmsghdr *h=CMSG_FIRSTHDR(&m); int reader=-1;
    if(!h||h->cmsg_level!=SOL_SOCKET||h->cmsg_type!=SCM_RIGHTS||h->cmsg_len!=CMSG_LEN(sizeof(int))) fail(46);
    memcpy(&reader,CMSG_DATA(h),sizeof reader); close(pair[0]);
    for(;;) pause();
}
int main(int argc,char **argv) {
    alarm(20);
    if(argc==2&&!strcmp(argv[1],"gateway")) return gateway();
    if(argc==2&&!strcmp(argv[1],"broker")) return broker();
    if(argc==1) return provider();
    return 2;
}
