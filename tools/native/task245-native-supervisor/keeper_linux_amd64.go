//go:build linux && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
)

var errKeeper = errors.New("keeper authentication rejected")

type keeperConfig struct { KeeperSHA256 string `json:"keeperSHA256"` }
type keeperSession struct { in, out *os.File; parent int; parentStart string; keeperHash string; inputDev, inputIno uint64; finishedInput bool; nonce [16]byte; binding [32]byte; length uint64; header [64]byte }

func openKeeper() (*keeperSession, error) {
	bad := func() (*keeperSession,error) { return nil,errKeeper }
	if os.Geteuid() <= 0 { return bad() }
	cfg, err := trustedKeeperConfig(); if err != nil { return bad() }
	labCheckpoint245(11)
	p := os.Getppid(); if p <= 1 || verifyParent(p,cfg.KeeperSHA256) != nil || !sameParentIdentity(p) { return bad() }
	labCheckpoint245(12)
	start, err := procStart(p); if err != nil { return bad() }
	var input syscall.Stat_t; if syscall.Fstat(0,&input)!=nil { return bad() }
	labCheckpoint245(13)
	if !reciprocalPipe(0,p,false) || !reciprocalPipe(1,p,true) || !sealedSelfFD3() { return bad() }
	labCheckpoint245(14)
	in, err := pollableKeeperPipe(0); if err != nil { return bad() }
	out, err := pollableKeeperPipe(1); if err != nil { in.Close(); return bad() }
	return &keeperSession{in:in,out:out,parent:p,parentStart:start,keeperHash:cfg.KeeperSHA256,inputDev:uint64(input.Dev),inputIno:input.Ino},nil
}

func pollableKeeperPipe(fd int) (*os.File, error) {
	var st syscall.Stat_t
	if fd < 0 || fd > 1 || syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO { return nil, errKeeper }
	copyFD, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_DUPFD_CLOEXEC, 3)
	if errno != 0 { return nil, errKeeper }
	if syscall.SetNonblock(int(copyFD), true) != nil { syscall.Close(int(copyFD)); return nil, errKeeper }
	f := os.NewFile(copyFD, "keeper-pipe")
	if f == nil { syscall.Close(int(copyFD)); return nil, errKeeper }
	return f, nil
}

func trustedKeeperConfig() (keeperConfig,error) {
	var c keeperConfig
	bad:=func()(keeperConfig,error){return c,errKeeper}
	for _,p:=range []string{"/etc","/etc/clawwright"} { fi,e:=os.Lstat(p); if e!=nil||!fi.IsDir()||fi.Mode()&os.ModeSymlink!=0||fi.Mode().Perm()&0022!=0{return bad()}; st,ok:=fi.Sys().(*syscall.Stat_t);if !ok||st.Uid!=0{return bad()} }
	f,e:=os.OpenFile("/etc/clawwright/native-supervisor.json",os.O_RDONLY|syscall.O_NOFOLLOW,0);if e!=nil{return bad()};defer f.Close()
	fi,e:=f.Stat();if e!=nil||!fi.Mode().IsRegular()||fi.Mode().Perm()&0022!=0{return bad()};st,ok:=fi.Sys().(*syscall.Stat_t);if !ok||st.Uid!=0||st.Nlink!=1||fi.Size()<2||fi.Size()>4096{return bad()}
	b,e:=io.ReadAll(io.LimitReader(f,4097));if e!=nil||len(b)>4096{return bad()}
	if parseKeeperConfig(b,&c)!=nil{return bad()}
	if _,e=hex.DecodeString(c.KeeperSHA256);e!=nil||strings.ToLower(c.KeeperSHA256)!=c.KeeperSHA256{return bad()};return c,nil
}

func parseKeeperConfig(b []byte,c *keeperConfig) error {
 if c==nil{return errKeeper}; d:=json.NewDecoder(strings.NewReader(string(b))); tok,e:=d.Token(); if e!=nil||tok!=json.Delim('{'){return errKeeper}; count:=0
 for d.More(){t,e:=d.Token();if e!=nil{return errKeeper};key,ok:=t.(string);if !ok||key!="keeperSHA256"||count!=0{return errKeeper};count++;if d.Decode(&c.KeeperSHA256)!=nil{return errKeeper}}
 tok,e=d.Token();if e!=nil||tok!=json.Delim('}')||count!=1||len(c.KeeperSHA256)!=64||d.Decode(new(any))!=io.EOF{return errKeeper};return nil
}


func verifyParent(pid int,want string) error { if pid<=1||!sameParentIdentity(pid){return errKeeper};f,e:=os.Open("/proc/"+strconv.Itoa(pid)+"/exe");if e!=nil{return errKeeper};defer f.Close()
	st,e:=f.Stat();if e!=nil||!st.Mode().IsRegular(){return errKeeper};u,ok:=st.Sys().(*syscall.Stat_t);if !ok||u.Uid!=0||u.Mode&0022!=0||u.Nlink==0{return errKeeper}
	h:=sha256.New();if _,e=io.Copy(h,io.LimitReader(f,64<<20+1));e!=nil{return errKeeper};if hex.EncodeToString(h.Sum(nil))!=want{return errKeeper}
	return nil
}

func procStart(pid int)(string,error){b,e:=readBounded("/proc/"+strconv.Itoa(pid)+"/stat",4096);if e!=nil{return "",errKeeper};i:=strings.LastIndex(string(b),")");if i<0{return "",errKeeper};f:=strings.Fields(string(b)[i+1:]);if len(f)<=19||f[19]=="0"{return "",errKeeper};return f[19],nil}

func reciprocalPipe(fd,pid int,childWrites bool) bool {
	link,e:=os.Readlink("/proc/self/fd/"+strconv.Itoa(fd));if e!=nil||!strings.HasPrefix(link,"pipe:[")||!strings.HasSuffix(link,"]"){return false}
	inode:=strings.TrimSuffix(strings.TrimPrefix(link,"pipe:["),"]");if inode==""{return false}
	flags,_,errno:=syscall.Syscall(syscall.SYS_FCNTL,uintptr(fd),3,0);if errno!=0{return false};want:=uintptr(0);if childWrites{want=1};if flags&3!=want{return false}
	pflags,ok:=procFDFlags(pid,inode);if !ok||pflags&3!=uint64(want^1){return false}
	return pipeHolderExclusive(inode,pid)
}

func procFDFlags(pid int,inode string)(uint64,bool){entries,e:=os.ReadDir("/proc/"+strconv.Itoa(pid)+"/fd");if e!=nil||len(entries)>4096{return 0,false};for _,v:=range entries{base:="/proc/"+strconv.Itoa(pid)+"/fd/"+v.Name();link,e:=os.Readlink(base);if e!=nil||link!="pipe:["+inode+"]"{continue};b,e:=readBounded(base[:strings.LastIndex(base,"/fd/")]+"/fdinfo/"+v.Name(),4096);if e!=nil{return 0,false};for _,line:=range strings.Split(string(b),"\n"){if strings.HasPrefix(line,"flags:"){n,e:=strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line,"flags:")),8,64);return n,e==nil}};return 0,false};return 0,false}

func readBounded(path string,n int)([]byte,error){f,e:=os.Open(path);if e!=nil{return nil,e};defer f.Close();b,e:=io.ReadAll(io.LimitReader(f,int64(n+1)));if e!=nil||len(b)>n{return nil,errKeeper};return b,nil}

func pipeHolderExclusive(inode string,parent int)bool {
 entries,e:=os.ReadDir("/proc");if e!=nil||len(entries)>32768{return false};self:=os.Getpid()
 for _,p:=range entries { pid,e:=strconv.Atoi(p.Name());if e!=nil||pid==self{continue}; uid,ok:=procUIDs(pid);if !ok {return false}; if uid[0]!=uint32(os.Geteuid()) {continue}; tasks,e:=os.ReadDir("/proc/"+p.Name()+"/task");if e!=nil||len(tasks)>4096{return false}
  for _,task:=range tasks { base:="/proc/"+p.Name()+"/task/"+task.Name()+"/fd";fds,e:=os.ReadDir(base);if e!=nil||len(fds)>4096{return false};for _,fd:=range fds {l,e:=os.Readlink(base+"/"+fd.Name());if e!=nil{return false};if l=="pipe:["+inode+"]"&&pid!=parent{return false}} }
 };return true
}
func procUIDs(pid int)([8]uint32,bool){return procIDs(pid)}
func sameParentIdentity(pid int) bool { if os.Getppid()!=pid{return false}; ids,ok:=procIDs(pid);if !ok{return false};return ids[0]==uint32(os.Geteuid())&&ids[1]==uint32(os.Geteuid())&&ids[2]==uint32(os.Geteuid())&&ids[3]==uint32(os.Geteuid())&&ids[4]==uint32(os.Getegid())&&ids[5]==uint32(os.Getegid())&&ids[6]==uint32(os.Getegid())&&ids[7]==uint32(os.Getegid()) }
func procIDs(pid int)([8]uint32,bool){var out [8]uint32;b,e:=readBounded("/proc/"+strconv.Itoa(pid)+"/status",16384);if e!=nil{return out,false};for _,line:=range strings.Split(string(b),"\n"){for _,field:=range []string{"Uid:","Gid:"}{if strings.HasPrefix(line,field){f:=strings.Fields(strings.TrimPrefix(line,field));if len(f)!=4{return out,false};off:=0;if field=="Gid:"{off=4};for i,s:=range f{n,e:=strconv.ParseUint(s,10,32);if e!=nil{return out,false};out[off+i]=uint32(n)}}}};return out,true}




func sealedSelfFD3() bool {
	var st,exe syscall.Stat_t;if syscall.Fstat(3,&st)!=nil||st.Mode&syscall.S_IFMT!=syscall.S_IFREG||st.Uid!=uint32(os.Geteuid())||st.Size<=0||syscall.Stat("/proc/self/exe",&exe)!=nil||st.Dev!=exe.Dev||st.Ino!=exe.Ino{return false}
	seals,_,e:=syscall.Syscall(syscall.SYS_FCNTL,3,1034,0);if e!=0{return false}
	const required=0x1|0x2|0x4|0x8
	return seals&required==required
}

func(k *keeperSession)readHeader(ctx context.Context,h *[64]byte)error{if k==nil||ctx==nil||h==nil||ctx.Err()!=nil||!k.live(){return errKeeper};dl,ok:=ctx.Deadline();if !ok||k.in.SetReadDeadline(dl)!=nil{return errKeeper};if _,e:=io.ReadFull(k.in,h[:]);e!=nil||string(h[:8])!="SSINK001"{return errKeeper};k.length=binary.BigEndian.Uint64(h[56:64]);if k.length==0||k.length>16384{return errKeeper};copy(k.nonce[:],h[8:24]);copy(k.binding[:],h[24:56]);k.header=*h;if k.nonce==[16]byte{}||k.binding==[32]byte{}{return errKeeper};return nil}
func(k *keeperSession)ownInputIdentity()bool{var st syscall.Stat_t;return k!=nil&&syscall.Fstat(0,&st)==nil&&uint64(st.Dev)==k.inputDev&&st.Ino==k.inputIno}
func(k *keeperSession)liveBase()bool{if k==nil||k.parent<=1{return false};start,e:=procStart(k.parent);if e!=nil||start!=k.parentStart||verifyParent(k.parent,k.keeperHash)!=nil||!sameParentIdentity(k.parent)||!k.ownInputIdentity()||!reciprocalPipe(1,k.parent,true)||!sealedSelfFD3(){return false};return true}
func(k *keeperSession)liveAfterInput()bool{return k.liveBase()}
func(k *keeperSession)live()bool{return k.liveBase()&&(k.finishedInput||reciprocalPipe(0,k.parent,false))}
func(k *keeperSession)checkContext(header [64]byte)error{if k==nil||!k.live()||header!=k.header{return errKeeper};return nil}
func(k *keeperSession)writeExact(ctx context.Context,p []byte)error{if ctx==nil||ctx.Err()!=nil||!k.live(){return errKeeper};dl,ok:=ctx.Deadline();if !ok||k.out.SetWriteDeadline(dl)!=nil{return errKeeper};for len(p)>0{n,e:=k.out.Write(p);if e!=nil||n==0{return errKeeper};p=p[n:]};return nil}
func(k *keeperSession)readPayload(ctx context.Context,n uint64)([]byte,[32]byte,error){var z [32]byte;if k==nil||n==0||n>16384||n!=k.length||ctx==nil||ctx.Err()!=nil||!k.live(){return nil,z,errKeeper};dl,ok:=ctx.Deadline();if !ok||k.in.SetReadDeadline(dl)!=nil{return nil,z,errKeeper};b:=make([]byte,int(n));if _,e:=io.ReadFull(k.in,b);e!=nil||ctx.Err()!=nil||!k.liveAfterInput(){clear(b);return nil,z,errKeeper};var extra [1]byte;if m,e:=k.in.Read(extra[:]);m!=0||e!=io.EOF||ctx.Err()!=nil{clear(b);return nil,z,errKeeper};k.finishedInput=true;if !k.live(){clear(b);return nil,z,errKeeper};return b,sha256.Sum256(b),nil}
func(k *keeperSession)close(){if k!=nil { if k.in!=nil{_ = k.in.Close()}; if k.out!=nil && k.out!=k.in{_ = k.out.Close()} }}
