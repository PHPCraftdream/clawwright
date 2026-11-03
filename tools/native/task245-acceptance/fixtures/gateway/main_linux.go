//go:build linux && amd64

package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

const (
	providerPath = "/usr/libexec/clawwright-native-provider"
	socketPath  = "/run/clawwright-native.sock"
	markerPath  = "/run/native-capture-ok"
	request     = `{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`
	expected    = "{\"protocolVersion\":1,\"values\":{\"gateway-token\":\"scoped secret\"}}\n"
)

func fail(code int) { os.Exit(code) }

func socketPair() (int, int, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	return fds[0], fds[1], err
}

func sendReader(fd, reader int) error {
	return syscall.Sendmsg(fd, []byte{'F'}, syscall.UnixRights(reader), nil, 0)
}

func receiveCapture(fd int) int {
	control := make([]byte, syscall.CmsgSpace(4))
	data := []byte{0}
	n, oobn, flags, _, err := syscall.Recvmsg(fd, data, control, syscall.MSG_CMSG_CLOEXEC)
	msgs, parseErr := syscall.ParseSocketControlMessage(control[:oobn])
	var received []int
	for i := range msgs {
		if msgs[i].Header.Level == syscall.SOL_SOCKET && msgs[i].Header.Type == syscall.SCM_RIGHTS {
			fds, rightsErr := syscall.ParseUnixRights(&msgs[i])
			if rightsErr == nil {
				received = append(received, fds...)
			}
		}
	}
	defer func() {
		for _, rawFD := range received {
			_ = syscall.Close(rawFD)
		}
	}()
	if err != nil || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || n != 1 || data[0] != 'F' {
		return 30
	}
	if parseErr != nil || len(msgs) != 1 || msgs[0].Header.Level != syscall.SOL_SOCKET || msgs[0].Header.Type != syscall.SCM_RIGHTS || msgs[0].Header.Len != uint64(syscall.CmsgLen(4)) || len(received) != 1 {
		return 31
	}
	buf := make([]byte, 4097)
	defer clear(buf)
	used := 0
	for used < len(buf)-1 {
		n, readErr := syscall.Read(received[0], buf[used:len(buf)-1])
		if n > 0 {
			used += n
			if bytes.IndexByte(buf[:used], '\n') >= 0 {
				break
			}
		}
		if readErr == syscall.EINTR {
			continue
		}
		if readErr != nil || n == 0 {
			return 32
		}
	}
	if used != len(expected) || !bytes.Equal(buf[:used], []byte(expected)) {
		return 33
	}
	return 0
}

func childCommand(path string, args ...string) *exec.Cmd {
	cmd := exec.Command(path, args...)
	cmd.Env = os.Environ()
	return cmd
}

func idleForever(output *os.File) {
	for {
		time.Sleep(time.Hour)
		runtime.KeepAlive(output)
	}
}

func broker(labCase string) int {
	if labCase == "unexpected-exec" {
		err := syscall.Exec("/usr/bin/node", []string{"/usr/bin/node", "unexpected"}, os.Environ())
		if err != nil {
			return 25
		}
	}
	outR, outW, err := socketPair()
	if err != nil {
		return 20
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		_ = syscall.Close(outR)
		_ = syscall.Close(outW)
		return 20
	}
	output := os.NewFile(uintptr(outW), "provider-output")
	cmd := childCommand(providerPath)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, output, os.Stderr
	cmd.Env = []string{"CLAWWRIGHT_NATIVE_SOCKET=" + socketPath}
	if err = cmd.Start(); err != nil {
		_ = syscall.Close(outR)
		_ = inR.Close()
		_ = inW.Close()
		_ = output.Close()
		return 21
	}
	_ = inR.Close()
	if labCase != "wrong-holder" {
		_ = output.Close()
	}
	if _, err = io.WriteString(inW, request); err != nil {
		_ = inW.Close()
		return 22
	}
	if err = inW.Close(); err != nil {
		return 22
	}
	if err = sendReader(3, outR); err != nil {
		return 23
	}
	_ = syscall.Close(outR)
	if err = cmd.Wait(); err != nil {
		return 24
	}
	idleForever(output)
	return 0
}

func gateway(labCase string) int {
	parent, child, err := socketPair()
	if err != nil {
		return 40
	}
	args := []string{"broker"}
	if labCase != "" {
		args = append(args, labCase)
	}
	cmd := exec.Command("/usr/bin/node", args...)
	cmd.Env = os.Environ()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.ExtraFiles = []*os.File{os.NewFile(uintptr(child), "control-fd3")}
	if err = cmd.Start(); err != nil {
		_ = syscall.Close(parent)
		_ = syscall.Close(child)
		return 41
	}
	_ = cmd.ExtraFiles[0].Close()
	result := receiveCapture(parent)
	_ = syscall.Close(parent)
	if result != 0 {
		return result
	}
	fd, err := syscall.Open(markerPath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return 42
	}
	marker := os.NewFile(uintptr(fd), "capture-marker")
	if _, err = io.WriteString(marker, "OCCAP001"); err != nil {
		_ = marker.Close()
		return 43
	}
	if err = marker.Sync(); err != nil {
		_ = marker.Close()
		return 44
	}
	if err = marker.Close(); err != nil {
		return 44
	}
	for {
		time.Sleep(time.Hour)
	}
}

func main() {
	args := os.Args[1:]
	labCase := ""
	if len(args) == 2 && (args[1] == "wrong-holder" || args[1] == "unexpected-exec") {
		labCase = args[1]
	} else if len(args) != 1 {
		fail(2)
	}
	var code int
	switch args[0] {
	case "gateway":
		code = gateway(labCase)
	case "broker":
		code = broker(labCase)
	default:
		fail(2)
	}
	fail(code)
}
