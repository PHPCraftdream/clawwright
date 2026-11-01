//go:build linux && amd64

package admission

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
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
