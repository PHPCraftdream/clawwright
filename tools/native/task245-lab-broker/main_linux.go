//go:build linux && amd64

// Disposable, root-only native lab broker; deliberately not wired into production startup.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const brokerSocket = "/run/task245-lab/broker.sock"
const brokerLifetimeLimit = 128

var brokerErr = errors.New("lab broker rejected operation")

type brokerConfig struct {
	RuntimeUID       uint32   `json:"RuntimeUID"`
	RuntimeGID       uint32   `json:"RuntimeGID"`
	Supervisor       string
	SupervisorSHA256 string
	Keeper           string
	KeeperSHA256     string
	Init             string
	InitSHA256       string
	Root             string
	Manifest         string
	ManifestSHA256   string
	Node             string
	Stub             string
	Provider         string
	ConfigPath       string
	NodeSHA256       string
	StubSHA256       string
	ProviderSHA256   string
	GatewayArgv      []string
	BrokerArgv       []string
	Target           string
	Revision         string
	Purpose          string
	SelectedImage    string
	CaptureEvidence  string
	LabScenario      string
}

type consumerKey struct {
	pid   int
	start string
}

var consumers = struct {
	sync.Mutex
	used map[consumerKey]struct{}
}{used: make(map[consumerKey]struct{})}

func main() {
	if len(os.Args) != 2 || os.Args[1] != "--disposable-lab" {
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if serve(ctx) != nil {
		os.Exit(1)
	}
}

func serve(ctx context.Context) error {
	if os.Geteuid() != 0 {
		return brokerErr
	}

	marker, err := os.Lstat("/lab/disposable-profile")
	if err != nil || marker.Mode()&os.ModeSymlink != 0 || !marker.Mode().IsRegular() {
		return brokerErr
	}
	markerStat, ok := marker.Sys().(*syscall.Stat_t)
	if !ok || markerStat.Uid != 0 || markerStat.Nlink != 1 || markerStat.Mode&07777 != 0444 {
		return brokerErr
	}

	config, err := loadBrokerConfig()
	if err != nil {
		return err
	}
	if err := os.Mkdir("/run/task245-lab", 0755); err != nil {
		return err
	}
	runDir, err := os.Lstat("/run/task245-lab")
	if err != nil || !runDir.IsDir() || runDir.Mode()&os.ModeSymlink != 0 {
		return brokerErr
	}
	runDirStat, ok := runDir.Sys().(*syscall.Stat_t)
	if !ok || runDirStat.Uid != 0 || runDirStat.Mode&07777 != 0755 {
		return brokerErr
	}
	if _, err := os.Lstat(brokerSocket); err == nil || !os.IsNotExist(err) {
		return brokerErr
	}

	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)

	// Shutdown interrupts Accept4; join the callback before the descriptor closes.
	shutdownDone := make(chan struct{})
	stopShutdown := context.AfterFunc(ctx, func() {
		_ = syscall.Shutdown(fd, syscall.SHUT_RDWR)
		close(shutdownDone)
	})
	defer func() {
		if !stopShutdown() {
			<-shutdownDone
		}
	}()

	if err := syscall.Bind(fd, &syscall.SockaddrUnix{Name: brokerSocket}); err != nil {
		return err
	}
	defer syscall.Unlink(brokerSocket)
	if err := os.Chmod(brokerSocket, 0666); err != nil {
		return err
	}
	if err := syscall.Listen(fd, 128); err != nil {
		return err
	}

	semaphore := make(chan struct{}, 4)
	var workers sync.WaitGroup
	for {
		select {
		case <-ctx.Done():
			workers.Wait()
			return nil
		case semaphore <- struct{}{}:
		}

		clientFD, _, err := syscall.Accept4(fd, syscall.SOCK_CLOEXEC)
		if err != nil {
			<-semaphore
			if ctx.Err() != nil {
				workers.Wait()
				return nil
			}
			return err
		}

		workers.Add(1)
		go func(fd int) {
			defer workers.Done()
			defer func() { <-semaphore }()
			handle(ctx, fd, config)
		}(clientFD)
	}
}

func handle(ctx context.Context, fd int, config brokerConfig) {
	defer syscall.Close(fd)

	// Keep the connection alive until the shutdown callback has finished.
	shutdownDone := make(chan struct{})
	stopShutdown := context.AfterFunc(ctx, func() {
		_ = syscall.Shutdown(fd, syscall.SHUT_RDWR)
		close(shutdownDone)
	})
	defer func() {
		if !stopShutdown() {
			<-shutdownDone
		}
	}()

	timeout := syscall.NsecToTimeval((5 * time.Second).Nanoseconds())
	if syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &timeout) != nil {
		return
	}

	var credentials syscall.Ucred
	credentialSize := uint32(unsafe.Sizeof(credentials))
	_, _, errno := syscall.Syscall6(
		syscall.SYS_GETSOCKOPT,
		uintptr(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED,
		uintptr(unsafe.Pointer(&credentials)), uintptr(unsafe.Pointer(&credentialSize)), 0,
	)
	if errno != 0 || credentials.Uid == 0 || credentials.Uid != config.RuntimeUID {
		return
	}

	_, _ = os.Stderr.WriteString("task245-broker: stage=1\n")
	pid := int(credentials.Pid)
	start, err := procStart245(pid)
	if err != nil || authenticateConsumer(pid, config) != nil {
		return
	}
	_, _ = os.Stderr.WriteString("task245-broker: stage=2\n")

	consumers.Lock()
	key := consumerKey{pid: pid, start: start}
	_, alreadyUsed := consumers.used[key]
	if alreadyUsed || len(consumers.used) >= brokerLifetimeLimit {
		consumers.Unlock()
		return
	}
	consumers.used[key] = struct{}{}
	consumers.Unlock()

	var request [9]byte
	control := make([]byte, syscall.CmsgSpace(4))
	n, controlN, flags, _, err := syscall.Recvmsg(fd, request[:], control, 0)
	if err != nil || n != 8 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || controlN != 0 || string(request[:8]) != "OCLAB001" {
		if controlN > len(control) {
			controlN = len(control)
		}
		closeReceivedRights(control[:controlN])
		return
	}

	_, _ = os.Stderr.WriteString("task245-broker: stage=3\n")
	if launchNativeContext(ctx, fd, pid, config) != nil {
		_, _ = os.Stderr.WriteString("task245-broker: stage=4\n")
	} else {
		_, _ = os.Stderr.WriteString("task245-broker: stage=5\n")
	}
}

func closeReceivedRights(oob []byte) {
	messages, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return
	}
	for _, message := range messages {
		fds, err := syscall.ParseUnixRights(&message)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			_ = syscall.Close(fd)
		}
	}
}

func loadBrokerConfig() (brokerConfig, error) {
	var config brokerConfig
	file, err := os.OpenFile("/etc/clawwright/native-lab.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return config, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
		return config, brokerErr
	}
	fileStat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || fileStat.Uid != 0 || fileStat.Nlink != 1 || fileStat.Mode&0022 != 0 {
		return config, brokerErr
	}

	for _, path := range []string{"/etc", "/etc/clawwright"} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return config, brokerErr
		}
		dirStat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || dirStat.Uid != 0 || dirStat.Mode&0022 != 0 {
			return config, brokerErr
		}
	}

	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 || duplicateJSON(data) != nil {
		return config, brokerErr
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || decoder.Decode(new(any)) != io.EOF {
		return config, brokerErr
	}
	if config.RuntimeUID == 0 || config.RuntimeGID == 0 || config.SelectedImage == "" {
		return config, brokerErr
	}

	hashes := []string{
		config.SupervisorSHA256, config.KeeperSHA256, config.InitSHA256,
		config.ManifestSHA256, config.NodeSHA256, config.StubSHA256, config.ProviderSHA256,
	}
	for _, hash := range hashes {
		if len(hash) != 64 || strings.Trim(hash, "0123456789abcdef") != "" {
			return config, brokerErr
		}
	}
	paths := []string{
		config.Supervisor, config.Keeper, config.Init, config.Root,
		config.Manifest, config.Node, config.Stub, config.Provider, config.ConfigPath,
	}
	for _, path := range paths {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return config, brokerErr
		}
	}
	return config, nil
}

func duplicateJSON(data []byte) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	nodes := 0

	var value func(depth int) error
	value = func(depth int) error {
		nodes++
		if depth > 32 || nodes > 8192 {
			return brokerErr
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}

		switch delim {
		case '{':
			seen := make(map[string]bool)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok || seen[key] {
					return brokerErr
				}
				seen[key] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			_, err := decoder.Token()
			return err
		case '[':
			for decoder.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			_, err := decoder.Token()
			return err
		default:
			return brokerErr
		}
	}

	if err := value(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return brokerErr
	}
	return nil
}
