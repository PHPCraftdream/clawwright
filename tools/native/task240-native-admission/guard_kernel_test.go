//go:build linux && amd64

package admission

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestGuardedTraceKernelRejectsExec(t *testing.T) {
	stub := os.Getenv("TASK240_STUB")
	if stub == "" {
		t.Fatal("TASK240_STUB must name the immutable CI trace stub")
	}
	image, err := os.Executable()
	if err != nil { t.Fatal(err) }
	imageFile, err := os.Open(image)
	if err != nil { t.Fatal(err) }
	defer imageFile.Close()
	info, err := imageFile.Stat()
	if err != nil { t.Fatal(err) }
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || st.Uid != 0 || st.Mode&022 != 0 || st.Mode&0111 == 0 || st.Nlink != 1 {
		t.Fatalf("approved helper image must satisfy exact fd3 trust rules: %s", image)
	}
	stubInfo, err := os.Lstat(stub)
	if err != nil { t.Fatal(err) }
	stubStat, ok := stubInfo.Sys().(*syscall.Stat_t)
	if !ok || stubInfo.Mode()&os.ModeSymlink != 0 || !stubInfo.Mode().IsRegular() || stubStat.Uid != 0 || stubStat.Mode&022 != 0 || stubStat.Mode&0111 == 0 || stubStat.Nlink != 1 {
		t.Fatal("TASK240_STUB fails trusted executable rules")
	}

	gateR, gateW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer gateR.Close()
	defer gateW.Close()
	specR, specW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer specR.Close()
	defer specW.Close()
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil { t.Fatal(err) }
	defer null.Close()
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer stdoutR.Close()
	defer stdoutW.Close()
	cmd := exec.Command(stub)
	cmd.Env = []string{}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, stdoutW, null
	cmd.ExtraFiles = []*os.File{imageFile, gateR, specR}
	if err := cmd.Start(); err != nil { t.Fatal(err) }
	defer func() { _ = cmd.Process.Release() }()
	if err := stdoutW.Close(); err != nil { t.Fatal(err) }
	if err := gateR.Close(); err != nil { t.Fatal(err) }
	if err := specR.Close(); err != nil { t.Fatal(err) }

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type guardRecord struct { tid int; generation uint64; err error }
	records := make(chan guardRecord, 1)
	tracker, err := NewGuardedTraceTracker(ctx, cmd.Process.Pid, func(tid int, generation uint64) error {
		records <- guardRecord{tid: tid, generation: generation, err: errTrace}
		return errTrace
	})
	if err != nil { t.Fatalf("seize trusted stub: %v", err) }
	defer tracker.Close()

	packet := []byte("OCARGV01")
	var word [4]byte
	binary.BigEndian.PutUint32(word[:], 4)
	packet = append(packet, word[:]...)
	put := func(s string) {
		binary.BigEndian.PutUint32(word[:], uint32(len(s)))
		packet = append(packet, word[:]...)
		packet = append(packet, s...)
	}
	put(image)
	put(admissionHelperArg)
	put("--")
	put("OCARGV01-helper")
	binary.BigEndian.PutUint32(word[:], 1)
	packet = append(packet, word[:]...)
	put("CLAWWRIGHT_NATIVE_SOCKET=task244-proof")
	writeAll := func(f *os.File, b []byte) error {
		for len(b) > 0 {
			n, e := f.Write(b)
			if e != nil { return e }
			if n == 0 { return io.ErrShortWrite }
			b = b[n:]
		}
		return nil
	}
	if err := writeAll(specW, packet); err != nil { t.Fatalf("write argv packet: %v", err) }
	if err := specW.Close(); err != nil { t.Fatal(err) }
	if n, err := gateW.Write([]byte{0xa5}); err != nil || n != 1 { t.Fatalf("write gate byte %d: %v", n, err) }
	if err := gateW.Close(); err != nil { t.Fatal(err) }

	select {
	case got := <-records:
		if got.tid != cmd.Process.Pid || got.generation != 1 { t.Fatalf("guard identity=(%d,%d), want (%d,1)", got.tid, got.generation, cmd.Process.Pid) }
		if !errors.Is(got.err, errTrace) { t.Fatalf("guard error %v, want errTrace", got.err) }
	case <-ctx.Done():
		t.Fatalf("exec guard was not called: %v", ctx.Err())
	}
	select {
	case <-tracker.done:
	case <-ctx.Done(): t.Fatalf("tracker cleanup did not finish: %v", ctx.Err())
	}
	if err := stdoutR.SetReadDeadline(time.Now().Add(time.Second)); err != nil { t.Fatal(err) }
	out, err := io.ReadAll(io.LimitReader(stdoutR, 4097))
	if err != nil { t.Fatalf("read helper stdout: %v", err) }
	if len(out) != 0 { t.Fatalf("rejected helper produced stdout: %q", out) }
}

func TestTraceConstructorKernelSeizeRefusal(t *testing.T) {
	stub := os.Getenv("TASK240_STUB")
	if stub == "" {
		t.Fatal("TASK240_STUB must name the immutable CI trace stub")
	}
	image, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	imageFile, err := os.Open(image)
	if err != nil {
		t.Fatal(err)
	}
	defer imageFile.Close()
	info, err := imageFile.Stat()
	if err != nil {
		t.Fatal(err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || st.Uid != 0 || st.Mode&022 != 0 || st.Mode&0111 == 0 || st.Nlink != 1 {
		t.Fatalf("approved helper image must satisfy exact fd3 trust rules: %s", image)
	}
	gateR, gateW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer gateR.Close()
	defer gateW.Close()
	specR, specW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer specR.Close()
	defer specW.Close()
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	cmd := exec.Command(stub)
	cmd.Env = []string{}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, null, null
	cmd.ExtraFiles = []*os.File{imageFile, gateR, specR}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Release() }()
	_ = gateR.Close()
	_ = specR.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := NewGuardedTraceTracker(ctx, cmd.Process.Pid, func(int, uint64) error { return nil })
	if err != nil {
		_ = cmd.Process.Kill()
		if ctx.Err() == nil {
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				var status syscall.WaitStatus
				pid, waitErr := syscall.Wait4(cmd.Process.Pid, &status, syscall.WNOHANG, nil)
				if pid == cmd.Process.Pid || errors.Is(waitErr, syscall.ECHILD) {
					break
				}
				if waitErr != nil && !errors.Is(waitErr, syscall.EINTR) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		t.Fatalf("first seize trusted stub: %v", err)
	}
	defer first.Close()
	second, err := NewGuardedTraceTracker(ctx, cmd.Process.Pid, func(int, uint64) error { return nil })
	if second != nil {
		second.Close()
		t.Fatal("second tracker unexpectedly seized already-owned process")
	}
	stage, errno, ok := TraceConstructorFailure(err)
	if !ok || stage != "seize" || errno != syscall.EPERM || !errors.Is(err, syscall.EPERM) || !errors.Is(err, errTrace) {
		t.Fatalf("second constructor failure=(%q,%v,%v), err=%v; want seize/EPERM wrapping errTrace", stage, errno, ok, err)
	}
	first.Close()
	select {
	case <-first.done:
	case <-ctx.Done():
		t.Fatalf("first tracker cleanup did not finish: %v", ctx.Err())
	}
	if err := syscall.Kill(cmd.Process.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("stub process still exists after tracker cleanup: %v", err)
	}
	_ = specW.Close()
	_ = gateW.Close()
}


func TestLaunchStubWaitsForPacketEOF(t *testing.T) {
	stub := os.Getenv("TASK240_STUB")
	if stub == "" { t.Fatal("TASK240_STUB must name the immutable CI trace stub") }
	image, err := os.Open("/bin/true")
	if err != nil { t.Fatal(err) }
	defer image.Close()
	info, err := image.Stat()
	if err != nil { t.Fatal(err) }
	trust, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || trust.Uid != 0 || trust.Mode&022 != 0 || trust.Mode&0111 == 0 || trust.Nlink != 1 { t.Fatalf("/bin/true fails fd3 trust rules: %v", info) }
	gateR, gateW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer gateR.Close(); defer gateW.Close()
	specR, specW, err := os.Pipe()
	if err != nil { t.Fatal(err) }
	defer specR.Close(); defer specW.Close()
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil { t.Fatal(err) }
	defer null.Close()
	cmd := exec.Command(stub)
	cmd.Env = []string{}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	cmd.ExtraFiles = []*os.File{image, gateR, specR}
	if err := cmd.Start(); err != nil { t.Fatal(err) }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	reaped := false
	defer func() {
		_ = specW.Close()
		_ = gateW.Close()
		if !reaped {
			_ = cmd.Process.Kill()
			<-waited
		}
	}()
	_ = gateR.Close(); _ = specR.Close()
	packet := []byte("OCARGV01")
	var word [4]byte
	binary.BigEndian.PutUint32(word[:], 1)
	packet = append(packet, word[:]...)
	binary.BigEndian.PutUint32(word[:], uint32(len("ignored")))
	packet = append(packet, word[:]...)
	packet = append(packet, "ignored"...)
	binary.BigEndian.PutUint32(word[:], 0)
	packet = append(packet, word[:]...)
	if _, err := specW.Write(packet); err != nil { t.Fatalf("write valid argv packet: %v", err) }
	if n, err := gateW.Write([]byte{0xa5}); err != nil || n != 1 { t.Fatalf("write gate byte %d: %v", n, err) }
	if err := gateW.Close(); err != nil { t.Fatal(err) }
	deadline := time.NewTimer(2*time.Second)
	defer deadline.Stop()
	blocked := false
	for !blocked {
		select {
		case err := <-waited:
			reaped = true
			t.Fatalf("stub exited before packet EOF: %v", err)
		case <-ctx.Done():
			t.Fatalf("stub did not remain blocked on packet EOF: %v", ctx.Err())
		case <-deadline.C:
			t.Fatal("stub never entered packet read while writer remained open")
		default:
			data, err := os.ReadFile("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/syscall")
			if err == nil {
				fields := strings.Fields(string(data))
				// The remaining read budget proves the complete packet was consumed.
				if len(fields) >= 4 && fields[0] == "0" && fields[3] == "0x"+strconv.FormatUint(uint64(4097-len(packet)), 16) {
					nr, parseErr := strconv.ParseUint(fields[1], 0, 64)
					if parseErr == nil && nr == 5 {
						blocked = true
						break
					}
				}
			}
			time.Sleep(10*time.Millisecond)
		}
	}
	if err := specW.Close(); err != nil { t.Fatal(err) }
	select {
	case err := <-waited:
		reaped = true
		if err != nil { t.Fatalf("stub exit: %v", err) }
	case <-ctx.Done():
		t.Fatalf("stub did not exit after packet EOF: %v", ctx.Err())
	}
}
func TestLaunchStubRejectsRetainedPacketWriter(t *testing.T) {
	stub := os.Getenv("TASK240_STUB")
	if stub == "" { t.Fatal("TASK240_STUB must name the immutable CI trace stub") }
	image, err := os.Open("/bin/true")
	if err != nil { t.Fatal(err) }
	defer image.Close()
	st, err := image.Stat()
	if err != nil { t.Fatal(err) }
	trust, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.Mode().IsRegular() || trust.Uid != 0 || trust.Mode&022 != 0 || trust.Mode&0111 == 0 || trust.Nlink != 1 { t.Fatalf("/bin/true fails fd3 trust rules: %v", st) }
	packet := func(args ...[]byte) []byte {
		b := []byte("OCARGV01")
		put := func(n uint32) { var w [4]byte; binary.BigEndian.PutUint32(w[:], n); b = append(b, w[:]...) }
		put(uint32(len(args))); for _, arg := range args { put(uint32(len(arg))); b = append(b, arg...) }
		return b
	}
	badMagic := packet(); copy(badMagic, []byte("BADMAGIC"))
	argcZero := []byte("OCARGV01"); var word [4]byte; binary.BigEndian.PutUint32(word[:], 0); argcZero = append(argcZero, word[:]...)
	argcMany := []byte("OCARGV01"); binary.BigEndian.PutUint32(word[:], 17); argcMany = append(argcMany, word[:]...)
	argLong := []byte("OCARGV01"); binary.BigEndian.PutUint32(word[:], 1); argLong = append(argLong, word[:]...); binary.BigEndian.PutUint32(word[:], 1025); argLong = append(argLong, word[:]...)
	agg := []byte("OCARGV01"); binary.BigEndian.PutUint32(word[:], 4); agg = append(agg, word[:]...); for _, n := range []int{1023,1023,1023,1} { binary.BigEndian.PutUint32(word[:], uint32(n)); agg = append(agg, word[:]...); if n != 1 { agg = append(agg, bytes.Repeat([]byte{'x'}, n)...)} }
	envBad := packet([]byte("x"))
	binary.BigEndian.PutUint32(word[:], 3)
	envBad = append(envBad, word[:]...)
	envLong := packet([]byte("x"))
	binary.BigEndian.PutUint32(word[:], 1)
	envLong = append(envLong, word[:]...)
	binary.BigEndian.PutUint32(word[:], 769)
	envLong = append(envLong, word[:]...)
	valid := packet([]byte("x"))
	binary.BigEndian.PutUint32(word[:], 0)
	valid = append(valid, word[:]...)
	trailing := append(valid, 0xff)
	cases := []struct{name string; data []byte}{{"bad magic",badMagic},{"argc zero",argcZero},{"argc 17",argcMany},{"argument length 1025",argLong},{"aggregate argv budget",agg},{"environment count 3",envBad},{"environment length 769",envLong},{"valid framing with trailing byte", trailing}}
	for _, tc := range cases { t.Run(tc.name, func(t *testing.T) {
		gateR, gateW, err := os.Pipe(); if err != nil { t.Fatal(err) }; defer gateR.Close(); defer gateW.Close()
		specR, specW, err := os.Pipe(); if err != nil { t.Fatal(err) }; defer specR.Close(); defer specW.Close()
		null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0); if err != nil { t.Fatal(err) }; defer null.Close()
		cmd := exec.Command(stub); cmd.Env = []string{}; cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null; cmd.ExtraFiles = []*os.File{image, gateR, specR}
		if err := cmd.Start(); err != nil { t.Fatal(err) }; defer func(){ _ = cmd.Process.Release() }(); _ = gateR.Close(); _ = specR.Close()
		if _, err := specW.Write(tc.data); err != nil {
			_ = specW.Close()
			_ = gateW.Close()
			_ = cmd.Process.Kill()
			errWait := cmd.Wait()
			if errWait == nil {
				t.Fatalf("write refusal packet: %v; process unexpectedly exited successfully", err)
			}
			if exitErr, ok := errWait.(*exec.ExitError); !ok || exitErr.ExitCode() != 111 {
				t.Fatalf("write refusal packet: %v; process exit=%v, want 111", err, errWait)
			}
			t.Fatalf("write refusal packet: %v", err)
		}
		done := make(chan error, 1); go func(){ done <- cmd.Wait() }()
		select { case err := <-done: if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 111 { t.Fatalf("exit=%v, want 111", err) }
		case <-time.After(2*time.Second): _ = cmd.Process.Kill(); <-done; t.Fatal("stub did not reject while packet and gate writers remained open") }
	}) }
}

func TestLaunchStubRefusals(t *testing.T) {
	stub := os.Getenv("TASK240_STUB")
	if stub == "" { t.Fatal("TASK240_STUB must name the immutable CI trace stub") }
	image, err := os.Open("/bin/true")
	if err != nil { t.Fatal(err) }
	defer image.Close()
	st, err := image.Stat()
	if err != nil { t.Fatal(err) }
	trust, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.Mode().IsRegular() || trust.Uid != 0 || trust.Mode&022 != 0 || trust.Mode&0111 == 0 || trust.Nlink != 1 { t.Fatalf("/bin/true fails fd3 trust rules: %v", st) }
	packet := func(args, env []string) []byte {
		b := []byte("OCARGV01")
		put := func(n uint32) { var w [4]byte; binary.BigEndian.PutUint32(w[:], n); b = append(b, w[:]...) }
		put(uint32(len(args)))
		for _, s := range args { put(uint32(len(s))); b = append(b, s...) }
		put(uint32(len(env)))
		for _, s := range env { put(uint32(len(s))); b = append(b, s...) }
		return b
	}
	valid := packet([]string{"ignored"}, nil)
	refusals := []struct { name string; spec, gate []byte; env, args []string; mode string }{
		{"bad magic", append([]byte("BADMAGIC"), valid[8:]...), []byte{0xa5}, nil, nil, ""},
		{"truncated", valid[:len(valid)-1], []byte{0xa5}, nil, nil, ""},
		{"trailing", append(append([]byte(nil), valid...), 1), []byte{0xa5}, nil, nil, ""},
		{"argc zero", packet(nil, nil), []byte{0xa5}, nil, nil, ""},
		{"oversized string", func() []byte { b := []byte("OCARGV01"); var w [4]byte; binary.BigEndian.PutUint32(w[:], 1); b = append(b, w[:]...); binary.BigEndian.PutUint32(w[:], 1025); return append(b, w[:]...) }(), []byte{0xa5}, nil, nil, ""},
		{"invalid utf8", packet([]string{string([]byte{0xff})}, nil), []byte{0xa5}, nil, nil, ""},
		{"unknown environment", packet([]string{"ignored"}, []string{"NOPE=x"}), []byte{0xa5}, nil, nil, ""},
		{"duplicate environment", packet([]string{"ignored"}, []string{"CLAWWRIGHT_NATIVE_SOCKET=x", "CLAWWRIGHT_NATIVE_SOCKET=y"}), []byte{0xa5}, nil, nil, ""},
		{"empty gate", valid, nil, nil, nil, ""}, {"wrong gate", valid, []byte{0}, nil, nil, ""}, {"extra gate", valid, []byte{0xa5, 1}, nil, nil, ""},
		{"inherited environment", valid, []byte{0xa5}, []string{"INHERITED=x"}, nil, ""},
		{"inherited argument", valid, []byte{0xa5}, nil, []string{"surprise"}, ""},
		{"extra fd6", valid, []byte{0xa5}, nil, nil, "extraFD6"},
		{"gate writer", valid, []byte{0xa5}, nil, nil, "gatewriter"},
		{"packet regular", valid, []byte{0xa5}, nil, nil, "packetregular"},
		{"exec writable", valid, []byte{0xa5}, nil, nil, "execmodewritable"},
		{"exec nonregular", valid, []byte{0xa5}, nil, nil, "execnonregular"},
		{"exec multilink", valid, []byte{0xa5}, nil, nil, "execmultilink"},
		{"exec invalid elf", valid, []byte{0xa5}, nil, nil, "execinvalidelf"},
	}
	for _, tc := range refusals { t.Run(tc.name, func(t *testing.T) {
		var e error
		launchImage := image
		var extra *os.File
		if tc.mode == "extraFD6" { extra, e = os.Open(os.DevNull); if e != nil { t.Fatal(e) }; defer extra.Close() }
		if tc.mode == "execnonregular" { launchImage, e = os.Open(os.DevNull); if e != nil { t.Fatal(e) }; defer launchImage.Close() }
		if tc.mode == "execmodewritable" || tc.mode == "execmultilink" || tc.mode == "execinvalidelf" {
			dir := t.TempDir()
			if e = os.Chmod(dir, 0700); e != nil { t.Fatal(e) }
			path := dir + "/image"
			data := []byte("not an ELF executable")
			if tc.mode != "execinvalidelf" { data, e = os.ReadFile("/bin/true"); if e != nil { t.Fatal(e) } }
			mode := os.FileMode(0555); if tc.mode == "execmodewritable" { mode = 0777 }
			if e = os.WriteFile(path, data, mode); e != nil { t.Fatal(e) }
			if tc.mode == "execmodewritable" { if e = os.Chmod(path, 0777); e != nil { t.Fatal(e) } }
			if tc.mode == "execmultilink" { if e = os.Link(path, dir+"/link"); e != nil { t.Fatal(e) } }
			launchImage, e = os.Open(path); if e != nil { t.Fatal(e) }; defer launchImage.Close()
		}
		gateR, gateW, e := os.Pipe(); if e != nil { t.Fatal(e) }; defer gateR.Close(); defer gateW.Close()
		specR, specW, e := os.Pipe(); if e != nil { t.Fatal(e) }; defer specR.Close(); defer specW.Close()
		if tc.mode == "packetregular" { specR.Close(); specR, e = os.Open(os.DevNull); if e != nil { t.Fatal(e) } }
		null, e := os.OpenFile(os.DevNull, os.O_RDWR, 0); if e != nil { t.Fatal(e) }; defer null.Close()
		cmd := exec.Command(stub, tc.args...)
		cmd.Env = []string{}
		if tc.env != nil { cmd.Env = tc.env }
		cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
		cmd.ExtraFiles = []*os.File{launchImage, gateR, specR}
		if tc.mode == "gatewriter" { cmd.ExtraFiles = []*os.File{launchImage, gateW, specR} }
		if extra != nil { cmd.ExtraFiles = append(cmd.ExtraFiles, extra) }
		if e = cmd.Start(); e != nil { t.Fatal(e) }
		_ = specR.Close()
		if tc.mode != "gatewriter" { _ = gateR.Close() }
		writePipe := func(f *os.File, data []byte) error { for len(data) > 0 { n, err := f.Write(data); if err != nil { return err }; if n == 0 { return io.ErrShortWrite }; data = data[n:] }; return nil }
		var writeErr error
		if len(tc.spec) > 0 { writeErr = writePipe(specW, tc.spec) }
		_ = specW.Close()
		if writeErr == nil && len(tc.gate) > 0 { writeErr = writePipe(gateW, tc.gate) }
		_ = gateW.Close()
		done := make(chan error, 1); go func() { done <- cmd.Wait() }()
		select {
		case e = <-done:
			if writeErr != nil && !errors.Is(writeErr, syscall.EPIPE) { t.Fatalf("write refusal input: %v", writeErr) }
			if e == nil { t.Fatal("stub accepted invalid launch") } else if x, ok := e.(*exec.ExitError); !ok || x.ExitCode() != 111 { t.Fatalf("exit=%v, want 111", e) }
		case <-time.After(5*time.Second): _ = cmd.Process.Kill(); <-done; t.Fatal("stub refusal timed out")
		}
	}) }
}
