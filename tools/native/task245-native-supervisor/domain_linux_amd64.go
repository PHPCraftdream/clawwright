//go:build linux && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var errLaunchDomain = errors.New("isolated launch domain rejected")

type launchConfig struct {
	Root string `json:"Root"`; Manifest string `json:"Manifest"`; ManifestSHA256 string `json:"ManifestSHA256"`
	Init string `json:"Init"`; InitSHA256 string `json:"InitSHA256"`
	RuntimeUID uint32 `json:"RuntimeUID"`; RuntimeGID uint32 `json:"RuntimeGID"`
	OuterPIDNS uint64 `json:"OuterPIDNS"`; OuterMNTNS uint64 `json:"OuterMNTNS"`; OuterNETNS uint64 `json:"OuterNETNS"`
	SupervisorSHA256 string `json:"SupervisorSHA256"`; BrokerSHA256 string `json:"BrokerSHA256"`
	Node string `json:"Node"`; NodeSHA256 string `json:"NodeSHA256"`
	Stub string `json:"Stub"`; StubSHA256 string `json:"StubSHA256"`
	Provider string `json:"Provider"`; ProviderSHA256 string `json:"ProviderSHA256"`
	ConfigPath string `json:"ConfigPath"`; SocketPath string `json:"SocketPath"`
	GatewayArgv []string `json:"GatewayArgv"`; BrokerArgv []string `json:"BrokerArgv"`
	Target string `json:"Target"`; Revision string `json:"Revision"`; Purpose string `json:"Purpose"`; SelectedImage string `json:"SelectedImage"`
	CaptureEvidence string `json:"CaptureEvidence"`
	LabReceiptPath string `json:"LabReceiptPath"`
	LabScenario string `json:"LabScenario"`
}

func runIsolated(ctx context.Context,k *keeperSession)error{
	bad:=func()error{return errLaunchDomain};if ctx==nil||k==nil||ctx.Err()!=nil{return bad()};c,e:=trustedLaunchConfig();if e!=nil||len(c.BrokerSHA256)!=64||strings.ToLower(c.BrokerSHA256)!=c.BrokerSHA256{return bad()};if _,e=hex.DecodeString(c.BrokerSHA256);e!=nil{return bad()};scenario:=c.LabScenario;if scenario!=""&&scenario!="partial-ack"&&scenario!="lost-ack"&&scenario!="cancel"&&scenario!="wrong-holder"&&scenario!="unexpected-exec"{return bad()};if scenario!=""&&verifyLabScenario(scenario)!=nil{return bad()}
	if c.LabReceiptPath != "" && c.LabReceiptPath != "/var/lib/ssjack/synthetic/consumer-receipt" { return bad() }; labCheckpoint245(20); fd,e:=connectLabBroker(ctx,c.BrokerSHA256);if e!=nil{return bad()};labCheckpoint245(21);req:=os.NewFile(uintptr(fd),"broker-request");defer req.Close()
	if n,e:=syscall.SendmsgN(fd,[]byte("OCLAB001"),nil,nil,0);e!=nil||n!=8{return bad()}
	var reply [9]byte;oob:=make([]byte,syscall.CmsgSpace(4));n,on,flags,_,e:=syscall.Recvmsg(fd,reply[:],oob,0);if e!=nil||n!=8||flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC)!=0||string(reply[:8])!="OCLABFD1"{return bad()};msgs,e:=syscall.ParseSocketControlMessage(oob[:on]);if e!=nil||len(msgs)!=1||msgs[0].Header.Level!=syscall.SOL_SOCKET||msgs[0].Header.Type!=syscall.SCM_RIGHTS{return bad()};fds,e:=syscall.ParseUnixRights(&msgs[0]);if e!=nil||len(fds)!=1{for _,x:=range fds{_ = syscall.Close(x)};return bad()};nativeFD:=fds[0];if e=syscall.SetNonblock(nativeFD,true);e!=nil{_ = syscall.Close(nativeFD);return bad()};native:=os.NewFile(uintptr(nativeFD),"native-worker");if native==nil{_ = syscall.Close(nativeFD);return bad()};defer native.Close()
	labCheckpoint245(22); stype,e:=syscall.GetsockoptInt(nativeFD,syscall.SOL_SOCKET,syscall.SO_TYPE);if e!=nil||stype!=syscall.SOCK_SEQPACKET{return bad()};peer,e:=syscall.Getpeername(nativeFD);if e!=nil{return bad()};if _,ok:=peer.(*syscall.SockaddrUnix);!ok{return bad()};cred,e:=syscall.GetsockoptUcred(nativeFD,syscall.SOL_SOCKET,syscall.SO_PEERCRED);if e!=nil||cred.Uid!=0{return bad()}
	dl,ok:=ctx.Deadline();if !ok||native.SetDeadline(dl)!=nil{return bad()};stop:=context.AfterFunc(ctx,func(){_ = req.Close();_ = native.Close()});defer stop()
	labCheckpoint245(23); var h [64]byte;if k.readHeader(ctx,&h)!=nil{return bad()};if n,e=native.Write(h[:]);e!=nil||n!=len(h){return bad()}
	labCheckpoint245(24); var sh [161]byte;n,e=native.Read(sh[:]);if e!=nil{return bad()};if n==64&&scenario!=""&&(scenario=="wrong-holder"||scenario=="unexpected-exec")&&string(sh[:8])=="OCLABNO1"&&string(sh[8:56])==string(h[8:56])&&((scenario=="wrong-holder"&&string(sh[56:64])=="BADWRITE")||(scenario=="unexpected-exec"&&string(sh[56:64])=="BADEXEC1")){if writeLabFault(scenario)!=nil{return bad()};return bad()};if n!=160||string(sh[:8])!="SSRDY001"{return bad()};targetHash:=sha256.Sum256([]byte(c.Target));revisionHash:=sha256.Sum256([]byte(c.Revision));purposeHash:=sha256.Sum256([]byte(c.Purpose));if string(sh[8:64])!=string(h[8:64])||string(sh[64:96])!=string(targetHash[:])||string(sh[96:128])!=string(revisionHash[:])||string(sh[128:160])!=string(purposeHash[:]){return bad()};if k.writeExact(ctx,sh[:160])!=nil{return bad()}
	labCheckpoint245(25); payload,digest,e:=k.readPayload(ctx,k.length);if e!=nil{return bad()};defer clear(payload);n,e=native.Write(payload);if e!=nil||n!=len(payload){return bad()}
	var ack [97]byte;n,e=native.Read(ack[:]);if e!=nil||n!=96||string(ack[:8])!="SSACK001"||string(ack[8:64])!=string(h[8:64])||string(ack[64:96])!=string(digest[:]){return bad()};if scenario=="cancel"{if writeLabCancelOwner()!=nil{return bad()};if writeLabFault(scenario)!=nil{return bad()};if c.LabReceiptPath!=""&&recordLabReceipt(h)!=nil{return bad()};if awaitLabCancel(ctx)!=nil{return bad()};return bad()};if c.LabReceiptPath!=""||scenario=="partial-ack"||scenario=="lost-ack" { if recordLabReceipt(h)!=nil{return bad()} };if scenario=="partial-ack"||scenario=="lost-ack"{if writeLabFault(scenario)!=nil{return bad()};if scenario=="partial-ack"{_ = k.writeExact(ctx,ack[:48])};return bad()};if k.writeExact(ctx,ack[:96])!=nil{return bad()};return nil
}

func verifyLabScenario(want string)error{bad:=func()error{return errLaunchDomain};for _,p:=range []string{"/lab","/etc","/etc/clawwright"}{fi,e:=os.Lstat(p);if e!=nil||!fi.IsDir()||fi.Mode()&os.ModeSymlink!=0{return bad()};s,ok:=fi.Sys().(*syscall.Stat_t);if !ok||s.Uid!=0||s.Mode&0022!=0{return bad()}};for p,mode:=range map[string]uint32{"/lab/scenario":0444,"/lab/disposable-profile":0444}{f,e:=os.OpenFile(p,os.O_RDONLY|syscall.O_NOFOLLOW,0);if e!=nil{return bad()};st,e:=f.Stat();if e!=nil{f.Close();return bad()};b,re:=io.ReadAll(io.LimitReader(f,129));f.Close();s,ok:=st.Sys().(*syscall.Stat_t);if re!=nil||!ok||!st.Mode().IsRegular()||s.Uid!=0||s.Nlink!=1||s.Mode&07777!=mode{return bad()};if p=="/lab/scenario"&&string(b)!=want{return bad()};if p=="/lab/disposable-profile"&&st.Size()<1{return bad()}};return nil}
func writeLabCancelOwner()error{bad:=func()error{return errLaunchDomain};p,e:=syscall.Open("/var/lib/ssjack/synthetic",syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,0);if e!=nil{return bad()};defer syscall.Close(p);var d syscall.Stat_t;if syscall.Fstat(p,&d)!=nil||d.Uid!=uint32(os.Geteuid())||d.Mode&07777!=0700{return bad()};pid:=os.Getpid();start,e:=procStart(pid);if e!=nil||start==""{return bad()};body:=strconv.Itoa(pid)+" "+start+" "+strconv.Itoa(os.Getppid());fd,e:=syscall.Openat(p,"native-cancel-owner",syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,0600);if e!=nil{return bad()};f:=os.NewFile(uintptr(fd),"native-cancel-owner");if f==nil{_ = syscall.Close(fd);return bad()};defer f.Close();var s syscall.Stat_t;if syscall.Fstat(fd,&s)!=nil||s.Uid!=uint32(os.Geteuid())||s.Mode&syscall.S_IFMT!=syscall.S_IFREG||s.Nlink!=1||s.Mode&07777!=0600{return bad()};n,e:=f.Write([]byte(body));if e!=nil||n!=len(body)||f.Sync()!=nil{return bad()};return nil}
func writeLabFault(scenario string)error{bad:=func()error{return errLaunchDomain};p,e:=syscall.Open("/var/lib/ssjack/synthetic",syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,0);if e!=nil{return bad()};defer syscall.Close(p);var d syscall.Stat_t;if syscall.Fstat(p,&d)!=nil||d.Uid!=uint32(os.Geteuid())||d.Mode&07777!=0700{return bad()};fd,e:=syscall.Openat(p,"native-fault-reached",syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,0600);if e!=nil{return bad()};f:=os.NewFile(uintptr(fd),"lab-fault");if f==nil{_ = syscall.Close(fd);return bad()};defer f.Close();var s syscall.Stat_t;if syscall.Fstat(fd,&s)!=nil||s.Uid!=uint32(os.Geteuid())||s.Mode&syscall.S_IFMT!=syscall.S_IFREG||s.Nlink!=1||s.Mode&07777!=0600{return bad()};n,e:=f.Write([]byte(scenario));if e!=nil||n!=len(scenario)||f.Sync()!=nil{return bad()};return nil}
func awaitLabCancel(ctx context.Context)error{if ctx==nil{return errLaunchDomain};for i:=0;i<1000;i++{if ctx.Err()!=nil{return errLaunchDomain};fd,e:=syscall.Open("/var/lib/ssjack/synthetic/cancel-ack",syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,0);if e==nil{f:=os.NewFile(uintptr(fd),"cancel-ack");var s syscall.Stat_t;b,re:=io.ReadAll(io.LimitReader(f,9));if re!=nil||len(b)!=7||syscall.Fstat(fd,&s)!=nil||s.Uid!=uint32(os.Geteuid())||s.Mode&syscall.S_IFMT!=syscall.S_IFREG||s.Nlink!=1||s.Mode&07777!=0600||string(b)!="release"{f.Close();return errLaunchDomain};f.Close();if syscall.Unlink("/var/lib/ssjack/synthetic/cancel-ack")!=nil{return errLaunchDomain};return nil};select{case <-ctx.Done():return errLaunchDomain;case <-time.After(10*time.Millisecond):}};return errLaunchDomain}

func recordLabReceipt(header [64]byte) error {
	bad := func() error { return errLaunchDomain }
	if string(header[:8]) != "SSINK001" { return bad() }
	parent, err := syscall.Open("/var/lib/ssjack/synthetic", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil { return bad() }
	defer syscall.Close(parent)
	var dir syscall.Stat_t
	if syscall.Fstat(parent, &dir) != nil || dir.Uid != uint32(os.Geteuid()) || dir.Mode&07777 != 0700 || dir.Nlink == 0 { return bad() }
	fd, err := syscall.Openat(parent, "consumer-receipt", syscall.O_WRONLY|syscall.O_CREAT|syscall.O_APPEND|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil { return bad() }
	f := os.NewFile(uintptr(fd), "lab-receipt")
	if f == nil { _ = syscall.Close(fd); return bad() }
	defer f.Close()
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Uid != uint32(os.Geteuid()) || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Mode&07777 != 0600 || st.Size < 0 || st.Size > 6144 || st.Size%48 != 0 { return bad() }
	if n, writeErr := f.Write(header[8:56]); writeErr != nil || n != 48 { return bad() }
	if err = f.Sync(); err != nil { return bad() }
	return nil
}

func trustedLaunchConfig()(launchConfig,error){var c launchConfig;bad:=func()(launchConfig,error){return c,errLaunchDomain};for _,p:=range []string{"/etc","/etc/clawwright"}{fi,e:=os.Lstat(p);if e!=nil||!fi.IsDir()||fi.Mode()&os.ModeSymlink!=0{return bad()};s,ok:=fi.Sys().(*syscall.Stat_t);if !ok||s.Uid!=0||s.Mode&0022!=0{return bad()}}
 f,e:=os.OpenFile("/etc/clawwright/native-launch.json",os.O_RDONLY|syscall.O_NOFOLLOW,0);if e!=nil{return bad()};defer f.Close();fi,e:=f.Stat();if e!=nil||!fi.Mode().IsRegular()||fi.Size()<2||fi.Size()>65536{return bad()};s,ok:=fi.Sys().(*syscall.Stat_t);if !ok||s.Uid!=0||s.Nlink!=1||s.Mode&0022!=0{return bad()};b,e:=io.ReadAll(io.LimitReader(f,65537));if e!=nil||len(b)>65536||duplicateJSON(b)!=nil{return bad()};d:=json.NewDecoder(strings.NewReader(string(b)));d.DisallowUnknownFields();if d.Decode(&c)!=nil||d.Decode(new(any))!=io.EOF{return bad()};return c,nil}
func duplicateJSON(b []byte)error{d:=json.NewDecoder(strings.NewReader(string(b)));nodes:=0;var value func(int)(any,error);value=func(depth int)(any,error){if depth>32{return nil,errLaunchDomain};nodes++;if nodes>8192{return nil,errLaunchDomain};t,e:=d.Token();if e!=nil{return nil,e};delim,ok:=t.(json.Delim);if !ok{return t,nil};switch delim{case '{':m:=map[string]any{};for d.More(){kt,e:=d.Token();if e!=nil{return nil,e};key,ok:=kt.(string);if !ok{return nil,errLaunchDomain};if _,exists:=m[key];exists{return nil,errLaunchDomain};v,e:=value(depth+1);if e!=nil{return nil,e};m[key]=v};end,e:=d.Token();if e!=nil||end!=json.Delim('}'){return nil,errLaunchDomain};return m,nil;case '[':a:=[]any{};for d.More(){v,e:=value(depth+1);if e!=nil{return nil,e};a=append(a,v)};end,e:=d.Token();if e!=nil||end!=json.Delim(']'){return nil,errLaunchDomain};return a,nil};return nil,errLaunchDomain};if _,e:=value(0);e!=nil{return errLaunchDomain};if _,e:=d.Token();e!=io.EOF{return errLaunchDomain};return nil}

func connectLabBroker(ctx context.Context, want string) (int, error) {
	bad := func() (int, error) { return -1, errLaunchDomain }
	if ctx == nil || ctx.Err() != nil || len(want) != 64 || strings.ToLower(want) != want { return bad() }
	if _, err := hex.DecodeString(want); err != nil { return bad() }
	for _, p := range []string{"/", "/run", "/run/task245-lab", "/run/task245-services", "/lab", "/lab/bin"} {
		fi, err := os.Lstat(p)
		if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 { return bad() }
		s, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || s.Uid != 0 || s.Mode&0022 != 0 { return bad() }
	}
	proofFD, err := syscall.Open("/run/task245-services/broker.auth", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil { return bad() }
	proof := os.NewFile(uintptr(proofFD), "broker.auth")
	if proof == nil { _ = syscall.Close(proofFD); return bad() }
	defer proof.Close()
	var ps syscall.Stat_t
	if syscall.Fstat(proofFD, &ps) != nil || ps.Uid != 0 || ps.Mode&syscall.S_IFMT != syscall.S_IFREG || ps.Nlink != 1 || ps.Mode&07777 != 0444 || ps.Size < 1 || ps.Size > 512 { return bad() }
	pb, err := io.ReadAll(io.LimitReader(proof, 513))
	if err != nil || len(pb) > 512 { return bad() }
	pid, start, dev, ino, sockDev, sockIno, hash, ok := parseServiceProof245(string(pb))
	if !ok || hash != want { return bad() }
	artifactFD, err := syscall.Open("/lab/bin/native-lab-broker", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil { return bad() }
	artifact := os.NewFile(uintptr(artifactFD), "native-lab-broker")
	if artifact == nil { _ = syscall.Close(artifactFD); return bad() }
	defer artifact.Close()
	var as syscall.Stat_t
	if syscall.Fstat(artifactFD, &as) != nil || as.Uid != 0 || as.Mode&syscall.S_IFMT != syscall.S_IFREG || as.Nlink != 1 || as.Mode&07777 != 0755 || uint64(as.Dev) != dev || as.Ino != ino { return bad() }
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(artifact, (64<<20)+1))
	if err != nil || n > 64<<20 || hex.EncodeToString(h.Sum(nil)) != want { return bad() }
	const path = "/run/task245-lab/broker.sock"
	var before syscall.Stat_t
	if syscall.Lstat(path, &before) != nil || before.Uid != 0 || before.Mode&syscall.S_IFMT != syscall.S_IFSOCK || before.Mode&07777 != 0666 || uint64(before.Dev) != sockDev || before.Ino != sockIno { return bad() }
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil { return bad() }
	fail := func() (int, error) { _ = syscall.Close(fd); return bad() }
	timeout := 30 * time.Second
	if deadline, has := ctx.Deadline(); has { remain := time.Until(deadline); if remain <= 0 { return fail() }; if remain < timeout { timeout = remain } }
	tv := syscall.NsecToTimeval(timeout.Nanoseconds())
	if syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv) != nil || syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_SNDTIMEO, &tv) != nil || ctx.Err() != nil || syscall.Connect(fd, &syscall.SockaddrUnix{Name: path}) != nil { return fail() }
	cred, err := syscall.GetsockoptUcred(fd, syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	if err != nil || cred.Uid != 0 || int(cred.Pid) != pid { return fail() }
	actualStart, err := procStart(pid)
	if err != nil || actualStart != start || ctx.Err() != nil { return fail() }
	var after syscall.Stat_t
	if syscall.Lstat(path, &after) != nil || after.Dev != before.Dev || after.Ino != before.Ino || after.Mode&syscall.S_IFMT != syscall.S_IFSOCK { return fail() }
	return fd, nil
}

func parseServiceProof245(line string) (int, string, uint64, uint64, uint64, uint64, string, bool) {
	bad := func() (int, string, uint64, uint64, uint64, uint64, string, bool) { return 0, "", 0, 0, 0, 0, "", false }
	if len(line) > 512 || !strings.HasSuffix(line, "\n") { return bad() }
	fields := strings.Fields(line)
	if len(fields) != 8 || fields[0] != "OCLABAUTH1" { return bad() }
	values := make([]uint64, 6)
	for i, field := range fields[1:7] {
		v, err := strconv.ParseUint(field, 10, 64)
		if err != nil || strconv.FormatUint(v, 10) != field { return bad() }
		values[i] = v
	}
	if values[0] <= 1 || values[0] > 1<<31-1 || values[1] == 0 || values[3] == 0 || values[5] == 0 { return bad() }
	hash := fields[7]
	if len(hash) != 64 || strings.ToLower(hash) != hash { return bad() }
	if _, err := hex.DecodeString(hash); err != nil { return bad() }
	if "OCLABAUTH1 "+strings.Join(fields[1:], " ")+"\n" != line { return bad() }
	return int(values[0]), strconv.FormatUint(values[1], 10), values[2], values[3], values[4], values[5], hash, true
}
