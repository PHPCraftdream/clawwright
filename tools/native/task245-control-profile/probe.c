#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error Linux amd64 only
#endif
static int denied(long r, int e) { return r == -1 && e == EPERM; }
static int denied_landlock(long r, int e) { return r == -1 && e == EACCES; }
static int check(void) {
  errno=0; long r=ptrace(PTRACE_TRACEME,0,0,0); int e=errno;
  if (!denied(r,e)) return 0;
  char byte=0; struct iovec local={&byte,1}, remote={&byte,1}; errno=0;
  r=syscall(SYS_process_vm_readv,getppid(),&local,1,&remote,1,0); e=errno;
  if (!denied(r,e)) return 0;
  errno=0; long pfd=syscall(SYS_pidfd_open,getppid(),0); int pe=errno;
  if (!denied(pfd,pe)) { if(pfd>=0)close((int)pfd); return 0; }
  errno=0; int s=socket(AF_UNIX,SOCK_STREAM,0); int se=errno;
  if(s>=0)close(s); if(!denied(s,se))return 0;
  int pair[2]; errno=0; int pr=socketpair(AF_UNIX,SOCK_STREAM,0,pair); int pre=errno;
  if(pr==0){close(pair[0]);close(pair[1]);} if(!denied(pr,pre))return 0;
  const char *paths[]={"/proc/self/mem","/proc/self/fd/0"};
  for(int i=0;i<2;i++){errno=0;int fd=open(paths[i],O_RDONLY|O_CLOEXEC);int e=errno;if(fd>=0)close(fd);if(!denied_landlock(fd,e))return 0;}
  errno=0; s=socket(AF_INET,SOCK_STREAM,0); se=errno;if(s<0)return 0;close(s);
  return 1;
}
int main(int argc,char **argv){if(argc!=3)return 2;(void)argv; if(!check())return 1;
  pid_t p=fork();if(p<0)return 1;if(p==0)_exit(check()?0:1);
  int st; if(waitpid(p,&st,0)!=p||!WIFEXITED(st)||WEXITSTATUS(st)!=0)return 1;
  puts("CONTROL_CONFINEMENT_OK");return 0;}
