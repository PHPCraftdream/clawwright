//go:build linux && amd64

package main

import (
 "bytes"
 "context"
 "crypto/sha256"
 "encoding/binary"
 "encoding/hex"
 "encoding/json"
 "errors"
  "io"
 "net"
 "os"
 "strconv"
 "sort"
 "strings"
 "sync"
 "syscall"
 "time"
 "unicode/utf8"
 admission "clawforge/tools/native/task240-native/task240-native-admission"
)

func runConnectedWorker() error {
 bad:=func()error{return errDomainWorker}
 if len(os.Args)!=2||os.Args[1]!="--task245-domain-worker"||len(os.Environ())!=0||os.Geteuid()==0||os.Getpid()!=2||os.Getppid()!=1{return bad()}
 var img,meta syscall.Stat_t
 if syscall.Fstat(3,&img)!=nil||img.Mode&syscall.S_IFMT!=syscall.S_IFREG||img.Uid!=0||img.Mode&0022!=0||img.Mode&0555!=0555||syscall.Fstat(6,&meta)!=nil||meta.Mode&syscall.S_IFMT!=syscall.S_IFREG||meta.Uid!=0||meta.Mode&0022!=0||meta.Size<2||meta.Size>65536{return bad()}
 for _,fd:=range []uintptr{3,6}{s,_,e:=syscall.Syscall(syscall.SYS_FCNTL,fd,1034,0);if e!=0||s&15!=15{return bad()}}
 mf:=os.NewFile(6,"launch-metadata");defer mf.Close();b,e:=io.ReadAll(io.LimitReader(mf,65537));if e!=nil||int64(len(b))!=meta.Size||duplicateJSON(b)!=nil{return bad()}
 var c launchConfig;d:=json.NewDecoder(strings.NewReader(string(b)));d.DisallowUnknownFields();if d.Decode(&c)!=nil||d.Decode(new(any))!=io.EOF{return bad()}
 var imageExe syscall.Stat_t; if syscall.Stat("/proc/self/exe",&imageExe)!=nil||img.Dev!=imageExe.Dev||img.Ino!=imageExe.Ino{return bad()}
 var pidns,mntns,netns syscall.Stat_t
 if syscall.Stat("/proc/self/ns/pid",&pidns)!=nil||syscall.Stat("/proc/self/ns/mnt",&mntns)!=nil||syscall.Stat("/proc/self/ns/net",&netns)!=nil{return bad()}
 if c.RuntimeUID==0||uint32(os.Getuid())!=c.RuntimeUID||uint32(os.Getgid())!=c.RuntimeGID||c.OuterPIDNS==0||c.OuterMNTNS==0||c.OuterNETNS==0||pidns.Ino==c.OuterPIDNS||mntns.Ino==c.OuterMNTNS||netns.Ino==c.OuterNETNS{return bad()}
 if !workerMountsOK()||!rootCodeMountedReadOnly(c)||!hashFD3(img,c.SupervisorSHA256){return bad()}
 if e=syscall.SetNonblock(4,true);e!=nil{return bad()};typ,te:=syscall.GetsockoptInt(4,syscall.SOL_SOCKET,syscall.SO_TYPE);if te!=nil||typ!=syscall.SOCK_SEQPACKET{return bad()};sa,se:=syscall.Getsockname(4);peer,pe:=syscall.Getpeername(4);if se!=nil||pe!=nil||sa==nil||peer==nil{return bad()};_,saOK:=sa.(*syscall.SockaddrUnix);_,peerOK:=peer.(*syscall.SockaddrUnix);if !saOK||!peerOK{return bad()};broker,be:=syscall.GetsockoptUcred(4,syscall.SOL_SOCKET,syscall.SO_PEERCRED);if be!=nil||broker==nil||broker.Uid!=0{return bad()}
 control:=os.NewFile(4,"outer-control");if control==nil{return bad()};defer control.Close();ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second);defer cancel();if dl,ok:=ctx.Deadline();!ok||control.SetDeadline(dl)!=nil{return bad()}
 var header [64]byte;var packet [65]byte;n,e:=control.Read(packet[:]);if e!=nil||n!=64{return bad()};copy(header[:],packet[:64]);if string(header[:8])!="SSINK001"||binary.BigEndian.Uint64(header[56:64])==0||binary.BigEndian.Uint64(header[56:64])>16384{return bad()};nonceZero:=true;for _,v:=range header[8:24]{if v!=0{nonceZero=false}};bindingZero:=true;for _,v:=range header[24:56]{if v!=0{bindingZero=false}};if nonceZero||bindingZero{return bad()}
 if c.SocketPath!="/run/clawwright-native.sock"{return bad()};_ = os.Remove(c.SocketPath);addr:=&net.UnixAddr{Name:c.SocketPath,Net:"unix"};l,e:=net.ListenUnix("unix",addr);if e!=nil{return bad()};defer l.Close();defer os.Remove(c.SocketPath);if l.SetDeadline(time.Now().Add(30*time.Second))!=nil{return bad()}
 wc:=workerConfig{Node:c.Node,Stub:c.Stub,Provider:c.Provider,ConfigPath:c.ConfigPath,SocketPath:c.SocketPath,CaptureEvidence:c.CaptureEvidence,GatewayArgv:c.GatewayArgv,BrokerArgv:c.BrokerArgv,NodeSHA256:c.NodeSHA256,StubSHA256:c.StubSHA256,ProviderSHA256:c.ProviderSHA256,Target:c.Target,Revision:c.Revision,Purpose:c.Purpose,LabScenario:c.LabScenario,registry:&execRegistry245{roles:map[int]string{}}}
 tracker,gatewayPID,e:=startGateway(ctx,wc);if e!=nil{return bad()};defer tracker.Close()
 var conn *net.UnixConn
 for {if ctx.Err()!=nil{return bad()};if l.SetDeadline(time.Now().Add(100*time.Millisecond))!=nil{return bad()};conn,e=l.AcceptUnix();if e==nil{break};if ne,ok:=e.(net.Error);!ok||!ne.Timeout(){return bad()};if c.LabScenario=="unexpected-exec"&&wc.registry.wasRejectedExec(){if sendLabRefusal(control,header,"BADEXEC1")!=nil{return bad()};return bad()}}
 defer conn.Close();raw,e:=conn.SyscallConn();if e!=nil{return bad()};var cred *syscall.Ucred;var ce error;if raw.Control(func(fd uintptr){cred,ce=syscall.GetsockoptUcred(int(fd),syscall.SOL_SOCKET,syscall.SO_PEERCRED)})!=nil||ce!=nil||cred==nil||cred.Uid!=uint32(os.Getuid())||cred.Pid<=0||int(cred.Pid)==gatewayPID||!wc.registry.isProvider(int(cred.Pid)){return bad()}
 // Guardian identity is intentionally checked against the connected peer; tracker custody validates its traced process tree.
 result:=serveAdmitted(ctx,control,conn,tracker,gatewayPID,int(cred.Pid),wc.registry.brokerIDs(),header,c.Target,c.Revision,c.Purpose,c.CaptureEvidence); if c.LabScenario=="wrong-holder"&&errors.Is(result,errUnexpectedWriter245){ if x:=sendLabRefusal(control,header,"BADWRITE");x!=nil{return x} }; return result
}
func sendLabRefusal(control *os.File,header [64]byte,code string)error{if control==nil||string(header[:8])!="SSINK001"||binary.BigEndian.Uint64(header[56:])==0||binary.BigEndian.Uint64(header[56:])>16384||(code!="BADWRITE"&&code!="BADEXEC1"){return errDomainWorker};packet:=make([]byte,64);copy(packet,"OCLABNO1");copy(packet[8:56],header[8:56]);copy(packet[56:],code);n,e:=control.Write(packet);if e!=nil||n!=len(packet){return errDomainWorker};return nil}
func hashFD3(st syscall.Stat_t,want string)bool{f:=os.NewFile(3,"supervisor-image-check");if f==nil{return false};defer f.Close();s,e:=f.Stat();if e!=nil{return false};cur,ok:=s.Sys().(*syscall.Stat_t);if !ok||cur.Dev!=st.Dev||cur.Ino!=st.Ino||cur.Mode&syscall.S_IFMT!=syscall.S_IFREG||cur.Uid!=0||cur.Mode&0555!=0555||cur.Mode&0022!=0{return false};return hashNodeSHA(f,want)==nil}
func workerMountsOK()bool{b,e:=os.ReadFile("/proc/self/mountinfo");if e!=nil||len(b)==0||len(b)>4<<20{return false};root,proc,run:=false,false,false;count:=0;for _,line:=range strings.Split(string(b),"\n"){if strings.TrimSpace(line)==""{continue};count++;f:=strings.Fields(line);if len(f)<10{return false};sep:=-1;for i:=6;i<len(f);i++{if f[i]=="-"{sep=i;break}};if sep<0||len(f)<=sep+2{return false};switch f[4]{case "/":if root||!hasOpt(f[5],"ro"){return false};root=true;case "/proc":if proc||f[sep+1]!="proc"||!hasOpt(f[5],"ro"){return false};proc=true;case "/run":if run||f[sep+1]!="tmpfs"||!hasOpt(f[5],"rw")||!hasOpt(f[5],"noexec")||!hasOpt(f[5],"nosuid")||!hasOpt(f[5],"nodev"){return false};run=true;default:return false}};return count==3&&root&&proc&&run}
func hasOpt(s,w string)bool{for _,v:=range strings.Split(s,","){if v==w{return true}};return false}
func rootCodeMountedReadOnly(c launchConfig)bool{for _,p:=range []struct{p,h string}{{c.Node,c.NodeSHA256},{c.Stub,c.StubSHA256},{c.Provider,c.ProviderSHA256}}{f,e:=os.Open(p.p);if e!=nil{return false};s,e:=f.Stat();if e!=nil{f.Close();return false};st,ok:=s.Sys().(*syscall.Stat_t);if !ok||st.Uid!=0||st.Mode&022!=0{f.Close();return false};h:=sha256.New();n,e:=io.Copy(h,io.LimitReader(f,64<<20+1));f.Close();if e!=nil||n>64<<20||hex.EncodeToString(h.Sum(nil))!=p.h{return false}};return true}

type workerConfig struct{Node,Stub,Provider,ConfigPath,SocketPath,CaptureEvidence string;GatewayArgv,BrokerArgv []string;NodeSHA256,StubSHA256,ProviderSHA256,Target,Revision,Purpose,LabScenario string;registry *execRegistry245}
type execRegistry245 struct{mu sync.Mutex;roles map[int]string;rejectedExec bool}
func(r *execRegistry245)setRejectedExec(){if r==nil{return};r.mu.Lock();defer r.mu.Unlock();r.rejectedExec=true}
func(r *execRegistry245)wasRejectedExec()bool{if r==nil{return false};r.mu.Lock();defer r.mu.Unlock();return r.rejectedExec}
func(r *execRegistry245)record(pid int,role string)error{if r==nil||pid<=0||role==""{return errDomainWorker};r.mu.Lock();defer r.mu.Unlock();if _,ok:=r.roles[pid];ok{return errDomainWorker};r.roles[pid]=role;return nil}
func(r *execRegistry245)brokerIDs()[]int{if r==nil{return nil};r.mu.Lock();defer r.mu.Unlock();ids:=make([]int,0);for pid,role:=range r.roles{if role=="broker"{ids=append(ids,pid)}};sort.Ints(ids);return ids}
func(r *execRegistry245)isProvider(pid int)bool{if r==nil{return false};r.mu.Lock();defer r.mu.Unlock();return r.roles[pid]=="provider"}
func startGateway(ctx context.Context,c workerConfig)(*admission.TraceTracker,int,error){
 bad:=func()(*admission.TraceTracker,int,error){return nil,0,errDomainWorker}
 if ctx==nil||ctx.Err()!=nil { return bad() }; if _,ok:=ctx.Deadline();!ok{return bad()}
 node,e:=openPinnedExec(c.Node,c.NodeSHA256);if e!=nil{return bad()};defer node.Close()
 stub,e:=openPinnedExec(c.Stub,c.StubSHA256);if e!=nil{return bad()};defer stub.Close()
 provider,e:=openPinnedExec(c.Provider,c.ProviderSHA256);if e!=nil{return bad()};defer provider.Close()
 packet,e:=encodeLaunchPacket(c.GatewayArgv,c.ConfigPath,c.SocketPath);if e!=nil{return bad()}
 gateR,gateW,e:=os.Pipe();if e!=nil{return bad()};defer gateR.Close();defer gateW.Close()
 argsR,argsW,e:=os.Pipe();if e!=nil{return bad()};defer argsR.Close();defer argsW.Close()
 pid,e:=syscall.ForkExec(c.Stub,[]string{c.Stub},&syscall.ProcAttr{Dir:"/",Env:[]string{},Files:[]uintptr{0,1,2,node.Fd(),gateR.Fd(),argsR.Fd()},Sys:&syscall.SysProcAttr{}});if e!=nil{return bad()};_ = gateR.Close();_ = argsR.Close()
 root:=pid
 guard:=func(tid int,generation uint64)error{
  if tid<=0{return errDomainWorker}
  exe,e:=os.Open("/proc/"+strconv.Itoa(tid)+"/exe");if e!=nil{return errDomainWorker};defer exe.Close()
  st,e:=exe.Stat();if e!=nil{return errDomainWorker};stat,ok:=st.Sys().(*syscall.Stat_t);if !ok||stat.Mode&syscall.S_IFMT!=syscall.S_IFREG||stat.Uid!=0||stat.Nlink!=1||stat.Mode&0022!=0{return errDomainWorker}
  if generation==3&&tid!=root&&c.LabScenario=="unexpected-exec"&&hashNodeSHA(exe,c.NodeSHA256)==nil{p:=mustOpenProc(tid,"cmdline");if p==nil{return errDomainWorker};b,e:=io.ReadAll(io.LimitReader(p,16385));_ = p.Close();if e!=nil{return errDomainWorker};if string(b)==c.Node+"\x00unexpected\x00"{c.registry.setRejectedExec();return errDomainWorker}}
  var want,role string;var argv []string
  switch {case generation==1&&tid==root: want=c.NodeSHA256;argv=c.GatewayArgv;role="gateway"
  case generation>1&&tid==root:return errDomainWorker
  case generation==2&&tid!=root: if hashNodeSHA(exe,c.NodeSHA256)==nil{want=c.NodeSHA256;argv=c.BrokerArgv;role="broker"}else{want=c.ProviderSHA256;argv=[]string{c.Provider};role="provider"}
  case generation==3&&tid!=root:want=c.ProviderSHA256;argv=[]string{c.Provider};role="provider"
  default:return errDomainWorker}
  if hashNodeSHA(exe,want)!=nil{return errDomainWorker}
  proc:=mustOpenProc(tid,"cmdline");if proc==nil{return errDomainWorker};b,e:=io.ReadAll(io.LimitReader(proc,16385));_ = proc.Close();if e!=nil||len(b)==0||len(b)>16384||b[len(b)-1]!=0{return errDomainWorker}
  fields:=strings.Split(string(b[:len(b)-1]),"\x00");if len(fields)!=len(argv){return errDomainWorker};for i:=range argv{if fields[i]!=argv[i]{return errDomainWorker}}
  tgid,e:=getTaskTGID(tid);if e!=nil{return errDomainWorker};return c.registry.record(tgid,role)
 }
 tracker,e:=admission.NewGuardedTraceTracker(ctx,pid,guard);if e!=nil{_ = syscall.Kill(pid,syscall.SIGKILL);var ws syscall.WaitStatus;_,_=syscall.Wait4(pid,&ws,0,nil);return bad()}
 fail:=func()(*admission.TraceTracker,int,error){tracker.Close();return nil,0,errDomainWorker}
 if e=writeAll(argsW,packet);e!=nil{return fail()};if e=argsW.Close();e!=nil{return fail()}
 if e=writeAll(gateW,[]byte{0xa5});e!=nil{return fail()};if e=gateW.Close();e!=nil{return fail()}
 return tracker,pid,nil
}
func getTaskTGID(tid int)(int,error){f:=mustOpenProc(tid,"status");if f==nil{return 0,errDomainWorker};defer f.Close();b,e:=io.ReadAll(io.LimitReader(f,1<<20));if e!=nil{return 0,e};for _,line:=range strings.Split(string(b),"\n"){if strings.HasPrefix(line,"Tgid:"){n,e:=strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line,"Tgid:")));if e==nil&&n>0{return n,nil};return 0,errDomainWorker}};return 0,errDomainWorker}
func mustOpenProc(pid int,name string)*os.File{f,e:=os.Open("/proc/"+strconv.Itoa(pid)+"/"+name);if e!=nil{return nil};return f}
func hashNodeSHA(f *os.File,want string)error{if f==nil{return errDomainWorker};if _,e:=f.Seek(0,io.SeekStart);e!=nil{return e};h:=sha256.New();n,e:=io.Copy(h,io.LimitReader(f,64<<20+1));if e!=nil||n>64<<20||hex.EncodeToString(h.Sum(nil))!=want{return errDomainWorker};return nil}
func writeAll(w io.Writer,b []byte)error{for len(b)>0{n,e:=w.Write(b);if e!=nil||n==0{return errDomainWorker};b=b[n:]};return nil}
func encodeLaunchPacket(args []string,config,socket string)([]byte,error){
 bad:=func()([]byte,error){return nil,errDomainWorker};if len(args)==0||len(args)>16||len(config)==0||len(socket)==0{return bad()}
 var argvBytes int;for _,s:=range args{if len(s)==0||len(s)>1024||strings.IndexByte(s,0)>=0||!utf8.ValidString(s){return bad()};argvBytes+=len(s)+1};if argvBytes>3072{return bad()}
 env:=[]string{"OPENCLAW_CONFIG_PATH="+config,"CLAWWRIGHT_NATIVE_SOCKET="+socket};envBytes:=0;for _,s:=range env{v:=strings.SplitN(s,"=",2)[1];if len(v)==0||len(v)>768||strings.IndexByte(v,0)>=0||!utf8.ValidString(s){return bad()};envBytes+=len(s)+1};if envBytes>1024{return bad()}
 var b bytes.Buffer;b.WriteString("OCARGV01");_ = binary.Write(&b,binary.BigEndian,uint32(len(args)));put:=func(s string){_ = binary.Write(&b,binary.BigEndian,uint32(len(s)));b.WriteString(s)};for _,s:=range args{put(s)};_ = binary.Write(&b,binary.BigEndian,uint32(len(env)));for _,s:=range env{put(s)};if b.Len()>4096{return bad()};return b.Bytes(),nil
}
func openPinnedExec(path,want string)(*os.File,error){f,e:=os.Open(path);if e!=nil{return nil,e};s,e:=f.Stat();if e!=nil{f.Close();return nil,errDomainWorker};st,ok:=s.Sys().(*syscall.Stat_t);if !ok||st.Mode&syscall.S_IFMT!=syscall.S_IFREG||st.Uid!=0||st.Nlink!=1||st.Mode&022!=0||st.Mode&0111==0{f.Close();return nil,errDomainWorker};if e=hashNodeSHA(f,want);e!=nil{f.Close();return nil,errDomainWorker};if _,e=f.Seek(0,io.SeekStart);e!=nil{f.Close();return nil,errDomainWorker};return f,nil}
var _=admission.NewGuardedTraceTracker
