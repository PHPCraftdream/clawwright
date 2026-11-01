//go:build linux && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	content "clawforge/tools/native/task240-native/task245-native-content"
)

// launchNative accepts only an already-authenticated consumer and transfers the
// outer supervisor descriptor; no request payload or secret is consumed here.
func launchNative(fd int, pid int, c brokerConfig) error {
	bad := func() error { return brokerErr }
	if fd < 0 || pid <= 0 || c.SelectedImage == "" || authenticateConsumer(pid, c) != nil { return bad() }
	r, err := content.Open(c.Root, c.Manifest, c.ManifestSHA256)
	if err != nil { return bad() }; defer r.Close()
	insideRoot := func(p string) bool { rel, e := filepath.Rel(c.Root, p); return e == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) }
	if !insideRoot(c.Init) || !insideRoot(c.Node) || !insideRoot(c.Stub) || !insideRoot(c.Provider) || !insideRoot(c.ConfigPath) { return bad() }
	for _, v := range []struct{ p, h string }{{c.Node,c.NodeSHA256},{c.Stub,c.StubSHA256},{c.Provider,c.ProviderSHA256}} {
		f,e:=r.File(filepath.ToSlash(strings.TrimPrefix(v.p, c.Root+string(filepath.Separator)))); if e!=nil{return bad()}; h:=sha256.New();_,e=io.Copy(h,f);f.Close();if e!=nil||hex.EncodeToString(h.Sum(nil))!=v.h{return bad()}
	}
	init,e:=r.File(filepath.ToSlash(strings.TrimPrefix(c.Init,c.Root+string(filepath.Separator))));if e!=nil{return bad()};defer init.Close();h:=sha256.New();if _,e=io.Copy(h,init);e!=nil||hex.EncodeToString(h.Sum(nil))!=c.InitSHA256{return bad()};if _,e=init.Seek(0,0);e!=nil{return bad()}
	sup,e:=safeRootFile245(c.Supervisor,c.SupervisorSHA256);if e!=nil{return bad()};defer sup.Close(); sealed,e:=sealNativeFile(sup,"clawwright-supervisor");if e!=nil{return bad()};defer sealed.Close()
	root,e:=os.Open(c.Root);if e!=nil{return bad()};defer root.Close()
	var outer syscall.Stat_t;if syscall.Fstat(int(root.Fd()),&outer)!=nil||outer.Uid!=0||outer.Mode&0022!=0{return bad()}
	cfg:=workerLaunch245{Root:"/",Manifest:"",ManifestSHA256:"",Init:"/"+filepath.Base(c.Init),InitSHA256:c.InitSHA256,Node:"/"+filepath.ToSlash(strings.TrimPrefix(c.Node,c.Root+string(filepath.Separator))),NodeSHA256:c.NodeSHA256,Stub:"/"+filepath.ToSlash(strings.TrimPrefix(c.Stub,c.Root+string(filepath.Separator))),StubSHA256:c.StubSHA256,Provider:"/"+filepath.ToSlash(strings.TrimPrefix(c.Provider,c.Root+string(filepath.Separator))),ProviderSHA256:c.ProviderSHA256,ConfigPath:"/"+filepath.ToSlash(strings.TrimPrefix(c.ConfigPath,c.Root+string(filepath.Separator))),SocketPath:"/run/clawwright-native.sock",GatewayArgv:c.GatewayArgv,BrokerArgv:c.BrokerArgv,Target:c.Target,Revision:c.Revision,Purpose:c.Purpose,SelectedImage:c.SelectedImage,CaptureEvidence:c.CaptureEvidence,LabScenario:c.LabScenario}
	cfg.RuntimeUID=c.RuntimeUID;cfg.RuntimeGID=c.RuntimeGID;cfg.SupervisorSHA256=c.SupervisorSHA256; for field,p:=range map[*uint64]string{&cfg.OuterPIDNS:"pid",&cfg.OuterMNTNS:"mnt",&cfg.OuterNETNS:"net"}{var st syscall.Stat_t;if syscall.Stat("/proc/self/ns/"+p,&st)!=nil{return bad()};*field=st.Ino}
	guestNode:="/"+filepath.ToSlash(strings.TrimPrefix(c.Node,c.Root+string(filepath.Separator)));if len(cfg.GatewayArgv)==0||len(cfg.BrokerArgv)==0||cfg.GatewayArgv[0]!=guestNode||cfg.BrokerArgv[0]!=guestNode{return bad()}
	meta,e:=sealedMetadataNative(cfg);if e!=nil{return bad()};defer meta.Close()
	pair,e:=syscall.Socketpair(syscall.AF_UNIX,syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC,0);if e!=nil{return bad()};outerFD:=os.NewFile(uintptr(pair[0]),"outer-control");inner:=os.NewFile(uintptr(pair[1]),"inner-control");defer outerFD.Close()
	ctx,cancel:=context.WithTimeout(context.Background(),60*time.Second);defer cancel()
	cmd:=exec.CommandContext(ctx,"/proc/self/fd/7",itoa(int(c.RuntimeUID)),itoa(int(c.RuntimeGID)));cmd.Env=[]string{};cmd.Dir="/";cmd.Stderr=os.Stderr;cmd.ExtraFiles=[]*os.File{sealed,inner,root,meta,init};cmd.SysProcAttr=&syscall.SysProcAttr{Pdeathsig:syscall.SIGKILL}
	if e=cmd.Start();e!=nil{inner.Close();return bad()};inner.Close()
	rights:=syscall.UnixRights(int(outerFD.Fd()));n,e:=syscall.SendmsgN(fd,[]byte("OCLABFD1"),rights,nil,0);if e!=nil||n!=8{_ = cmd.Process.Kill();_,_=cmd.Process.Wait();return bad()};outerFD.Close()
	done:=make(chan error,1);go func(){err:=cmd.Wait();code:=0;if err!=nil{code=255;if exited,ok:=err.(*exec.ExitError);ok&&exited.ExitCode()>=0{code=exited.ExitCode()}};_,_=os.Stderr.WriteString("task245-broker: child="+strconv.Itoa(code)+"\n");done<-err}(); eof:=make(chan error,1);go func(){var b [1]byte;for{n,x:=syscall.Read(fd,b[:]);if x==syscall.EINTR{continue};if x!=nil{eof<-x;return};if n==0{eof<-nil;return};eof<-brokerErr;return}}()
	select { case e=<-done: if e!=nil{return bad()};return nil;case e=<-eof: _ = cmd.Process.Kill();select{case w:=<-done:if w!=nil{return bad()};return e;case <-ctx.Done():return bad()};case <-ctx.Done():_ = cmd.Process.Kill();<-done;return bad() }
}

func sealNativeFile(src *os.File,name string)(*os.File,error){p,e:=syscall.BytePtrFromString(name);if e!=nil{return nil,e};fd,_,errno:=syscall.Syscall(319,uintptr(unsafe.Pointer(p)),uintptr(0x2|0x1),0);runtime.KeepAlive(p);if errno!=0{return nil,errno};f:=os.NewFile(fd,name);if _,e=src.Seek(0,0);e!=nil{f.Close();return nil,e};if _,e=io.Copy(f,src);e!=nil{f.Close();return nil,e};if _,e=f.Seek(0,0);e!=nil{f.Close();return nil,e};if e=f.Chmod(0555);e!=nil{f.Close();return nil,e};_,_,errno=syscall.Syscall(syscall.SYS_FCNTL,fd,1033,uintptr(0xf));if errno!=0{f.Close();return nil,errno};return f,nil}

func sealedMetadataNative(v any)(*os.File,error){b,e:=json.Marshal(v);if e!=nil||len(b)>65536{return nil,brokerErr};p,e:=syscall.BytePtrFromString("clawwright-worker-metadata");if e!=nil{return nil,e};fd,_,errno:=syscall.Syscall(319,uintptr(unsafe.Pointer(p)),uintptr(0x2|0x1),0);runtime.KeepAlive(p);if errno!=0{return nil,errno};f:=os.NewFile(fd,"worker-metadata");if _,e=f.Write(b);e!=nil{f.Close();return nil,e};if _,e=f.Seek(0,0);e!=nil{f.Close();return nil,e};if e=f.Chmod(0444);e!=nil{f.Close();return nil,e};_,_,errno=syscall.Syscall(syscall.SYS_FCNTL,fd,1033,uintptr(0xf));if errno!=0{f.Close();return nil,errno};return f,nil}

type workerLaunch245 struct {
 Root,Manifest,ManifestSHA256,Init,InitSHA256,Node,NodeSHA256,Stub,StubSHA256,Provider,ProviderSHA256,ConfigPath,SocketPath string
 GatewayArgv,BrokerArgv []string
 Target,Revision,Purpose,SelectedImage,SupervisorSHA256,CaptureEvidence,LabScenario string
 RuntimeUID,RuntimeGID uint32
 OuterPIDNS,OuterMNTNS,OuterNETNS uint64
}

func itoa(n int)string{return strconv.Itoa(n)}
