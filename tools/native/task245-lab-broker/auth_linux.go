//go:build linux && amd64

package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const (
	auth245MaxTasks = 4096
	auth245MaxFDs = 16384
)

func authenticateConsumer(pid int, c brokerConfig) error {
	if pid <= 0 { return brokerErr }
	start, err := procStart245(pid); if err != nil { return brokerErr }
	base := "/proc/" + strconv.Itoa(pid)
	status, err := readStatus245(base+"/status"); if err != nil || status.ppid <= 0 || !allIDs245(status.uid, c.RuntimeUID) || !allIDs245(status.gid, c.RuntimeGID) { return brokerErr }
	parent := status.ppid
	ps, err := readStatus245("/proc/"+strconv.Itoa(parent)+"/status"); if err != nil || !allIDs245(ps.uid, c.RuntimeUID) || !allIDs245(ps.gid, c.RuntimeGID) { return brokerErr }
	parentStart, err := procStart245(parent); if err != nil { return brokerErr }

	rootExe, err := safeRootFile245(c.Supervisor, c.SupervisorSHA256); if err != nil { return brokerErr }; defer rootExe.Close()
	childExe, err := os.Open(base+"/exe"); if err != nil { return brokerErr }; defer childExe.Close()
	ce, err := stat245(childExe); if err != nil || ce.Mode&syscall.S_IFMT != syscall.S_IFREG || ce.Uid != c.RuntimeUID || ce.Size < 0 || ce.Size > 64<<20 || ce.Mode&0022 != 0 || hashFD245(childExe) != c.SupervisorSHA256 { return brokerErr }
	f3, err := os.Open(base+"/fd/3"); if err != nil { return brokerErr }; defer f3.Close()
	s3, err := stat245(f3); if err != nil || s3.Dev != ce.Dev || s3.Ino != ce.Ino { return brokerErr }
	seals, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(f3.Fd()), 1034, 0)
	if errno != 0 || seals&0xf != 0xf { return brokerErr }

	rootKeeper, err := safeRootFile245(c.Keeper, c.KeeperSHA256); if err != nil { return brokerErr }; defer rootKeeper.Close()
	parentExe, err := os.Open("/proc/"+strconv.Itoa(parent)+"/exe"); if err != nil { return brokerErr }; defer parentExe.Close()
	pe, err := stat245(parentExe); rk, er := stat245(rootKeeper)
	if err != nil || er != nil || pe.Dev != rk.Dev || pe.Ino != rk.Ino || pe.Uid != 0 || pe.Nlink != 1 || pe.Mode&0022 != 0 || hashFD245(parentExe) != c.KeeperSHA256 { return brokerErr }

	childPipes := make([]syscall.Stat_t, 2)
	for i, want := range []uint64{syscall.O_RDONLY, syscall.O_WRONLY} {
		fd := strconv.Itoa(i); st, e := statProc245(base+"/fd/"+fd); if e != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO { return brokerErr }
		fl, e := fdFlags245(base+"/fdinfo/"+fd); if e != nil || fl&uint64(syscall.O_ACCMODE) != want { return brokerErr }; childPipes[i] = st
	}
	parentPipes, ok := matchingParentPipes245(parent, childPipes); if !ok { return brokerErr }
	if !pipeCustody245(pid, parent, status.uid[0], childPipes, parentPipes) { return brokerErr }
	end, err := procStart245(pid); if err != nil || end != start { return brokerErr }
	parentEnd, err := procStart245(parent); if err != nil || parentEnd != parentStart { return brokerErr }
	parentExeEnd, err := os.Open("/proc/"+strconv.Itoa(parent)+"/exe"); if err != nil { return brokerErr }; defer parentExeEnd.Close()
	peEnd, err := stat245(parentExeEnd); if err != nil || peEnd.Dev != rk.Dev || peEnd.Ino != rk.Ino { return brokerErr }
	return nil
}

type status245 struct { ppid int; uid, gid [4]uint32 }
func readStatus245(path string) (status245,error) {
	var s status245; f,e:=os.Open(path); if e!=nil{return s,e}; defer f.Close()
	r:=io.LimitReader(f,16<<10); sc:=bufio.NewScanner(r); sc.Buffer(make([]byte,1024),16<<10); gotP,gotU,gotG:=false,false,false
	for sc.Scan(){ a,b,ok:=strings.Cut(sc.Text(),":"); if !ok{continue}; fields:=strings.Fields(b); switch a {case "PPid": if len(fields)!=1{return s,brokerErr}; n,x:=strconv.Atoi(fields[0]);if x!=nil{return s,brokerErr};s.ppid=n;gotP=true
	case "Uid","Gid": if len(fields)!=4{return s,brokerErr}; dst:=&s.uid;if a=="Gid"{dst=&s.gid};for i,v:=range fields{n,x:=strconv.ParseUint(v,10,32);if x!=nil{return s,brokerErr};dst[i]=uint32(n)};if a=="Uid"{gotU=true}else{gotG=true}} }
	if sc.Err()!=nil||!gotP||!gotU||!gotG{return s,brokerErr};return s,nil
}
func sameIDs245(a,b [4]uint32)bool{return a==b}
func allIDs245(a [4]uint32, want uint32)bool{return a[0]==want&&a[1]==want&&a[2]==want&&a[3]==want}
// Stat follows proc's fd symlink without opening a FIFO or adding a pipe holder.
func statProc245(path string)(syscall.Stat_t,error){var s syscall.Stat_t;e:=syscall.Stat(path,&s);return s,e}
func matchingParentPipes245(parent int, cp []syscall.Stat_t)([]syscall.Stat_t,bool){
	out:=make([]syscall.Stat_t,2); found:=[2]bool{}; base:="/proc/"+strconv.Itoa(parent)
	tasks,e:=os.ReadDir(base+"/task");if e!=nil||len(tasks)>auth245MaxTasks{return nil,false}
	seen:=map[int]bool{};pairs:=[2]map[string]bool{make(map[string]bool),make(map[string]bool)}
	for _,task:=range tasks{tid,e:=strconv.Atoi(task.Name());if e!=nil||seen[tid]{continue};seen[tid]=true;fdbase:=base+"/task/"+task.Name()+"/fd";fds,e:=os.ReadDir(fdbase);if e!=nil{return nil,false};if len(fds)>auth245MaxFDs{return nil,false}
		for _,entry:=range fds{_,e:=strconv.Atoi(entry.Name());if e!=nil{continue};path:=fdBaseName245(fdbase,entry.Name());st,e:=statProc245(path);if e!=nil{continue};if st.Mode&syscall.S_IFMT!=syscall.S_IFIFO{continue};flags,e:=fdFlags245(base+"/task/"+task.Name()+"/fdinfo/"+entry.Name());if e!=nil{return nil,false};for k:=0;k<2;k++{mode:=uint64(syscall.O_WRONLY);if k==1{mode=syscall.O_RDONLY};if st.Dev==cp[k].Dev&&st.Ino==cp[k].Ino&&flags&uint64(syscall.O_ACCMODE)==mode{key:=entry.Name();if !pairs[k][key]{pairs[k][key]=true;found[k]=true;out[k]=st}}}}
	}
	if !found[0]||!found[1]{return nil,false};return out,true
}
func fdBaseName245(base,name string)string{return base+"/"+name}
func procStart245(pid int)(string,error){b,e:=os.ReadFile("/proc/"+strconv.Itoa(pid)+"/stat");if e!=nil||len(b)>16<<10{return "",brokerErr};i:=strings.LastIndexByte(string(b),')');if i<0{return "",brokerErr};f:=strings.Fields(string(b[i+1:]));if len(f)<20{return "",brokerErr};return f[19],nil}
func stat245(f *os.File)(syscall.Stat_t,error){var s syscall.Stat_t;e:=syscall.Fstat(int(f.Fd()),&s);return s,e}
func hashFD245(f *os.File)string{st,e:=stat245(f);if e!=nil||st.Size<=0||st.Size>64<<20{return ""};if _,e=f.Seek(0,0);e!=nil{return ""};h:=sha256.New();n,e:=io.Copy(h,io.LimitReader(f,64<<20+1));if e!=nil||n!=st.Size{return ""};return hex.EncodeToString(h.Sum(nil))}
func safeRootFile245(path,want string)(*os.File,error){
	if !filepath.IsAbs(path)||filepath.Clean(path)!=path{return nil,brokerErr}; cur:="/"; parts:=strings.Split(strings.TrimPrefix(path,"/"),"/")
	for _,p:=range parts[:len(parts)-1]{cur=filepath.Join(cur,p);s,e:=os.Lstat(cur);if e!=nil||!s.IsDir()||s.Mode()&os.ModeSymlink!=0{return nil,brokerErr};st,ok:=s.Sys().(*syscall.Stat_t);if !ok||st.Uid!=0||st.Mode&0022!=0{return nil,brokerErr}}
	f,e:=syscall.Open(path,syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,0);if e!=nil{return nil,e};file:=os.NewFile(uintptr(f),path);s,e:=stat245(file);if e!=nil||s.Mode&syscall.S_IFMT!=syscall.S_IFREG||s.Uid!=0||s.Nlink!=1||s.Mode&0022!=0||hashFD245(file)!=want{file.Close();return nil,brokerErr};return file,nil
}
func fdFlags245(path string)(uint64,error){b,e:=os.ReadFile(path);if e!=nil||len(b)>4096{return 0,brokerErr};for _,line:=range strings.Split(string(b),"\n"){if strings.HasPrefix(line,"flags:"){v,x:=strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line,"flags:")),8,64);return v,x}};return 0,brokerErr}

// Enumerate proc task fd tables once; inaccessible tasks fail closed, and shared-thread fd tables count once.
func pipeCustody245(child,parent int,uid uint32,cp,pp []syscall.Stat_t)bool{
	if len(cp)!=2||len(pp)!=2||cp[0].Dev==cp[1].Dev&&cp[0].Ino==cp[1].Ino{return false}
	entries,e:=os.ReadDir("/proc");if e!=nil||len(entries)>auth245MaxTasks{return false};holders:=[2]map[string]bool{make(map[string]bool),make(map[string]bool)};tasks:=0
	for _,ent:=range entries{tgid,x:=strconv.Atoi(ent.Name());if x!=nil{continue};ts,x:=os.ReadDir("/proc/"+ent.Name()+"/task");if x!=nil{return false};for _,te:=range ts{tid,x:=strconv.Atoi(te.Name());if x!=nil{continue};tasks++;if tasks>auth245MaxTasks{return false};fdpath:=fmt.Sprintf("/proc/%d/task/%d/fd",tgid,tid);fds,x:=os.ReadDir(fdpath);if x!=nil{return false};if len(fds)>auth245MaxFDs{return false};for _,fe:=range fds{st,x:=statProc245(fdpath+"/"+fe.Name());if x!=nil{return false};if st.Mode&syscall.S_IFMT!=syscall.S_IFIFO{continue};for k:=0;k<2;k++{if st.Dev==cp[k].Dev&&st.Ino==cp[k].Ino{holders[k][strconv.Itoa(tgid)+":"+fe.Name()]=true}}}}}
	for k:=0;k<2;k++{if len(holders[k])<1{return false};for key:=range holders[k]{parts:=strings.SplitN(key,":",2);tgid,_:=strconv.Atoi(parts[0]);if tgid!=child&&tgid!=parent{return false}}};return true
}
var _ = fmt.Sprintf
