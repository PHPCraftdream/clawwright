//go:build linux && amd64

package admission

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// TestUnixDiagKernelPair exercises SOCK_DIAG against kernel-created sockets;
// inability to observe diag is a CI failure, never a reason to skip.
func TestUnixDiagKernelPair(t *testing.T) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil { t.Fatal(err) }
	writer, reader := os.NewFile(uintptr(fds[0]), "unix-writer"), os.NewFile(uintptr(fds[1]), "unix-reader")
	defer writer.Close(); defer reader.Close()
	inode := func(f *os.File) uint32 {
		link, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
		if err != nil { t.Fatal(err) }
		n, socket, ok := parseSocketLink(link)
		if !ok || !socket || n == 0 { t.Fatalf("unexpected socket fd target: %q", link) }
		return n
	}
	wi, ri := inode(writer), inode(reader)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second); defer cancel()
	pair, err := ObserveUnixPair(ctx, wi)
	if err != nil { t.Fatalf("SOCK_DIAG unavailable or pair rejected (writer inode %d): %v", wi, err) }
	if pair.Writer.Inode != wi || pair.Reader.Inode != ri || pair.Writer.PeerInode != ri || pair.Reader.PeerInode != wi || !validCookie(pair.Writer.Cookie) || !validCookie(pair.Reader.Cookie) {
		t.Fatalf("kernel pair mismatch: writer=%+v reader=%+v expected inodes=%d,%d", pair.Writer, pair.Reader, wi, ri)
	}
	wrong := pair.Writer.Cookie; wrong[1] ^= 1
	if _, err := queryUnix(ctx, wi, wrong); err == nil { t.Fatal("accepted altered upper cookie word") }
	if err := writer.Close(); err != nil { t.Fatal(err) }
	if err := reader.Close(); err != nil { t.Fatal(err) }
	ctx2, cancel2 := context.WithTimeout(context.Background(), 3*time.Second); defer cancel2()
	if _, err := queryUnix(ctx2, wi, pair.Writer.Cookie); err == nil { t.Fatal("accepted stale cookie after socketpair closure") }
}

const admissionHelperArg = "-test.run=^TestAdmissionKernelHelper$"
const admissionDescendantArg = "-test.run=^TestAdmissionDescendantHelper$"

func TestAdmissionDescendantHelper(t *testing.T) {
	if len(os.Args) < 2 { return }
	marker := os.Args[len(os.Args)-1]
	if marker != "OCARGV01-descendant" && marker != "OCARGV01-descendant-exec" { return }
	runtime.LockOSThread()
	if got := os.Getenv("CLAWWRIGHT_NATIVE_SOCKET"); got != "task244-proof" || len(os.Environ()) != 1 { t.Fatalf("unexpected descendant environment: %q", os.Environ()) }
	if marker == "OCARGV01-descendant" {
		image, err := os.Executable()
		if err != nil { t.Fatal(err) }
		execNonleader := func() {
			runtime.LockOSThread()
			if syscall.Gettid() == os.Getpid() { t.Fatal("exec fixture did not obtain nonleader") }
			if err := syscall.Exec(image, []string{image, admissionDescendantArg, "--", "OCARGV01-descendant-exec"}, []string{"CLAWWRIGHT_NATIVE_SOCKET=task244-proof"}); err != nil { t.Fatalf("exec descendant: %v", err) }
			t.Fatal("exec returned")
		}
		if syscall.Gettid() != os.Getpid() { execNonleader() }
		go execNonleader()
		select {}
	}
	if n, err := fmt.Fprintf(os.Stdout, "CHILD %d %d\n", os.Getpid(), syscall.Gettid()); err != nil || n == 0 { t.Fatalf("write child evidence: n=%d err=%v", n, err) }
	var b [1]byte
	for { n, err := syscall.Read(0, b[:]); if err == syscall.EINTR { continue }; if err != nil { t.Fatal(err) }; if n != 1 { t.Fatalf("child read %d bytes, want one", n) }; break }
}

func TestAdmissionKernelHelper(t *testing.T) {
	if len(os.Args) < 2 || os.Args[len(os.Args)-1] != "OCARGV01-helper" { return }
	runtime.LockOSThread()
	if got := os.Getenv("CLAWWRIGHT_NATIVE_SOCKET"); got != "task244-proof" || len(os.Environ()) != 1 { t.Fatalf("unexpected helper environment: %q", os.Environ()) }
	mode, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, 21, 0, 0)
	if e != 0 || mode != 2 { t.Fatalf("PR_GET_SECCOMP=%d errno=%v, want 2", mode, e) }
	noNewPrivs, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, 39, 0, 0)
	if e != 0 || noNewPrivs != 1 { t.Fatalf("PR_GET_NO_NEW_PRIVS=%d errno=%v, want 1", noNewPrivs, e) }
	for _, tc := range []struct{name string; nr uintptr}{ {"clone3",435}, {"io_uring_setup",425} } {
		if _, _, e := syscall.RawSyscall(tc.nr, 0, 0, 0); e != syscall.ENOSYS { t.Fatalf("%s errno=%v, want ENOSYS", tc.name, e) }
	}
	if _, _, e := syscall.RawSyscall(syscall.SYS_UNSHARE, 0, 0, 0); e != syscall.EPERM { t.Fatalf("unshare errno=%v, want EPERM", e) }
	if _, _, e := syscall.RawSyscall(syscall.SYS_CLONE, 0x00800000|uintptr(syscall.SIGCHLD), 0, 0); e != syscall.EPERM { t.Fatalf("CLONE_UNTRACED errno=%v, want EPERM", e) }
	if _, _, e := syscall.RawSyscall(0x40000000|syscall.SYS_GETPID, 0, 0, 0); e != syscall.EPERM { t.Fatalf("x32 getpid errno=%v, want EPERM", e) }
	selfPID, _, e := syscall.RawSyscall(syscall.SYS_GETPID, 0, 0, 0)
	if e != 0 || selfPID != uintptr(os.Getpid()) { t.Fatalf("allowed getpid=%d errno=%v, want %d", selfPID, e, os.Getpid()) }
	rawGateR, rawGateW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer rawGateW.Close()
	var rawByte [1]byte
	rawFD := rawGateR.Fd()
	rawPID, _, rawErr := syscall.RawSyscall(syscall.SYS_FORK, 0, 0, 0)
	if rawErr != 0 { t.Fatalf("raw fork: %v", rawErr) }
	if rawPID == 0 {
		// The raw child must not enter the Go runtime before exit.
		for { _, _, e := syscall.RawSyscall(syscall.SYS_READ, rawFD, uintptr(unsafe.Pointer(&rawByte[0])), 1); if e != syscall.EINTR { break } }
		_, _, _ = syscall.RawSyscall(syscall.SYS_EXIT, 0, 0, 0)
		for {}
	}
	if err := rawGateR.Close(); err != nil { t.Fatal(err) }
	if _, err := fmt.Fprintf(os.Stdout, "RAW %d\n", rawPID); err != nil { t.Fatal(err) }
	childGateR, childGateW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer childGateW.Close()
	image, err := os.Executable()
	if err != nil { t.Fatal(err) }
	childPID, err := syscall.ForkExec(image, []string{image, admissionDescendantArg, "--", "OCARGV01-descendant"}, &syscall.ProcAttr{Env: []string{"CLAWWRIGHT_NATIVE_SOCKET=task244-proof"}, Files: []uintptr{childGateR.Fd(), os.Stdout.Fd(), os.Stderr.Fd()}})
	if err != nil { t.Fatalf("spawn descendant: %v", err) }
	if err := childGateR.Close(); err != nil { t.Fatal(err) }
	if _, err := fmt.Fprintf(os.Stdout, "SPAWN %d\n", childPID); err != nil { t.Fatal(err) }
	if _, err := fmt.Fprintf(os.Stdout, "LIVE %d\n", syscall.Gettid()); err != nil { t.Fatal(err) }
	var command [1]byte
	for { n, err := syscall.Read(0, command[:]); if err == syscall.EINTR { continue }; if err != nil { t.Fatal(err) }; if n != 1 { t.Fatalf("helper read %d bytes, want one", n) }; break }
	if command[0] != 'R' { t.Fatalf("unexpected release command %q", command[0]) }
	data, oob := make([]byte, 1), make([]byte, syscall.CmsgSpace(4))
	var n, oobn, flags int
	for { n, oobn, flags, _, err = syscall.Recvmsg(0, data, oob, 0); if err == syscall.EINTR { continue }; break }
	if err != nil { t.Fatal(err) }
	if n != 1 || data[0] != 'T' { t.Fatalf("unexpected transfer payload n=%d data=%q", n, data[:n]) }
	if flags&syscall.MSG_CTRUNC != 0 { t.Fatal("truncated transfer control message") }
	msgs, err := syscall.ParseSocketControlMessage(oob[:oobn]); if err != nil { t.Fatal(err) }
	if len(msgs) != 1 { t.Fatalf("got %d control messages, want one", len(msgs)) }
	fds, err := syscall.ParseUnixRights(&msgs[0]); if err != nil { t.Fatal(err) }
	if len(fds) != 1 { t.Fatalf("got %d rights fds, want one", len(fds)) }
	defer syscall.Close(fds[0])
	var st syscall.Stat_t
	if err := syscall.Fstat(fds[0], &st); err != nil { t.Fatalf("received fd invalid: %v", err) }
	if _, err := io.WriteString(os.Stdout, "ACK\n"); err != nil { t.Fatal(err) }
	for { n, err := syscall.Read(0, command[:]); if err == syscall.EINTR { continue }; if err != nil { t.Fatal(err) }; if n != 1 { t.Fatalf("helper final read %d bytes, want one", n) }; break }
}

// Reorder only real kernel stops, preserving their exact status and identity.
func childFirstWait(count *atomic.Int32) traceWait {
	var queuedPID int
	var queuedStatus syscall.WaitStatus
	seen := map[int]bool{}
	return func(pid int, status *syscall.WaitStatus, options int, usage *syscall.Rusage) (int, error) {
		if queuedPID != 0 { n := queuedPID; queuedPID = 0; *status = queuedStatus; return n, nil }
		n, err := syscall.Wait4(pid, status, options, usage)
		if err != nil || n <= 0 || !status.Stopped() { return n, err }
		seen[n] = true
		event := int(uint32(*status) >> 16)
		if event != 1 && event != 2 && event != 3 { return n, nil }
		var child uintptr
		if _, err := ptrace(ptraceGetEventMsg, n, uintptr(unsafe.Pointer(&child))); err != nil { return 0, err }
		if seen[int(child)] { count.Add(1); return n, nil }
		queuedPID, queuedStatus = n, *status
		for { n, err = syscall.Wait4(int(child), status, waitWall, nil); if err != syscall.EINTR { break } }
		if err != nil || n != int(child) || !status.Stopped() { return 0, errTrace }
		seen[n] = true; count.Add(1)
		return n, nil
	}
}

func TestTraceKernelBarrier(t *testing.T) {
	for _, receivingFD := range []int{0, 1} {
		t.Run(fmt.Sprintf("recv-fd-%d", receivingFD), func(t *testing.T) {
			stub := os.Getenv("TASK240_STUB")
	if stub == "" { t.Fatal("TASK240_STUB must name the immutable CI trace stub") }
	image, err := os.Executable(); if err != nil { t.Fatal(err) }
	imageFile, err := os.Open(image); if err != nil { t.Fatal(err) }; defer imageFile.Close()
	info, err := imageFile.Stat(); if err != nil { t.Fatal(err) }
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || st.Uid != 0 || st.Mode&022 != 0 || st.Mode&0111 == 0 || st.Nlink != 1 { t.Fatalf("approved helper image must satisfy exact fd3 trust rules: %s", image) }
	stubInfo, err := os.Lstat(stub); if err != nil { t.Fatal(err) }
	stubStat, ok := stubInfo.Sys().(*syscall.Stat_t)
	if !ok || stubInfo.Mode()&os.ModeSymlink != 0 || !stubInfo.Mode().IsRegular() || stubStat.Uid != 0 || stubStat.Mode&022 != 0 || stubStat.Mode&0111 == 0 || stubStat.Nlink != 1 { t.Fatal("TASK240_STUB fails trusted executable rules") }

	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0); if err != nil { t.Fatal(err) }
	parentFile, child := os.NewFile(uintptr(fds[0]), "parent-control"), os.NewFile(uintptr(fds[1]), "child-control")
	defer parentFile.Close(); defer child.Close()
	gateR, gateW, err := os.Pipe(); if err != nil { t.Fatal(err) }; defer gateR.Close(); defer func(){ if err:=gateW.Close(); err!=nil&&!errors.Is(err,os.ErrClosed){t.Fatal(err)} }()
	specR, specW, err := os.Pipe(); if err != nil { t.Fatal(err) }; defer specR.Close(); defer func(){ if err:=specW.Close(); err!=nil&&!errors.Is(err,os.ErrClosed){t.Fatal(err)} }()
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0); if err != nil { t.Fatal(err) }; defer null.Close()
	cmd := exec.Command(stub); cmd.Env = []string{}; cmd.Stdin, cmd.Stdout, cmd.Stderr = child, child, null; cmd.ExtraFiles = []*os.File{imageFile, gateR, specR}
	if err := cmd.Start(); err != nil { t.Fatal(err) }; defer func(){ _ = cmd.Process.Release() }()
	if err := child.Close(); err != nil { t.Fatal(err) }; if err := gateR.Close(); err != nil { t.Fatal(err) }; if err := specR.Close(); err != nil { t.Fatal(err) }
	parent, err := net.FileConn(parentFile); if err != nil { t.Fatal(err) }
	if err := parentFile.Close(); err != nil { t.Fatal(err) }
	unixConn, ok := parent.(*net.UnixConn); if !ok { t.Fatalf("control connection is %T, want UnixConn", parent) }; defer unixConn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second); defer cancel()
	deadline, _ := ctx.Deadline(); if err:=unixConn.SetDeadline(deadline); err!=nil {t.Fatal(err)}
	var childFirst atomic.Int32
	tracker, err := newTraceTracker(ctx, cmd.Process.Pid, childFirstWait(&childFirst)); if err != nil { _ = cmd.Process.Kill(); t.Fatalf("seize trusted stub: %v", err) }; defer tracker.Close()
	packet := []byte("OCARGV01"); var word [4]byte
	put := func(s string) { binary.BigEndian.PutUint32(word[:], uint32(len(s))); packet = append(packet, word[:]...); packet = append(packet, s...) }
	binary.BigEndian.PutUint32(word[:], 4); packet = append(packet, word[:]...); put(image); put(admissionHelperArg); put("--"); put("OCARGV01-helper")
	binary.BigEndian.PutUint32(word[:], 1); packet = append(packet, word[:]...); put("CLAWWRIGHT_NATIVE_SOCKET=task244-proof")
	writeAll := func(f *os.File, b []byte) error { for len(b)>0 { n,e:=f.Write(b); if e!=nil{return e}; if n==0{return io.ErrShortWrite}; b=b[n:] }; return nil }
	if err := writeAll(specW, packet); err != nil { t.Fatalf("write argv packet: %v", err) }; if err := specW.Close(); err != nil { t.Fatal(err) }
	snap1, err := tracker.Freeze(ctx); if err != nil { t.Fatalf("freeze gated stub: %v", err) }
	if len(snap1.tasks)!=1 || snap1.tasks[0].TID!=cmd.Process.Pid || snap1.tasks[0].TGID!=cmd.Process.Pid || snap1.tasks[0].StartTicks==0 || snap1.tasks[0].ExecGeneration!=0 { t.Fatalf("unexpected pre-gate tasks: %+v",snap1.tasks) }
	if n,err:=gateW.Write([]byte{0xa5}); err!=nil||n!=1 { t.Fatalf("write gate byte %d: %v",n,err) }; if err:=gateW.Close(); err!=nil {t.Fatal(err)}
	if err:=tracker.Release(snap1); err!=nil { t.Fatal(err) }; if err:=tracker.Release(snap1); err==nil { t.Fatal("accepted stale barrier snapshot") }
	reader:=bufio.NewReader(unixConn)
	var helperTID, spawned, childPID, childTID, rawChild int
	seen := map[string]bool{}
	for len(seen) < 4 {
		line, err := reader.ReadString('\n'); if err != nil { t.Fatal(err) }
		fields := strings.Fields(line); if len(fields) == 0 { t.Fatal("empty record") }
		kind := fields[0]; want := 2; if kind == "CHILD" { want = 3 }
		if kind != "CHILD" && kind != "LIVE" && kind != "SPAWN" && kind != "RAW" { t.Fatalf("unknown record %q", line) }
		if len(fields) != want || seen[kind] { t.Fatalf("invalid record %q", line) }
		a, e := strconv.Atoi(fields[1]); if e != nil || a <= 0 { t.Fatal("invalid identity") }
		switch kind { case "RAW": rawChild = a; case "LIVE": helperTID = a; case "SPAWN": spawned = a; case "CHILD": childPID = a; childTID, e = strconv.Atoi(fields[2]); if e != nil || childTID <= 0 { t.Fatal("invalid child tid") } }
		seen[kind] = true
	}
	if spawned != childPID || childPID == cmd.Process.Pid { t.Fatal("descendant mismatch") }
	snap2, err := tracker.Freeze(ctx); if err != nil { t.Fatal(err) }
	if childFirst.Load() == 0 { t.Fatal("child stop was never delivered before its parent event") }
		if !hasTask(snap2, rawChild, 1) { t.Fatal("raw SYS_fork child absent from stopped task set") }
		if !hasTask(snap2, cmd.Process.Pid, 1) || !hasTask(snap2, helperTID, 1) || !hasTask(snap2, childTID, 3) || !hasTask(snap2, childPID, 3) { t.Fatalf("missing executed tasks: %+v", snap2.tasks) }
	groups := map[int]bool{}; for _, task := range snap2.tasks { groups[task.TGID] = true; _, state, e := readTaskStatus(task.TID); id, x := procIdentity(task.TID); if e != nil || x != nil || state != 't' || id.StartTicks != task.StartTicks || id.TGID != task.TGID { t.Fatal("task identity or stop mismatch") } }
	seenTIDs := map[int]bool{}; for group := range groups { entries, e := os.ReadDir(fmt.Sprintf("/proc/%d/task", group)); if e != nil { t.Fatal(e) }; for _, entry := range entries { tid, e := strconv.Atoi(entry.Name()); if e != nil { t.Fatal(e) }; seenTIDs[tid] = true } }; if len(seenTIDs) != len(snap2.tasks) { t.Fatal("task set mismatch") }; for _, task := range snap2.tasks { if !seenTIDs[task.TID] { t.Fatal("missing task") } }
	if old, e := tracker.AdvanceTransfer(ctx, snap2, -1, 0); e == nil || old != snap2 { t.Fatal("invalid request changed barrier") }
	rights, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0); if e != nil { t.Fatal(e) }; rightRead, rightWrite := os.NewFile(uintptr(rights[0]), "rights-read"), os.NewFile(uintptr(rights[1]), "rights-write"); defer rightRead.Close(); defer rightWrite.Close()
	link, e := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", rightRead.Fd())); if e != nil { t.Fatal(e) }; inode, socket, ok := parseSocketLink(link); if !ok || !socket { t.Fatal("invalid socket inode") }
	if n, e := unixConn.Write([]byte{'R'}); e != nil || n != 1 { t.Fatalf("command write %d: %v", n, e) }
	oob := syscall.UnixRights(int(rightRead.Fd())); n, oobn, e := unixConn.WriteMsgUnix([]byte{'T'}, oob, nil); if e != nil || n != 1 || oobn != len(oob) { t.Fatalf("rights write %d/%d: %v", n, oobn, e) }
			transferCtx := ctx
			cancelTransfer := func() {}
			if receivingFD == 1 {
				transferCtx, cancelTransfer = context.WithTimeout(ctx, 2*time.Second)
			}
			defer cancelTransfer()
			snap3, e := tracker.AdvanceTransfer(transferCtx, snap2, helperTID, receivingFD)
			if receivingFD == 1 {
				if e == nil || snap3 != nil { t.Fatal("wrong recvmsg descriptor advanced barrier") }
				if !errors.Is(transferCtx.Err(), context.DeadlineExceeded) || ctx.Err() != nil { t.Fatalf("wrong-fd wait ended without its deadline: transfer=%v outer=%v", transferCtx.Err(), ctx.Err()) }
				select { case <-tracker.done: case <-ctx.Done(): t.Fatal("wrong-fd progress did not close tracker") }
				return
			}
			if e != nil { t.Fatal(e) }
			if snap3.generation <= snap2.generation || !hasTask(snap3, childTID, 3) { t.Fatal("new barrier lost descendant") }; if e := tracker.Release(snap2); e == nil { t.Fatal("stale release accepted") }; if _, e := tracker.AdvanceTransfer(ctx, snap2, helperTID, 0); e == nil { t.Fatal("stale transfer accepted") }
			entries, e := os.ReadDir(fmt.Sprintf("/proc/%d/fd", helperTID)); if e != nil { t.Fatal(e) }; found := false; for _, entry := range entries { link, e := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", helperTID, entry.Name())); if e != nil { t.Fatal(e) }; n, s, ok := parseSocketLink(link); if ok && s && n == inode { found = true } }; if !found { t.Fatal("received socket not installed under barrier") }
			if e := tracker.Release(snap3); e != nil { t.Fatal(e) }; ack, e := reader.ReadString('\n'); if e != nil || ack != "ACK\n" { t.Fatalf("ack %q: %v", ack, e) }
		})
	}
}

func hasTask(s *traceSnapshot, tid int, generation uint64) bool { if s == nil { return false }; for _, task := range s.tasks { if task.TID == tid && task.ExecGeneration == generation { return true } }; return false }
