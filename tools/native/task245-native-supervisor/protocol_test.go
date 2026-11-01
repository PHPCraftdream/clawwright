//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func kernelFailure245(output []byte) string {
 for _, fault := range []struct{code, label string}{{"10","fixture_case_open"},{"11","fixture_case_invalid"},{"20","fixture_socket"},{"21","fixture_connect"},{"22","fixture_metadata"},{"23","fixture_admission"},{"24","fixture_admission_magic"},{"25","fixture_payload_length"},{"26","fixture_mutation"},{"27","fixture_payload_read"},{"30","fixture_broker_socket"},{"31","fixture_broker_fork"},{"32","fixture_broker_dup"},{"33","fixture_provider_exec"},{"34","fixture_stdin"},{"35","fixture_transfer"},{"40","fixture_gateway_socket"},{"41","fixture_gateway_fork"},{"42","fixture_gateway_dup"},{"43","fixture_gateway_flags"},{"44","fixture_broker_exec"},{"45","fixture_gateway_recv"},{"46","fixture_gateway_rights"}} {
  if bytes.Contains(output, []byte("release-fixture: code="+fault.code+"\n")) { return fault.label }
 }
 for _, reason := range []string{"private mount", "chroot", "proc mount", "read executable", "gateway start", "provider accept before gateway exec", "provider accept before broker exec", "provider accept after provider exec", "provider accept after broker exec", "provider accept", "ready handshake", "mutation marker absent", "admission timeout", "negative scenario timed out", "valid holder rejected", "between-write rejection or context failure", "actual send backpressure not observed", "worker failed"} {
  if bytes.Contains(output, []byte(": "+reason+"\n")) { return strings.ReplaceAll(reason," ","_") }
 }
 return "unclassified"
}

func providerAcceptFailure245(r *execRegistry245) string {
 r.mu.Lock(); defer r.mu.Unlock()
 gateway, broker, provider := false, false, false
 for _, role := range r.roles { gateway = gateway || role=="gateway"; broker = broker || role=="broker"; provider = provider || role=="provider" }
 if !gateway { return "provider accept before gateway exec" }
 if !broker { return "provider accept before broker exec" }
 if provider { return "provider accept after provider exec" }
 return "provider accept after broker exec"
}

func TestConnectedReleaseKernel(t *testing.T) {
 if os.Getenv("TASK245_KERNEL")!="1" { t.Fatal("TASK245_KERNEL=1 required") }; if os.Geteuid()!=0 { t.Fatal("root required") }
 fixture,stub:=os.Getenv("TASK245_RELEASE_FIXTURE"),os.Getenv("TASK240_STUB"); if fixture==""||stub=="" { t.Fatal("kernel fixture and stub required") }
 for _,name:=range []string{"positive","backpressure","wrong-holder","partial-ack","lost-ack","cancel","unexpected-exec","between-write-holder"} { t.Run(name,func(t *testing.T){ root,e:=os.MkdirTemp("/lab","release-root-");if e!=nil{t.Fatal(e)};defer os.RemoveAll(root)
  for _,d:=range []string{"etc","proc","run","usr/bin","usr/libexec"}{if e=os.MkdirAll(filepath.Join(root,d),0755);e!=nil{t.Fatal(e)}}
  copy:=func(src,dst string,mode os.FileMode){b,x:=os.ReadFile(src);if x!=nil{t.Fatal(x)};if strings.HasSuffix(dst,"release-provider"){b=append(b,0)};if x=os.WriteFile(dst,b,mode);x!=nil{t.Fatal(x)}}
  node:=filepath.Join(root,"usr/bin/node");provider:=filepath.Join(root,"usr/libexec/release-provider");copy(fixture,node,0555);copy(fixture,provider,0555);copy(stub,filepath.Join(root,"usr/libexec/stub"),0555);copy(os.Args[0],filepath.Join(root,"release-test"),0555);if e=os.WriteFile(filepath.Join(root,"etc/release-case"),[]byte(name+"\n"),0444);e!=nil{t.Fatal(e)}
  ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second);defer cancel();cmd:=exec.CommandContext(ctx,filepath.Join(root,"release-test"),"-test.run=^TestReleaseNamespaceHelper$");cmd.Env=[]string{"TASK245_HELPER=init","TASK245_ROOT="+root,"TASK245_CASE="+name};cmd.SysProcAttr=&syscall.SysProcAttr{Cloneflags:syscall.CLONE_NEWPID|syscall.CLONE_NEWNS|syscall.CLONE_NEWNET};out,e:=cmd.CombinedOutput();if e!=nil{t.Fatalf("namespace helper failed diagnostic=%s (output length %d)",kernelFailure245(out),len(out))}
 }) }
}

func TestReleaseNamespaceHelper(t *testing.T) {
 role:=os.Getenv("TASK245_HELPER");if role==""{return};if role=="init" {if os.Getpid()!=1{t.Fatalf("init pid = %d, want 1",os.Getpid())};root:=os.Getenv("TASK245_ROOT");if syscall.Mount("","/","",syscall.MS_PRIVATE|syscall.MS_REC,"")!=nil{t.Fatal("private mount")};if syscall.Chroot(root)!=nil||os.Chdir("/")!=nil{t.Fatal("chroot")};if syscall.Mount("proc","/proc","proc",syscall.MS_NOSUID|syscall.MS_NOEXEC|syscall.MS_NODEV,"")!=nil{t.Fatal("proc mount")};c,x:=context.WithTimeout(context.Background(),30*time.Second);defer x();cmd:=exec.CommandContext(c,"/release-test","-test.run=^TestReleaseNamespaceHelper$");cmd.Env=[]string{"TASK245_HELPER=worker","TASK245_CASE="+os.Getenv("TASK245_CASE")};cmd.Stdin=os.Stdin;cmd.Stdout=os.Stdout;cmd.Stderr=os.Stderr;if e:=cmd.Run();e!=nil{t.Fatal("worker failed")};return };if role!="worker"{t.Fatal("bad helper role")};if os.Getpid()<=1||os.Getppid()!=1{t.Fatal("worker ancestry rejected")}
 ctx,cancel:=context.WithTimeout(context.Background(),10*time.Second);defer cancel();node,provider,stub:="/usr/bin/node","/usr/libexec/release-provider","/usr/libexec/stub";hash:=func(p string)string{b,e:=os.ReadFile(p);if e!=nil{t.Fatal("read executable")};s:=sha256.Sum256(b);return hex.EncodeToString(s[:])};const sock="/run/clawwright-native.sock"
 l,e:=net.ListenUnix("unix",&net.UnixAddr{Name:sock,Net:"unix"});if e!=nil{t.Fatal("listen")};defer l.Close();if e=l.SetDeadline(time.Now().Add(10*time.Second));e!=nil{t.Fatal("listener deadline")};wc:=workerConfig{Node:node,Stub:stub,Provider:provider,ConfigPath:"/etc/release-case",SocketPath:sock,GatewayArgv:[]string{node,"gateway"},BrokerArgv:[]string{node,"broker"},NodeSHA256:hash(node),StubSHA256:hash(stub),ProviderSHA256:hash(provider),Target:"target",Revision:"revision",Purpose:"release",registry:&execRegistry245{roles:map[int]string{}}};tracker,pid,e:=startGateway(ctx,wc);if e!=nil{t.Fatal("gateway start")};defer tracker.Close();conn,e:=l.AcceptUnix();if e!=nil{t.Fatal(providerAcceptFailure245(wc.registry))};defer conn.Close();raw,rawErr:=conn.SyscallConn();if rawErr!=nil{t.Fatal("provider socket control")};var cred *syscall.Ucred;var ce error;if rawErr=raw.Control(func(fd uintptr){cred,ce=syscall.GetsockoptUcred(int(fd),syscall.SOL_SOCKET,syscall.SO_PEERCRED)});rawErr!=nil||ce!=nil||cred==nil{t.Fatal("peer credentials")}
 fds,e:=syscall.Socketpair(syscall.AF_UNIX,syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC,0);if e!=nil{t.Fatal("socketpair")};if e=syscall.SetNonblock(fds[0],true);e!=nil{t.Fatal("nonblock control")};if e=syscall.SetNonblock(fds[1],true);e!=nil{t.Fatal("nonblock relay")};c:=os.NewFile(uintptr(fds[0]),"control");r:=os.NewFile(uintptr(fds[1]),"relay");defer c.Close();defer r.Close();if e=c.SetDeadline(time.Now().Add(10*time.Second));e!=nil{t.Fatal("control deadline")};if e=r.SetDeadline(time.Now().Add(10*time.Second));e!=nil{t.Fatal("relay deadline")};var h [64]byte;copy(h[:8],"SSINK001");copy(h[8:24],[]byte("0123456789abcdef"));copy(h[24:56],[]byte(strings.Repeat("b",32)));binary.BigEndian.PutUint64(h[56:],8192);scenario:=os.Getenv("TASK245_CASE")
done:=make(chan error,1)
backpressureCount:=0
var schedule *sendSchedule245
if scenario=="between-write-holder" {schedule=&sendSchedule245{afterSend:func(off int)error{if off<4096{return errSupervisor};marker:="/run/release-mutated-after";if off==4096{marker="/run/release-mutated-after"}else if off>4096{marker="/run/release-extra"};for{if _,x:=os.Stat(marker);x==nil{return nil};select{case <-ctx.Done():return ctx.Err();case <-time.After(time.Millisecond):}}}}}
if scenario=="backpressure" { var se error;if x:=raw.Control(func(fd uintptr){se=syscall.SetsockoptInt(int(fd),syscall.SOL_SOCKET,syscall.SO_SNDBUF,1024)});x!=nil||se!=nil{t.Fatal("send buffer")};schedule=&sendSchedule245{backpressure:func()error{backpressureCount++;return os.WriteFile("/run/release-drain",[]byte("D"),0600)}} }
go func(){done<-serveAdmitted245(ctx,c,conn,tracker,pid,int(cred.Pid),wc.registry.brokerIDs(),h,"target","revision","release","",schedule)}()
var ready [160]byte;if n,x:=r.Read(ready[:]);x!=nil||n!=160||string(ready[:8])!="SSRDY001"||string(ready[8:64])!=string(h[8:]){t.Fatal("ready handshake")};marker:="/run/release-mutated";deadline:=time.Now().Add(8*time.Second);mutated:=false;for time.Now().Before(deadline){if _,e=os.Stat(marker);e==nil{mutated=true;break};select{case <-ctx.Done():t.Fatal("helper timeout");case <-time.After(20*time.Millisecond):}};if !mutated{t.Fatal("mutation marker absent")}
 if scenario=="unexpected-exec" { deadline:=time.Now().Add(5*time.Second);for time.Now().Before(deadline){if syscall.Kill(int(pid),0)==syscall.ESRCH{break};select{case <-ctx.Done():t.Fatal("helper timeout");case <-time.After(20*time.Millisecond):}};if syscall.Kill(int(pid),0)!=syscall.ESRCH{t.Fatal("unexpected exec was not killed")};_ = r.Close() } else if scenario=="cancel" { cancel(); _=r.Close() } else { n,x:=r.Write(bytes.Repeat([]byte{'x'},8192));if x!=nil||n!=8192{t.Fatal("payload")} }
 if scenario=="cancel"||scenario=="unexpected-exec" { select { case e=<-done: case <-time.After(2*time.Second): t.Fatal("admission did not finish") } } else { select { case e=<-done: case <-ctx.Done(): t.Fatal("admission timeout") } }
 received:="/run/release-received"
 if scenario=="between-write-holder" { for _,p:=range []string{"/run/release-mutated-after","/run/release-received"}{if _,x:=os.Stat(p);x!=nil{t.Fatal("between-write marker absent")}};if e==nil||ctx.Err()!=nil{t.Fatal("between-write rejection or context failure")};var ack [97]byte;rn,_,_,_,re:=syscall.Recvmsg(fds[1],ack[:],nil,syscall.MSG_DONTWAIT);if rn>0||re!=syscall.EAGAIN&&re!=syscall.EWOULDBLOCK{t.Fatal("unexpected ACK")};if _,x:=os.Stat("/run/release-extra");!os.IsNotExist(x){t.Fatal("extra data received")} ;return }
 if scenario!="positive"&&scenario!="backpressure" {
  if e==nil { t.Fatal("negative scenario returned success") }
  if scenario!="cancel"&&ctx.Err()!=nil { t.Fatal("negative scenario timed out") }
  _,statErr:=os.Stat(received)
  if scenario=="wrong-holder"||scenario=="cancel"||scenario=="unexpected-exec" { if !os.IsNotExist(statErr) { t.Fatal("unexpected received marker") } } else if statErr!=nil { t.Fatal("received marker absent") }
  if scenario!="cancel"&&scenario!="unexpected-exec" { var extra [97]byte;rn,_,_,_,re:=syscall.Recvmsg(fds[1],extra[:],nil,syscall.MSG_DONTWAIT);if rn>0||re!=syscall.EAGAIN&&re!=syscall.EWOULDBLOCK { t.Fatal("unexpected ACK") } }
  return
 }
 if e!=nil { t.Fatal("valid holder rejected") }
 if scenario=="backpressure"&&backpressureCount<1 { t.Fatal("actual send backpressure not observed") }
 var ack [96]byte
 if n,x:=r.Read(ack[:]);x!=nil||n!=96||string(ack[:8])!="SSACK001"||string(ack[8:64])!=string(h[8:]) { t.Fatal("ack mismatch") }
 sum:=sha256.Sum256(bytes.Repeat([]byte{'x'},8192));if string(ack[64:])!=string(sum[:]) { t.Fatal("ack digest mismatch") }
 if _,e=os.Stat(received);e!=nil { t.Fatal("received marker absent") }

}

func TestEncodeLaunchPacketHasFixedBigEndianLength(t *testing.T) {
	got, err := encodeLaunchPacket([]string{"serve", "--safe"}, "/etc/native/config", "/run/native.sock")
	if err != nil { t.Fatal("encodeLaunchPacket rejected valid fields") }
	if len(got) > 4096 { t.Fatalf("packet length = %d, exceeds 4096", len(got)) }
	r := bytes.NewReader(got); magic := make([]byte, 8)
	if _, err := io.ReadFull(r, magic); err != nil || string(magic) != "OCARGV01" { t.Fatalf("magic = %q, err = %v", magic, err) }
	var argc uint32
	if err := binary.Read(r, binary.BigEndian, &argc); err != nil || argc != 2 { t.Fatalf("argc = %d, err = %v", argc, err) }
	readString := func() string { t.Helper(); var n uint32; if err := binary.Read(r, binary.BigEndian, &n); err != nil { t.Fatal(err) }; b := make([]byte, n); if _, err := io.ReadFull(r, b); err != nil { t.Fatal(err) }; return string(b) }
	for i, want := range []string{"serve", "--safe"} { if s := readString(); s != want { t.Errorf("argv[%d] = %q, want %q", i, s, want) } }
	var envc uint32
	if err := binary.Read(r, binary.BigEndian, &envc); err != nil || envc != 2 { t.Fatalf("envc = %d, err = %v", envc, err) }
	for i, want := range []string{"OPENCLAW_CONFIG_PATH=/etc/native/config", "CLAWWRIGHT_NATIVE_SOCKET=/run/native.sock"} { if s := readString(); s != want { t.Errorf("env[%d] = %q, want %q", i, s, want) } }
	if r.Len() != 0 { t.Fatalf("%d trailing bytes", r.Len()) }
}

func TestEncodeLaunchPacketRejectsInvalidFields(t *testing.T) {
	cases := []struct{name string; args []string; cfg, sock string}{
		{"no argv", nil, "config", "socket"}, {"nul argv", []string{"bad\x00value"}, "config", "socket"}, {"oversized argv", []string{strings.Repeat("x", 4097)}, "config", "socket"},
		{"nul config", []string{"ok"}, "bad\x00value", "socket"}, {"oversized config", []string{"ok"}, strings.Repeat("x", 4097), "socket"}, {"nul socket", []string{"ok"}, "config", "bad\x00value"}, {"oversized socket", []string{"ok"}, "config", strings.Repeat("x", 4097)},
	}
	for _, tc := range cases { t.Run(tc.name, func(t *testing.T) { if _, err := encodeLaunchPacket(tc.args, tc.cfg, tc.sock); err == nil { t.Fatal("invalid packet fields were accepted") } }) }
}

func TestParseKeeperConfigRejectsDuplicateKeys(t *testing.T) {
	var cfg keeperConfig
	if err := parseKeeperConfig([]byte(`{"keeperSHA256":"`+strings.Repeat("a", 64)+`","keeperSHA256":"`+strings.Repeat("b", 64)+`"}`), &cfg); err == nil { t.Fatal("duplicate keeperSHA256 was accepted") }
}

func TestParseKeeperConfigRejectsEscapedDuplicateKey(t *testing.T) {
	var cfg keeperConfig
	if err := parseKeeperConfig([]byte(`{"keeperSHA256":"`+strings.Repeat("a", 64)+`","keeper\u0053HA256":"`+strings.Repeat("b", 64)+`"}`), &cfg); err == nil { t.Fatal("escaped duplicate keeperSHA256 was accepted") }
}
