#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "task240 launch stub supports Linux amd64 only"
#endif
#define DIE() _exit(111)
#define MAX_PACKET 4096
#define MAX_ARGS 16
#define MAX_ENV 2
static unsigned char packet[MAX_PACKET];
static char *argvv[MAX_ARGS+1], *envv[MAX_ENV+1];
static unsigned char argsbuf[3072], envbuf[1024];
static int numeric(const char *s) { if(!*s)return 0; for(;*s;s++)if(*s<'0'||*s>'9')return 0; return 1; }
static void audit(void) {
 DIR *d=opendir("/proc/self/task"); if(!d)DIE(); struct dirent *e; int tasks=0;
 while((e=readdir(d))) { if(!strcmp(e->d_name,".")||!strcmp(e->d_name,".."))continue; if(!numeric(e->d_name))DIE(); tasks++; }
 if(closedir(d)||tasks!=1)DIE();
 d=opendir("/proc/self/fd"); if(!d)DIE(); int own=dirfd(d),seen[6]={0};
 while((e=readdir(d))) { if(!strcmp(e->d_name,".")||!strcmp(e->d_name,".."))continue; if(!numeric(e->d_name))DIE(); char *end; long n=strtol(e->d_name,&end,10); if(*end)DIE(); if(n==own)continue; if(n<0||n>5)DIE(); seen[n]=1; }
 for(int i=0;i<6;i++)if(!seen[i])DIE();
 for(int i=0;i<=5;i++) { char path[64],target[4096]; snprintf(path,sizeof(path),"/proc/self/fd/%d",i); ssize_t n=readlink(path,target,sizeof(target)-1); if(n<=0)DIE(); target[n]=0; if(strstr(target,"io_uring"))DIE(); }
 struct stat st; if(fstat(3,&st)||!S_ISREG(st.st_mode)||st.st_uid!=0||st.st_nlink!=1||(st.st_mode&022)||!(st.st_mode&0111))DIE();
 for(int i=4;i<=5;i++){int f=fcntl(i,F_GETFL);if(f<0||(f&O_ACCMODE)!=O_RDONLY||fstat(i,&st)||!S_ISFIFO(st.st_mode))DIE();}
 if(closedir(d)||fcntl(3,F_SETFD,FD_CLOEXEC))DIE();
}
static uint32_t be32(const unsigned char *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
static int exact_read(int fd,void *buf,size_t n) { unsigned char *p=buf; while(n){ssize_t r=read(fd,p,n);if(r<0&&errno==EINTR)continue;if(r<=0)return -1;p+=r;n-=r;}return 0; }
static int string_ok(const unsigned char *p,uint32_t n) {
 if(!n)return 0; for(uint32_t i=0;i<n;) { unsigned c=p[i++]; if(c<0x80){if(!c)return 0;continue;} uint32_t cp; unsigned k;
  if(c>=0xc2&&c<=0xdf){cp=c&31;k=1;}else if(c>=0xe0&&c<=0xef){cp=c&15;k=2;}else if(c>=0xf0&&c<=0xf4){cp=c&7;k=3;}else return 0;
  if(i+k>n)return 0; for(unsigned j=0;j<k;j++){unsigned b=p[i++];if((b&0xc0)!=0x80)return 0;cp=(cp<<6)|(b&63);} if((k==1&&cp<0x80)||(k==2&&cp<0x800)||(k==3&&cp<0x10000)||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))return 0;
 } return 1;
}
static void parse(void) {
 if(exact_read(5,packet,12)||memcmp(packet,"OCARGV01",8))DIE(); size_t used=12,au=0,eu=0;uint32_t ac=be32(packet+8);if(ac<1||ac>MAX_ARGS)DIE();
 for(uint32_t i=0;i<ac;i++){if(used+4>MAX_PACKET||exact_read(5,packet+used,4))DIE();uint32_t n=be32(packet+used);used+=4;if(n>1024||used+n>MAX_PACKET||au+n+1>sizeof(argsbuf)||exact_read(5,packet+used,n)||!string_ok(packet+used,n))DIE();argvv[i]=(char*)argsbuf+au;memcpy(argsbuf+au,packet+used,n);argsbuf[au+n]=0;au+=n+1;used+=n;}
 if(used+4>MAX_PACKET||exact_read(5,packet+used,4))DIE();uint32_t ec=be32(packet+used);used+=4;if(ec>MAX_ENV)DIE();
 for(uint32_t i=0;i<ec;i++){if(used+4>MAX_PACKET||exact_read(5,packet+used,4))DIE();uint32_t n=be32(packet+used);used+=4;if(n<3||n>768||used+n>MAX_PACKET||eu+n+1>sizeof(envbuf)||exact_read(5,packet+used,n)||!string_ok(packet+used,n))DIE();char *s=(char*)envbuf+eu;memcpy(s,packet+used,n);s[n]=0;char *eq=strchr(s,'=');if(!eq)DIE();size_t key=(size_t)(eq-s);if(!((key==sizeof("OPENCLAW_CONFIG_PATH")-1&&!memcmp(s,"OPENCLAW_CONFIG_PATH",sizeof("OPENCLAW_CONFIG_PATH")-1))||(key==sizeof("CLAWWRIGHT_NATIVE_SOCKET")-1&&!memcmp(s,"CLAWWRIGHT_NATIVE_SOCKET",sizeof("CLAWWRIGHT_NATIVE_SOCKET")-1))))DIE();for(uint32_t j=0;j<i;j++){char *prev=strchr(envv[j],'=');if(!prev||(size_t)(prev-envv[j])==key&&!memcmp(envv[j],s,key))DIE();}envv[i]=s;eu+=n+1;used+=n;}
 unsigned char extra;if(read(5,&extra,1)!=0)DIE();argvv[ac]=0;envv[ec]=0;memset(packet,0,sizeof(packet));
}
#define DENY_NR(nr,act) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(nr),0,1),BPF_STMT(BPF_RET|BPF_K,(act))
static void sandbox(void) {
 struct sock_filter f[]={
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
 BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
 DENY_NR(435,SECCOMP_RET_ERRNO|ENOSYS),DENY_NR(425,SECCOMP_RET_ERRNO|ENOSYS),DENY_NR(101,SECCOMP_RET_ERRNO|EPERM),DENY_NR(311,SECCOMP_RET_ERRNO|EPERM),
 DENY_NR(272,SECCOMP_RET_ERRNO|EPERM),DENY_NR(308,SECCOMP_RET_ERRNO|EPERM),DENY_NR(165,SECCOMP_RET_ERRNO|EPERM),DENY_NR(166,SECCOMP_RET_ERRNO|EPERM),DENY_NR(155,SECCOMP_RET_ERRNO|EPERM),DENY_NR(161,SECCOMP_RET_ERRNO|EPERM),DENY_NR(429,SECCOMP_RET_ERRNO|EPERM),DENY_NR(428,SECCOMP_RET_ERRNO|EPERM),DENY_NR(430,SECCOMP_RET_ERRNO|EPERM),DENY_NR(431,SECCOMP_RET_ERRNO|EPERM),DENY_NR(432,SECCOMP_RET_ERRNO|EPERM),DENY_NR(433,SECCOMP_RET_ERRNO|EPERM),DENY_NR(442,SECCOMP_RET_ERRNO|EPERM),
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,56,0,3),BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x7e820000,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
 struct sock_fprog p={(unsigned short)(sizeof(f)/sizeof(f[0])),f};if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p))DIE();
}
int main(int argc,char **argv,char **envp) {
 (void)argv;if(argc!=1||!envp||envp[0]!=NULL||getpid()!=gettid())DIE();audit();parse();close(5);
 unsigned char gate,extra;if(exact_read(4,&gate,1)||gate!=0xa5)DIE();ssize_t r;do{r=read(4,&extra,1);}while(r<0&&errno==EINTR);if(r!=0)DIE();close(4);
 sandbox();syscall(SYS_execveat,3,"",argvv,envv,AT_EMPTY_PATH);DIE();
}
