package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	admission "clawforge/tools/native/task240-native/task240-native-admission"
)

type nativeRequest245 struct {
	ProtocolVersion int      `json:"protocolVersion"`
	Provider        string   `json:"provider"`
	IDs             []string `json:"ids"`
}

func parseNativeRequest245(b []byte) (nativeRequest245, error) {
	var r nativeRequest245
	if len(b) == 0 || len(b) > 4096 || !utf8.Valid(b) || duplicateJSON(b) != nil { return r, errSupervisor }
	var top map[string]json.RawMessage
	if json.Unmarshal(b, &top) != nil || len(top) != 3 { return r, errSupervisor }
	for _, k := range []string{"protocolVersion", "provider", "ids"} { if _, ok := top[k]; !ok { return r, errSupervisor } }
	d := json.NewDecoder(strings.NewReader(string(b))); d.DisallowUnknownFields()
	if d.Decode(&r) != nil || d.Decode(new(any)) != io.EOF || r.ProtocolVersion != 1 || r.Provider != "clawwright-ssjack" || len(r.IDs) != 1 || r.IDs[0] != "gateway-token" { return r, errSupervisor }
	return r, nil
}

func pendingCustody(tasks []admission.TaskIdentity, pair admission.UnixPair, provider, gateway int, brokers []int) (bool, error) {
	bad := func() (bool, error) { return false, errSupervisor }
	wrongWriter := func() (bool, error) { return false, errUnexpectedWriter245 }
	if len(tasks) == 0 || len(tasks) > 4096 || provider <= 0 || gateway <= 0 || pair.Writer.Inode == 0 || pair.Reader.Inode == 0 { return bad() }
	allowed := map[int]bool{gateway: true}
	for _, id := range brokers { if id <= 0 { return bad() }; allowed[id] = true }
	writer, reader := false, false
	for _, task := range tasks {
		if task.TID <= 0 || task.TGID <= 0 { return bad() }
		fdDir := filepath.Join("/proc", strconv.Itoa(task.TID), "fd")
		entries, err := os.ReadDir(fdDir); if err != nil || len(entries) > 4096 { return bad() }
		for _, entry := range entries {
			fd, err := strconv.Atoi(entry.Name()); if err != nil || fd < 0 { return bad() }
			target, err := os.Readlink(filepath.Join(fdDir, entry.Name())); if err != nil { return bad() }
			prefix := "socket:["
			if !strings.HasPrefix(target, prefix) { continue }
			if len(target) <= len(prefix) || target[len(target)-1] != ']' { return bad() }
			inode, err := strconv.ParseUint(target[len(prefix):len(target)-1], 10, 32); if err != nil || inode == 0 { return bad() }
			if uint32(inode) == pair.Writer.Inode { if task.TGID != provider || fd != 1 { return wrongWriter() }; writer = true }
			if uint32(inode) == pair.Reader.Inode { if !allowed[task.TGID] { return bad() }; if task.TGID == gateway { reader = true } }
		}
	}
	if !writer { return bad() }
	return reader, nil
}

func prepareCaptureEvidence(ctx context.Context, path string) (*os.File, error) {
	if path == "" { return nil, nil }
	const fixed = "/run/native-capture-ok"
	bad := func() (*os.File, error) { return nil, errSupervisor }
	if path != fixed { return bad() }
	if _, e := os.Lstat(fixed); e == nil || !os.IsNotExist(e) { return bad() }
	fd, e := syscall.InotifyInit1(syscall.IN_NONBLOCK | syscall.IN_CLOEXEC); if e != nil { return bad() }
	watch, e := syscall.InotifyAddWatch(fd, "/run", syscall.IN_CLOSE_WRITE); if e != nil || watch < 0 { _ = syscall.Close(fd); return bad() }
	f := os.NewFile(uintptr(fd), "capture-evidence-inotify"); if f == nil { _ = syscall.Close(fd); return bad() }
	dl, ok := ctx.Deadline(); if !ok || f.SetReadDeadline(dl) != nil { _ = f.Close(); return bad() }
	return f, nil
}

func waitCaptureEvidence(f *os.File) error {
	if f == nil { return nil }
	const fixed = "/run/native-capture-ok"
	bad := func() error { return errSupervisor }
	buf := make([]byte, 4096)
	for {
		n, e := f.Read(buf); if e != nil || n < 16 { return bad() }
		for off := 0; off < n; {
			if n-off < 16 { return bad() }
			wd := int32(binary.LittleEndian.Uint32(buf[off:]))
			mask := binary.LittleEndian.Uint32(buf[off+4:])
			nameLen := int(binary.LittleEndian.Uint32(buf[off+12:]))
			end := off + 16 + nameLen
			if nameLen > n-off-16 || end > n { return bad() }
			name := strings.TrimRight(string(buf[off+16:end]), "\x00")
			if wd >= 0 && name == "native-capture-ok" && mask&syscall.IN_CLOSE_WRITE != 0 {
				mfd, x := syscall.Open(fixed, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0); if x != nil { return bad() }
				mf := os.NewFile(uintptr(mfd), "capture-evidence"); if mf == nil { _ = syscall.Close(mfd); return bad() }; defer mf.Close()
				var st syscall.Stat_t
				if syscall.Fstat(mfd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != 0600 || st.Uid != uint32(os.Getuid()) || st.Nlink != 1 || st.Size != 8 { return bad() }
				proof := make([]byte, 8); if _, x = io.ReadFull(mf, proof); x != nil || string(proof) != "OCCAP001" { return bad() }
				var extra [1]byte; if k, x := mf.Read(extra[:]); k != 0 || x != io.EOF { return bad() }
				return nil
			}
			off = end
		}
	}
}

type sendSchedule245 struct {
	afterSend func(int) error
	backpressure func() error
}

func serveAdmitted(ctx context.Context, control *os.File, provider *net.UnixConn, tracker *admission.TraceTracker, gatewayPID, providerPID int, brokerPIDs []int, header [64]byte, target, revision, purpose, captureEvidence string) error {
	return serveAdmitted245(ctx, control, provider, tracker, gatewayPID, providerPID, brokerPIDs, header, target, revision, purpose, captureEvidence, nil)
}

func serveAdmitted245(ctx context.Context, control *os.File, provider *net.UnixConn, tracker *admission.TraceTracker, gatewayPID, providerPID int, brokerPIDs []int, header [64]byte, target, revision, purpose, captureEvidence string, schedule *sendSchedule245) error {
	bad := func() error { return errSupervisor }
	if ctx == nil || control == nil || provider == nil || tracker == nil || gatewayPID <= 0 || providerPID <= 0 || len(brokerPIDs) > 64 || ctx.Err() != nil || string(header[:8]) != "SSINK001" || binary.BigEndian.Uint64(header[56:]) == 0 || binary.BigEndian.Uint64(header[56:]) > 16384 { return bad() }
	defer tracker.Close()
	deadline, ok := ctx.Deadline(); if !ok { return bad() }; if provider.SetDeadline(deadline) != nil || control.SetDeadline(deadline) != nil { return bad() }
	raw, e := provider.SyscallConn(); if e != nil { return bad() }; var cred *syscall.Ucred; var ce error
	if raw.Control(func(fd uintptr) { cred, ce = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED) }) != nil || ce != nil || cred == nil || int(cred.Pid) != providerPID || cred.Uid != uint32(os.Getuid()) { return bad() }
	st, e := os.Stat("/proc/" + strconv.Itoa(providerPID) + "/fd/1"); if e != nil { return bad() }; ps, ok := st.Sys().(*syscall.Stat_t); if !ok || st.Mode()&os.ModeSocket == 0 || ps.Ino == 0 || ps.Ino > 0xffffffff { return bad() }; inode := uint32(ps.Ino)
	var nbuf [4]byte; if _, e = io.ReadFull(provider, nbuf[:]); e != nil { return bad() }; n := binary.BigEndian.Uint32(nbuf[:]); if n == 0 || n > 4096 { return bad() }; meta := make([]byte, int(n)); defer clear(meta); if _, e = io.ReadFull(provider, meta); e != nil { return bad() }; if _, e = parseNativeRequest245(meta); e != nil { return bad() }
	snapshot, e := tracker.Freeze(ctx); if e != nil { return bad() }
	pair, e := admission.ObserveUnixPair(ctx, inode); if e != nil { return bad() }
	var obs *admission.KernelObservation
	for attempt := 0; attempt < 5; attempt++ {
		tasks, _, x := admission.SnapshotTasks(tracker, snapshot); if x != nil { return bad() }
		 hasReader, x := pendingCustody(tasks, pair, providerPID, gatewayPID, brokerPIDs); if x != nil { return x }
		if hasReader { obs, x = admission.ObserveHeldKernelState(ctx, tracker, snapshot, providerPID, gatewayPID, brokerPIDs, inode, header); if x != nil { return bad() }; break }
		candidates, _, x := tracker.Candidates(snapshot); if x != nil { return bad() }; var chosen *admission.RecvCandidate; count := 0
		for i := range candidates { c := &candidates[i]; if c.TGID == gatewayPID { chosen = c; count++ } }
		if count != 1 || attempt == 4 { return bad() }; snapshot, x = tracker.AdvanceTransfer(ctx, snapshot, chosen.TID, chosen.FD); if x != nil { return bad() }
	}
	if obs == nil { return bad() }; defer obs.Close()
	captureWatch, e := prepareCaptureEvidence(ctx, captureEvidence); if e != nil { return bad() }; if captureWatch != nil { defer captureWatch.Close() }
	payloadLen := binary.BigEndian.Uint64(header[56:]); record := make([]byte, 92); copy(record, "OCADMIT1"); copy(record[8:24], header[8:24]); copy(record[24:56], header[24:56]); binary.BigEndian.PutUint32(record[56:60], obs.Endpoints.Writer.Inode); binary.BigEndian.PutUint32(record[60:64], obs.Endpoints.Writer.Cookie[0]); binary.BigEndian.PutUint32(record[64:68], obs.Endpoints.Writer.Cookie[1]); binary.BigEndian.PutUint32(record[68:72], obs.Endpoints.Reader.Inode); binary.BigEndian.PutUint32(record[72:76], obs.Endpoints.Reader.Cookie[0]); binary.BigEndian.PutUint32(record[76:80], obs.Endpoints.Reader.Cookie[1]); binary.BigEndian.PutUint64(record[80:88], obs.BarrierGeneration); binary.BigEndian.PutUint32(record[88:92], uint32(payloadLen))
	if ctx.Err() != nil || writeAll245(provider, record) != nil { return bad() }
	ready := make([]byte, 160); copy(ready, "SSRDY001"); copy(ready[8:64], header[8:64]); a, b, c := sha256.Sum256([]byte(target)), sha256.Sum256([]byte(revision)), sha256.Sum256([]byte(purpose)); copy(ready[64:96], a[:]); copy(ready[96:128], b[:]); copy(ready[128:], c[:])
	if ctx.Err() != nil { return bad() }; m, e := control.Write(ready); if e != nil || m != len(ready) { return bad() }
	if e = obs.ReleaseBarrier(); e != nil { return bad() }
	buf := make([]byte, int(payloadLen)+1); defer clear(buf); nread, readErr := control.Read(buf); if readErr != nil || nread != int(payloadLen) || ctx.Err() != nil { return bad() }; buf = buf[:nread]
	lastGeneration := obs.BarrierGeneration
	for off := 0; off < len(buf); {
		if ctx.Err() != nil { return bad() }
		nextSnapshot, x := tracker.Freeze(ctx); if x != nil { return bad() }
		fresh, x := admission.ObserveHeldKernelState(ctx, tracker, nextSnapshot, providerPID, gatewayPID, brokerPIDs, inode, header)
		if x != nil { return bad() }
		if fresh.Endpoints != pair || fresh.KeeperNonce != obs.KeeperNonce || fresh.KeeperBinding != obs.KeeperBinding || fresh.BarrierGeneration <= lastGeneration { _ = fresh.Close(); return bad() }
		lastGeneration = fresh.BarrierGeneration
		info, x := os.Stat("/proc/" + strconv.Itoa(providerPID) + "/fd/1"); if x != nil { _ = fresh.Close(); return bad() }; fdst, ok := info.Sys().(*syscall.Stat_t); if !ok || fdst.Mode&syscall.S_IFMT != syscall.S_IFSOCK || fdst.Ino != uint64(inode) { _ = fresh.Close(); return bad() }
		end := off + 4096; if end > len(buf) { end = len(buf) }
		fd, x := provider.SyscallConn(); if x != nil { _ = fresh.Close(); return bad() }; var wn int; var we error
		if fd.Control(func(raw uintptr) { if ctx.Err() != nil { we = ctx.Err(); return }; wn, we = syscall.SendmsgN(int(raw), buf[off:end], nil, nil, syscall.MSG_DONTWAIT|syscall.MSG_NOSIGNAL) }) != nil { _ = fresh.Close(); return bad() }
		if we != nil && wn > 0 { _ = fresh.Close(); return bad() }
		if we == syscall.EINTR || we == syscall.EAGAIN || we == syscall.EWOULDBLOCK {
			if fresh.ReleaseBarrier() != nil { _ = fresh.Close(); return bad() }
			if (we == syscall.EAGAIN || we == syscall.EWOULDBLOCK) && schedule != nil && schedule.backpressure != nil { if schedule.backpressure() != nil { _ = fresh.Close(); return bad() } }
			timer := time.NewTimer(5 * time.Millisecond)
			select { case <-ctx.Done(): timer.Stop(); return bad(); case <-timer.C: }
			continue
		}
		if we != nil || wn <= 0 || wn > end-off { _ = fresh.Close(); return bad() }
		if fresh.ReleaseBarrier() != nil { _ = fresh.Close(); return bad() }; off += wn
		if schedule != nil && schedule.afterSend != nil { if schedule.afterSend(off) != nil { return bad() } }
		if off < len(buf) {
			timer := time.NewTimer(5 * time.Millisecond)
			select { case <-ctx.Done(): timer.Stop(); return bad(); case <-timer.C: }
		}
	}
	var ack [56]byte; if _, e = io.ReadFull(provider, ack[:]); e != nil || string(ack[:8]) != "OCPIPE01" || string(ack[8:24]) != string(header[8:24]) || string(ack[24:]) != string(header[24:56]) { return bad() }; var extra [1]byte; if n, e := provider.Read(extra[:]); n != 0 || e != io.EOF { return bad() }
	if waitCaptureEvidence(captureWatch) != nil { return bad() }
	sum := sha256.Sum256(buf); var out [96]byte; copy(out[:8], "SSACK001"); copy(out[8:64], header[8:64]); copy(out[64:], sum[:]); if ctx.Err() != nil { return bad() }; m, e = control.Write(out[:]); if e != nil || m != len(out) { return bad() }; return nil
}

func writeAll245(w io.Writer, b []byte) error { for len(b) > 0 { n, e := w.Write(b); if e != nil { return e }; if n <= 0 { return io.ErrShortWrite }; b = b[n:] }; return nil }
