//go:build linux && amd64

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
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

func TestStartupDiagnostics(t *testing.T) {
	var output bytes.Buffer
	writeStartupDiagnostic(&output, "invalid", syscall.EACCES)
	if output.Len() != 0 {
		t.Fatal("invalid startup stage emitted a diagnostic")
	}
	writeStartupDiagnostic(&output, "node", errors.Join(errors.New("wrapped"), syscall.EACCES))
	if got, want := output.String(), "task245-worker: startup=node errno=13\n"; got != want {
		t.Fatalf("diagnostic = %q, want %q", got, want)
	}
}

func TestStartGatewayDiagnosticsFailures(t *testing.T) {
	for _, tc := range []struct {
		name, stage string
		ctx func() (context.Context, context.CancelFunc)
		config func(*testing.T) workerConfig
		want string
	}{
		{
			name: "missing node", stage: "node",
			ctx: func() (context.Context, context.CancelFunc) { return context.WithTimeout(context.Background(), time.Second) },
			config: func(t *testing.T) workerConfig {
				return workerConfig{Node: filepath.Join(t.TempDir(), "missing-node")}
			},
			want: "task245-worker: startup=node errno=2\n",
		},
		{
			name: "canceled context", stage: "context",
			ctx: func() (context.Context, context.CancelFunc) { ctx, cancel := context.WithCancel(context.Background()); cancel(); return ctx, cancel },
			config: func(*testing.T) workerConfig { return workerConfig{} },
			want: "task245-worker: startup=context errno=0\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			ctx, cancel := tc.ctx()
			defer cancel()
			_, pid, err := startGatewayDiagnostics(ctx, tc.config(t), &output)
			if pid != 0 || !errors.Is(err, errDomainWorker) {
				t.Fatalf("startGatewayDiagnostics returned pid=%d err=%v", pid, err)
			}
			if got := output.String(); got != tc.want {
				t.Fatalf("diagnostic = %q, want %q", got, tc.want)
			}
		})
	}
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

func TestLabServicePeerKernel(t *testing.T) {
	if os.Getenv("TASK245_SERVICE_PEER") != "1" { return }
	if os.Geteuid() != 65534 { t.Fatal("service peer uid") }
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	fd, err := connectLabBroker(ctx, os.Getenv("TASK245_BROKER_HASH"))
	if err != nil { t.Fatal("service peer rejected") }
	defer syscall.Close(fd)
	if _, err = syscall.SendmsgN(fd, []byte("OCLAB001"), nil, nil, syscall.MSG_NOSIGNAL); err != nil && err != syscall.EPIPE && err != syscall.ECONNRESET { t.Fatal("wrong caller send") }
	var payload [9]byte; rights := make([]byte, syscall.CmsgSpace(4))
	n, on, flags, _, err := syscall.Recvmsg(fd, payload[:], rights, 0)
	if n > 0 || on > 0 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || err == nil && (n != 0 || on != 0) || err != nil && err != syscall.ECONNRESET { t.Fatal("wrong caller obtained handoff") }
}

func TestParseServiceProof245(t *testing.T) {
	hash := strings.Repeat("a", 64)
	canonical := "OCLABAUTH1 123 456 7 8 9 10 " + hash + "\n"
	pid, start, exeDev, exeIno, sockDev, sockIno, gotHash, ok := parseServiceProof245(canonical)
	if !ok {
		t.Fatal("canonical proof rejected")
	}
	if pid != 123 || start != "456" || exeDev != 7 || exeIno != 8 || sockDev != 9 || sockIno != 10 || gotHash != hash {
		t.Fatalf("parsed values = (%d, %q, %d, %d, %d, %d, %q)", pid, start, exeDev, exeIno, sockDev, sockIno, gotHash)
	}
	_, _, exeDev, _, _, _, _, ok = parseServiceProof245(strings.Replace(canonical, " 7 8 ", " 0 8 ", 1))
	if !ok || exeDev != 0 {
		t.Fatalf("zero executable device rejected or parsed as %d", exeDev)
	}

	cases := []struct {
		name string
		line string
	}{
		{"wrong prefix", strings.Replace(canonical, "OCLABAUTH1", "OCLABAUTH0", 1)},
		{"missing field", "OCLABAUTH1 123 456 7 8 9 " + hash + "\n"},
		{"extra field", strings.TrimSuffix(canonical, "\n") + " extra\n"},
		{"leading zero pid", strings.Replace(canonical, " 123 ", " 0123 ", 1)},
		{"signed pid", strings.Replace(canonical, " 123 ", " +123 ", 1)},
		{"zero pid", strings.Replace(canonical, " 123 ", " 0 ", 1)},
		{"zero start", strings.Replace(canonical, " 456 ", " 0 ", 1)},
		{"zero exe inode", strings.Replace(canonical, " 7 8 ", " 7 0 ", 1)},
		{"zero socket inode", strings.Replace(canonical, " 9 10 ", " 9 0 ", 1)},
		{"invalid hash", strings.TrimSuffix(canonical, hash+"\n") + strings.Repeat("g", 64) + "\n"},
		{"uppercase hash", strings.TrimSuffix(canonical, hash+"\n") + strings.Repeat("A", 64) + "\n"},
		{"extra newline", canonical + "\n"},
		{"embedded nul", strings.Replace(canonical, " 456 ", "\x00456 ", 1)},
		{"oversize", strings.Repeat("x", 513)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, _, _, _, _, _, ok := parseServiceProof245(tc.line); ok {
				t.Fatal("invalid proof accepted")
			}
		})
	}
}

func TestKeeperInheritedPipes(t *testing.T) {
	if os.Getenv("TASK245_PIPE_HELPER") == "1" { os.Exit(keeperPipeHelper245()) }
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	input, writer, err := os.Pipe()
	if err != nil { t.Fatal("input pipe") }
	defer input.Close(); defer writer.Close()
	reader, output, err := os.Pipe()
	if err != nil { t.Fatal("output pipe") }
	defer reader.Close(); defer output.Close()
	if reader.SetReadDeadline(time.Now().Add(8*time.Second)) != nil { t.Fatal("parent deadline") }
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestKeeperInheritedPipes$")
	cmd.Env = []string{"TASK245_PIPE_HELPER=1"}
	cmd.Stdin, cmd.Stdout = input, output
	if cmd.Start() != nil { t.Fatal("pipe helper start") }
	defer func() { if cmd.ProcessState == nil { _ = cmd.Process.Kill(); _ = cmd.Wait() } }()
	input.Close(); output.Close()
	var record [8]byte
	if _, err = io.ReadFull(reader, record[:]); err != nil || string(record[:]) != "KREADY01" { t.Fatal("pollable pipe readiness") }
	if _, err = writer.Write([]byte("KINPUT01")); err != nil { t.Fatal("pipe input") }
	writer.Close()
	if _, err = io.ReadFull(reader, record[:]); err != nil || string(record[:]) != "KACK0001" { t.Fatal("pipe acknowledgement") }
	if n, err := reader.Read(record[:1]); n != 0 || err != io.EOF { t.Fatal("pipe output EOF") }
	if cmd.Wait() != nil { t.Fatal("pipe helper exit") }
}

func keeperPipeHelper245() int {
	if os.Stdin.SetReadDeadline(time.Now().Add(time.Second)) == nil || os.Stdout.SetWriteDeadline(time.Now().Add(time.Second)) == nil { return 10 }
	in, err := pollableKeeperPipe(0)
	if err != nil { return 11 }
	defer in.Close()
	out, err := pollableKeeperPipe(1)
	if err != nil { return 12 }
	defer out.Close()
	for i, f := range []*os.File{in, out} {
		var original, duplicate syscall.Stat_t
		if syscall.Fstat(i, &original) != nil || syscall.Fstat(int(f.Fd()), &duplicate) != nil || original.Dev != duplicate.Dev || original.Ino != duplicate.Ino { return 13 }
	}
	if in.SetReadDeadline(time.Now().Add(30*time.Millisecond)) != nil || out.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil { return 14 }
	var b [8]byte
	if n, err := in.Read(b[:]); n != 0 || !errors.Is(err, os.ErrDeadlineExceeded) { return 15 }
	if in.SetReadDeadline(time.Now().Add(5*time.Second)) != nil { return 16 }
	if _, err := out.Write([]byte("KREADY01")); err != nil { return 17 }
	if _, err := io.ReadFull(in, b[:]); err != nil || string(b[:]) != "KINPUT01" { return 18 }
	if n, err := in.Read(b[:1]); n != 0 || err != io.EOF { return 19 }
	if _, err := out.Write([]byte("KACK0001")); err != nil { return 20 }
	return 0
}

func TestParseKeeperConfigRejectsDuplicateKeys(t *testing.T) {
	var cfg keeperConfig
	if err := parseKeeperConfig([]byte(`{"keeperSHA256":"`+strings.Repeat("a", 64)+`","keeperSHA256":"`+strings.Repeat("b", 64)+`"}`), &cfg); err == nil { t.Fatal("duplicate keeperSHA256 was accepted") }
}

func TestParseKeeperConfigRejectsEscapedDuplicateKey(t *testing.T) {
	var cfg keeperConfig
	if err := parseKeeperConfig([]byte(`{"keeperSHA256":"`+strings.Repeat("a", 64)+`","keeper\u0053HA256":"`+strings.Repeat("b", 64)+`"}`), &cfg); err == nil { t.Fatal("escaped duplicate keeperSHA256 was accepted") }
}

	// Dispatch the sealed test image before the Go test runner starts.
func init() {
	if len(os.Args) == 2 && os.Args[0] == "native-supervisor" && os.Args[1] == "--task245-domain-worker" {
		os.Exit(domainWorkerProbe245())
	}
	if len(os.Args) == 2 && os.Args[1] == "--task245-bootstrap-target" {
		for {
			time.Sleep(time.Hour)
		}
	}
}

func domainWorkerProbe245() int {
	if os.Getpid() != 2 || os.Getppid() != 1 || os.Getuid() != 65534 || os.Geteuid() != 65534 || os.Getgid() != 65533 || os.Getegid() != 65533 {
		return 31
	}
	groups, err := os.Getgroups()
	if err != nil || len(groups) != 0 {
		return 32
	}
	got, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, 39, 0, 0, 0, 0, 0)
	if errno != 0 || got != 1 {
		return 34
	}
	for _, fd := range []int{3, 6} {
		seals, _, er := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), 1034, 0)
		if er != 0 || seals&15 != 15 {
			return 35
		}
	}
	var a, b syscall.Stat_t
	if syscall.Fstat(3, &a) != nil || syscall.Stat("/proc/self/exe", &b) != nil || a.Dev != b.Dev || a.Ino != b.Ino {
		return 36
	}
	var metadata syscall.Stat_t
	startupProbe := syscall.Fstat(6, &metadata) == nil && metadata.Size == 25
	bootstrapProbe := syscall.Fstat(6, &metadata) == nil && metadata.Size == 26
	retainedMetadata := syscall.Fstat(6, &metadata) == nil && metadata.Size == 27
	if retainedMetadata {
		var expected [24]byte
		if n, e := syscall.Pread(6, expected[:], 0); e != nil || n != len(expected) || !domainNamespacesMatch245(expected) {
			return 42
		}
	} else if !domainFreshNamespaces245() {
		return 40
	}
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil || !bytes.Contains(data, []byte(" - proc proc ")) || !bytes.Contains(data, []byte(" - tmpfs tmpfs ")) || !workerMountsOK() {
		return 37
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 6 && fields[4] == "/proc" {
			for _, opt := range []string{"ro", "nosuid", "nodev", "noexec"} {
				if !hasOpt(fields[5], opt) {
					return 41
				}
			}
		}
	}
	if startupProbe {
		return startupControlProbe245()
	}
	if bootstrapProbe || retainedMetadata {
		return bootstrapTrackerProbe245(retainedMetadata)
	}
	if _, err = syscall.Write(4, []byte("domain-worker-ready")); err != nil {
		return 38
	}
	var one [1]byte
	if _, err = syscall.Read(4, one[:]); err != nil {
		return 39
	}
	return 0
}

func memfdDomain245(t *testing.T, name string, data []byte, mode uint32, seal bool) *os.File {
	t.Helper()
	p, _ := syscall.BytePtrFromString(name)
	fd, _, errno := syscall.Syscall(319, uintptr(unsafe.Pointer(p)), 3, 0)
	if errno != 0 {
		t.Fatalf("memfd_create: %v", errno)
	}
	f := os.NewFile(fd, name)
	t.Cleanup(func() { _ = f.Close() })
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if err := f.Chmod(os.FileMode(mode)); err != nil {
		t.Fatal(err)
	}
	if seal {
		if _, _, errno = syscall.Syscall(syscall.SYS_FCNTL, fd, 1033, 15); errno != 0 {
			t.Fatalf("sealing: %v", errno)
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	return f
}

func domainFreshNamespaces245() bool {
	meta := os.NewFile(6, "namespace-metadata")
	if meta == nil {
		return false
	}
	var expected [24]byte
	_, err := io.ReadFull(meta, expected[:])
	_ = meta.Close()
	return err == nil && domainNamespacesMatch245(expected)
}

func domainNamespacesMatch245(expected [24]byte) bool {
	for i, name := range []string{"pid", "mnt", "net"} {
		var self, init syscall.Stat_t
		if syscall.Stat("/proc/self/ns/"+name, &self) != nil || syscall.Stat("/proc/1/ns/"+name, &init) != nil {
			return false
		}
		want := binary.BigEndian.Uint64(expected[i*8:])
		if self.Ino == want || self.Ino != init.Ino {
			return false
		}
	}
	return true
}

func TestDomainInitDiagnosticKernel(t *testing.T) {
	binaryPath := os.Getenv("TASK245_INIT")
	if binaryPath == "" {
		t.Fatal("TASK245_INIT required (native-supervisor workflow)")
	}
	if os.Geteuid() != 0 {
		t.Fatal("root required")
	}
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"invalid-id", []string{"0", "1"}, "task245-init: checkpoint=112 errno=0\n"},
		{"missing-image-fd", []string{"65534", "65533"}, "task245-init: checkpoint=112 errno=9\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, binaryPath, tc.args...)
			cmd.Env = []string{}
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err := cmd.Run()
			if ctx.Err() != nil {
				t.Fatal("diagnostic case timed out")
			}
			if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 112 {
				t.Fatal("diagnostic case did not exit 112")
			}
			got := stderr.String()
			if len(got) > 64 || got != tc.want {
				t.Fatal("unexpected bounded bootstrap diagnostic")
			}
		})
	}
}

func TestDomainInitKernel(t *testing.T) {
	binaryPath := os.Getenv("TASK245_INIT")
	if binaryPath == "" {
		t.Fatal("TASK245_INIT required (native-supervisor workflow)")
	}
	if os.Geteuid() != 0 {
		t.Fatal("root required")
	}
	t.Run("positive", func(t *testing.T) { runDomainInitLifecycle245(t, binaryPath, false) })
	t.Run("parent-death", func(t *testing.T) { runDomainInitLifecycle245(t, binaryPath, true) })
	t.Run("invalid-id", func(t *testing.T) { runDomainInitReject245(t, binaryPath, "0", "65533", true) })
	t.Run("unsealed-image", func(t *testing.T) { runDomainInitReject245(t, binaryPath, "65534", "65533", false) })
	for _, kind := range []string{"metadata-unsealed", "control-stream", "root-writable", "root-mode-writable", "image-mode"} {
		t.Run(kind, func(t *testing.T) { runDomainInitBadFD245(t, binaryPath, kind) })
	}
}

func domainFixture245(t *testing.T, sealImage bool) (string, *os.File, *os.File, *os.File, [2]int) {
	t.Helper()
	root, err := os.MkdirTemp("", "domain-init-root-")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"proc", "run"} {
		if err = os.Mkdir(filepath.Join(root, d), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err = syscall.Mount(root, root, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		t.Fatalf("bind root: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Unmount(root, syscall.MNT_DETACH); _ = os.RemoveAll(root) })
	if err = syscall.Mount("", root, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil {
		t.Fatal(err)
	}
	imageBytes, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	image := memfdDomain245(t, "domain-image", imageBytes, 0555, sealImage)
	metaData := make([]byte, 24)
	for i, name := range []string{"pid", "mnt", "net"} {
		var ns syscall.Stat_t
		if err := syscall.Stat("/proc/self/ns/"+name, &ns); err != nil {
			t.Fatalf("stat namespace %s: %v", name, err)
		}
		binary.BigEndian.PutUint64(metaData[i*8:], ns.Ino)
	}
	meta := memfdDomain245(t, "domain-metadata", metaData, 0444, true)
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Close(pair[0]) })
	rootfd, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rootfd.Close() })
	return root, image, meta, rootfd, pair
}

func runDomainInitPositive245(t *testing.T, path string) {
	runDomainInitLifecycle245(t, path, false)
}

func runDomainInitLifecycle245(t *testing.T, path string, killParent bool) {
	_, image, meta, rootfd, pair := domainFixture245(t, true)
	control := os.NewFile(uintptr(pair[1]), "domain-control-child")
	t.Cleanup(func() { _ = control.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "65534", "65533")
	cmd.Env = []string{}
	cmd.ExtraFiles = []*os.File{image, control, rootfd, meta}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = control.Close()
	syscall.CloseOnExec(pair[0])
	_ = syscall.SetNonblock(pair[0], true)
	deadline := time.Now().Add(12 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		var buf [64]byte
		n, err := syscall.Read(pair[0], buf[:])
		if err == nil && string(buf[:n]) == "domain-worker-ready" {
			ready = true
			break
		}
		if err != syscall.EAGAIN && err != syscall.EWOULDBLOCK && err != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal("actual worker did not send readiness")
	}
	if killParent {
		if err := cmd.Process.Kill(); err != nil {
			t.Fatalf("kill domain-init parent: %v", err)
		}
		if err := cmd.Wait(); err == nil {
			t.Fatal("domain-init parent kill unexpectedly succeeded")
		}
		deadline = time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			var buf [64]byte
			n, err := syscall.Read(pair[0], buf[:])
			if n > 0 {
				t.Fatal("worker sent data after parent death")
			}
			if err == nil {
				return
			}
			if err == syscall.ECONNRESET {
				return
			}
			if err == syscall.EAGAIN || err == syscall.EWOULDBLOCK {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			t.Fatalf("unexpected worker socket error after parent death: %v", err)
		}
		t.Fatal("worker did not close socket within 3 seconds of parent death")
	}
	_, _ = syscall.Write(pair[0], []byte("x"))
	if err := cmd.Wait(); err != nil {
		t.Fatalf("domain-init exited %v", err)
	}
}

func runDomainInitReject245(t *testing.T, path, uid, gid string, sealImage bool) {
	_, image, meta, rootfd, pair := domainFixture245(t, sealImage)
	control := os.NewFile(uintptr(pair[1]), "domain-control-child")
	t.Cleanup(func() { _ = control.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, uid, gid)
	cmd.Env = []string{}
	cmd.ExtraFiles = []*os.File{image, control, rootfd, meta}
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("negative case timed out: %v", ctx.Err())
	}
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 112 {
		t.Fatalf("refusal=%v, want status 112", err)
	}
}

func runDomainInitBadFD245(t *testing.T, path, kind string) {
	root, image, meta, rootfd, pair := domainFixture245(t, true)
	control := os.NewFile(uintptr(pair[1]), "domain-control-child")
	t.Cleanup(func() { _ = control.Close() })
	switch kind {
	case "metadata-unsealed":
		meta = memfdDomain245(t, "bad-metadata", nil, 0444, false)
	case "control-stream":
		fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
		if err != nil { t.Fatal(err) }
		_ = control.Close()
		control = os.NewFile(uintptr(fds[1]), "domain-control-stream")
		t.Cleanup(func() { _ = control.Close(); _ = syscall.Close(fds[0]) })
	case "root-writable", "root-mode-writable":
		if err := syscall.Mount("", root, "", syscall.MS_BIND|syscall.MS_REMOUNT, ""); err != nil { t.Fatal(err) }
		if kind == "root-mode-writable" {
			if err := os.Chmod(root, 0777); err != nil { t.Fatal(err) }
			if err := syscall.Mount("", root, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil { t.Fatal(err) }
		}
	case "image-mode":
		data, err := os.ReadFile(os.Args[0]); if err != nil { t.Fatal(err) }
		image = memfdDomain245(t, "bad-image-mode", data, 0444, true)
	default:
		t.Fatalf("unknown bad-FD case %q", kind)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "65534", "65533")
	cmd.Env = []string{}
	cmd.ExtraFiles = []*os.File{image, control, rootfd, meta}
	err := cmd.Run()
	if ctx.Err() != nil { t.Fatalf("negative case timed out: %v", ctx.Err()) }
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 112 { t.Fatalf("refusal=%v, want status 112", err) }
}
