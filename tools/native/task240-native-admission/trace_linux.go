//go:build linux && amd64

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	ptraceSeize = 0x4206
	ptraceInterrupt = 0x4207
	ptraceGetEventMsg = 0x4201
	ptraceGetSyscallInfo = 0x420e
	ptraceSyscall = 24
	ptraceOptions = 2 | 4 | 8 | 16 | 64 | 0x100000 | 1
	waitWall = 0x40000000
	maxTraceTasks = 4096
)

type syscallStop struct { entry bool; nr uint64; args [6]uint64; result int64; failed bool }
func parseSyscallStop(raw []byte, n int) (syscallStop, error) {
	if n < 24 || n > len(raw) || binary.LittleEndian.Uint32(raw[4:8]) != 0xc000003e { return syscallStop{}, errTrace }
	i := syscallStop{}
	switch raw[0] {
	case 1:
		if n < 80 { return syscallStop{}, errTrace }; i.entry = true; i.nr = binary.LittleEndian.Uint64(raw[24:32]); for x := range i.args { i.args[x] = binary.LittleEndian.Uint64(raw[32+x*8:40+x*8]) }
	case 2:
		if n < 33 || raw[32] > 1 { return syscallStop{}, errTrace }; i.failed = raw[32] == 1; i.result = int64(binary.LittleEndian.Uint64(raw[24:32]))
	default: return syscallStop{}, errTrace
	}
	return i, nil
}
func readSyscallStop(tid int) (syscallStop, error) { var b [88]byte; n, e := ptrace(ptraceGetSyscallInfo, tid, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b))); if e != nil || n > uintptr(len(b)) { return syscallStop{}, errTrace }; return parseSyscallStop(b[:], int(n)) }
var errTrace = errors.New("ptrace admission refused")
type taskIdentity struct { TID, TGID int; StartTicks, ExecGeneration uint64 }
type traceTask struct { id taskIdentity; stopped, exiting bool; pending syscall.Signal; recvEntry bool; recvMatch bool; recvFD int }
type traceCommand struct { action uint8; ctx context.Context; snap *traceSnapshot; tid, fd int; reply chan traceReply }
type traceReply struct { snap *traceSnapshot; err error }
type TraceTracker struct { commands chan traceCommand; done chan struct{}; cancel context.CancelFunc; root int; once sync.Once }
type traceSnapshot struct { owner *TraceTracker; generation uint64; tasks []taskIdentity }

func readProcBound(path string, max int64) ([]byte,error) { f,e:=os.Open(path); if e!=nil{return nil,e}; defer f.Close(); b,e:=io.ReadAll(io.LimitReader(f,max+1)); if e!=nil||int64(len(b))>max{return nil,errTrace}; return b,nil }
func procIdentity(tid int)(taskIdentity,error){ base:="/proc/"+strconv.Itoa(tid); b,e:=readProcBound(base+"/status",65536); if e!=nil{return taskIdentity{},e}; tg:=0; for _,l:=range strings.Split(string(b),"\n"){if strings.HasPrefix(l,"Tgid:"){tg,_=strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(l,"Tgid:")));break}}; b,e=readProcBound(base+"/stat",65536); if e!=nil||tg<=0{return taskIdentity{},errTrace}; x:=strings.LastIndex(string(b),")"); if x<0{return taskIdentity{},errTrace}; f:=strings.Fields(string(b)[x+1:]); if len(f)<=19{return taskIdentity{},errTrace}; n,e:=strconv.ParseUint(f[19],10,64); if e!=nil{return taskIdentity{},e}; return taskIdentity{TID:tid,TGID:tg,StartTicks:n},nil }
func namespaceInode(path string)(uint64,error){ i,e:=os.Stat(path);if e!=nil{return 0,e};s,ok:=i.Sys().(*syscall.Stat_t);if !ok||s.Ino==0{return 0,errTrace};return s.Ino,nil }
func checkClosedTasks(tasks map[int]*traceTask,root int)error{ own,e:=namespaceInode("/proc/self/ns/pid");if e!=nil{return errTrace}; p,e:=namespaceInode("/proc/"+strconv.Itoa(os.Getppid())+"/ns/pid");if e!=nil||p!=own{return errTrace}; tracked:=map[int]bool{};for tid,t:=range tasks{if t==nil||t.id.TID!=tid{return errTrace};tracked[t.id.TGID]=true;id,x:=procIdentity(tid);if x!=nil||id.TGID!=t.id.TGID||id.StartTicks!=t.id.StartTicks{return errTrace};n,x:=namespaceInode("/proc/"+strconv.Itoa(tid)+"/ns/pid");if x!=nil||n!=own{return errTrace}};r,e:=procIdentity(root);if e!=nil||!tracked[r.TGID]{return errTrace}; entries,e:=os.ReadDir("/proc");if e!=nil||len(entries)>maxTraceTasks{return errTrace}; self,parent:=os.Getpid(),os.Getppid();for _,v:=range entries{if !v.IsDir(){continue};pid,x:=strconv.Atoi(v.Name());if x!=nil||pid<=0{continue};id,x:=procIdentity(pid);if x!=nil{return errTrace};if id.TGID!=self&&id.TGID!=parent&&!tracked[id.TGID]{return errTrace}};return nil }
func ptrace(req,tid int,data uintptr,addrlen ...uintptr)(uintptr,error){var a uintptr;if len(addrlen)>0{a=addrlen[0]};r,_,e:=syscall.RawSyscall6(syscall.SYS_PTRACE,uintptr(req),uintptr(tid),a,data,0,0);if e!=0{return r,e};return r,nil}

func NewTraceTracker(ctx context.Context,root int)(*TraceTracker,error){if ctx==nil||root<=0{return nil,errTrace};if _,ok:=ctx.Deadline();!ok||ctx.Err()!=nil{return nil,errTrace};c,cancel:=context.WithCancel(ctx);t:=&TraceTracker{commands:make(chan traceCommand),done:make(chan struct{}),cancel:cancel,root:root};ready:=make(chan error,1);go t.loop(c,ready);select{case e:=<-ready:if e!=nil{cancel();return nil,e};return t,nil;case <-c.Done():cancel();return nil,errTrace}}
func(t *TraceTracker)loop(ctx context.Context,ready chan<- error){
	runtime.LockOSThread();defer close(t.done)
	rootID,e:=procIdentity(t.root); ents,x:=os.ReadDir("/proc/"+strconv.Itoa(t.root)+"/task");if e!=nil||x!=nil||len(ents)!=1||ents[0].Name()!=strconv.Itoa(t.root)||rootID.TID!=rootID.TGID{ready<-errTrace;return}
	sig:=make(chan os.Signal,1);signal.Notify(sig,syscall.SIGCHLD);defer signal.Stop(sig)
	if _,e=ptrace(ptraceSeize,t.root,ptraceOptions);e!=nil{ready<-errTrace;return}
	owned:=map[int]*traceTask{t.root:{id:rootID}}
	cleanup:=func(){for tid,task:=range owned{_ = syscall.Tgkill(task.id.TGID,tid,syscall.SIGKILL);if task.stopped{_,_=ptrace(ptraceSyscall,tid,uintptr(syscall.SIGKILL))}};timer:=time.NewTimer(time.Second);defer timer.Stop();for len(owned)>0{for tid:=range owned{var ws syscall.WaitStatus;waited,we:=syscall.Wait4(tid,&ws,waitWall|syscall.WNOHANG,nil);if we==syscall.EINTR{continue};if we==syscall.ECHILD||(waited==tid&&(ws.Exited()||ws.Signaled())){delete(owned,tid);continue};if we==nil&&waited==tid&&ws.Stopped(){_,_=ptrace(ptraceSyscall,tid,uintptr(syscall.SIGKILL))}};if len(owned)==0{return};select{case <-sig:case <-timer.C:return}}}
	if _,e=ptrace(ptraceInterrupt,t.root,0);e!=nil{cleanup();ready<-errTrace;return}
	for {if ctx.Err()!=nil{cleanup();ready<-errTrace;return};var ws syscall.WaitStatus;pid,we:=syscall.Wait4(t.root,&ws,waitWall|syscall.WNOHANG,nil);if we==syscall.EINTR{continue};if we!=nil{cleanup();ready<-errTrace;return};if pid==t.root&&ws.Stopped(){owned[t.root].stopped=true;break};select{case <-sig:case <-ctx.Done():cleanup();ready<-errTrace;return}}
	id,e:=procIdentity(t.root);if e!=nil||id.StartTicks!=rootID.StartTicks{cleanup();ready<-errTrace;return};if _,e=ptrace(ptraceSyscall,t.root,0);e!=nil{cleanup();ready<-errTrace;return};owned[t.root].stopped=false
	frozen:=false;var generation uint64;var active *traceSnapshot;pending:=map[int]syscall.WaitStatus{};var transferTarget, transferFD int;var transferPending bool
	drain := func() error {
		for {
			var ws syscall.WaitStatus
			pid, e := syscall.Wait4(-1, &ws, waitWall|syscall.WNOHANG, nil)
			if e == syscall.EINTR { continue }; if e != nil { return errTrace }; if pid == 0 { return nil }
			task := owned[pid]
			if ws.Exited() || ws.Signaled() {
				if (frozen && active != nil) || task == nil { return errTrace }
				delete(owned, pid)
				if pid == t.root { groupLive:=false; for _,member:=range owned{if member.id.TGID==task.id.TGID{groupLive=true;break}}; if !groupLive{return errTrace} }
				continue
			}
			if !ws.Stopped() { continue }
			event:=int(uint32(ws)>>16)
			if task==nil && event==4 { var former uintptr; if _,e=ptrace(ptraceGetEventMsg,pid,uintptr(unsafe.Pointer(&former)));e!=nil{return errTrace}; task=owned[int(former)]; if task==nil||task.id.TGID!=pid{return errTrace} }
			if task == nil {
				if frozen && active != nil { return errTrace }; pending[pid] = ws; if len(pending) > maxTraceTasks { return errTrace }; continue
			}
			if frozen && active != nil { return errTrace }
			task.stopped = true
			s := ws.StopSignal(); task.pending = 0
			if event == 4 {
				var former uintptr
				if _, e = ptrace(ptraceGetEventMsg, pid, uintptr(unsafe.Pointer(&former))); e != nil { return errTrace }
				old := task
				if int(former) != pid { old = owned[int(former)]; if old == nil || old.id.TGID != pid { return errTrace }; delete(owned, int(former)); owned[pid] = old; task = old; task.stopped=true }
				ni, x := procIdentity(pid); if x != nil { return errTrace }; gen := old.id.ExecGeneration + 1; task.id = ni; task.id.ExecGeneration = gen; task.recvEntry = false; task.exiting = false
			} else if event == 0 && s != syscall.Signal(int(syscall.SIGTRAP)|0x80) { task.pending = s }
			if task.exiting && event != 6 { if _, e = ptrace(ptraceSyscall, pid, 0); e != nil { return errTrace }; task.stopped = false; continue }
			if event == 0 && s == syscall.Signal(int(syscall.SIGTRAP)|0x80) {
				info, x := readSyscallStop(pid); if x != nil { return errTrace }
				if info.entry { task.recvEntry = info.nr == 47; if task.recvEntry { task.recvFD = int(info.args[0]) } } else { matched := task.recvEntry; task.recvEntry = false; if matched && pid == transferTarget && task.recvFD == transferFD && !info.failed && info.result > 0 { transferPending = true; frozen = true; continue } }
			} else if event == 0 { task.pending = s }
			if event == 1 || event == 2 || event == 3 {
				var child uintptr; if _, e = ptrace(ptraceGetEventMsg, pid, uintptr(unsafe.Pointer(&child))); e != nil { return errTrace }; cid := int(child); if len(owned) >= maxTraceTasks { return errTrace }; if cid <= 0 || owned[cid] != nil { return errTrace }; ci, x := procIdentity(cid); if x != nil { return errTrace }; ci.ExecGeneration = task.id.ExecGeneration; owned[cid] = &traceTask{id: ci}
				if birth, ok := pending[cid]; ok { delete(pending, cid); childTask := owned[cid]; childTask.stopped = true; if int(uint32(birth)>>16) == 0 && birth.StopSignal() != syscall.Signal(int(syscall.SIGTRAP)|0x80) { childTask.pending = birth.StopSignal() }; if !frozen { _, e = ptrace(ptraceSyscall, cid, uintptr(childTask.pending)); if e != nil { return errTrace }; childTask.stopped = false } }
			}
			if event == 6 { task.exiting = true; if _, e = ptrace(ptraceSyscall, pid, 0); e != nil { return errTrace }; task.stopped = false; continue }
			if task.stopped && !task.exiting && !frozen { if _, e = ptrace(ptraceSyscall, pid, uintptr(task.pending)); e != nil { return errTrace }; task.stopped = false; task.pending = 0 }
		}
	}

	_ = drain
	ready<-nil
	for{select{case <-ctx.Done():cleanup();return;case <-sig:if e:=drain();e!=nil{cleanup();return};case c:=<-t.commands:
		if c.action==2{cleanup();return}
		if c.action==3||c.action==4{if !frozen||active==nil||active!=c.snap{c.reply<-traceReply{err:errTrace};continue};if c.action==4{if checkClosedTasks(owned,t.root)!=nil{c.reply<-traceReply{err:errTrace}}else{c.reply<-traceReply{}};continue};active=nil;frozen=false;for tid,task:=range owned{if task.stopped{_,e=ptrace(ptraceSyscall,tid,uintptr(task.pending));if e!=nil{cleanup();c.reply<-traceReply{err:errTrace};return};task.stopped=false}};c.reply<-traceReply{};continue}
		if c.action==5{if !frozen||active==nil||active!=c.snap||c.ctx==nil||c.ctx.Err()!=nil{c.reply<-traceReply{err:errTrace};continue};target:=owned[c.tid];if target==nil||!target.stopped{c.reply<-traceReply{snap:active,err:errTrace};continue};transferFD=c.fd;transferTarget=c.tid;transferPending=false;active=nil;frozen=false;for tid,v:=range owned{if v.stopped{_,e=ptrace(ptraceSyscall,tid,uintptr(v.pending));if e!=nil{cleanup();c.reply<-traceReply{err:errTrace};return};v.stopped=false}};for !transferPending{if c.ctx.Err()!=nil{cleanup();c.reply<-traceReply{err:errTrace};return};select{case <-c.ctx.Done():cleanup();c.reply<-traceReply{err:errTrace};return;case <-sig:if drain()!=nil{cleanup();c.reply<-traceReply{err:errTrace};return};case <-ctx.Done():cleanup();c.reply<-traceReply{err:errTrace};return}};frozen=true}else if c.action==1{if frozen||c.ctx==nil||c.ctx.Err()!=nil{c.reply<-traceReply{err:errTrace};continue};frozen=true}else{c.reply<-traceReply{err:errTrace};continue}
		for tid,v:=range owned{if !v.stopped&&!v.exiting{if _,e=ptrace(ptraceInterrupt,tid,0);e!=nil{cleanup();c.reply<-traceReply{err:errTrace};return}}}
		for {
			if c.ctx==nil||c.ctx.Err()!=nil{cleanup();c.reply<-traceReply{err:errTrace};return}
			if drain()!=nil{cleanup();c.reply<-traceReply{err:errTrace};return}
			all:=len(owned)>0
			for _,v:=range owned{if !v.stopped||v.exiting{all=false}}
			if all {
				if owned[t.root]==nil||len(pending)!=0{cleanup();c.reply<-traceReply{err:errTrace};return}
				seen:=map[int]bool{};groups:=map[int]bool{};valid:=true
				for _,v:=range owned{groups[v.id.TGID]=true}
				for g:=range groups{ts,er:=os.ReadDir("/proc/"+strconv.Itoa(g)+"/task");if er!=nil||len(ts)>maxTraceTasks{valid=false;break};for _,entry:=range ts{n,er:=strconv.Atoi(entry.Name());if er!=nil{valid=false;break};seen[n]=true}}
				if len(seen)!=len(owned){valid=false}
				for tid,v:=range owned{n,er:=procIdentity(tid);if er!=nil||n.TGID!=v.id.TGID||n.StartTicks!=v.id.StartTicks||!seen[tid]{valid=false}}
				if !valid{cleanup();c.reply<-traceReply{err:errTrace};return};break
			}
			select{case <-c.ctx.Done():cleanup();c.reply<-traceReply{err:errTrace};return;case <-sig:case <-ctx.Done():cleanup();c.reply<-traceReply{err:errTrace};return}
		}
		generation++;active=&traceSnapshot{owner:t,generation:generation};transferTarget=0;for _,v:=range owned{active.tasks=append(active.tasks,v.id)};c.reply<-traceReply{snap:active}
	}}
}
func(t *TraceTracker)Freeze(ctx context.Context)(*traceSnapshot,error){if t==nil||ctx==nil||ctx.Err()!=nil{return nil,errTrace};if _,ok:=ctx.Deadline();!ok{return nil,errTrace};r,e:=t.request(traceCommand{action:1,ctx:ctx});return r.snap,e}
func(t *TraceTracker)request(c traceCommand)(traceReply,error){r:=make(chan traceReply,1);c.reply=r;select{case t.commands<-c:case <-t.done:return traceReply{},errTrace;case <-c.ctxDone():return traceReply{},errTrace};select{case v:=<-r:return v,v.err;case <-c.ctxDone():return traceReply{},errTrace;case <-t.done:return traceReply{},errTrace}}
func(c traceCommand)ctxDone()<-chan struct{}{if c.ctx==nil{return nil};return c.ctx.Done()}
func(t *TraceTracker)CheckNamespace(s *traceSnapshot)error{if t==nil||s==nil||s.owner!=t{return errTrace};_,e:=t.request(traceCommand{action:4,snap:s});return e}
func(t *TraceTracker)Release(s *traceSnapshot)error{if t==nil||s==nil||s.owner!=t{return errTrace};_,e:=t.request(traceCommand{action:3,snap:s});return e}
func(t *TraceTracker)AdvanceTransfer(ctx context.Context,s *traceSnapshot,tid,fd int)(*traceSnapshot,error){if t==nil||ctx==nil||s==nil||s.owner!=t||tid<=0||fd<0||ctx.Err()!=nil{return s,errTrace};if _,ok:=ctx.Deadline();!ok{return s,errTrace};r,e:=t.request(traceCommand{action:5,ctx:ctx,snap:s,tid:tid,fd:fd});if e!=nil{return r.snap,errTrace};return r.snap,nil}
func(t *TraceTracker)Close(){if t==nil{return};t.once.Do(func(){t.cancel();r:=make(chan traceReply,1);select{case t.commands<-traceCommand{action:2,reply:r}:case <-t.done:};select{case <-t.done:case <-time.After(2*time.Second)}})}
