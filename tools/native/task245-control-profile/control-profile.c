#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/vfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "metadata.h"

#if !defined(__linux__) || !defined(__x86_64__)
#error unsupported syscall ABI
#endif
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(n),0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
static void die(const char *s){dprintf(2,"control-profile: %s\n",s);_exit(126);}
static int fdpath(int fd,char *b,size_t n){char p[64];snprintf(p,sizeof p,"/proc/self/fd/%d",fd);ssize_t z=readlink(p,b,n-1);if(z<0||(size_t)z>=n-1)return -1;b[z]=0;return 0;}
static int rootsafe(const char *p){char b[PATH_MAX];if(strlen(p)>=sizeof b)return -1;strcpy(b,p);for(char *q=b+1; ;q++){if(*q!='/'&&*q)continue;char c=*q;*q=0;struct stat s;if(lstat(b,&s)||!S_ISDIR(s.st_mode)||s.st_uid!=0||(s.st_mode&022))return -1;*q=c;if(!c)break;}struct statvfs f;if(statvfs(p,&f))return -1;/* read-only mount required */if(!(f.f_flag&ST_RDONLY))return -1;return 0;}
static void landlock(void){struct landlock_ruleset_attr a={.handled_access_fs=LANDLOCK_ACCESS_FS_EXECUTE|LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_REMOVE_DIR|LANDLOCK_ACCESS_FS_REMOVE_FILE|LANDLOCK_ACCESS_FS_MAKE_CHAR|LANDLOCK_ACCESS_FS_MAKE_DIR|LANDLOCK_ACCESS_FS_MAKE_REG|LANDLOCK_ACCESS_FS_MAKE_SOCK|LANDLOCK_ACCESS_FS_MAKE_FIFO|LANDLOCK_ACCESS_FS_MAKE_BLOCK|LANDLOCK_ACCESS_FS_MAKE_SYM|LANDLOCK_ACCESS_FS_REFER|LANDLOCK_ACCESS_FS_TRUNCATE};int r=syscall(SYS_landlock_create_ruleset,&a,sizeof a,0);if(r<0)die("Landlock ABI unavailable");int abi=syscall(SYS_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION);if(abi<3)die("Landlock ABI v3 required");const char *p="/lab/bin";if(rootsafe(p))die("allowed mount/path is absent, mutable, or not read-only");int fd=open(p,O_PATH|O_CLOEXEC);struct landlock_path_beneath_attr x={.allowed_access=LANDLOCK_ACCESS_FS_EXECUTE|LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR,.parent_fd=fd};if(fd<0||syscall(SYS_landlock_add_rule,r,LANDLOCK_RULE_PATH_BENEATH,&x,0))die("cannot add Landlock path");close(fd);if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||syscall(SYS_landlock_restrict_self,r,0))die("cannot restrict filesystem");close(r);}
static void seccomp(void){
    struct sock_filter f[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,53,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,46,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,47,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,307,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,299,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,101,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,310,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,311,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,434,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,438,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,440,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,312,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,321,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,298,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,323,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,425,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,426,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,427,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,303,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,304,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,308,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,272,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,165,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,166,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,155,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,161,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,435,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,56,0,4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x7e820000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,41,0,5),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AF_INET,2,0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AF_INET6,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog p={.len=(unsigned short)(sizeof f/sizeof*f),.filter=f};
    if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p))die("cannot install seccomp");
}
static int safe_ref(const char *s){size_t n=strlen(s);if(!n||n>32768)return 0;for(size_t i=0;i<n;i++){unsigned char c=s[i];if(c<0x20||c==0x7f)return 0;}return 1;}
static int lab_mode(const char *mode){struct stat root;if(lstat("/lab",&root)||!S_ISDIR(root.st_mode)||root.st_uid!=0||(root.st_mode&022))return 0;const char *paths[]={"/lab/disposable-profile","/lab/scenario"};struct stat files[2];for(int i=0;i<2;i++){int fd=open(paths[i],O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return 0;if(fstat(fd,&files[i])||!S_ISREG(files[i].st_mode)||files[i].st_uid!=0||files[i].st_nlink!=1||(files[i].st_mode&0777)!=0444||files[i].st_size<1||files[i].st_size>128){close(fd);return 0;}close(fd);}int fd=open(paths[1],O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return 0;char b[129];ssize_t n=read(fd,b,sizeof b);close(fd);if(n<=0||n>128)return 0;b[n]=0;if(!strcmp(b,"wrong-holder")||!strcmp(b,"unexpected-exec"))return !strcmp(mode,"withheld");if(!strcmp(b,"partial-ack")||!strcmp(b,"lost-ack"))return !strcmp(mode,"unknown");if(!strcmp(b,"cancel"))return !strcmp(mode,"cancel");return 0;}
int main(int argc,char **argv,char **envp){(void)envp;if(argc!=3||!safe_ref(argv[1]))die("expected REF mode");int golden=!strcmp(argv[2],"golden");if(!golden&&strcmp(argv[2],"withheld")&&strcmp(argv[2],"unknown")&&strcmp(argv[2],"cancel"))die("invalid mode");if(!golden&&!lab_mode(argv[2]))die("scenario does not authorize mode");char *end;errno=0;long lim=strtol(argv[1],&end,10);(void)lim;/* REF is opaque bounded UTF-8-ish metadata; no shell interpretation. */
if(!strcmp(argv[1],".")||!strcmp(argv[1],"..")||strchr(argv[1],'/'))die("invalid REF");struct stat s;if(lstat("/lab/bin/harness",&s)||!S_ISREG(s.st_mode)||s.st_uid|| (s.st_mode&022))die("harness must be root-owned immutable regular file");char *names[]={"SSJACK_ENV_TOKEN","SSJACK_SESSION","SSJACK_ENDPOINT","SSJACK_CERTIFICATE_SHA256","SSJACK_BOOTSTRAP_FILE"};char *vals[5];for(int i=0;i<4;i++){const char *v=getenv(names[i]);if(!v||! *v)die("missing broker bootstrap variable");size_t n=strlen(v);vals[i]=malloc(n+strlen(names[i])+2);if(!vals[i])die("memory allocation failed");sprintf(vals[i],"%s=%s",names[i],v);}vals[4]=NULL;
struct rlimit z={0,0};if(setrlimit(RLIMIT_CORE,&z)||prctl(PR_SET_DUMPABLE,0))die("cannot disable dumps");for(int i=0;i<4;i++)unsetenv(names[i]);clearenv();for(int i=0;i<4;i++)putenv(vals[i]);setenv("PATH","/lab/bin",1);setenv("LANG","C",1);setenv("LC_ALL","C",1);struct rlimit fdlim;if(getrlimit(RLIMIT_NOFILE,&fdlim))die("cannot read descriptor limit");rlim_t fdmax=fdlim.rlim_cur;if(fdmax==RLIM_INFINITY)fdmax=1048576;for(rlim_t i=3;i<fdmax;i++)close((int)i);if(!golden&&task245_metadata_install())die("metadata broker unavailable");landlock();seccomp();char *av[]={"/lab/bin/harness",argv[1],argv[2],NULL};execve(av[0],av,environ);die("exec harness failed");}
