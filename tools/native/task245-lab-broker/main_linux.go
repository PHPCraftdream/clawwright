//go:build linux && amd64

// Disposable, root-only native lab broker; deliberately not wired into production startup.
package main

import (
 "context"
 "encoding/json"
 "errors"
 "io"
 "os"
 "os/signal"
 "path/filepath"
 "strings"
 "sync"
 "syscall"
 "time"
 "unsafe"
)

const brokerSocket = "/run/task245-lab/broker.sock"
const brokerLifetimeLimit = 128
var brokerErr = errors.New("lab broker rejected operation")
type brokerConfig struct {
 RuntimeUID uint32 `json:"RuntimeUID"`; RuntimeGID uint32 `json:"RuntimeGID"`
 Supervisor, SupervisorSHA256, Keeper, KeeperSHA256 string
 Init, InitSHA256, Root, Manifest, ManifestSHA256 string
 Node, Stub, Provider, ConfigPath string
 NodeSHA256, StubSHA256, ProviderSHA256 string
 GatewayArgv, BrokerArgv []string
 Target, Revision, Purpose, SelectedImage string
 CaptureEvidence string
 LabScenario string
}
type consumerKey struct { pid int; start string }
var consumers = struct { sync.Mutex; used map[consumerKey]struct{} }{used: make(map[consumerKey]struct{})}
func main() {
 if len(os.Args)!=2||os.Args[1]!="--disposable-lab" { os.Exit(1) }
 ctx,stop:=signal.NotifyContext(context.Background(),syscall.SIGINT,syscall.SIGTERM); defer stop()
 if serve(ctx)!=nil { os.Exit(1) }
}
func serve(ctx context.Context) error {
 if os.Geteuid()!=0{return brokerErr}
 marker,e:=os.Lstat("/lab/disposable-profile");if e!=nil||marker.Mode()&os.ModeSymlink!=0||!marker.Mode().IsRegular(){return brokerErr};ms,ok:=marker.Sys().(*syscall.Stat_t);if !ok||ms.Uid!=0||ms.Nlink!=1||ms.Mode&07777!=0444{return brokerErr}
 c,e:=loadBrokerConfig();if e!=nil{return e}
 if e=os.Mkdir("/run/task245-lab",0755);e!=nil{return e};d,e:=os.Lstat("/run/task245-lab");if e!=nil||!d.IsDir()||d.Mode()&os.ModeSymlink!=0{return brokerErr};ds,ok:=d.Sys().(*syscall.Stat_t);if !ok||ds.Uid!=0||ds.Mode&07777!=0755{return brokerErr}
 if _,e=os.Lstat(brokerSocket);e==nil||!os.IsNotExist(e){return brokerErr}
 fd,e:=syscall.Socket(syscall.AF_UNIX,syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC,0);if e!=nil{return e};defer syscall.Close(fd)
 stopClose:=context.AfterFunc(ctx,func(){_ = syscall.Close(fd)});defer stopClose()
 if e=syscall.Bind(fd,&syscall.SockaddrUnix{Name:brokerSocket});e!=nil{return e};defer syscall.Unlink(brokerSocket);if e=os.Chmod(brokerSocket,0666);e!=nil{return e};if e=syscall.Listen(fd,128);e!=nil{return e}
 sem:=make(chan struct{},4);var wg sync.WaitGroup
 for { select {case <-ctx.Done(): _=syscall.Close(fd);wg.Wait();return nil;case sem<-struct{}{}:}
  cfd,_,ae:=syscall.Accept4(fd,syscall.SOCK_CLOEXEC);if ae!=nil{<-sem;if ctx.Err()!=nil{wg.Wait();return nil};return ae};wg.Add(1);go func(){defer wg.Done();defer func(){<-sem}();handle(cfd,c)}()
 }
}
func handle(fd int,c brokerConfig){defer syscall.Close(fd);tv:=syscall.NsecToTimeval((5*time.Second).Nanoseconds());if syscall.SetsockoptTimeval(fd,syscall.SOL_SOCKET,syscall.SO_RCVTIMEO,&tv)!=nil{return};var u syscall.Ucred;n:=uint32(unsafe.Sizeof(u));_,_,errno:=syscall.Syscall6(syscall.SYS_GETSOCKOPT,uintptr(fd),syscall.SOL_SOCKET,syscall.SO_PEERCRED,uintptr(unsafe.Pointer(&u)),uintptr(unsafe.Pointer(&n)),0);if errno!=0||u.Uid==0||u.Uid!=c.RuntimeUID{return}
 start,e:=procStart245(int(u.Pid));if e!=nil||authenticateConsumer(int(u.Pid),c)!=nil{return}
 consumers.Lock();key:=consumerKey{int(u.Pid),start};if _,ok:=consumers.used[key];ok||len(consumers.used)>=brokerLifetimeLimit{consumers.Unlock();return};consumers.used[key]=struct{}{};consumers.Unlock()
 var req [9]byte;oob:=make([]byte,syscall.CmsgSpace(4));nr,on,flags,_,e:=syscall.Recvmsg(fd,req[:],oob,0);if e!=nil||nr!=8||flags&syscall.MSG_TRUNC!=0||on!=0||string(req[:8])!="OCLAB001"{return};_ = launchNative(fd,int(u.Pid),c)
}
func loadBrokerConfig()(brokerConfig,error){var c brokerConfig;f,e:=os.OpenFile("/etc/clawwright/native-lab.json",os.O_RDONLY|syscall.O_NOFOLLOW,0);if e!=nil{return c,e};defer f.Close();s,e:=f.Stat();if e!=nil||!s.Mode().IsRegular()||s.Size()>65536{return c,brokerErr};st,ok:=s.Sys().(*syscall.Stat_t);if !ok||st.Uid!=0||st.Nlink!=1||st.Mode&0022!=0{return c,brokerErr};for _,p:=range []string{"/etc","/etc/clawwright"}{x,e:=os.Lstat(p);if e!=nil||!x.IsDir()||x.Mode()&os.ModeSymlink!=0{return c,brokerErr};q,ok:=x.Sys().(*syscall.Stat_t);if !ok||q.Uid!=0||q.Mode&0022!=0{return c,brokerErr}};b,e:=io.ReadAll(io.LimitReader(f,65537));if e!=nil||len(b)>65536||duplicateJSON(b)!=nil{return c,brokerErr};d:=json.NewDecoder(strings.NewReader(string(b)));d.DisallowUnknownFields();if d.Decode(&c)!=nil||d.Decode(new(any))!=io.EOF{return c,brokerErr};if c.RuntimeUID==0||c.RuntimeGID==0||c.SelectedImage==""{return c,brokerErr};for _,h:=range []string{c.SupervisorSHA256,c.KeeperSHA256,c.InitSHA256,c.ManifestSHA256,c.NodeSHA256,c.StubSHA256,c.ProviderSHA256}{if len(h)!=64||strings.Trim(h,"0123456789abcdef")!=""{return c,brokerErr}};for _,p:=range []string{c.Supervisor,c.Keeper,c.Init,c.Root,c.Manifest,c.Node,c.Stub,c.Provider,c.ConfigPath}{if !filepath.IsAbs(p)||filepath.Clean(p)!=p{return c,brokerErr}};return c,nil}
func duplicateJSON(b []byte)error{d:=json.NewDecoder(strings.NewReader(string(b)));d.UseNumber();nodes:=0;var value func(int)error;value=func(depth int)error{nodes++;if depth>32||nodes>8192{return brokerErr};t,e:=d.Token();if e!=nil{return e};del,ok:=t.(json.Delim);if !ok{return nil};switch del{case '{':seen:=map[string]bool{};for d.More(){k,e:=d.Token();if e!=nil{return e};s,ok:=k.(string);if !ok||seen[s]{return brokerErr};seen[s]=true;if e=value(depth+1);e!=nil{return e}};_,e=d.Token();return e;case '[':for d.More(){if e=value(depth+1);e!=nil{return e}};_,e=d.Token();return e};return brokerErr};if e:=value(0);e!=nil{return e};if _,e:=d.Token();e!=io.EOF{return brokerErr};return nil}
