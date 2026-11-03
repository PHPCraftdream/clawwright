//go:build linux && amd64

package main

import (
	"encoding/binary"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

const (
	socketPath   = "/run/clawwright-native.sock"
	casePath     = "/etc/release-case"
	providerPath = "/usr/libexec/release-provider"
	request      = `{"protocolVersion":1,"provider":"clawwright-ssjack","ids":["gateway-token"]}`
)

func fail(code int) {
	_, _ = io.WriteString(os.Stderr, "release-fixture: code="+strconv.Itoa(code)+"\n")
	os.Exit(code)
}

func exactRead(fd int, data []byte) bool {
	for len(data) > 0 {
		n, err := syscall.Read(fd, data)
		if err == syscall.EINTR {
			continue
		}
		if err != nil || n == 0 {
			return false
		}
		data = data[n:]
	}
	return true
}

func exactWrite(fd int, data []byte) bool {
	for len(data) > 0 {
		n, err := syscall.Write(fd, data)
		if err == syscall.EINTR {
			continue
		}
		if err != nil || n == 0 {
			return false
		}
		data = data[n:]
	}
	return true
}

func marker(path string) {
	fd, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		fail(12)
	}
	writeOK := exactWrite(fd, []byte("M"))
	if writeOK {
		writeOK = syscall.Fsync(fd) == nil
	}
	closeErr := syscall.Close(fd)
	if !writeOK || closeErr != nil {
		fail(12)
	}
}

func scenario() int {
	fd, err := syscall.Open(casePath, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		fail(10)
	}
	var stat syscall.Stat_t
	statOK := syscall.Fstat(fd, &stat) == nil &&
		stat.Mode&syscall.S_IFMT == syscall.S_IFREG && stat.Uid == 0 && stat.Mode&022 == 0
	if !statOK {
		_ = syscall.Close(fd)
		fail(10)
	}

	data := make([]byte, 32)
	n, readErr := syscall.Read(fd, data)
	closeErr := syscall.Close(fd)
	if readErr != nil || closeErr != nil {
		fail(11)
	}

	switch string(data[:n]) {
	case "positive\n":
		return 0
	case "wrong-holder\n":
		return 1
	case "partial-ack\n":
		return 2
	case "lost-ack\n":
		return 3
	case "cancel\n":
		return 4
	case "unexpected-exec\n":
		return 5
	case "between-write-holder\n":
		return 6
	case "backpressure\n":
		return 7
	default:
		fail(11)
	}
	return 0
}

func provider() int {
	mode := scenario()
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		fail(20)
	}
	if err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: socketPath}); err != nil {
		fail(21)
	}

	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(request)))
	if !exactWrite(fd, length[:]) || !exactWrite(fd, []byte(request)) {
		fail(22)
	}
	var admission [92]byte
	if !exactRead(fd, admission[:]) {
		fail(23)
	}
	if string(admission[:8]) != "OCADMIT1" {
		fail(24)
	}
	payloadSize := binary.BigEndian.Uint32(admission[88:])
	if payloadSize < 1 || payloadSize > 16384 {
		fail(25)
	}

	if mode == 1 && syscall.Dup2(1, 7) != nil {
		fail(26)
	}
	marker("/run/release-mutated")
	if mode == 6 {
		first := make([]byte, 4096)
		if !exactRead(fd, first) {
			fail(26)
		}
		for i := range first {
			first[i] = 0
		}
		marker("/run/release-received")
		if syscall.Dup2(1, 7) != nil {
			fail(26)
		}
		marker("/run/release-mutated-after")
		for {
			var extra [1]byte
			n, readErr := syscall.Read(fd, extra[:])
			if readErr == syscall.EINTR {
				continue
			}
			if n > 0 {
				marker("/run/release-extra")
			}
			idle()
		}
	}
	if mode == 5 {
		if err := syscall.Exec(providerPath, []string{providerPath, "unexpected"}, os.Environ()); err != nil {
			fail(33)
		}
	}
	if mode == 7 {
		for {
			if _, err := os.Stat("/run/release-drain"); err == nil {
				break
			}
			time.Sleep(time.Millisecond)
		}
	}

	payload := make([]byte, int(payloadSize))
	got := 0
	for got < len(payload) {
		n, readErr := syscall.Read(fd, payload[got:])
		if readErr == syscall.EINTR {
			continue
		}
		if readErr != nil || n == 0 {
			fail(27)
		}
		if got == 0 {
			marker("/run/release-received")
		}
		got += n
	}

	receipt := make([]byte, 56)
	copy(receipt, "OCPIPE01")
	copy(receipt[8:], admission[8:56])
	switch mode {
	case 2:
		if !exactWrite(fd, receipt[:28]) || syscall.Shutdown(fd, syscall.SHUT_WR) != nil {
			fail(28)
		}
	case 3:
		if syscall.Shutdown(fd, syscall.SHUT_WR) != nil {
			fail(28)
		}
	case 4:
	default:
		if !exactWrite(fd, receipt) || syscall.Shutdown(fd, syscall.SHUT_WR) != nil {
			fail(28)
		}
	}
	for i := range payload {
		payload[i] = 0
	}
	idle()
	return 0
}

func idle(files ...*os.File) {
	for {
		time.Sleep(time.Second)
		for _, file := range files {
			runtime.KeepAlive(file)
		}
	}
}

func sendReader(controlFD, readerFD int) error {
	return syscall.Sendmsg(controlFD, []byte{'F'}, syscall.UnixRights(readerFD), nil, 0)
}

func broker() int {
	controlFD := 3
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		fail(30)
	}
	outputReader := pair[0]
	output := os.NewFile(uintptr(pair[1]), "provider-output")
	inputReader, inputWriter, err := os.Pipe()
	if err != nil {
		_ = output.Close()
		_ = syscall.Close(outputReader)
		fail(30)
	}

	cmd := exec.Command(providerPath)
	cmd.Stdin = inputReader
	cmd.Stdout = output
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		_ = inputReader.Close()
		_ = inputWriter.Close()
		_ = output.Close()
		_ = syscall.Close(outputReader)
		fail(32)
	}
	_ = inputReader.Close()
	_ = output.Close()
	if _, err := io.WriteString(inputWriter, request); err != nil {
		_ = inputWriter.Close()
		_ = syscall.Close(outputReader)
		fail(34)
	}
	_ = inputWriter.Close()
	if sendReader(controlFD, outputReader) != nil {
		_ = syscall.Close(outputReader)
		fail(35)
	}
	_ = syscall.Close(outputReader)
	idle()
	return 0
}

func closeRights(messages []syscall.SocketControlMessage) {
	for i := range messages {
		if messages[i].Header.Level != syscall.SOL_SOCKET || messages[i].Header.Type != syscall.SCM_RIGHTS {
			continue
		}
		fds, err := syscall.ParseUnixRights(&messages[i])
		if err != nil {
			continue
		}
		for _, fd := range fds {
			_ = syscall.Close(fd)
		}
	}
}

func gateway() int {
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		fail(40)
	}
	controlFile := os.NewFile(uintptr(pair[1]), "control-fd3")
	cmd := exec.Command("/usr/bin/node", "broker")
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	cmd.ExtraFiles = []*os.File{controlFile}
	if err := cmd.Start(); err != nil {
		_ = controlFile.Close()
		_ = syscall.Close(pair[0])
		fail(41)
	}
	_ = controlFile.Close()

	data := []byte{0}
	control := make([]byte, syscall.CmsgSpace(4))
	n, controlN, flags, _, err := syscall.Recvmsg(pair[0], data, control, syscall.MSG_CMSG_CLOEXEC)
	if err != nil || n != 1 || data[0] != 'F' || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 {
		messages, _ := syscall.ParseSocketControlMessage(control[:controlN])
		closeRights(messages)
		_ = syscall.Close(pair[0])
		fail(45)
	}
	messages, err := syscall.ParseSocketControlMessage(control[:controlN])
	if err != nil || len(messages) != 1 || messages[0].Header.Level != syscall.SOL_SOCKET || messages[0].Header.Type != syscall.SCM_RIGHTS || messages[0].Header.Len != uint64(syscall.CmsgLen(4)) {
		closeRights(messages)
		_ = syscall.Close(pair[0])
		fail(46)
	}
	fds, err := syscall.ParseUnixRights(&messages[0])
	if err != nil || len(fds) != 1 {
		closeRights(messages)
		_ = syscall.Close(pair[0])
		fail(46)
	}
	reader := os.NewFile(uintptr(fds[0]), "release-reader")
	_ = syscall.Close(pair[0])
	idle(reader)
	return 0
}

func main() {
	time.AfterFunc(20*time.Second, func() {
		_ = syscall.Kill(os.Getpid(), syscall.SIGALRM)
		os.Exit(124)
	})
	args := os.Args[1:]
	if len(args) == 0 {
		_ = provider()
		return
	}
	if len(args) != 1 {
		fail(2)
	}
	switch args[0] {
	case "gateway":
		_ = gateway()
	case "broker":
		_ = broker()
	default:
		fail(2)
	}
}
